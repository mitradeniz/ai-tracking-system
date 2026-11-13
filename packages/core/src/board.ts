import { buildGraph, type TaskGraph } from "./graph.ts";
import type { Agent, ProjectFile, Task, TaskIssue, TrackEvent } from "./schema.ts";

/**
 * Runtime status of a task, derived from its events:
 * - idle: never sent to a chat (or reopened)
 * - dispatched: the prompt was given to a chat, no report yet
 * - in_progress: the chat reported that it started
 * - blocked: the chat reported that it cannot continue
 * - review: the chat reported done and a human must approve (settings.requireApproval)
 * - done: finished
 * - failed: the chat gave up; can be sent again
 */
export type RuntimeStatus = "idle" | "dispatched" | "in_progress" | "blocked" | "review" | "done" | "failed";

/** Board status: runtime status plus readiness for idle tasks. */
export type BoardStatus = "waiting" | "ready" | Exclude<RuntimeStatus, "idle">;

export type Reason =
  | { kind: "dependency"; task: string; status: BoardStatus }
  | { kind: "agent_busy"; agent: string; tasks: string[] }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "awaiting_approval" }
  | { kind: "cycle"; cycle: string[] };

export interface TaskRuntime {
  status: RuntimeStatus;
  /** Chat currently holding the task (from the last dispatch or report). */
  agent?: string;
  summary?: string;
  reason?: string;
  pr?: string;
  verify?: string;
  /** Problems from the latest report that listed any; cleared when the task is sent, done without problems, approved or reopened. */
  issues: TaskIssue[];
  lastMessage?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  history: TrackEvent[];
}

export interface TaskView {
  task: Task;
  status: BoardStatus;
  runtime: TaskRuntime;
  /** True when every dependency is done. */
  depsDone: boolean;
  /** True when the task can be given to a chat right now (ready and a chat has room). */
  dispatchable: boolean;
  /** Chats that can take the task right now, owner first. */
  candidates: string[];
  /** Why the task is not dispatchable, or why it is stuck. */
  reasons: Reason[];
  layer: number;
  /** Longest chain of work (estimated days) starting at this task. Higher means more urgent. */
  chain: number;
  critical: boolean;
}

export interface AgentView {
  agent: Agent;
  /** Tasks this chat holds now (dispatched, in progress or blocked). */
  holding: string[];
  hasRoom: boolean;
  /** Tasks this chat can take right now, most urgent first. */
  dispatchable: string[];
}

export interface Board {
  tasks: TaskView[];
  byId: Map<string, TaskView>;
  agents: AgentView[];
  graph: TaskGraph;
  counts: Record<BoardStatus, number> & { total: number };
}

const HOLDING: RuntimeStatus[] = ["dispatched", "in_progress", "blocked"];

export function reduceEvents(tasks: Task[], events: TrackEvent[], requireApproval: boolean): Map<string, TaskRuntime> {
  const runtime = new Map<string, TaskRuntime>(tasks.map((t) => [t.id, { status: "idle", history: [], issues: [] }]));
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  for (const e of sorted) {
    const r = runtime.get(e.task);
    if (!r) continue;
    r.history.push(e);
    r.updatedAt = e.ts;
    if (e.agent) r.agent = e.agent;
    // A note is the person's, not something the chat said.
    if (e.message && e.type !== "note") r.lastMessage = e.message;

    switch (e.type) {
      case "dispatched":
        r.status = "dispatched";
        r.reason = undefined;
        break;
      case "started":
        r.status = "in_progress";
        r.startedAt ??= e.ts;
        r.reason = undefined;
        break;
      case "progress":
        if (r.status === "idle" || r.status === "dispatched") r.status = "in_progress";
        break;
      case "blocked":
        r.status = "blocked";
        r.reason = e.reason ?? e.message ?? r.reason;
        break;
      case "review":
        r.status = "review";
        r.summary = e.message ?? r.summary;
        break;
      case "done":
        r.status = requireApproval ? "review" : "done";
        r.summary = e.message ?? r.summary;
        r.reason = undefined;
        if (!requireApproval) r.finishedAt = e.ts;
        break;
      case "approved":
        r.status = "done";
        r.finishedAt = e.ts;
        break;
      case "failed":
        r.status = "failed";
        r.reason = e.reason ?? e.message ?? r.reason;
        break;
      case "reopened":
        r.status = "idle";
        r.agent = undefined;
        r.reason = undefined;
        r.finishedAt = undefined;
        break;
      case "note":
        break;
    }
    if (e.pr) r.pr = e.pr;
    if (e.verify) r.verify = e.verify;
    if (e.issues) r.issues = e.issues;
    else if (e.type === "dispatched" || e.type === "done" || e.type === "approved" || e.type === "reopened") r.issues = [];
  }
  return runtime;
}

