import { AgentSchema, ID_PATTERN } from "./schema.ts";
import { parseProjectFile } from "./io.ts";

/**
 * Edits of a project file that keep the author's formatting choices: the file is changed as plain
 * JSON (fields the author left out stay out, key order stays), then validated as a whole.
 */

export class EditError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_file" | "invalid_agent" | "not_found" | "has_tasks" | "last_agent" | "invalid_result",
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

const agentsOf = (raw: Json) => raw.agents as Json[];
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
  if (agents.length === 1) throw new EditError("A project needs at least one chat.", "last_agent");
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
