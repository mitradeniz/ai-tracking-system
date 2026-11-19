import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../store.ts";
import { DEFAULT_RUNNER, PROVIDERS, type Access, type ChatRunner, type SessionMode } from "./providers.ts";

/**
 * Run settings live in the app's data folder (~/.aitrack/runners.json), never in the project
 * file: a shared or downloaded `.aitrack` file must not be able to make this computer run commands.
 */

/** An AI CLI that runs the project while the person is away: answers chats, keeps the plan up to date. */
export interface ManagerSettings {
  enabled: boolean;
  provider: "claude" | "codex" | "antigravity" | "gemini" | "copilot" | "cursor" | "deepseek";
  model?: string;
  effort?: string;
  /** Program path when the CLI is not on PATH. */
  binary?: string;
  /** Also let it continue tasks the person stopped. */
  resumeStopped: boolean;
  /** Also let it approve finished tasks that wait in review (projects with requireApproval). */
  approveDone: boolean;
  /**
   * Full automation: it reviews finished work itself (reads the change and its checks), sends back
   * what is not done, and approves work whose remaining gaps do not stop others, listing what the
   * person may want to look at among its approvals. Implies approving.
   */
  fullAuto: boolean;
  /** Let it have a reviewed task's own chat merge that task's PRs into main when their checks are green. */
  mergeGreen: boolean;
  /**
   * Full authority: it decides what the person would, beyond answering chats. It grants the
   * permissions chats need (full access too), moves tasks to other chats, takes duplicate tasks
   * nobody started out of the plan, has chats merge the green PRs a task needs, and handles what it
   * would otherwise leave for the person. Implies full automation and merging. Payments,
   * credentials and accounts, legal terms, deleting data and publishing stay with the person.
   */
  fullAuthority: boolean;
}

export const DEFAULT_MANAGER: ManagerSettings = {
  enabled: false,
  provider: "claude",
  resumeStopped: true,
  approveDone: false,
  fullAuto: false,
  mergeGreen: false,
  fullAuthority: false,
};

/** Whether the manager may approve finished tasks with these settings. */
export const approves = (s: ManagerSettings): boolean => s.approveDone || s.fullAuto || s.fullAuthority;
/** Whether it reviews finished work itself (and may send it back). */
export const reviewsWork = (s: ManagerSettings): boolean => s.fullAuto || s.fullAuthority;
/** Whether it may have chats merge green PRs into main. */
export const mergesGreen = (s: ManagerSettings): boolean => (s.mergeGreen || s.fullAuthority) && approves(s);

export interface ProjectRunners {
  /** Give the next ready task to a chat as soon as it is free. */
  autoDispatch: boolean;
  /** At most this many runs at once in this project. */
  maxConcurrent: number;
  chats: Record<string, ChatRunner>;
  manager: ManagerSettings;
  /**
   * The session prompt each chat's conversation has read (by chat: its session id and a hash of
   * the prompt), so a changed prompt is given again to a conversation that goes on.
   */
  sessionPrompts?: Record<string, { session: string; hash: string }>;
  /** The session prompt each conversation has read (by session id: a hash of the prompt). */
  promptSeen?: Record<string, string>;
  /**
   * Saving mode: each task gets a conversation of its own (answers and resumes go on in it), so a
   * chat does not carry every earlier task's context into each call; what chats checked is passed on.
   */
  saving?: boolean;
  /** Each chat's conversation for each task (by chat, then task): replies and resumes go on there. */
  taskSessions?: Record<string, Record<string, string>>;
  /** What CLIs report for a whole conversation (Codex tokens, Claude Code cost) at its last run, by session id. */
  sessionUsage?: Record<string, SessionUsage>;
  /** What chats checked about the environment and the project; newest last. */
  facts?: Fact[];
  /** Folders every chat of the project may use besides its working folder, one absolute path per line. */
  extraDirs?: string;
  /**
   * Tasks put first (by the manager or the person): automatic dispatch gives these to a free chat
   * that can take them before any other ready task, in this order. A task leaves the list when it starts.
   */
  firstUp?: string[];
}

