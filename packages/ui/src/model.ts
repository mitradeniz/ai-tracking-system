import type { Agent, Reason, Task, TaskSnapshot, TrackEvent } from "@aitrack/core";
import type { ProjectDetail } from "./api.ts";
import type { T } from "./i18n.ts";

export interface Model {
  detail: ProjectDetail;
  tasks: Task[];
  task: Map<string, Task>;
  snap: Map<string, TaskSnapshot>;
  agent: Map<string, Agent>;
  eventsByTask: Map<string, TrackEvent[]>;
}

export function buildModel(detail: ProjectDetail): Model | null {
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
  };
}

export function agentName(model: Model, id: string | null | undefined): string {
  if (!id) return "—";
  return model.agent.get(id)?.name ?? id;
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
      return t("why_blocked", { reason: reason.reason || "—" });
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
  if (s.status === "blocked" || s.status === "failed") return s.reason ?? "";
  if (s.status === "waiting") {
    const open = s.reasons.filter((r) => r.kind === "dependency").map((r) => (r.kind === "dependency" ? r.task : ""));
    return open.length ? `⏳ ${open.slice(0, 3).join(", ")}${open.length > 3 ? "…" : ""}` : "";
  }
  if (s.status === "ready" && !s.dispatchable) {
    const busy = s.reasons.find((r) => r.kind === "agent_busy");
    return busy ? reasonText(model, busy, t) : "";
  }
  if (s.status === "in_progress" || s.status === "dispatched") return s.lastMessage ?? "";
  if (s.status === "done" || s.status === "review") return s.summary ?? "";
  return "";
}

export function formatTime(iso: string | null | undefined, lang: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(lang === "tr" ? "tr-TR" : "en-US", { dateStyle: "short", timeStyle: "short" });
}
