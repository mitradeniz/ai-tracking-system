import type { Agent, BoardStatus, Reason, Task, TaskIssue, TaskSnapshot, TrackEvent } from "@aitrack/core";
import { explainStep, REFUSED, type RefusedStep } from "@aitrack/core";
import type { ChatRunner, ProjectDetail, RunnerState, RunSummary } from "./api.ts";
import type { T } from "./i18n.ts";

export interface Model {
  detail: ProjectDetail;
  tasks: Task[];
  task: Map<string, Task>;
  snap: Map<string, TaskSnapshot>;
  agent: Map<string, Agent>;
  eventsByTask: Map<string, TrackEvent[]>;
  /** How chats run on this computer and their recent runs; null when unknown. */
  runners: RunnerState | null;
}

export function buildModel(detail: ProjectDetail, runners: RunnerState | null = null): Model | null {
  if (!detail.project || !detail.board) return null;
  const eventsByTask = new Map<string, TrackEvent[]>();
  for (const e of detail.events) {
    const list = eventsByTask.get(e.task) ?? [];
    list.push(e);
    eventsByTask.set(e.task, list);
  }
  return {
    detail,
    tasks: detail.project.tasks,
    task: new Map(detail.project.tasks.map((t) => [t.id, t])),
    snap: new Map(detail.board.tasks.map((t) => [t.id, t])),
    agent: new Map(detail.project.agents.map((a) => [a.id, a])),
    eventsByTask,
    runners: runners && detail.key ? runners : null,
  };
}

/** The chat's runner, or null when it is run by hand. */
export function runnerOf(model: Model, agentId: string | null | undefined): ChatRunner | null {
  if (!agentId) return null;
  const r = model.runners?.settings.chats[agentId];
  return r && r.provider !== "manual" ? r : null;
}

/** The chat's run in progress, if any. */
export function activeRun(model: Model, agentId: string | null | undefined): RunSummary | undefined {
  return model.runners?.runs.find((r) => r.agent === agentId && r.state === "running");
}

/** The latest run of a task. */
export function lastRunOf(model: Model, taskId: string): RunSummary | undefined {
  return model.runners?.runs.find((r) => r.task === taskId);
}

export const PROVIDER_LABEL: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  copilot: "Copilot",
  gemini: "Gemini",
  custom: "CLI",
  manual: "",
};

export function agentName(model: Model, id: string | null | undefined): string {
  if (!id) return "—";
  return model.agent.get(id)?.name ?? id;
}

/** Reasons the tracker writes itself, shown in the UI language. */
export function localReason(reason: string, t: T): string {
  if (reason === "Waiting for your reply.") return t("run_state_waiting");
  if (reason.startsWith("Stopped from the tracker.")) return t("run_reason_stopped");
  if (reason.startsWith("The run stopped when the app closed.")) return t("run_reason_closed");
  if (reason.startsWith("Needs you: ")) return t("run_reason_needs", { message: reason.slice(11) });
  return reason;
}

/** How to install each CLI (macOS and Linux), and the command that signs in the first time. */
export const INSTALL: Record<string, { install: string; login: string }> = {
  claude: { install: "curl -fsSL https://claude.ai/install.sh | bash", login: "claude" },
  codex: { install: "npm install -g @openai/codex", login: "codex login" },
  copilot: { install: "npm install -g @github/copilot", login: "copilot" },
  gemini: { install: "npm install -g @google/gemini-cli", login: "gemini" },
};

/** Errors the tracker explains in English, shown in the UI language. */
export function localError(message: string, t: T): string {
  let m = /^The project's code folder does not exist yet: (.+) \(settings\.repoPath in the project file\)\./.exec(message);
  if (m) return t("err_codeFolderMissing", { path: m[1]! });
  m = /^This chat's working folder was not found: (.+)\. Choose another one/.exec(message);
  if (m) return t("err_workdirMissing", { path: m[1]! });
  m = /^(.+) was not found \(([^)]+)\)\. Install it/.exec(message);
  if (m) {
    const how = INSTALL[m[2]!];
    return how ? t("err_cliMissingHow", { name: m[1]!, install: how.install, login: how.login }) : t("err_cliMissing", { name: m[1]! });
  }
  return message;
}