/** Counters a CLI reports for a whole conversation, not for one run. */
export interface SessionUsage {
  input?: number;
  cached?: number;
  output?: number;
  costUsd?: number;
}

/** Something a chat checked, so others need not check it again. */
export interface Fact {
  text: string;
  task?: string;
  agent?: string;
  at: string;
}

/** Kept at most: the newest win. */
const MAX_FACTS = 40;
const MAX_TASK_SESSIONS = 200;
const MAX_SESSION_RECORDS = 300;
export const MAX_FIRST_UP = 30;

/** The same fact in other words: letters and digits only, lower case. */
const factKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Keeps the newest entries of a record built by insertion. */
function keepLast<T>(record: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(record);
  return entries.length > max ? Object.fromEntries(entries.slice(entries.length - max)) : record;
}

interface RunnerFile {
  version: 1;
  projects: Record<string, ProjectRunners>;
}

export const DEFAULT_PROJECT_RUNNERS: ProjectRunners = { autoDispatch: false, maxConcurrent: 2, chats: {}, manager: { ...DEFAULT_MANAGER } };

/** Validates manager settings coming from the UI or from disk. */
export function normalizeManager(input: unknown, base: ManagerSettings = DEFAULT_MANAGER): ManagerSettings {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const provider =
    (["claude", "codex", "antigravity", "gemini", "copilot", "cursor", "deepseek"] as const).find((p) => p === o.provider) ?? base.provider;
  const pick = (k: "model" | "effort" | "binary", max: number) => (k in o ? str(o[k], max) : base[k]);
  const model = pick("model", 200);
  if (model && !modelName(model)) throw new Error(`"${model}" is not a model name the CLI understands.`);
  const effort = pick("effort", 20);
  if (effort && !/^[a-z]+$/.test(effort)) throw new Error(`Unknown effort level "${effort}".`);
  const binary = pick("binary", 1000);
  if (binary && !path.isAbsolute(binary)) throw new Error("The program path must be an absolute path.");
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
    provider,
    model,
    effort,
    binary,
    resumeStopped: typeof o.resumeStopped === "boolean" ? o.resumeStopped : base.resumeStopped,
    approveDone: typeof o.approveDone === "boolean" ? o.approveDone : base.approveDone,
    fullAuto: typeof o.fullAuto === "boolean" ? o.fullAuto : (base.fullAuto ?? false),
    mergeGreen: typeof o.mergeGreen === "boolean" ? o.mergeGreen : (base.mergeGreen ?? false),
    fullAuthority: typeof o.fullAuthority === "boolean" ? o.fullAuthority : (base.fullAuthority ?? false),
  };
}

/** A model id a CLI takes: no spaces, except a name like Antigravity's "Orchestrator (Carbon)". */
const modelName = (m: string) => /^[\w.:@/[\]-]+$/.test(m) || /^[A-Za-z][\w .-]*\([\w .-]+\)$/.test(m);

const str = (v: unknown, max = 4000): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
};

/** Folders given one per line. */
export function splitDirs(text: string | undefined): string[] {
  return [...new Set((text ?? "").split(/\r?\n/).map((d) => d.trim().replace(/(.)\/+$/, "$1")).filter(Boolean))];
}

