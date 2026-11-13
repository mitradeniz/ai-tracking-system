import { AgentSchema, ID_PATTERN, PromptSchema, TaskSchema } from "./schema.ts";
import { parseProjectFile } from "./io.ts";

/**
 * Edits of a project file that keep the author's formatting choices: the file is changed as plain
 * JSON (fields the author left out stay out, key order stays), then validated as a whole.
 */

export class EditError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_file"
      | "invalid_agent"
      | "invalid_task"
      | "invalid_prompt"
      | "not_found"
      | "exists"
      | "has_tasks"
      | "invalid_result",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface AgentInput {
  id: string;
  name: string;
  tool?: string;
  role?: string;
  capabilities?: string[];
  color?: string;
  maxParallel?: number;
  bootstrapPrompts?: string[];
  quickPrompts?: string[];
}

export interface AgentChange {
  agent: AgentInput;
  /**
   * Chats whose tasks this chat may also take. Every task owned by a listed chat gets this chat in
   * `alsoAgents`; tasks of chats not listed lose it. Leave undefined to keep the current tasks as they are.
   */
  helpsWith?: string[];
}

type Json = Record<string, unknown>;

function parseRaw(text: string): Json {
  const { project, issues } = parseProjectFile(text);
  const errors = issues.filter((i) => i.level === "error");
  if (!project || errors.length > 0) {
    throw new EditError(
      `The project file has errors; fix them before editing: ${errors.map((e) => e.message).join("; ")}`,
      "invalid_file",
    );
  }
  return JSON.parse(text) as Json;
}

function finish(raw: Json): string {
  const text = JSON.stringify(raw, null, 2) + "\n";
  const { project, issues } = parseProjectFile(text);
  const errors = issues.filter((i) => i.level === "error");
  if (!project || errors.length > 0) {
    throw new EditError(`The change would make the file invalid: ${errors.map((e) => e.message).join("; ")}`, "invalid_result");
  }
  return text;
}