export function computeBoard(project: ProjectFile, events: TrackEvent[]): Board {
  const graph = buildGraph(project.tasks);
  const runtime = reduceEvents(project.tasks, events, project.settings.requireApproval);
  const agentsById = new Map(project.agents.map((a) => [a.id, a]));

  // How many tasks each chat holds.
  const holding = new Map<string, string[]>(project.agents.map((a) => [a.id, []]));
  for (const t of project.tasks) {
    const r = runtime.get(t.id);
    if (r && HOLDING.includes(r.status)) {
      const who = r.agent && holding.has(r.agent) ? r.agent : t.agent;
      holding.get(who)?.push(t.id);
    }
  }
  const hasRoom = (agentId: string) =>
    (holding.get(agentId)?.length ?? 0) < (agentsById.get(agentId)?.maxParallel ?? 1);

  const statusOf = (id: string): BoardStatus => {
    const r = runtime.get(id);
    if (!r || r.status === "idle") return "waiting";
    return r.status;
  };

  const views: TaskView[] = project.tasks.map((task) => {
    const r = runtime.get(task.id) ?? { status: "idle" as const, history: [], issues: [] };
    const deps = task.dependsOn.filter((d) => graph.byId.has(d));
    const depsDone = deps.every((d) => runtime.get(d)?.status === "done");
    const reasons: Reason[] = [];
    let status: BoardStatus;
    let dispatchable = false;
    let candidates: string[] = [];

    if (graph.cycle && graph.cycle.includes(task.id)) {
      reasons.push({ kind: "cycle", cycle: graph.cycle });
    }

    if (r.status === "idle" || r.status === "failed") {
      if (!depsDone) {
        for (const d of deps) {
          if (runtime.get(d)?.status !== "done") reasons.push({ kind: "dependency", task: d, status: statusOf(d) });
        }
      }
      const eligible = [task.agent, ...task.alsoAgents.filter((a) => a !== task.agent)].filter((a) =>
        agentsById.has(a),
      );
      candidates = depsDone && !graph.cycle ? eligible.filter(hasRoom) : [];
      if (depsDone && candidates.length === 0) {
        for (const a of eligible) reasons.push({ kind: "agent_busy", agent: a, tasks: holding.get(a) ?? [] });
      }
      if (r.status === "failed") {
        status = "failed";
        reasons.unshift({ kind: "failed", reason: r.reason ?? "" });
      } else {
        status = depsDone ? "ready" : "waiting";
        dispatchable = depsDone && candidates.length > 0 && !graph.cycle;
      }
    } else {
      status = r.status;
      if (r.status === "blocked") reasons.push({ kind: "blocked", reason: r.reason ?? "" });
      if (r.status === "review") reasons.push({ kind: "awaiting_approval" });
    }

    return {
      task,
      status,
      runtime: r,
      depsDone,
      dispatchable,
      candidates,
      reasons,
      layer: graph.layer.get(task.id) ?? 0,
      chain: graph.chain.get(task.id) ?? 0,
      critical: graph.critical.has(task.id),
    };
  });

  const byId = new Map(views.map((v) => [v.task.id, v]));
  const urgency = (a: TaskView, b: TaskView) =>
    b.chain - a.chain || graph.order.indexOf(a.task.id) - graph.order.indexOf(b.task.id);

  const agents: AgentView[] = project.agents.map((agent) => ({
    agent,
    holding: holding.get(agent.id) ?? [],
    hasRoom: hasRoom(agent.id),
    dispatchable: views
      .filter((v) => v.dispatchable && v.candidates.includes(agent.id))
      .sort(urgency)
      .map((v) => v.task.id),
  }));

  const counts = {
    waiting: 0,
    ready: 0,
    dispatched: 0,
    in_progress: 0,
    blocked: 0,
    review: 0,
    done: 0,
    failed: 0,
    total: views.length,
  };
  for (const v of views) counts[v.status] += 1;

  return { tasks: views, byId, agents, graph, counts };
}

/** Tasks a chat should take next, most urgent first. */
export function nextTasksFor(board: Board, agentId: string): TaskView[] {
  const view = board.agents.find((a) => a.agent.id === agentId);
  return (view?.dispatchable ?? []).map((id) => board.byId.get(id)).filter((v): v is TaskView => Boolean(v));
}