/** Messages the tracker writes itself when it runs a chat, shown in the UI language. */
export function localMessage(message: string, t: T): string {
  let m = /^(Auto-sent|Sent) to (.+) \((r-[\w-]+)\)\.$/.exec(message);
  if (m) return t(m[1] === "Auto-sent" ? "run_msg_autoSent" : "run_msg_sent", { provider: m[2]! });
  m = /^(.+) is working( on it)?\.$/.exec(message);
  if (m) return t("run_msg_working", { provider: m[1]! });
  m = /^Reply sent: ([\s\S]*)$/.exec(message);
  if (m) return t("run_msg_reply", { text: m[1]! });
  m = /^Manager: (replied|left for you|allowed|sent it again|approved)(?: — )?([\s\S]*)$/.exec(message);
  if (m) return t(`msg_manager_${m[1]!.replace(/ /g, "_")}` as Parameters<T>[0], { text: m[2]! });
  m = /^Manager: chose "(.*)" for "([\s\S]*)"$/.exec(message);
  if (m) return t("msg_manager_chose", { choice: m[1]!, title: m[2]! });
  m = /^Proposed tasks: ([\s\S]*)$/.exec(message);
  if (m) return t("msg_proposals", { text: m[1]!.replace(/ → ignored/g, ` → ${t("prop_ignoredShort")}`).replace(/ → open/g, ` → ${t("prop_openShort")}`) });
  m = /^Problem (resolved|ignored|reopened): ([\s\S]*)$/.exec(message);
  if (m) return t(m[1] === "resolved" ? "msg_problemResolved" : m[1] === "ignored" ? "msg_problemIgnored" : "msg_problemReopened", { title: m[2]! });
  return message;
}

export function reasonText(model: Model, reason: Reason, t: T): string {
  switch (reason.kind) {
    case "dependency":
      return t("why_dependency", { task: reason.task, status: t(`status_${reason.status}`) });
    case "waiting_for":
      return t("why_waiting_for", { tasks: reason.tasks.join(", ") });
    case "agent_busy":
      return reason.tasks.length > 0
        ? t("why_agent_busy", { agent: agentName(model, reason.agent), tasks: reason.tasks.join(", ") })
        : t("why_agent_busy_free", { agent: agentName(model, reason.agent) });
    case "blocked":
      return t("why_blocked", { reason: localReason(reason.reason, t) || "—" });
    case "failed":
      return t("why_failed", { reason: reason.reason || "—" });
    case "awaiting_approval":
      return t("why_awaiting_approval");
    case "cycle":
      return t("why_cycle", { cycle: reason.cycle.join(" → ") });
  }
}

/** The tasks a blocked task waits for: the chat stopped it until they are done. Null otherwise. */
export function waitingFor(s: TaskSnapshot): string[] | null {
  const r = s.reasons.find((x) => x.kind === "waiting_for");
  return r?.kind === "waiting_for" ? r.tasks : null;
}

/** The status a pill shows: a task waiting for other tasks needs nothing from the person, so it is not shown as blocked. */
export function shownStatus(s: TaskSnapshot): BoardStatus {
  return waitingFor(s) ? "waiting" : s.status;
}

/** One short line under a card title. */
export function cardNote(model: Model, s: TaskSnapshot, t: T): string {
  const wait = waitingFor(s);
  if (wait) return t("card_waitingFor", { tasks: wait.join(", ") });
  if (s.resumes?.length) return t("card_resumes", { tasks: s.resumes.join(", ") });
  if (s.status === "blocked" || s.status === "failed") return s.reason ? localReason(s.reason, t) : "";
  if (s.status === "waiting") {
    const open = s.reasons.filter((r) => r.kind === "dependency").map((r) => (r.kind === "dependency" ? r.task : ""));
    return open.length ? `⏳ ${open.slice(0, 3).join(", ")}${open.length > 3 ? "…" : ""}` : "";
  }
  if (s.status === "ready" && !s.dispatchable) {
    const busy = s.reasons.find((r) => r.kind === "agent_busy");
    return busy ? reasonText(model, busy, t) : "";
  }
  if (s.status === "in_progress" || s.status === "dispatched") {
    const run = model.runners?.runs.find((r) => r.task === s.id && r.state === "running");
    if (run?.lastActivity) return run.lastActivity;
    return s.lastMessage ? localMessage(s.lastMessage, t) : "";
  }
  if (s.status === "done" || s.status === "review") return s.summary ?? "";
  return "";
}

export function formatTime(iso: string | null | undefined, lang: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(lang === "tr" ? "tr-TR" : "en-US", { dateStyle: "short", timeStyle: "short" });
}

/** Chats whose tasks the given chat may also take (it is in their tasks' `alsoAgents`). */
export function helpedChats(tasks: Task[], agentId: string): string[] {
  const out = new Set<string>();
  for (const t of tasks) if (t.agent !== agentId && t.alsoAgents.includes(agentId)) out.add(t.agent);
  return [...out];
}

/** A free chat id derived from a display name, e.g. "Codex D" -> "codex-d". */
export function agentIdFromName(name: string, taken: Iterable<string>): string {
  return slugId(name, taken, "chat");
}

