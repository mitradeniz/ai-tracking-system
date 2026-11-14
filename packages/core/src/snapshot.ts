import type { Board, BoardStatus, Reason } from "./board.ts";
import type { TaskIssue } from "./schema.ts";

/** JSON-friendly view of a board, sent to the UI. Task definitions come from the project itself. */
export interface TaskSnapshot {
  id: string;
  status: BoardStatus;
  agent: string | null;
  summary: string | null;
  reason: string | null;
  pr: string | null;
  verify: string | null;
  issues: TaskIssue[];
  lastMessage: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  depsDone: boolean;
  dispatchable: boolean;
  candidates: string[];
  reasons: Reason[];
  /** The tasks the chat waited for, when they are done and the task goes back to it. */
  resumes: string[] | null;
  layer: number;
  chain: number;
  critical: boolean;
  dependents: string[];
}

export interface AgentSnapshot {
  id: string;
  holding: string[];
  hasRoom: boolean;
  dispatchable: string[];
}

export interface BoardSnapshot {
  tasks: TaskSnapshot[];
  agents: AgentSnapshot[];
  counts: Board["counts"];
  order: string[];
  cycle: string[] | null;
  layers: number;
}

export function serializeBoard(board: Board): BoardSnapshot {
  const tasks = board.tasks.map((v) => ({
    id: v.task.id,
    status: v.status,
    agent: v.runtime.agent ?? null,
    summary: v.runtime.summary ?? null,
    reason: v.runtime.reason ?? null,
    pr: v.runtime.pr ?? null,
    verify: v.runtime.verify ?? null,
    issues: v.runtime.issues,
    lastMessage: v.runtime.lastMessage ?? null,
    updatedAt: v.runtime.updatedAt ?? null,
    startedAt: v.runtime.startedAt ?? null,
    finishedAt: v.runtime.finishedAt ?? null,
    depsDone: v.depsDone,
    dispatchable: v.dispatchable,
    candidates: v.candidates,
    reasons: v.reasons,
    resumes: v.resumes ?? null,
    layer: v.layer,
    chain: v.chain,
    critical: v.critical,
    dependents: board.graph.dependents.get(v.task.id) ?? [],
  }));
  return {
    tasks,
    agents: board.agents.map((a) => ({
      id: a.agent.id,
      holding: a.holding,
      hasRoom: a.hasRoom,
      dispatchable: a.dispatchable,
    })),
    counts: board.counts,
    order: board.graph.order,
    cycle: board.graph.cycle,
    layers: tasks.reduce((max, t) => Math.max(max, t.layer + 1), 0),
  };
}
