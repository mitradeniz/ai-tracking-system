/**
 * Adapters for the AI coding CLIs that can run a task without a human typing it in.
 *
 * Each adapter turns a chat's run settings into a command line, and turns the CLI's output into a
 * small set of events: the session id (so the next message continues the same conversation),
 * activity lines (commands, file edits, tool calls), assistant messages and the final result.
 *
 * The CLIs run with the user's own login. Nothing here stores or forwards credentials.
 */

export const PROVIDERS = ["codex", "claude", "copilot", "gemini", "custom"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export type Access = "readonly" | "edit" | "full";
export type SessionMode = "keep" | "perTask";

/** How one chat is run. Stored only on this computer, never in the project file. */
export interface ChatRunner {
  provider: ProviderId | "manual";
  /** Folder the agent works in. Empty means the project's repository. */
  workdir?: string;
  model?: string;
  /** Reasoning effort, for the CLIs that have one (Codex, Claude Code, Copilot). */
  effort?: string;
  access: Access;
  session: SessionMode;
  /** Conversation that the next message continues. Filled automatically, can be pasted by hand. */
  sessionId?: string;
  /** Tell the agent not to wait for a plan approval; it still stops for anything risky. */
  unattended: boolean;
  /** Codex only: allow network access inside the workspace sandbox. */
  network: boolean;
  /** Claude Code and Copilot: extra tool permissions, e.g. "Bash(npm test:*)" or "shell(git:*)". */
  allowedTools?: string;
  /** Extra command line arguments, appended as written (quotes are respected). */
  extraArgs?: string;
  /** Full path of the CLI when it is not found on PATH. */
  binary?: string;
  /** Custom provider: the command line. {{prompt}}, {{sessionId}} and {{workdir}} are replaced. */
  command?: string;
}

export const DEFAULT_RUNNER: ChatRunner = {
  provider: "manual",
  access: "edit",
  session: "keep",
  unattended: false,
  network: false,
};

export interface ModelChoice {
  id: string;
  label: string;
  /** Effort levels this model supports, when the CLI says so. */
  efforts?: string[];
  defaultEffort?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** Models offered when the CLI cannot list its own; aliases that follow the latest versions. */
  models: ModelChoice[];
  /** Effort levels the CLI accepts; empty when it has no such option. */
  efforts: string[];
  /** Executable looked up on PATH. */
  bin: string | null;
  /** What each access level means for this CLI, shown in the settings dialog. */
  access: Record<Access, string>;
  /** Command that continues a session in a terminal, for handing a run over to a human. */
  resumeHint: string | null;
}

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  codex: {
    id: "codex",
    name: "Codex CLI",
    bin: "codex",
    models: [],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    access: {
      readonly: "-s read-only",
      edit: "-s workspace-write",
      full: "--dangerously-bypass-approvals-and-sandbox",
    },
    resumeHint: "codex resume {{sessionId}}",
  },
  claude: {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    models: [
      { id: "fable", label: "Fable" },
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    access: {
      readonly: "--permission-mode plan",
      edit: "--permission-mode acceptEdits",
      full: "--permission-mode bypassPermissions",
    },
    resumeHint: "claude --resume {{sessionId}}",
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot CLI",
    bin: "copilot",
    models: [{ id: "auto", label: "Auto" }],
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    access: {
      readonly: "(no extra permissions)",
      edit: "--allow-tool write",
      full: "--allow-all-tools",
    },
    resumeHint: "copilot --resume {{sessionId}}",
  },
  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    bin: "gemini",
    models: [
      { id: "auto", label: "Auto" },
      { id: "pro", label: "Pro" },
      { id: "flash", label: "Flash" },
      { id: "flash-lite", label: "Flash Lite" },
    ],
    efforts: [],
    access: {
      readonly: "--approval-mode plan",
      edit: "--approval-mode auto_edit",
      full: "--approval-mode yolo",
    },
    resumeHint: "gemini --resume {{sessionId}}",
  },
  custom: {
    id: "custom",
    name: "Custom command",
    bin: null,
    models: [],
    efforts: [],
    access: { readonly: "", edit: "", full: "" },
    resumeHint: null,
  },
};

/** Splits a command line into arguments. Supports single and double quotes and backslash escapes. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in the command line.");
  if (has || cur) out.push(cur);
  return out;
}

/** Splits a tool permission list. Commas and new lines separate entries; spaces inside one entry are kept. */
export function splitTools(text: string | undefined): string[] {
  return (text ?? "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Invocation {
  /** Executable name or path. */
  command: string;
  args: string[];
  /** Written to the process and closed; undefined closes stdin right away. */
  stdin?: string;
  /** Session id fixed before the run (Claude Code, Copilot, Gemini); Codex reports its own. */
  sessionId?: string;
  /** How the output is read. */
  format: "codex" | "claude" | "gemini" | "text";
}

export interface BuildInput {
  runner: ChatRunner;
  prompt: string;
  cwd: string;
  /** Session to continue, if any. */
  resume?: string;
  /** Fresh UUID to use when a new session starts. */
  newSessionId: string;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(prompt|sessionId|workdir)\s*\}\}/g, (_m, name: string) => vars[name] ?? "");
}