/** Validates a chat's run settings coming from the UI or from disk. */
export function normalizeRunner(input: unknown, base: ChatRunner = DEFAULT_RUNNER): ChatRunner {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const provider = o.provider === "manual" || PROVIDERS.includes(o.provider as never) ? (o.provider as ChatRunner["provider"]) : base.provider;
  const access: Access = o.access === "readonly" || o.access === "edit" || o.access === "full" ? o.access : base.access;
  const session: SessionMode = o.session === "keep" || o.session === "perTask" ? o.session : base.session;
  const pick = (key: keyof ChatRunner, max?: number) => (key in o ? str(o[key], max) : (base[key] as string | undefined));
  const sessionId = pick("sessionId", 200);
  if (sessionId && !/^[\w.:-]+$/.test(sessionId)) throw new Error("A session id may contain letters, digits, '.', ':', '_' and '-'.");
  const workdir = pick("workdir", 1000);
  if (workdir && !path.isAbsolute(workdir)) throw new Error("The working folder must be an absolute path.");
  const model = pick("model", 200);
  if (model && !modelName(model)) {
    throw new Error(`"${model}" is not a model name the CLI understands. Pick one from the list, or type its id without spaces (for example "opus" or "gpt-6-sol").`);
  }
  const effort = pick("effort", 20);
  if (effort && !/^[a-z]+$/.test(effort)) throw new Error(`Unknown effort level "${effort}".`);
  const binary = pick("binary", 1000);
  if (binary && !path.isAbsolute(binary)) throw new Error("The program path must be an absolute path.");
  const extraDirs = pick("extraDirs", 4000);
  for (const dir of splitDirs(extraDirs)) {
    if (!path.isAbsolute(dir)) throw new Error(`"${dir}" is not an absolute path. Give each folder as a full path, one per line.`);
  }
  return {
    provider,
    workdir,
    model,
    effort,
    access,
    session,
    sessionId,
    // Whose conversation it is: kept while the id stays, the CLI's own when an id is given by hand.
    ...(sessionId && {
      sessionProvider:
        sessionId === base.sessionId && base.sessionProvider
          ? base.sessionProvider
          : PROVIDERS.includes(o.sessionProvider as never)
            ? (o.sessionProvider as ChatRunner["sessionProvider"])
            : sessionId !== base.sessionId && provider !== "manual"
              ? provider
              : base.sessionProvider,
    }),
    unattended: typeof o.unattended === "boolean" ? o.unattended : base.unattended,
    network: typeof o.network === "boolean" ? o.network : base.network,
    workCommands: typeof o.workCommands === "boolean" ? o.workCommands : base.workCommands,
    autoPermissions: typeof o.autoPermissions === "boolean" ? o.autoPermissions : base.autoPermissions,
    terminal: typeof o.terminal === "boolean" ? o.terminal || undefined : base.terminal,
    terminalApp: terminalApp(pick("terminalApp", 80)),
    allowedTools: pick("allowedTools", 2000),
    extraDirs: splitDirs(extraDirs).join("\n") || undefined,
    extraArgs: pick("extraArgs", 2000),
    binary,
    command: pick("command", 4000),
  };
}

/** The app a Terminal run opens in: a name such as "Terminal" or "iTerm", no path. */
function terminalApp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^[\w .+-]{1,80}$/.test(value)) throw new Error(`"${value}" is not the name of an app. Give the terminal app's name, for example "Terminal" or "iTerm".`);
  return value;
}

