/**
 * Hooks let sessions that a person opened by hand (Claude Code, Codex) tell the tracker when a turn
 * starts and ends. The tracker accepts the CLIs' own hook payloads as they are, so the hook can be
 * a one-line curl that forwards its input.
 */

export type HookEvent = "prompt" | "stop" | "attention" | "start" | "end";

export interface HookSignal {
  tool: string;
  event: HookEvent;
  sessionId?: string;
  cwd?: string;
  /** The last assistant message (turn end) or the notification text. */
  message?: string;
  /** Chat id, when the session was started with AITRACK_CHAT set. */
  chat?: string;
  project?: string;
  /** Set when the session is a run started by the tracker itself. */
  runId?: string;
}

const text = (v: unknown, max = 20000): string | undefined =>
  typeof v === "string" && v.trim() ? v.slice(0, max) : undefined;

const CLAUDE_EVENTS: Record<string, HookEvent> = {
  UserPromptSubmit: "prompt",
  Stop: "stop",
  Notification: "attention",
  SessionStart: "start",
  SessionEnd: "end",
};

/** Turns a hook payload into a signal. Returns null for payloads the tracker does not use. */
export function normalizeHook(
  body: Record<string, unknown>,
  hints: { tool?: string; chat?: string; project?: string; runId?: string } = {},
): HookSignal | null {
  const base = {
    chat: text(hints.chat, 80) ?? text(body.chat, 80),
    project: text(hints.project, 80) ?? text(body.project, 80),
    runId: text(hints.runId, 80) ?? text(body.runId, 80),
  };
  // Claude Code hooks: stdin JSON with hook_event_name.
  if (typeof body.hook_event_name === "string") {
    const event = CLAUDE_EVENTS[body.hook_event_name];
    if (!event) return null;
    return {
      ...base,
      tool: hints.tool ?? "claude",
      event,
      sessionId: text(body.session_id, 200),
      cwd: text(body.cwd, 2000),
      message: event === "attention" ? text(body.message) : event === "stop" ? text(body.last_assistant_message) : undefined,
    };
  }
  // Codex `notify`: JSON argument with type "agent-turn-complete".
  if (typeof body.type === "string" && ("thread-id" in body || "turn-id" in body)) {
    const event: HookEvent | null =
      body.type === "agent-turn-complete" ? "stop" : body.type === "approval-requested" ? "attention" : null;
    if (!event) return null;
    return {
      ...base,
      tool: hints.tool ?? "codex",
      event,
      sessionId: text(body["thread-id"], 200),
      cwd: text(body.cwd, 2000),
      message: text(body["last-assistant-message"]) ?? text(body.message),
    };
  }
  // The tracker's own shape, for any other tool: {event, sessionId, cwd, message}.
  if (typeof body.event === "string" && ["prompt", "stop", "attention", "start", "end"].includes(body.event)) {
    return {
      ...base,
      tool: hints.tool ?? text(body.tool, 40) ?? "other",
      event: body.event as HookEvent,
      sessionId: text(body.sessionId, 200),
      cwd: text(body.cwd, 2000),
      message: text(body.message),
    };
  }
  return null;
}

/** Snippets the settings dialog shows, ready to paste. */
export function hookSnippets(serverUrl: string): { claude: string; codex: string; generic: string } {
  const headers = `-H 'Content-Type: application/json' -H "X-Aitrack-Chat: \${AITRACK_CHAT:-}" -H "X-Aitrack-Run: \${AITRACK_RUN:-}"`;
  const claudeCmd = `curl -s -m 3 -X POST '${serverUrl}/api/hook?tool=claude' ${headers} --data-binary @- >/dev/null 2>&1 || true`;
  const entry = [{ hooks: [{ type: "command", command: claudeCmd }] }];
  const claude = JSON.stringify({ hooks: { UserPromptSubmit: entry, Stop: entry, Notification: entry } }, null, 2);
  const codexScript = `curl -s -m 3 -X POST '${serverUrl}/api/hook?tool=codex' ${headers} -d "$1" >/dev/null 2>&1 || true`;
  const codex = `notify = ["sh", "-c", ${JSON.stringify(codexScript)}, "aitrack"]`;
  const generic = `curl -s -X POST '${serverUrl}/api/hook?tool=mytool' -H 'Content-Type: application/json' -d '{"event":"stop","sessionId":"...","cwd":"'"$PWD"'","message":"..."}'`;
  return { claude, codex, generic };
}