export function buildInvocation(input: BuildInput): Invocation {
  const { runner, prompt, cwd, resume, newSessionId } = input;
  const extra = runner.extraArgs ? splitArgs(runner.extraArgs) : [];
  const model = runner.model?.trim();
  const effort = runner.effort?.trim();
  switch (runner.provider) {
    case "codex": {
      const args = ["exec", "--json", "--skip-git-repo-check", "-C", cwd];
      if (runner.access === "readonly") args.push("-s", "read-only");
      else if (runner.access === "edit") {
        args.push("-s", "workspace-write");
        if (runner.network) args.push("-c", "sandbox_workspace_write.network_access=true");
      } else args.push("--dangerously-bypass-approvals-and-sandbox");
      if (model) args.push("-m", model);
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push(...extra);
      if (resume) args.push("resume", resume);
      args.push("-");
      return { command: runner.binary || "codex", args, stdin: prompt, format: "codex" };
    }
    case "claude": {
      const args = ["-p", "--output-format", "stream-json", "--verbose"];
      if (resume) args.push("--resume", resume);
      else args.push("--session-id", newSessionId);
      args.push(
        "--permission-mode",
        runner.access === "readonly" ? "plan" : runner.access === "edit" ? "acceptEdits" : "bypassPermissions",
      );
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      args.push(...extra);
      const tools = splitTools(runner.allowedTools);
      if (tools.length) args.push("--allowedTools", ...tools);
      return { command: runner.binary || "claude", args, stdin: prompt, sessionId: resume ?? newSessionId, format: "claude" };
    }
    case "copilot": {
      const session = resume ?? newSessionId;
      const args = ["-p", prompt, "-s", "--no-color", "--no-ask-user", "--session-id", session];
      if (runner.access === "edit") args.push("--allow-tool", "write");
      if (runner.access === "full") args.push("--allow-all-tools");
      for (const tool of splitTools(runner.allowedTools)) args.push("--allow-tool", tool);
      if (model) args.push("--model", model);
      if (effort) args.push("--reasoning-effort", effort);
      args.push(...extra);
      return { command: runner.binary || "copilot", args, sessionId: session, format: "text" };
    }
    case "gemini": {
      const args = ["-p", prompt, "-o", "stream-json", "--skip-trust"];
      if (resume) args.push("--resume", resume);
      else args.push("--session-id", newSessionId);
      args.push(
        "--approval-mode",
        runner.access === "readonly" ? "plan" : runner.access === "edit" ? "auto_edit" : "yolo",
      );
      if (model) args.push("-m", model);
      args.push(...extra);
      return { command: runner.binary || "gemini", args, sessionId: resume ?? newSessionId, format: "gemini" };
    }
    case "custom": {
      const template = runner.command?.trim();
      if (!template) throw new Error("The custom command is empty.");
      const session = resume ?? newSessionId;
      const parts = splitArgs(template);
      const usesPrompt = parts.some((p) => /\{\{\s*prompt\s*\}\}/.test(p));
      const vars = { prompt, sessionId: session, workdir: cwd };
      const [command, ...args] = parts.map((p) => fill(p, vars));
      if (!command) throw new Error("The custom command is empty.");
      return {
        command,
        args: [...args, ...extra],
        stdin: usesPrompt ? undefined : prompt,
        sessionId: session,
        format: "text",
      };
    }
    default:
      throw new Error("This chat is set to manual: copy the prompt instead.");
  }
}

/** Tokens, context and cost of a run, as far as the CLI reports them. */
export interface RunUsage {
  /** Input tokens, including cached ones. */
  input?: number;
  cached?: number;
  output?: number;
  /** Tokens in the conversation at the last model call: how full the context is. */
  context?: number;
  contextWindow?: number;
  /** Cost the CLI reports (list price; a subscription may not charge it). */
  costUsd?: number;
  turns?: number;
  model?: string;
}

/** What the runner learns from one line of output. */
export type StreamEvent =
  | { kind: "session"; id: string }
  | { kind: "usage"; usage: RunUsage }
  | { kind: "tool" }
  | { kind: "denied"; tool: string }
  | { kind: "activity"; text: string }
  | { kind: "message"; text: string; partial?: boolean }
  | { kind: "error"; text: string }
  | { kind: "result"; ok: boolean; text?: string; error?: string };