function normalizeProject(input: unknown): ProjectRunners {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const chats: Record<string, ChatRunner> = {};
  const raw = (o.chats && typeof o.chats === "object" ? o.chats : {}) as Record<string, unknown>;
  for (const [id, cfg] of Object.entries(raw)) {
    try {
      chats[id] = normalizeRunner(cfg);
    } catch {
      try {
        // Keep the chat's runner; drop a model or effort written by an older version that the CLI would refuse.
        chats[id] = normalizeRunner({ ...(cfg as object), model: undefined, effort: undefined });
      } catch {
        // A broken entry is dropped; the chat falls back to manual.
      }
    }
  }
  const max = Number(o.maxConcurrent);
  let manager: ManagerSettings;
  try {
    manager = normalizeManager(o.manager);
  } catch {
    manager = { ...DEFAULT_MANAGER };
  }
  const sessionPrompts: Record<string, { session: string; hash: string }> = {};
  const seen = (o.sessionPrompts && typeof o.sessionPrompts === "object" ? o.sessionPrompts : {}) as Record<string, unknown>;
  for (const [id, v] of Object.entries(seen)) {
    const e = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    if (typeof e.session === "string" && typeof e.hash === "string") sessionPrompts[id] = { session: e.session, hash: e.hash };
  }
  const strings = (v: unknown): Record<string, string> =>
    Object.fromEntries(Object.entries(v && typeof v === "object" ? (v as Record<string, unknown>) : {}).filter((e): e is [string, string] => typeof e[1] === "string"));
  const promptSeen = strings(o.promptSeen);
  const taskSessions: Record<string, Record<string, string>> = {};
  for (const [agent, v] of Object.entries(o.taskSessions && typeof o.taskSessions === "object" ? (o.taskSessions as Record<string, unknown>) : {})) {
    const map = strings(v);
    if (Object.keys(map).length) taskSessions[agent] = map;
  }
  const sessionUsage: Record<string, SessionUsage> = {};
  for (const [id, v] of Object.entries(o.sessionUsage && typeof o.sessionUsage === "object" ? (o.sessionUsage as Record<string, unknown>) : {})) {
    const u = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const pick = (k: keyof SessionUsage) => (typeof u[k] === "number" && Number.isFinite(u[k]) ? { [k]: u[k] as number } : {});
    sessionUsage[id] = { ...pick("input"), ...pick("cached"), ...pick("output"), ...pick("costUsd") };
  }
  const facts = (Array.isArray(o.facts) ? o.facts : [])
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object" && typeof (f as Record<string, unknown>).text === "string")
    .map((f) => ({
      text: String(f.text).slice(0, 300),
      ...(typeof f.task === "string" && { task: f.task }),
      ...(typeof f.agent === "string" && { agent: f.agent }),
      at: typeof f.at === "string" ? f.at : new Date(0).toISOString(),
    }))
    .slice(-MAX_FACTS);
  const firstUp = [...new Set((Array.isArray(o.firstUp) ? o.firstUp : []).filter((x): x is string => typeof x === "string" && x.trim() !== ""))].slice(0, MAX_FIRST_UP);
  return {
    autoDispatch: o.autoDispatch === true,
    maxConcurrent: Number.isInteger(max) && max >= 1 && max <= 10 ? max : DEFAULT_PROJECT_RUNNERS.maxConcurrent,
    chats,
    manager,
    ...(Object.keys(sessionPrompts).length && { sessionPrompts }),
    ...(Object.keys(promptSeen).length && { promptSeen }),
    ...(o.saving === true && { saving: true }),
    ...(Object.keys(taskSessions).length && { taskSessions }),
    ...(Object.keys(sessionUsage).length && { sessionUsage }),
    ...(facts.length && { facts }),
    ...(typeof o.extraDirs === "string" && splitDirs(o.extraDirs).every((d) => path.isAbsolute(d)) && splitDirs(o.extraDirs).length && { extraDirs: splitDirs(o.extraDirs).join("\n") }),
    ...(firstUp.length && { firstUp }),
  };
}

export class RunnerStore {
  private data: RunnerFile = { version: 1, projects: {} };

  constructor(readonly dataDir: string) {}

