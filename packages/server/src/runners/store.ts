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
  provider: "claude" | "codex" | "gemini" | "copilot";
  model?: string;
  effort?: string;
  /** Program path when the CLI is not on PATH. */
  binary?: string;
  /** At most this many manager runs an hour. */
  maxRunsPerHour: number;
  /** Also let it continue tasks the person stopped. */
  resumeStopped: boolean;
  /** Also let it approve finished tasks that wait in review (projects with requireApproval). */
  approveDone: boolean;
}

export const DEFAULT_MANAGER: ManagerSettings = { enabled: false, provider: "claude", maxRunsPerHour: 6, resumeStopped: true, approveDone: false };

export interface ProjectRunners {
  /** Give the next ready task to a chat as soon as it is free. */
  autoDispatch: boolean;
  /** At most this many runs at once in this project. */
  maxConcurrent: number;
  chats: Record<string, ChatRunner>;
  manager: ManagerSettings;
}

interface RunnerFile {
  version: 1;
  projects: Record<string, ProjectRunners>;
}

export const DEFAULT_PROJECT_RUNNERS: ProjectRunners = { autoDispatch: false, maxConcurrent: 2, chats: {}, manager: { ...DEFAULT_MANAGER } };

/** Validates manager settings coming from the UI or from disk. */
export function normalizeManager(input: unknown, base: ManagerSettings = DEFAULT_MANAGER): ManagerSettings {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const provider = o.provider === "claude" || o.provider === "codex" || o.provider === "gemini" || o.provider === "copilot" ? o.provider : base.provider;
  const pick = (k: "model" | "effort" | "binary", max: number) => (k in o ? str(o[k], max) : base[k]);
  const model = pick("model", 200);
  if (model && !/^[\w.:@/[\]-]+$/.test(model)) throw new Error(`"${model}" is not a model name the CLI understands.`);
  const effort = pick("effort", 20);
  if (effort && !/^[a-z]+$/.test(effort)) throw new Error(`Unknown effort level "${effort}".`);
  const binary = pick("binary", 1000);
  if (binary && !path.isAbsolute(binary)) throw new Error("The program path must be an absolute path.");
  const max = Number(o.maxRunsPerHour);
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
    provider,
    model,
    effort,
    binary,
    maxRunsPerHour: Number.isInteger(max) && max >= 1 && max <= 60 ? max : base.maxRunsPerHour,
    resumeStopped: typeof o.resumeStopped === "boolean" ? o.resumeStopped : base.resumeStopped,
    approveDone: typeof o.approveDone === "boolean" ? o.approveDone : base.approveDone,
  };
}

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
  if (model && !/^[\w.:@/[\]-]+$/.test(model)) {
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
    unattended: typeof o.unattended === "boolean" ? o.unattended : base.unattended,
    network: typeof o.network === "boolean" ? o.network : base.network,
    workCommands: typeof o.workCommands === "boolean" ? o.workCommands : base.workCommands,
    autoPermissions: typeof o.autoPermissions === "boolean" ? o.autoPermissions : base.autoPermissions,
    allowedTools: pick("allowedTools", 2000),
    extraDirs: splitDirs(extraDirs).join("\n") || undefined,
    extraArgs: pick("extraArgs", 2000),
    binary,
    command: pick("command", 4000),
  };
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
  return {
    autoDispatch: o.autoDispatch === true,
    maxConcurrent: Number.isInteger(max) && max >= 1 && max <= 10 ? max : DEFAULT_PROJECT_RUNNERS.maxConcurrent,
    chats,
    manager,
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

  async setProject(key: string, patch: { autoDispatch?: boolean; maxConcurrent?: number }): Promise<ProjectRunners> {
    const p = (this.data.projects[key] ??= { ...DEFAULT_PROJECT_RUNNERS, chats: {}, manager: { ...DEFAULT_MANAGER } });
    if (typeof patch.autoDispatch === "boolean") p.autoDispatch = patch.autoDispatch;
    if (typeof patch.maxConcurrent === "number" && Number.isInteger(patch.maxConcurrent)) {
      p.maxConcurrent = Math.min(10, Math.max(1, patch.maxConcurrent));
    }
    await this.save();
    return this.project(key);
  }

  async setSession(key: string, agentId: string, sessionId: string | undefined): Promise<void> {
    const current = this.chat(key, agentId);
    if (current.sessionId === sessionId) return;
    await this.setChat(key, agentId, { ...current, sessionId });
  }

  private async save(): Promise<void> {
    await writeFileAtomic(this.file, JSON.stringify(this.data, null, 2) + "\n");
    await chmod(this.file, 0o600).catch(() => undefined);
  }
}