const clip = (s: string, n = 240) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function describeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return name;
  const o = input as Record<string, unknown>;
  const pick = (o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.description) as unknown;
  return typeof pick === "string" ? `${name} ${clip(pick, 160)}` : name;
}

function parseCodex(o: Record<string, unknown>): StreamEvent[] {
  const type = String(o.type ?? "");
  if (type === "thread.started" && typeof o.thread_id === "string") return [{ kind: "session", id: o.thread_id }];
  if (type === "turn.completed") {
    const u = (o.usage ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" ? v : undefined);
    return [
      { kind: "usage", usage: { input: n(u.input_tokens), cached: n(u.cached_input_tokens), output: n(u.output_tokens) } },
      { kind: "result", ok: true },
    ];
  }
  if (type === "turn.failed") {
    const err = (o.error as { message?: string } | undefined)?.message ?? "Turn failed";
    return [{ kind: "result", ok: false, error: err }];
  }
  if (type === "error") return [{ kind: "error", text: String(o.message ?? "error") }];
  if (!type.startsWith("item.")) return [];
  const item = (o.item ?? {}) as Record<string, unknown>;
  const itemType = String(item.type ?? "");
  const done = type === "item.completed";
  switch (itemType) {
    case "agent_message":
      return done && typeof item.text === "string" ? [{ kind: "message", text: item.text }] : [];
    case "command_execution":
      if (type === "item.started") return [{ kind: "tool" }, { kind: "activity", text: `$ ${clip(String(item.command ?? ""), 200)}` }];
      if (done && typeof item.exit_code === "number" && item.exit_code !== 0) {
        return [{ kind: "activity", text: `  ↳ exit ${item.exit_code}` }];
      }
      return [];
    case "file_change": {
      if (!done) return [];
      const changes = Array.isArray(item.changes) ? (item.changes as { path?: string; kind?: string }[]) : [];
      return [{ kind: "tool" }, { kind: "activity", text: `✎ ${changes.map((c) => `${c.kind ?? "edit"} ${c.path ?? ""}`).join(", ")}` }];
    }
    case "mcp_tool_call":
      return type === "item.started" ? [{ kind: "tool" }, { kind: "activity", text: `⚙ ${item.server ?? ""}.${item.tool ?? ""}` }] : [];
    case "web_search":
      return type === "item.started" ? [{ kind: "tool" }, { kind: "activity", text: `⌕ ${clip(String(item.query ?? ""))}` }] : [];
    case "todo_list": {
      const items = Array.isArray(item.items) ? (item.items as { text?: string; completed?: boolean }[]) : [];
      return items.length ? [{ kind: "activity", text: `☐ ${items.map((i) => `${i.completed ? "✓" : "·"} ${i.text ?? ""}`).join("  ")}` }] : [];
    }
    case "error":
      return [{ kind: "error", text: String(item.message ?? "error") }];
    default:
      return [];
  }
}

function parseClaude(o: Record<string, unknown>): StreamEvent[] {
  const type = String(o.type ?? "");
  if (type === "system" && o.subtype === "init" && typeof o.session_id === "string") return [{ kind: "session", id: o.session_id }];
  if (type === "assistant") {
    const message = (o.message ?? {}) as { content?: unknown[]; usage?: Record<string, unknown>; model?: string };
    const content = (message.content ?? []) as Record<string, unknown>[];
    const out: StreamEvent[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) out.push({ kind: "message", text: block.text });
      if (block.type === "tool_use") {
        out.push({ kind: "tool" });
        out.push({ kind: "activity", text: `⚙ ${describeToolInput(String(block.name ?? "tool"), block.input)}` });
      }
    }
    const u = message.usage;
    if (u) {
      const n = (v: unknown) => (typeof v === "number" ? v : 0);
      const context = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens);
      if (context > 0) out.push({ kind: "usage", usage: { context, model: typeof message.model === "string" ? message.model : undefined } });
    }
    return out;
  }
  if (type === "result") {
    const out: StreamEvent[] = [];
    const denials = Array.isArray(o.permission_denials) ? (o.permission_denials as { tool_name?: string; tool_input?: unknown }[]) : [];
    for (const d of denials) {
      const tool = describeToolInput(d.tool_name ?? "tool", d.tool_input);
      out.push({ kind: "denied", tool });
      out.push({ kind: "activity", text: `⛔ permission denied: ${tool}` });
    }
    const u = (o.usage ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" ? v : undefined);
    const windows = Object.values((o.modelUsage ?? {}) as Record<string, { contextWindow?: number }>)
      .map((m) => m?.contextWindow)
      .filter((v): v is number => typeof v === "number");
    out.push({
      kind: "usage",
      usage: {
        input: (n(u.input_tokens) ?? 0) + (n(u.cache_creation_input_tokens) ?? 0) + (n(u.cache_read_input_tokens) ?? 0) || undefined,
        cached: n(u.cache_read_input_tokens),
        output: n(u.output_tokens),
        costUsd: n(o.total_cost_usd),
        turns: n(o.num_turns),
        contextWindow: windows.length ? Math.max(...windows) : undefined,
      },
    });
    const ok = o.is_error !== true && (o.subtype === undefined || o.subtype === "success");
    out.push({
      kind: "result",
      ok,
      text: typeof o.result === "string" ? o.result : undefined,
      error: ok ? undefined : String(o.result || o.subtype || "error"),
    });
    return out;
  }
  return [];
}

