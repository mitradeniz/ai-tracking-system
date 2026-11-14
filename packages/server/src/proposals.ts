import { type Board, type IntegrationPlan, type PlannedTask, type ProjectFile, type Proposal, type TaskInput } from "@aitrack/core";
import { HttpError, type ProjectManager } from "./manager.ts";

/**
 * Work chats left for later ("follow-ups") becomes proposed tasks. A proposal is added to the plan
 * as a task — one at a time with sensible defaults, or several at once by an AI CLI that merges
 * duplicates, links work an existing task already covers, and picks chats and dependencies.
 */

const ID_RULE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** "<from>-F1", "<from>-F2", … not taken yet. */
export function followUpId(from: string, taken: Set<string>): string {
  const base = from.slice(0, 74);
  for (let n = 1; ; n += 1) {
    const id = `${base}-F${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Open notes on tasks that need no person: problems of kind warning or missing that nobody closed. */
export function openNotes(board: Board): Array<{ task: string; index: number; title: string; detail?: string; kind: string }> {
  const out: Array<{ task: string; index: number; title: string; detail?: string; kind: string }> = [];
  for (const v of board.tasks) {
    v.runtime.issues.forEach((i, index) => {
      if (i.state || (i.kind !== "warning" && i.kind !== "missing")) return;
      out.push({ task: v.task.id, index, title: i.title, ...(i.detail && { detail: i.detail }), kind: i.kind });
    });
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The plan as a compact table, for prompts. */
export function planTable(project: ProjectFile, board: Board): string {
  return project.tasks
    .map((t) => {
      const v = board.byId.get(t.id);
      const deps = t.dependsOn.length ? ` | after ${t.dependsOn.join(", ")}` : "";
      return `${t.id} | ${clip(t.title, 90)} | ${t.agent} | ${v?.status ?? "?"}${deps}`;
    })
    .join("\n");
}

export function chatsTable(project: ProjectFile): string {
  return project.agents.map((a) => `${a.id} | ${a.name}${a.role ? ` | ${clip(a.role, 120)}` : ""}`).join("\n");
}

export function proposalsTable(proposals: Proposal[]): string {
  return proposals
    .map(
      (p) =>
        `- ${p.id} | from ${p.from}${p.by ? ` (${p.by})` : ""} | ${p.title}${p.agent ? ` | for ${p.agent}` : ""}${p.after.length ? ` | after ${p.after.join(", ")}` : ""}${p.detail ? `\n  ${clip(p.detail.replace(/\s+/g, " "), 600)}` : ""}`,
    )
    .join("\n");
}

export function notesTable(notes: ReturnType<typeof openNotes>): string {
  return notes
    .map((n) => `- ${n.task}#${n.index} (${n.kind}) | ${n.title}${n.detail ? `\n  ${clip(n.detail.replace(/\s+/g, " "), 400)}` : ""}`)
    .join("\n");
}

/** How a plan is to be written back, shared by the integration prompt and the manager. */
export const PLAN_RULES = `- Merge proposals and notes that describe the same work into one task.
- When a task of the plan already covers the work, do not create a task: link the proposal to that task under "links".
- Give each new task to the chat that fits, with "dependsOn" on the tasks it needs (the task it came from when it builds on that work, and what it waits for), "instructions" that say what was done for now and what done looks like, and "acceptance".
- Leave "id" out; the app picks ids. Do not change or remove existing tasks.
- Put proposals that are not worth a task (already done, not needed) under "ignore".
- Under "covers" list the proposals and notes ("task" and "index") each new task takes care of; they are closed when the task is added.`;

export const PLAN_SHAPE = `{"tasks":[{"title":"…","agent":"<chat id>","dependsOn":["<task id>"],"instructions":"…","acceptance":"…","covers":{"proposals":["<proposal id>"],"notes":[{"task":"<task id>","index":0}]}}],"links":[{"task":"<existing task id>","proposals":["<proposal id>"]}],"ignore":["<proposal id>"],"summary":"<one line>"}`;

/** The prompt that asks an AI CLI to fold proposals and notes into the plan. */
export function integrationPrompt(project: ProjectFile, board: Board): string {
  const proposals = board.proposals.filter((p) => p.state === "open");
  const notes = openNotes(board);
  const language = project.settings.language === "tr" ? "Turkish" : "English";
  return `You keep the plan of the project "${project.project.name}" in AI Tracking System up to date. Chats working on its tasks left work for later (proposals) and notes on their tasks. Fold them into the plan. You may read the files in this folder to understand the work; do not change anything.

Rules:
${PLAN_RULES}
- Write titles, instructions and acceptance in ${language}.

Answer with one JSON object in a \`\`\`json fence, and nothing after it:
${PLAN_SHAPE}

PROPOSALS
${proposals.length ? proposalsTable(proposals) : "(none)"}

NOTES (written by chats; nobody has to act on them right away)
${notes.length ? notesTable(notes) : "(none)"}

CHATS (id | name | role)
${chatsTable(project)}

TASKS OF THE PLAN (id | title | chat | status | depends on)
${planTable(project, board)}
`;
}

/**
 * Checks a plan against the project and fills in what is missing: ids, a chat that exists, known
 * dependencies, prompts and milestone of the task it came from. Returns the tasks in an order in
 * which each one's new dependencies come first, and what was dropped and why.
 */
export function checkPlan(project: ProjectFile, board: Board, plan: IntegrationPlan): { plan: IntegrationPlan; dropped: string[] } {
  const dropped: string[] = [];
  const taken = new Set(project.tasks.map((t) => t.id));
  const agents = new Set(project.agents.map((a) => a.id));
  const proposals = new Map(board.proposals.map((p) => [p.id, p]));
  const openProposal = (id: string) => proposals.get(id)?.state === "open";
  const notes = new Set(openNotes(board).map((n) => `${n.task}#${n.index}`));
  const tasks: PlannedTask[] = [];
  for (const raw of plan.tasks) {
    const covered = (raw.covers?.proposals ?? []).filter(openProposal);
    const source = proposals.get(covered[0] ?? "")?.from ?? raw.covers?.notes?.[0]?.task;
    const from = source ? project.tasks.find((t) => t.id === source) : undefined;
    // A new id follows the task it came from, or else the last task it waits for.
    const after = [...(raw.dependsOn ?? [])].reverse().find((d) => project.tasks.some((t) => t.id === d));
    const id = raw.id && ID_RULE.test(raw.id) && !taken.has(raw.id) ? raw.id : followUpId(from?.id ?? after ?? "T", taken);
    taken.add(id);
    const agent = agents.has(raw.agent) ? raw.agent : (from?.agent ?? project.agents[0]?.id);
    if (!agent) {
      dropped.push(`${raw.title}: the project has no chats`);
      continue;
    }
    tasks.push({
      ...raw,
      id,
      agent,
      prompts: (raw.prompts ?? from?.prompts ?? []).filter((p) => p in project.prompts),
      ...(raw.milestone && project.milestones.some((m) => m.id === raw.milestone)
        ? { milestone: raw.milestone }
        : from?.milestone
          ? { milestone: from.milestone }
          : { milestone: undefined }),
      covers: { proposals: covered, notes: (raw.covers?.notes ?? []).filter((n) => notes.has(`${n.task}#${n.index}`)) },
    });
  }
  const known = new Set([...project.tasks.map((t) => t.id), ...tasks.map((t) => t.id!)]);
  for (const t of tasks) {
    const deps = (t.dependsOn ?? []).filter((d) => known.has(d) && d !== t.id);
    for (const d of t.dependsOn ?? []) if (!known.has(d)) dropped.push(`${t.id}: unknown dependency ${d}`);
    t.dependsOn = [...new Set(deps)];
  }
  // New tasks that wait for other new tasks come after them; a cycle among them is broken.
  const ordered: PlannedTask[] = [];
  const pending = new Map(tasks.map((t) => [t.id!, t]));
  while (pending.size) {
    const ready = [...pending.values()].find((t) => (t.dependsOn ?? []).every((d) => !pending.has(d)));
    const next = ready ?? [...pending.values()][0]!;
    if (!ready) {
      dropped.push(`${next.id}: dependencies on new tasks removed to break a cycle`);
      next.dependsOn = (next.dependsOn ?? []).filter((d) => !pending.has(d));
    }
    ordered.push(next);
    pending.delete(next.id!);
  }
  const links = plan.links
    .filter((l) => project.tasks.some((t) => t.id === l.task))
    .map((l) => ({ task: l.task, proposals: l.proposals.filter(openProposal) }))
    .filter((l) => l.proposals.length > 0);
  const ignore = plan.ignore.filter(openProposal);
  return { plan: { tasks: ordered, links, ignore, ...(plan.summary && { summary: plan.summary }) }, dropped };
}

/** The task a proposal becomes when it is added on its own: after the task it came from, for the chat it names. */
export function taskFromProposal(project: ProjectFile, proposal: Proposal, agentId?: string): PlannedTask {
  const from = project.tasks.find((t) => t.id === proposal.from);
  const agents = new Set(project.agents.map((a) => a.id));
  const agent = [agentId, proposal.agent, from?.agent, project.agents[0]?.id].find((a): a is string => Boolean(a && agents.has(a)));
  if (!agent) throw new HttpError(400, "The project has no chat to give it to.");
  const known = new Set(project.tasks.map((t) => t.id));
  return {
    title: proposal.title,
    agent,
    dependsOn: [...new Set([proposal.from, ...proposal.after])].filter((d) => known.has(d)),
    instructions: [proposal.detail, `Follow-up of ${proposal.from}${from ? ` (${from.title})` : ""}.`].filter(Boolean).join("\n\n"),
    covers: { proposals: [proposal.id] },
  };
}

export interface ApplyResult {
  created: string[];
  linked: string[];
  ignored: string[];
  closedNotes: number;
  errors: string[];
}

/** Writes a checked plan into the project: the new tasks, then what happened to the proposals and notes. */
export async function applyPlan(manager: ProjectManager, key: string, input: IntegrationPlan, source: "ui" | "manager" = "ui"): Promise<ApplyResult> {
  const { project, board } = manager.context(key);
  const { plan, dropped } = checkPlan(project, board, input);
  const result: ApplyResult = { created: [], linked: [], ignored: [], closedNotes: 0, errors: [...dropped] };
  const updates: Array<{ id: string; state: "added" | "ignored"; task?: string }> = [];
  const notes = new Map<string, Array<{ index: number; title: string }>>();
  const issueTitle = (task: string, index: number) => manager.context(key).board.byId.get(task)?.runtime.issues[index]?.title;
  for (const t of plan.tasks) {
    const input: TaskInput = {
      id: t.id!,
      title: t.title,
      agent: t.agent,
      dependsOn: t.dependsOn ?? [],
      prompts: t.prompts ?? [],
      ...(t.instructions && { instructions: t.instructions }),
      ...(t.acceptance && { acceptance: t.acceptance }),
      ...(t.allowedPaths?.length && { allowedPaths: t.allowedPaths }),
      ...(t.milestone && { milestone: t.milestone }),
      ...(t.estimateDays && { estimateDays: t.estimateDays }),
    };
    try {
      await manager.saveTask(key, input, "create");
      result.created.push(t.id!);
      for (const p of t.covers?.proposals ?? []) updates.push({ id: p, state: "added", task: t.id });
      for (const n of t.covers?.notes ?? []) {
        const title = issueTitle(n.task, n.index);
        if (title) notes.set(n.task, [...(notes.get(n.task) ?? []), { index: n.index, title }]);
      }
    } catch (e) {
      result.errors.push(`${t.title}: ${(e as Error).message}`);
    }
  }
  for (const l of plan.links) {
    for (const p of l.proposals) updates.push({ id: p, state: "added", task: l.task });
    result.linked.push(...l.proposals);
  }
  for (const p of plan.ignore) updates.push({ id: p, state: "ignored" });
  result.ignored.push(...plan.ignore);
  if (updates.length) await manager.setProposalStates(key, updates, source);
  for (const [task, list] of notes) {
    try {
      await manager.setIssueStates(key, task, list, "resolved");
      result.closedNotes += list.length;
    } catch (e) {
      result.errors.push(`${task}: ${(e as Error).message}`);
    }
  }
  return result;
}