/** A free id derived from a title: lower case, ASCII, words joined with "-". */
export function slugId(name: string, taken: Iterable<string>, fallback: string): string {
  const map: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" };
  const base =
    name
      .toLowerCase()
      .replace(/[çğıöşü]/g, (c) => map[c] ?? c)
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || fallback;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The next task id in the style the project already uses: T-07 after T-06; T-01 at first. */
export function nextTaskId(ids: string[]): string {
  const used = new Set(ids);
  let best: { prefix: string; n: number; width: number } | null = null;
  for (const id of ids) {
    const m = /^(.*?)(\d+)$/.exec(id);
    if (!m) continue;
    const n = Number(m[2]);
    if (!best || n > best.n) best = { prefix: m[1]!, n, width: m[2]!.length };
  }
  const style = best ?? { prefix: "T-", n: 0, width: 2 };
  for (let n = style.n + 1; ; n += 1) {
    const id = `${style.prefix}${String(n).padStart(style.width, "0")}`;
    if (!used.has(id)) return id;
  }
}

/** Every task that waits, directly or through others, for the given task. */
export function dependentsOf(tasks: Task[], taskId: string): Set<string> {
  const out = new Set<string>();
  const stack = [taskId];
  while (stack.length) {
    const current = stack.pop()!;
    for (const t of tasks) {
      if (t.dependsOn.includes(current) && !out.has(t.id)) {
        out.add(t.id);
        stack.push(t.id);
      }
    }
  }
  return out;
}

/** Session prompts every chat shares (for example the shared context), in the first chat's order. */
export function sharedBootstrapPrompts(agents: Agent[]): string[] {
  const [first, ...rest] = agents;
  if (!first) return [];
  return first.bootstrapPrompts.filter((p) => rest.every((a) => a.bootstrapPrompts.includes(p)));
}

/** Something the person should look at, with a prompt that would fix it. */
export interface Problem {
  kind: "error" | "missing" | "needs-you" | "warning";
  title: string;
  detail?: string;
  /** Prompt to give the chat, ready to send; empty when the chat cannot fix it (a sign-in, say). */
  fix: string;
  /** A command for the person to run in Terminal. */
  command?: string;
  /** The problem is in how the chat runs (permissions, CLI), not in the work. */
  settings?: boolean;
  /** The problems the chat reported that this card stands for; they are closed together. */
  issues?: Array<{ index: number; title: string }>;
  /** Steps the CLI refused, each explained in plain words. */
  steps?: RefusedStep[];
  /** A decision: the options the chat offered, as buttons. */
  choices?: IssueChoice[];
}

export type IssueChoice = NonNullable<TaskIssue["choices"]>[number];

// What a refused step does and how risky it is: shared with the tracker, which lets a manager allow safe steps.
export { explainStep, permissionRules, REFUSED, type RefusedStep, type StepRisk, type StepWhat } from "@aitrack/core";

function issueFix(taskId: string, title: string, issue: TaskIssue): string {
  if (issue.fix?.trim()) return issue.fix.trim();
  return [
    `Task ${taskId} (${title}) has an open problem: ${issue.title}.`,
    issue.detail ? `Details: ${issue.detail}` : "",
    "Resolve it within the task's allowed paths, verify the result, and report again with the aitrack-report block. If you cannot resolve it, explain in plain words what is needed from me.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A CLI that is installed but not signed in. */
const SIGN_IN = /not logged in|please run \/login|not authenticated|unauthori[sz]ed|authentication (?:failed|required|error)|invalid (?:x-)?api[- ]key|codex login|please log ?in/i;
/** A CLI that was asked to continue a session it no longer has. */
const SESSION_GONE = /no conversation found|unknown session|could not (?:find|resume) (?:the )?session/i;
/** Claude Code refused auto mode (an older version, or turned off for the account). */
const AUTO_MODE = /auto mode|invalid[^\n]{0,80}permission-mode|permission-mode[^\n]{0,80}(?:invalid|choices)/i;

/** Problems of a task: what the chat reported, plus failures and blocks the tracker knows about. */
export function problemsOf(model: Model, s: TaskSnapshot, t: T): Problem[] {
  const task = model.task.get(s.id);
  const title = task?.title ?? s.id;
  const out: Problem[] = [];
  const lastRun = lastRunOf(model, s.id);
  const refused: Array<{ index: number; title: string }> = [];
  (s.issues ?? []).forEach((i, index) => {
    // Notes need no answer: they are shown with the task, not as problems.
    if (i.state || i.kind === "warning") return;
    if (i.title.startsWith(REFUSED)) {
      refused.push({ index, title: i.title });
      return;
    }
    out.push({
      kind: i.kind ?? "error",
      title: i.title,
      detail: i.detail,
      fix: issueFix(s.id, title, i),
      issues: [{ index, title: i.title }],
      ...(i.choices?.length && { choices: i.choices }),
    });
  });
  // Every step the CLI refused, on one card.
  if (refused.length) {
    const list = refused.map((r) => explainStep(r.title.slice(REFUSED.length), lastRun?.workdir));
    out.push({
      kind: "needs-you",
      title: list.length === 1 ? t("issue_refusedOne") : t("issue_refusedMany", { n: list.length }),
      detail: t(list.some((x) => x.risk === "risky") ? "issue_refusedDetailRisky" : "issue_refusedDetail"),
      fix: `Task ${s.id} (${title}): your permissions refused these steps: ${list.map((x) => x.tool).join("; ")}. Finish the task without them if you can; otherwise tell me in plain words which one you need and why.`,
      settings: true,
      issues: refused,
      steps: list,
    });
  }
  const runFailedNow = s.status === "failed" && s.reason && lastRun?.state === "failed" && lastRun.error === s.reason;
  if (runFailedNow && SIGN_IN.test(s.reason!)) {
    const how = INSTALL[lastRun!.provider];
    out.unshift({
      kind: "needs-you",
      title: t("issue_signIn", { cli: PROVIDER_LABEL[lastRun!.provider] || lastRun!.provider }),
      detail: t("issue_signInDetail", { login: how?.login ?? lastRun!.provider }),
      fix: "",
      command: how?.login,
    });
  } else if (runFailedNow && SESSION_GONE.test(s.reason!)) {
    out.unshift({ kind: "warning", title: t("issue_sessionGone"), detail: t("issue_sessionGoneDetail"), fix: "" });
  } else if (runFailedNow && lastRun!.provider === "claude" && AUTO_MODE.test(s.reason!)) {
    out.unshift({ kind: "warning", title: t("issue_autoMode"), detail: t("issue_autoModeDetail"), fix: "", settings: true, command: "claude update" });
  } else if (s.status === "failed" && s.reason && !out.some((p) => p.detail === s.reason)) {
    const runFailed = lastRun?.state === "failed" && lastRun.error === s.reason;
    out.unshift({
      kind: "error",
      title: runFailed ? t("issue_runFailed") : t("issue_failed"),
      detail: s.reason,
      fix: `Task ${s.id} (${title}) failed: ${s.reason}\nFind the cause, fix it, verify the result, and report again with the aitrack-report block. If you need something from me, say exactly what.`,
      settings: runFailed,
    });
  }
  // The chat's own question, unless it already wrote down what it needs as problems of its own.
  const askedAlready = out.some((p) => p.kind === "needs-you" && p.issues && !p.steps);
  if (
    s.status === "blocked" &&
    s.reason &&
    !askedAlready &&
    !waitingFor(s) &&
    s.reason !== "Waiting for your reply." &&
    !s.reason.startsWith("Stopped from") &&
    !s.reason.startsWith("The run stopped")
  ) {
    out.unshift({
      kind: "needs-you",
      title: t("issue_blocked"),
      detail: localReason(s.reason, t),
      fix: `About task ${s.id} (${title}), which is blocked: ${s.reason}\n<your answer or decision>\nContinue with this, verify, and report again.`,
    });
  }
  return out;
}

/** What a chat noted without needing an answer (kind "warning"), still open. */
export function notesOf(s: TaskSnapshot): Array<TaskIssue & { index: number }> {
  return (s.issues ?? []).map((i, index) => ({ ...i, index })).filter((i) => i.kind === "warning" && !i.state);
}

/** Work chats left for later that nobody added to the plan or ignored yet. */
export function openProposals(model: Model) {
  return (model.detail.board?.proposals ?? []).filter((p) => p.state === "open");
}

/** The problems a chat reported that the person resolved or ignored. */
export function closedIssuesOf(s: TaskSnapshot): Array<TaskIssue & { index: number }> {
  return (s.issues ?? []).map((i, index) => ({ ...i, index })).filter((i) => Boolean(i.state));
}

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** How full the session's context is, 0–100, when the CLI tells. */
export function contextPercent(run: RunSummary | undefined): number | null {
  const u = run?.usage;
  if (!u?.context || !u.contextWindow) return null;
  return Math.min(100, Math.round((u.context / u.contextWindow) * 100));
}

/** The chat's latest run that reported context usage. */
export function lastContextRun(model: Model, agentId: string): RunSummary | undefined {
  return model.runners?.runs.find((r) => r.agent === agentId && r.usage?.context);
}
