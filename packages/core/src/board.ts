import { buildGraph, type TaskGraph } from "./graph.ts";
import type { Agent, ProjectFile, Task, TaskIssue, TrackEvent } from "./schema.ts";

/** Work a chat left for later, proposed as a new task. */
export interface Proposal {
  /** "<event id>:<index>". */
  id: string;
  /** The task it came from. */
  from: string;
  /** The chat that proposed it. */
  by?: string;
  ts: string;
  title: string;
  detail?: string;
  /** The chat that should do it, as the proposing chat suggested. */
  agent?: string;
  after: string[];
  state: "open" | "added" | "ignored";
  /** The task it became, once added. */
  task?: string;
}

/**
 * The proposed tasks of a project, oldest first: every follow-up chats reported, with what
 * happened to it. A chat that reports the same work again for the same task does not add it twice.
 */
export function reduceProposals(events: TrackEvent[]): Proposal[] {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const list: Proposal[] = [];
  const byId = new Map<string, Proposal>();
  const seen = new Set<string>();
  for (const e of sorted) {
    (e.followUps ?? []).forEach((f, i) => {
      const key = `${e.task}\u0000${f.title.trim().toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      const p: Proposal = {
        id: `${e.id}:${i}`,
        from: e.task,
        ...(e.agent && { by: e.agent }),
        ts: e.ts,
        title: f.title.trim(),
        ...(f.detail && { detail: f.detail }),
        ...(f.agent && { agent: f.agent }),
        after: f.after ?? [],
        state: "open",
      };
      list.push(p);
      byId.set(p.id, p);
    });
    for (const u of e.proposals ?? []) {
      const p = byId.get(u.id);
      if (!p) continue;
      p.state = u.state;
      if (u.task) p.task = u.task;
      else if (u.state === "open") delete p.task;
    }
  }
  return list;
}

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
  /** The chat stopped until these tasks are done; it gets the task back then. */
  | { kind: "waiting_for"; tasks: string[] }
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
  /** Blocked until these tasks are done (from the chat's report), and since when. */
  waitingFor?: string[];
  waitingSince?: string;
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
  /**
   * The chat stopped this task until other tasks were done, and they are done now: the task goes
   * back to the same chat, before its other work.
   */
  resumes?: string[];
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
  /** Work chats left for later, proposed as new tasks. */
  proposals: Proposal[];
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
    if (e.type === "blocked" && e.waitingFor?.length) {
      r.waitingFor = e.waitingFor.filter((id) => id !== e.task);
      r.waitingSince = e.ts;
    } else if (e.type !== "note") {
      r.waitingFor = undefined;
      r.waitingSince = undefined;
    }
  }
  return runtime;
}

export function computeBoard(project: ProjectFile, events: TrackEvent[]): Board {
  const graph = buildGraph(project.tasks);
  const runtime = reduceEvents(project.tasks, events, project.settings.requireApproval);
  const agentsById = new Map(project.agents.map((a) => [a.id, a]));

  /**
   * A task the chat stopped until other tasks are done: "waiting" while any of them is not done,
   * "resume" once all are done after the chat stopped, or null — no such wait, or the tasks were
   * already done when it stopped (then the chat needs the person, not those tasks).
   */
  const parked = (r: TaskRuntime | undefined): { state: "waiting" | "resume"; tasks: string[] } | null => {
    if (!r || r.status !== "blocked" || !r.waitingFor?.length || !r.waitingSince) return null;
    const tasks = r.waitingFor.filter((id) => graph.byId.has(id));
    if (!tasks.length) return null;
    const open = tasks.filter((id) => runtime.get(id)?.status !== "done");
    if (open.length) return { state: "waiting", tasks: open };
    const since = r.waitingSince;
    return tasks.every((id) => (runtime.get(id)?.finishedAt ?? "") >= since) ? { state: "resume", tasks } : null;
  };

  // How many tasks each chat holds. A task waiting for others keeps its chat; one ready to go back does not.
  const holding = new Map<string, string[]>(project.agents.map((a) => [a.id, []]));
  for (const t of project.tasks) {
    const r = runtime.get(t.id);
    if (r && HOLDING.includes(r.status) && parked(r)?.state !== "resume") {
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
    const wait = parked(r);
    let resumes: string[] | undefined;

    if (wait?.state === "resume") {
      // Back to the chat that stopped it, which has its context.
      const holder = r.agent && agentsById.has(r.agent) ? r.agent : task.agent;
      status = "ready";
      candidates = hasRoom(holder) && !graph.cycle ? [holder] : [];
      if (!candidates.length) reasons.push({ kind: "agent_busy", agent: holder, tasks: holding.get(holder) ?? [] });
      dispatchable = candidates.length > 0;
      resumes = wait.tasks;
    } else if (wait?.state === "waiting") {
      status = "blocked";
      reasons.push({ kind: "waiting_for", tasks: wait.tasks });
    } else if (r.status === "idle" || r.status === "failed") {
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
      ...(resumes && { resumes }),
    };
  });

  const byId = new Map(views.map((v) => [v.task.id, v]));
  // A task going back to its chat comes before new work, so the chat finishes what it started.
  const urgency = (a: TaskView, b: TaskView) =>
    Number(Boolean(b.resumes)) - Number(Boolean(a.resumes)) ||
    b.chain - a.chain ||
    graph.order.indexOf(a.task.id) - graph.order.indexOf(b.task.id);

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
  // A task the chat stopped until other tasks are done counts as waiting: it needs nothing from the person.
  for (const v of views) counts[v.reasons.some((r) => r.kind === "waiting_for") ? "waiting" : v.status] += 1;

  return { tasks: views, byId, agents, graph, counts, proposals: reduceProposals(events) };
}

/** Tasks a chat should take next, most urgent first. */
export function nextTasksFor(board: Board, agentId: string): TaskView[] {
  const view = board.agents.find((a) => a.agent.id === agentId);
  return (view?.dispatchable ?? []).map((id) => board.byId.get(id)).filter((v): v is TaskView => Boolean(v));
}
