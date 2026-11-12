import type { Agent, Reason, Task, TaskSnapshot, TrackEvent } from "@aitrack/core";
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

/** Messages the tracker writes itself when it runs a chat, shown in the UI language. */
export function localMessage(message: string, t: T): string {
  let m = /^(Auto-sent|Sent) to (.+) \((r-[\w-]+)\)\.$/.exec(message);
  if (m) return t(m[1] === "Auto-sent" ? "run_msg_autoSent" : "run_msg_sent", { provider: m[2]! });
  m = /^(.+) is working( on it)?\.$/.exec(message);
  if (m) return t("run_msg_working", { provider: m[1]! });
  m = /^Reply sent: ([\s\S]*)$/.exec(message);
  if (m) return t("run_msg_reply", { text: m[1]! });
  return message;
}

export function reasonText(model: Model, reason: Reason, t: T): string {
  switch (reason.kind) {
    case "dependency":
      return t("why_dependency", { task: reason.task, status: t(`status_${reason.status}`) });
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

/** One short line under a card title. */
export function cardNote(model: Model, s: TaskSnapshot, t: T): string {
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
  const map: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" };
  const base =
    name
      .toLowerCase()
      .replace(/[çğıöşü]/g, (c) => map[c] ?? c)
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "chat";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Session prompts every chat shares (for example the shared context), in the first chat's order. */
export function sharedBootstrapPrompts(agents: Agent[]): string[] {
  const [first, ...rest] = agents;
  if (!first) return [];
  return first.bootstrapPrompts.filter((p) => rest.every((a) => a.bootstrapPrompts.includes(p)));
}
