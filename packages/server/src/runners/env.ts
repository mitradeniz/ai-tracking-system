import { execFile, spawn } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PROVIDER_INFO, PROVIDERS, type ModelChoice, type ProviderId } from "./providers.ts";

/**
 * Apps started from the Dock or Finder get a minimal PATH, so CLIs installed with Homebrew, npm
 * or a version manager are not found. This builds a PATH from the login shell plus the usual
 * install folders.
 */

let cachedPath: Promise<string> | null = null;

function loginShellPath(): Promise<string> {
  if (process.platform === "win32" || process.env.AITRACK_NO_LOGIN_SHELL) return Promise.resolve("");
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(shell, ["-ilc", 'printf "__AITRACK_PATH__%s__AITRACK_END__" "$PATH"'], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, TERM: "dumb" },
      });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => (out += c));
    const done = () => {
      clearTimeout(timer);
      const m = /__AITRACK_PATH__(.*)__AITRACK_END__/s.exec(out);
      resolve(m?.[1]?.trim() ?? "");
    };
    child.on("error", done);
    child.on("close", done);
  });
}

function nvmBins(home: string): string[] {
  const root = path.join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(root)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(root, v, "bin"));
  } catch {
    return [];
  }
}

function commonDirs(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(appData, "npm"), path.join(local, "Programs"), path.join(home, ".local", "bin")];
  }
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".yarn", "bin"),
    ...nvmBins(home),
    "/usr/bin",
    "/bin",
  ];
}

/** PATH for the agents: the app's own, the login shell's and the usual install folders. */
export function agentPath(): Promise<string> {
  cachedPath ??= loginShellPath().then((shellPath) => {
    const seen = new Set<string>();
    const parts = [...(process.env.PATH ?? "").split(path.delimiter), ...shellPath.split(path.delimiter), ...commonDirs()];
    return parts.filter((p) => p && !seen.has(p) && (seen.add(p), true)).join(path.delimiter);
  });
  return cachedPath;
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds an executable on the given PATH. An absolute or relative path is checked as is. */
export function which(name: string, searchPath: string): string | null {
  if (name.includes("/") || name.includes("\\")) return isExecutable(name) ? path.resolve(name) : null;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export interface DetectedProvider {
  id: ProviderId;
  name: string;
  path: string | null;
  version: string | null;
  /** Models to offer: the CLI's own list when it has one, else aliases. */
  models: ModelChoice[];
  efforts: string[];
  /** Claude Code: whether the installed version has auto mode. */
  autoMode?: boolean;
}

let detectCache: { at: number; value: Promise<DetectedProvider[]> } | null = null;

function output(file: string, args: string[], envPath: string, timeout = 8000, maxBuffer = 4 * 1024 * 1024): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, maxBuffer, encoding: "utf8", env: { ...process.env, PATH: envPath, NO_COLOR: "1" } }, (err, stdout) =>
      resolve(err ? null : (stdout ?? "")),
    );
    // Nothing to read: a CLI that waits for input on stdin goes on at once.
    child.stdin?.end();
  });
}

async function version(file: string, envPath: string): Promise<string | null> {
  const out = await output(file, ["--version"], envPath);
  const line = out?.split("\n").find((l) => l.trim());
  return line ? line.trim().slice(0, 80) : null;
}

/** Whether `claude --help` lists "auto" among the permission modes. */
export function helpHasAutoMode(help: string): boolean {
  return /--permission-mode[^(]{0,200}\(choices:[^)]*["'`]auto["'`]/.test(help);
}

const autoModeCache = new Map<string, { at: number; value: Promise<boolean> }>();

/** Forgets what was found out about auto mode (after an update of the CLI, and in tests). */
export function clearAutoModeCache(): void {
  autoModeCache.clear();
}

/** Whether this Claude Code binary has auto mode. Cached for ten minutes per binary. */
export function claudeHasAutoMode(file: string, envPath: string): Promise<boolean> {
  const hit = autoModeCache.get(file);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const value = output(file, ["--help"], envPath, 10_000).then((out) => Boolean(out && helpHasAutoMode(out)));
  autoModeCache.set(file, { at: Date.now(), value });
  return value;
}

/** `codex debug models`: the model catalog with each model's effort levels. */
export function parseCodexModels(json: string): ModelChoice[] {
  try {
    const data = JSON.parse(json) as { models?: Record<string, unknown>[] };
    return (data.models ?? [])
      .filter((m) => m.visibility === "list" && typeof m.slug === "string")
      .sort((a, b) => Number(a.priority ?? 99) - Number(b.priority ?? 99))
      .map((m) => ({
        id: String(m.slug),
        label: typeof m.display_name === "string" ? m.display_name : String(m.slug),
        efforts: Array.isArray(m.supported_reasoning_levels)
          ? (m.supported_reasoning_levels as { effort?: string }[]).map((l) => String(l.effort ?? "")).filter(Boolean)
          : undefined,
        defaultEffort: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : undefined,
      }));
  } catch {
    return [];
  }
}

/** `copilot help config`: the quoted values listed under `model`. */
export function parseCopilotModels(text: string): ModelChoice[] {
  const block = /`model`:[^\n]*\n((?:[ \t]+- "[^"]+"[^\n]*\n)+)/.exec(text)?.[1];
  if (!block) return [];
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => ({ id: m[1]!, label: m[1]! }));
}

async function modelsOf(id: ProviderId, file: string, envPath: string): Promise<ModelChoice[]> {
  const fallback = PROVIDER_INFO[id].models;
  if (id === "codex") {
    const out = await output(file, ["debug", "models"], envPath, 10_000);
    const list = out ? parseCodexModels(out) : [];
    return list.length ? list : fallback;
  }
  if (id === "copilot") {
    const out = await output(file, ["help", "config"], envPath, 10_000);
    const list = out ? parseCopilotModels(out) : [];
    return list.length ? [...fallback, ...list.filter((m) => m.id !== "auto")] : fallback;
  }
  return fallback;
}

/** Which CLIs are installed. Cached for a minute. */
export function detectProviders(force = false): Promise<DetectedProvider[]> {
  if (!force && detectCache && Date.now() - detectCache.at < 60_000) return detectCache.value;
  const value = (async () => {
    const envPath = await agentPath();
    return Promise.all(
      PROVIDERS.filter((id) => PROVIDER_INFO[id].bin).map(async (id) => {
        const info = PROVIDER_INFO[id];
        const found = which(info.bin!, envPath);
        const canRun = Boolean(found) && process.platform !== "win32";
        const [ver, models, autoMode] = await Promise.all([
          canRun ? version(found!, envPath) : Promise.resolve(null),
          canRun ? modelsOf(id, found!, envPath) : Promise.resolve(info.models),
          canRun && id === "claude" ? claudeHasAutoMode(found!, envPath) : Promise.resolve(undefined),
        ]);
        return { id, name: info.name, path: found, version: ver, models, efforts: info.efforts, ...(autoMode !== undefined && { autoMode }) };
      }),
    );
  })();
  detectCache = { at: Date.now(), value };
  return value;
}