const agentsOf = (raw: Json) => (Array.isArray(raw.agents) ? (raw.agents as Json[]) : []);
const tasksOf = (raw: Json) => (Array.isArray(raw.tasks) ? (raw.tasks as Json[]) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function setOrDelete(target: Json, key: string, value: unknown, keepWhen: (v: unknown) => boolean): void {
  if (keepWhen(value)) target[key] = value;
  else delete target[key];
}

/** Adds a chat, or updates the chat with the same id. */
export function upsertAgentInFile(text: string, change: AgentChange): string {
  const raw = parseRaw(text);
  const input = change.agent;
  const id = String(input.id ?? "").trim();
  if (!ID_PATTERN.test(id)) {
    throw new EditError('The id may contain letters, digits, ".", "_" and "-" and must start with a letter or digit.', "invalid_agent");
  }
  const checked = AgentSchema.safeParse({ ...input, id, name: String(input.name ?? "").trim() });
  if (!checked.success) {
    throw new EditError(checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "invalid_agent");
  }
  const prompts = (raw.prompts ?? {}) as Json;
  for (const p of [...(input.bootstrapPrompts ?? []), ...(input.quickPrompts ?? [])]) {
    if (!(p in prompts)) throw new EditError(`Unknown prompt "${p}".`, "invalid_agent");
  }

  if (!Array.isArray(raw.agents)) raw.agents = [];
  const agents = agentsOf(raw);
  let entry = agents.find((a) => a.id === id);
  if (!entry) {
    entry = { id };
    agents.push(entry);
  }
  const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== "";
  // Lists: keep an empty list only when the author had written one.
  const listKeeper = (key: string) => (v: unknown) => Array.isArray(v) && (v.length > 0 || Array.isArray(entry![key]));
  entry.name = checked.data.name;
  setOrDelete(entry, "tool", input.tool?.trim(), nonEmpty);
  setOrDelete(entry, "role", input.role?.trim(), nonEmpty);
  if (input.capabilities !== undefined) setOrDelete(entry, "capabilities", input.capabilities, listKeeper("capabilities"));
  if (input.color !== undefined) setOrDelete(entry, "color", input.color.trim(), nonEmpty);
  if (input.maxParallel !== undefined) setOrDelete(entry, "maxParallel", input.maxParallel, (v) => v !== 1 || "maxParallel" in entry!);
  if (input.bootstrapPrompts !== undefined) setOrDelete(entry, "bootstrapPrompts", input.bootstrapPrompts, listKeeper("bootstrapPrompts"));
  if (input.quickPrompts !== undefined) setOrDelete(entry, "quickPrompts", input.quickPrompts, listKeeper("quickPrompts"));

  if (change.helpsWith !== undefined) {
    const known = new Set(agents.map((a) => String(a.id)));
    const helps = new Set(change.helpsWith.filter((h) => h !== id));
    for (const h of helps) if (!known.has(h)) throw new EditError(`Unknown chat "${h}".`, "not_found");
    for (const task of tasksOf(raw)) {
      const owner = String(task.agent);
      if (owner === id) continue;
      const also = strings(task.alsoAgents);
      const has = also.includes(id);
      if (helps.has(owner) && !has) task.alsoAgents = [...also, id];
      if (!helps.has(owner) && has) {
        const rest = also.filter((a) => a !== id);
        if (rest.length > 0) task.alsoAgents = rest;
        else delete task.alsoAgents;
      }
    }
  }
  return finish(raw);
}

/** Chats whose tasks the given chat may take (it is in their tasks' `alsoAgents`). */
export function helpedChats(tasks: Array<{ agent: string; alsoAgents: string[] }>, agentId: string): string[] {
  const out = new Set<string>();
  for (const t of tasks) if (t.agent !== agentId && t.alsoAgents.includes(agentId)) out.add(t.agent);
  return [...out];
}

/** Removes a chat. Its tasks move to `reassignTo`; it is removed from every `alsoAgents`. */
export function removeAgentFromFile(text: string, agentId: string, reassignTo?: string): string {
  const raw = parseRaw(text);
  const agents = agentsOf(raw);
  const index = agents.findIndex((a) => a.id === agentId);
  if (index < 0) throw new EditError(`Unknown chat "${agentId}".`, "not_found");
  const owned = tasksOf(raw).filter((t) => t.agent === agentId);
  if (owned.length > 0) {
    if (!reassignTo) {
      throw new EditError(`${owned.length} task(s) belong to this chat; choose a chat to move them to.`, "has_tasks", {
        count: owned.length,
      });
    }
    if (reassignTo === agentId || !agents.some((a) => a.id === reassignTo)) {
      throw new EditError(`Unknown chat "${reassignTo}".`, "not_found");
    }
  }
  for (const task of tasksOf(raw)) {
    if (task.agent === agentId) task.agent = reassignTo;
    const also = strings(task.alsoAgents).filter((a) => a !== agentId && a !== task.agent);
    if (also.length > 0) task.alsoAgents = also;
    else delete task.alsoAgents;
  }
  agents.splice(index, 1);
  return finish(raw);
}

/** A free id derived from a display name, e.g. "Codex D" -> "codex-d". */
export function agentIdFromName(name: string, taken: Iterable<string>): string {
  return slugId(name, taken, "chat");
}

/** A free id derived from any title: lower case, ASCII, words joined with "-". */
export function slugId(name: string, taken: Iterable<string>, fallback = "item"): string {
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

/** The next task id in the style the project already uses: T-07 after T-06, API-12 after API-11; T-01 at first. */
export function nextTaskId(ids: Iterable<string>): string {
  const list = [...ids];
  const used = new Set(list);
  let best: { prefix: string; n: number; width: number } | null = null;
  for (const id of list) {
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

// ---------------------------------------------------------------------------------------------
// Tasks

export interface TaskInput {
  id: string;
  title: string;
  agent: string;
  description?: string;
  alsoAgents?: string[];
  dependsOn?: string[];
  prompts?: string[];
  instructions?: string;
  scope?: string;
  allowedPaths?: string[];
  acceptance?: string;
  milestone?: string;
  /** null removes the estimate. */
  estimateDays?: number | null;
  tags?: string[];
}

const TASK_KEY_ORDER = [
  "id",
  "title",
  "description",
  "agent",
  "alsoAgents",
  "dependsOn",
  "prompts",
  "instructions",
  "scope",
  "allowedPaths",
  "acceptance",
  "milestone",
  "estimateDays",
  "tags",
];

const cleanList = (v: string[] | undefined): string[] | undefined =>
  v === undefined ? undefined : [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];

/**
 * Adds a task (`mode: "create"`, appended at the end) or changes one (`mode: "update"`). Only the
 * fields present in `input` are changed; empty values remove optional fields.
 */
export function upsertTaskInFile(text: string, input: TaskInput, mode: "create" | "update"): string {
  const raw = parseRaw(text);
  const id = String(input.id ?? "").trim();
  if (!ID_PATTERN.test(id)) {
    throw new EditError('The task id may contain letters, digits, ".", "_" and "-" and must start with a letter or digit.', "invalid_task");
  }
  const title = String(input.title ?? "").trim();
  if (!title) throw new EditError("Give the task a title.", "invalid_task");
  if (!Array.isArray(raw.tasks)) raw.tasks = [];
  const tasks = raw.tasks as Json[];
  const existing = tasks.find((t) => t.id === id);
  if (mode === "create" && existing) throw new EditError(`A task with the id "${id}" already exists.`, "exists");
  if (mode === "update" && !existing) throw new EditError(`Unknown task "${id}".`, "not_found");

  const agentIds = new Set(agentsOf(raw).map((a) => String(a.id)));
  const taskIds = new Set(tasks.map((t) => String(t.id)));
  const promptIds = new Set(Object.keys((raw.prompts ?? {}) as Json));
  const agent = String(input.agent ?? "").trim();
  if (!agentIds.has(agent)) throw new EditError(agent ? `Unknown chat "${agent}".` : "Choose the chat that takes this task.", "invalid_task");
  const also = cleanList(input.alsoAgents)?.filter((a) => a !== agent);
  for (const a of also ?? []) if (!agentIds.has(a)) throw new EditError(`Unknown chat "${a}".`, "invalid_task");
  const deps = cleanList(input.dependsOn);
  for (const d of deps ?? []) {
    if (d === id) throw new EditError("A task cannot depend on itself.", "invalid_task");
    if (!taskIds.has(d)) throw new EditError(`Unknown task "${d}".`, "invalid_task");
  }
  const prompts = cleanList(input.prompts);
  for (const p of prompts ?? []) if (!promptIds.has(p)) throw new EditError(`Unknown prompt "${p}".`, "invalid_task");
  if (input.estimateDays !== undefined && input.estimateDays !== null) {
    const n = Number(input.estimateDays);
    if (!(n > 0 && n <= 365)) throw new EditError("The estimate must be between 0 and 365 days.", "invalid_task");
  }

  const entry: Json = existing ?? { id };
  const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const listKeeper = (key: string) => (v: unknown) => Array.isArray(v) && (v.length > 0 || (existing !== undefined && Array.isArray(existing[key])));
  entry.title = title;
  entry.agent = agent;
  for (const key of ["description", "instructions", "scope", "acceptance", "milestone"] as const) {
    if (input[key] !== undefined) setOrDelete(entry, key, String(input[key]).trim(), nonEmpty);
  }
  if (also !== undefined) setOrDelete(entry, "alsoAgents", also, listKeeper("alsoAgents"));
  else if (Array.isArray(entry.alsoAgents)) {
    // The owner changed: it cannot also be a helper.
    const rest = strings(entry.alsoAgents).filter((a) => a !== agent);
    setOrDelete(entry, "alsoAgents", rest, listKeeper("alsoAgents"));
  }
  if (deps !== undefined) setOrDelete(entry, "dependsOn", deps, listKeeper("dependsOn"));
  if (prompts !== undefined) setOrDelete(entry, "prompts", prompts, listKeeper("prompts"));
  if (input.allowedPaths !== undefined) setOrDelete(entry, "allowedPaths", cleanList(input.allowedPaths), listKeeper("allowedPaths"));
  if (input.tags !== undefined) setOrDelete(entry, "tags", cleanList(input.tags), listKeeper("tags"));
  if (input.estimateDays !== undefined) {
    setOrDelete(entry, "estimateDays", input.estimateDays === null ? undefined : Number(input.estimateDays), (v) => typeof v === "number");
  }

  const checked = TaskSchema.safeParse(entry);
  if (!checked.success) {
    throw new EditError(checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "invalid_task");
  }
  if (!existing) {
    // New tasks get the usual key order.
    const ordered: Json = {};
    for (const key of TASK_KEY_ORDER) if (key in entry) ordered[key] = entry[key];
    tasks.push(ordered);
  }
  return finish(raw);
}

/**
 * Removes a task. Tasks that depended on it now depend on what it depended on, so the order of
 * the remaining work stays the same.
 */
export function removeTaskFromFile(text: string, taskId: string): string {
  const raw = parseRaw(text);
  const tasks = tasksOf(raw);
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index < 0) throw new EditError(`Unknown task "${taskId}".`, "not_found");
  const inherited = strings(tasks[index]!.dependsOn);
  tasks.splice(index, 1);
  for (const task of tasks) {
    const deps = strings(task.dependsOn);
    if (!deps.includes(taskId)) continue;
    const next = [...new Set(deps.flatMap((d) => (d === taskId ? inherited : [d])))].filter((d) => d !== task.id);
    if (next.length > 0) task.dependsOn = next;
    else delete task.dependsOn;
  }
  return finish(raw);
}

// ---------------------------------------------------------------------------------------------
// Prompts

export interface PromptInput {
  id: string;
  title?: string;
  body: string;
}

/** Adds a prompt (`mode: "create"`) or changes its title and text (`mode: "update"`). */
export function upsertPromptInFile(text: string, input: PromptInput, mode: "create" | "update"): string {
  const raw = parseRaw(text);
  const id = String(input.id ?? "").trim();
  if (!ID_PATTERN.test(id)) {
    throw new EditError('The prompt id may contain letters, digits, ".", "_" and "-" and must start with a letter or digit.', "invalid_prompt");
  }
  const body = String(input.body ?? "");
  if (!body.trim()) throw new EditError("The prompt text is empty.", "invalid_prompt");
  if (!raw.prompts || typeof raw.prompts !== "object" || Array.isArray(raw.prompts)) raw.prompts = {};
  const prompts = raw.prompts as Json;
  const existing = prompts[id] as Json | undefined;
  if (mode === "create" && existing) throw new EditError(`A prompt with the id "${id}" already exists.`, "exists");
  if (mode === "update" && !existing) throw new EditError(`Unknown prompt "${id}".`, "not_found");
  const entry: Json = existing ?? {};
  const title = input.title?.trim();
  if (title) entry.title = title;
  else delete entry.title;
  entry.body = body;
  if (!existing) prompts[id] = title ? { title, body } : { body };
  const checked = PromptSchema.safeParse(prompts[id]);
  if (!checked.success) throw new EditError(checked.error.issues.map((i) => i.message).join("; "), "invalid_prompt");
  return finish(raw);
}

/** Where a prompt is used: tasks and chats (session and quick prompts). */
export function promptUsage(
  project: { tasks: Array<{ id: string; prompts: string[] }>; agents: Array<{ id: string; bootstrapPrompts: string[]; quickPrompts: string[] }> },
  promptId: string,
): { tasks: string[]; agents: string[] } {
  return {
    tasks: project.tasks.filter((t) => t.prompts.includes(promptId)).map((t) => t.id),
    agents: project.agents.filter((a) => a.bootstrapPrompts.includes(promptId) || a.quickPrompts.includes(promptId)).map((a) => a.id),
  };
}

/** Removes a prompt and every reference to it from tasks and chats. */
export function removePromptFromFile(text: string, promptId: string): string {
  const raw = parseRaw(text);
  const prompts = (raw.prompts ?? {}) as Json;
  if (!(promptId in prompts)) throw new EditError(`Unknown prompt "${promptId}".`, "not_found");
  delete prompts[promptId];
  const drop = (target: Json, key: string) => {
    if (!Array.isArray(target[key])) return;
    const rest = strings(target[key]).filter((p) => p !== promptId);
    if (rest.length > 0 || (target[key] as unknown[]).length === 0) target[key] = rest;
    else delete target[key];
  };
  for (const task of tasksOf(raw)) drop(task, "prompts");
  for (const agent of agentsOf(raw)) {
    drop(agent, "bootstrapPrompts");
    drop(agent, "quickPrompts");
  }
  return finish(raw);
}

// ---------------------------------------------------------------------------------------------
// Project

export interface ProjectInfoInput {
  name?: string;
  description?: string;
  language?: "en" | "tr" | null;
  requireApproval?: boolean;
  /** The code folder, relative to the project file's folder; null or "" removes it. */
  repoPath?: string | null;
}

/** Changes the project's name, description, prompt language, approval setting or code folder. */
export function updateProjectInfoInFile(text: string, input: ProjectInfoInput): string {
  const raw = parseRaw(text);
  const project = raw.project as Json;
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new EditError("Give the project a name.", "invalid_file");
    project.name = name;
  }
  if (input.description !== undefined) setOrDelete(project, "description", input.description.trim(), (v) => typeof v === "string" && v !== "");
  if (input.repoPath !== undefined && input.repoPath !== null) {
    const repoPath = input.repoPath.trim();
    if (repoPath.length > 1000 || /[\u0000-\u001f]/.test(repoPath)) throw new EditError("That is not a folder path.", "invalid_file");
  }
  if (input.language !== undefined || input.requireApproval !== undefined || input.repoPath !== undefined) {
    if (!raw.settings || typeof raw.settings !== "object") raw.settings = {};
    const settings = raw.settings as Json;
    if (input.language !== undefined) setOrDelete(settings, "language", input.language ?? undefined, (v) => v === "en" || v === "tr");
    if (input.requireApproval !== undefined) settings.requireApproval = input.requireApproval;
    if (input.repoPath !== undefined) setOrDelete(settings, "repoPath", input.repoPath?.trim() || undefined, (v) => typeof v === "string" && v !== "");
  }
  return finish(raw);
}