function parseGemini(o: Record<string, unknown>): StreamEvent[] {
  const type = String(o.type ?? "");
  if (type === "init" && typeof o.session_id === "string") return [{ kind: "session", id: o.session_id }];
  if (type === "message" && o.role === "assistant" && typeof o.content === "string") {
    return [{ kind: "message", text: o.content, partial: o.delta === true }];
  }
  if (type === "tool_use") return [{ kind: "tool" }, { kind: "activity", text: `⚙ ${describeToolInput(String(o.tool_name ?? "tool"), o.parameters)}` }];
  if (type === "tool_result" && o.status === "error") {
    return [{ kind: "activity", text: `  ↳ ${clip(String((o.error as { message?: string } | undefined)?.message ?? "tool error"))}` }];
  }
  if (type === "error") return [{ kind: "error", text: String(o.message ?? "error") }];
  if (type === "result") {
    const ok = o.status === "success";
    const st = (o.stats ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" ? v : undefined);
    return [
      { kind: "usage", usage: { input: n(st.input_tokens), cached: n(st.cached), output: n(st.output_tokens) } },
      { kind: "result", ok, error: ok ? undefined : String((o.error as { message?: string } | undefined)?.message ?? "error") },
    ];
  }
  return [];
}

/** Reads a CLI's stdout line by line and keeps the last assistant message. */
export class OutputParser {
  private messages: string[] = [];
  private partial = "";
  private textOut: string[] = [];
  result: { ok: boolean; text?: string; error?: string } | null = null;
  sessionId: string | null = null;
  errors: string[] = [];
  usage: RunUsage = {};
  tools = 0;
  denials: string[] = [];

  constructor(readonly format: Invocation["format"]) {}

  /** Parses one line; returns the events it carried. */
  feed(line: string): StreamEvent[] {
    if (this.format === "text") {
      this.textOut.push(line);
      if (this.textOut.length > 4000) this.textOut.splice(0, this.textOut.length - 4000);
      return line.trim() ? [{ kind: "activity", text: line }] : [];
    }
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      return line.trim() ? [{ kind: "activity", text: line }] : [];
    }
    if (!o || typeof o !== "object") return [];
    const events =
      this.format === "codex"
        ? parseCodex(o as Record<string, unknown>)
        : this.format === "claude"
          ? parseClaude(o as Record<string, unknown>)
          : parseGemini(o as Record<string, unknown>);
    for (const e of events) {
      if (e.kind === "session") this.sessionId = e.id;
      if (e.kind === "error") this.errors.push(e.text);
      if (e.kind === "result") this.result = { ok: e.ok, text: e.text, error: e.error };
      if (e.kind === "tool") this.tools += 1;
      if (e.kind === "denied" && !this.denials.includes(e.tool)) this.denials.push(e.tool);
      if (e.kind === "usage") {
        for (const [k, v] of Object.entries(e.usage)) if (v !== undefined) (this.usage as Record<string, unknown>)[k] = v;
      }
      if (e.kind === "message") {
        if (e.partial) this.partial += e.text;
        else {
          this.flushPartial();
          this.messages.push(e.text);
        }
      } else this.flushPartial();
    }
    return events;
  }

  private flushPartial(): void {
    if (this.partial) {
      this.messages.push(this.partial);
      this.partial = "";
    }
  }

  /** The agent's final answer: the result text, else the last message, else the plain output. */
  finalMessage(): string {
    this.flushPartial();
    if (this.format === "text") return this.textOut.join("\n").trim();
    return (this.result?.text ?? this.messages[this.messages.length - 1] ?? "").trim();
  }

  /** Every message of the run, for finding a report block that was not in the last one. */
  allMessages(): string {
    this.flushPartial();
    if (this.format === "text") return this.textOut.join("\n");
    return [...this.messages, this.result?.text ?? ""].join("\n\n");
  }
}