  get file(): string {
    return path.join(this.dataDir, "runners.json");
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as { projects?: Record<string, unknown> };
      const projects: Record<string, ProjectRunners> = {};
      for (const [key, value] of Object.entries(raw.projects ?? {})) projects[key] = normalizeProject(value);
      this.data = { version: 1, projects };
    } catch {
      this.data = { version: 1, projects: {} };
    }
  }

  project(key: string): ProjectRunners {
    const p = this.data.projects[key];
    return p ? { ...p, chats: { ...p.chats }, manager: { ...p.manager } } : { ...DEFAULT_PROJECT_RUNNERS, chats: {}, manager: { ...DEFAULT_MANAGER } };
  }

  chat(key: string, agentId: string): ChatRunner {
    return this.data.projects[key]?.chats[agentId] ?? { ...DEFAULT_RUNNER };
  }

  async setChat(key: string, agentId: string, runner: ChatRunner): Promise<void> {
    const p = (this.data.projects[key] ??= { ...DEFAULT_PROJECT_RUNNERS, chats: {}, manager: { ...DEFAULT_MANAGER } });
    p.chats[agentId] = runner;
    await this.save();
  }

  async setManager(key: string, patch: unknown): Promise<ManagerSettings> {
    const p = (this.data.projects[key] ??= { ...DEFAULT_PROJECT_RUNNERS, chats: {}, manager: { ...DEFAULT_MANAGER } });
    p.manager = normalizeManager(patch, p.manager);
    await this.save();
    return { ...p.manager };
  }

  async setProject(key: string, patch: { autoDispatch?: boolean; maxConcurrent?: number; saving?: boolean; extraDirs?: string }): Promise<ProjectRunners> {
    if (typeof patch.extraDirs === "string") {
      for (const dir of splitDirs(patch.extraDirs)) {
        if (!path.isAbsolute(dir)) throw new Error(`"${dir}" is not an absolute path. Give each folder as a full path, one per line.`);
      }
    }
    const p = this.entry(key);
    if (typeof patch.autoDispatch === "boolean") p.autoDispatch = patch.autoDispatch;
    if (typeof patch.saving === "boolean") p.saving = patch.saving;
    if (typeof patch.extraDirs === "string") {
      const dirs = splitDirs(patch.extraDirs);
      if (dirs.length) p.extraDirs = dirs.join("\n");
      else delete p.extraDirs;
    }
    if (typeof patch.maxConcurrent === "number" && Number.isInteger(patch.maxConcurrent)) {
      p.maxConcurrent = Math.min(10, Math.max(1, patch.maxConcurrent));
    }
    await this.save();
    return this.project(key);
  }

  private entry(key: string): ProjectRunners {
    return (this.data.projects[key] ??= { ...DEFAULT_PROJECT_RUNNERS, chats: {}, manager: { ...DEFAULT_MANAGER } });
  }

  /** The session prompt a chat's conversation has read, if the tracker knows it. */
  sessionPrompt(key: string, agentId: string, session?: string): { session: string; hash: string } | undefined {
    const p = this.data.projects[key];
    const hash = session ? p?.promptSeen?.[session] : undefined;
    if (session && hash) return { session, hash };
    return p?.sessionPrompts?.[agentId];
  }

  async setSessionPrompt(key: string, agentId: string, session: string, hash: string): Promise<void> {
    const p = this.entry(key);
    const cur = p.sessionPrompts?.[agentId];
    if (cur && cur.session === session && cur.hash === hash && p.promptSeen?.[session] === hash) return;
    p.sessionPrompts = { ...p.sessionPrompts, [agentId]: { session, hash } };
    const seen = { ...p.promptSeen };
    delete seen[session];
    seen[session] = hash;
    p.promptSeen = keepLast(seen, MAX_SESSION_RECORDS);
    await this.save();
  }

  /** The conversation a chat had for a task, if the tracker knows it. */
  taskSession(key: string, agentId: string, task: string): string | undefined {
    return this.data.projects[key]?.taskSessions?.[agentId]?.[task];
  }

  async setTaskSession(key: string, agentId: string, task: string, session: string): Promise<void> {
    const p = this.entry(key);
    const mine = { ...p.taskSessions?.[agentId] };
    if (mine[task] === session) return;
    delete mine[task];
    mine[task] = session;
    p.taskSessions = { ...p.taskSessions, [agentId]: keepLast(mine, MAX_TASK_SESSIONS) };
    await this.save();
  }

  /** Forgets every conversation the tracker knew for a chat (it now runs with another CLI). */
  async forgetChatSessions(key: string, agentId: string): Promise<void> {
    const p = this.entry(key);
    if (!p.taskSessions?.[agentId] && !p.sessionPrompts?.[agentId]) return;
    if (p.taskSessions) {
      const rest = { ...p.taskSessions };
      delete rest[agentId];
      p.taskSessions = rest;
    }
    if (p.sessionPrompts) {
      const rest = { ...p.sessionPrompts };
      delete rest[agentId];
      p.sessionPrompts = rest;
    }
    await this.save();
  }

  async forgetTaskSession(key: string, agentId: string, task: string): Promise<void> {
    const p = this.entry(key);
    const mine = p.taskSessions?.[agentId];
    if (!mine || !(task in mine)) return;
    const rest = { ...mine };
    delete rest[task];
    p.taskSessions = { ...p.taskSessions, [agentId]: rest };
    await this.save();
  }

  /** Tasks put first, in order. */
  firstUp(key: string): string[] {
    return [...(this.data.projects[key]?.firstUp ?? [])];
  }

  async setFirstUp(key: string, ids: string[]): Promise<string[]> {
    const list = [...new Set(ids.map((x) => x.trim()).filter(Boolean))].slice(0, MAX_FIRST_UP);
    const p = this.entry(key);
    const before = p.firstUp ?? [];
    if (before.length === list.length && before.every((x, i) => x === list[i])) return list;
    if (list.length) p.firstUp = list;
    else delete p.firstUp;
    await this.save();
    return list;
  }

  /** What the CLI last reported for a whole conversation. */
  sessionUsage(key: string, session: string): SessionUsage | undefined {
    return this.data.projects[key]?.sessionUsage?.[session];
  }

  async setSessionUsage(key: string, session: string, usage: SessionUsage): Promise<void> {
    if (!Object.keys(usage).length) return;
    const p = this.entry(key);
    const all = { ...p.sessionUsage };
    delete all[session];
    all[session] = usage;
    p.sessionUsage = keepLast(all, MAX_SESSION_RECORDS);
    await this.save();
  }

  facts(key: string): Fact[] {
    return [...(this.data.projects[key]?.facts ?? [])];
  }

  /** Adds what a chat checked; the same fact again moves to the end with the new date. Returns how many were new. */
  async addFacts(key: string, texts: string[], from: { task?: string; agent?: string }): Promise<number> {
    const clean = texts.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean);
    if (!clean.length) return 0;
    const p = this.entry(key);
    const list = [...(p.facts ?? [])];
    let added = 0;
    for (const text of clean) {
      const k = factKey(text);
      const i = list.findIndex((f) => factKey(f.text) === k);
      if (i >= 0) list.splice(i, 1);
      else added += 1;
      list.push({ text, ...(from.task && { task: from.task }), ...(from.agent && { agent: from.agent }), at: new Date().toISOString() });
    }
    p.facts = list.slice(-MAX_FACTS);
    await this.save();
    return added;
  }

  /** Removes facts (by their text), or all of them. */
  async removeFacts(key: string, texts: string[] | "all"): Promise<Fact[]> {
    const p = this.entry(key);
    if (texts === "all") p.facts = [];
    else {
      const gone = new Set(texts.map(factKey));
      p.facts = (p.facts ?? []).filter((f) => !gone.has(factKey(f.text)));
    }
    await this.save();
    return this.facts(key);
  }

  async setSession(key: string, agentId: string, sessionId: string | undefined): Promise<void> {
    const current = this.chat(key, agentId);
    if (current.sessionId === sessionId) return;
    const { sessionProvider: _old, ...rest } = current;
    await this.setChat(key, agentId, {
      ...rest,
      sessionId,
      ...(sessionId && current.provider !== "manual" && current.provider !== "custom" && { sessionProvider: current.provider }),
    });
  }

  private async save(): Promise<void> {
    await writeFileAtomic(this.file, JSON.stringify(this.data, null, 2) + "\n");
    await chmod(this.file, 0o600).catch(() => undefined);
  }
}
