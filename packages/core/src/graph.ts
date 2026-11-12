import type { ProjectFile, Task } from "./schema.ts";

export interface Issue {
  level: "error" | "warning";
  path: string;
  message: string;
}

export interface TaskGraph {
  /** Tasks by id. */
  byId: Map<string, Task>;
  /** Direct dependents (tasks that depend on the key). */
  dependents: Map<string, string[]>;
  /** Topological order (dependencies first). Empty when the graph has a cycle. */
  order: string[];
  /** Depth of each task: 0 for tasks without dependencies, otherwise 1 + max depth of its dependencies. */
  layer: Map<string, number>;
  /** Length (in estimated days) of the longest chain that starts at the task, the task included. */
  chain: Map<string, number>;
  /** Tasks on the longest chain of the whole project. */
  critical: Set<string>;
  /** A dependency cycle, if any, as a list of task ids. */
  cycle: string[] | null;
}

const DEFAULT_ESTIMATE = 1;

/** Finds one dependency cycle, if the graph has any. */
export function findCycle(tasks: Task[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const s = state.get(dep) ?? 0;
      if (s === 1) {
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (s === 0) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const t of tasks) {
    if ((state.get(t.id) ?? 0) === 0) {
      const found = visit(t.id);
      if (found) return found;
    }
  }
  return null;
}

export function buildGraph(tasks: Task[]): TaskGraph {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dependents = new Map<string, string[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks) {
    for (const dep of t.dependsOn) dependents.get(dep)?.push(t.id);
  }

  const cycle = findCycle(tasks);
  const order: string[] = [];
  const layer = new Map<string, number>();
  const chain = new Map<string, number>();
  const critical = new Set<string>();

  if (cycle) {
    for (const t of tasks) layer.set(t.id, 0);
    return { byId, dependents, order, layer, chain, critical, cycle };
  }

  // Kahn's algorithm, stable with respect to the file order.
  const indegree = new Map<string, number>();
  for (const t of tasks) indegree.set(t.id, t.dependsOn.filter((d) => byId.has(d)).length);
  const queue = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  for (const id of order) {
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
    layer.set(id, deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => layer.get(d) ?? 0)));
  }

  for (const id of [...order].reverse()) {
    const own = byId.get(id)?.estimateDays ?? DEFAULT_ESTIMATE;
    const next = dependents.get(id) ?? [];
    chain.set(id, own + (next.length === 0 ? 0 : Math.max(...next.map((n) => chain.get(n) ?? 0))));
  }

  // Walk the longest chain from the best starting task.
  const roots = order.filter((id) => (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d)).length === 0);
  let current = roots.sort((a, b) => (chain.get(b) ?? 0) - (chain.get(a) ?? 0))[0];
  while (current) {
    critical.add(current);
    const next: string[] = dependents.get(current) ?? [];
    current = [...next].sort((a, b) => (chain.get(b) ?? 0) - (chain.get(a) ?? 0))[0];
  }

  return { byId, dependents, order, layer, chain, critical, cycle: null };
}

/** Checks references and structure that the schema alone cannot check. */
export function validateProject(project: ProjectFile): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: "error", path, message });
  const warn = (path: string, message: string) => issues.push({ level: "warning", path, message });

  const agentIds = new Set<string>();
  project.agents.forEach((a, i) => {
    if (agentIds.has(a.id)) err(`agents[${i}].id`, `Duplicate agent id "${a.id}".`);
    agentIds.add(a.id);
    [...a.bootstrapPrompts, ...a.quickPrompts].forEach((p) => {
      if (!project.prompts[p]) err(`agents[${i}]`, `Agent "${a.id}" refers to unknown prompt "${p}".`);
    });
  });

  const milestoneIds = new Set(project.milestones.map((m) => m.id));
  const taskIds = new Set<string>();
  project.tasks.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (taskIds.has(t.id)) err(`${at}.id`, `Duplicate task id "${t.id}".`);
    taskIds.add(t.id);
    if (!agentIds.has(t.agent)) err(`${at}.agent`, `Task "${t.id}" is assigned to unknown agent "${t.agent}".`);
    t.alsoAgents.forEach((a) => {
      if (!agentIds.has(a)) err(`${at}.alsoAgents`, `Task "${t.id}" lists unknown agent "${a}".`);
    });
    t.prompts.forEach((p) => {
      if (!project.prompts[p]) err(`${at}.prompts`, `Task "${t.id}" refers to unknown prompt "${p}".`);
    });
    if (t.prompts.length === 0 && !t.instructions) {
      warn(at, `Task "${t.id}" has no prompts and no instructions; the copied prompt will be almost empty.`);
    }
    if (t.milestone && !milestoneIds.has(t.milestone)) {
      warn(`${at}.milestone`, `Task "${t.id}" refers to unknown milestone "${t.milestone}".`);
    }
    if (t.dependsOn.includes(t.id)) err(`${at}.dependsOn`, `Task "${t.id}" depends on itself.`);
  });

  project.tasks.forEach((t, i) => {
    t.dependsOn.forEach((d) => {
      if (!taskIds.has(d)) err(`tasks[${i}].dependsOn`, `Task "${t.id}" depends on unknown task "${d}".`);
    });
  });

  const cycle = findCycle(project.tasks);
  if (cycle) err("tasks", `Dependency cycle: ${cycle.join(" -> ")}.`);

  return issues;
}
