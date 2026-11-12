import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * In-app updates for an app built from a git clone (the macOS installer). Checking runs `git fetch`
 * in that clone and compares with the branch it follows; updating runs `update-macos.command`
 * unattended, which pulls, rebuilds, replaces the app in Applications and opens the new version.
 */

export interface Commit {
  sha: string;
  date: string;
  subject: string;
}

export type UpdateReason =
  | "not-mac"
  | "dev"
  | "no-repo"
  | "git-missing"
  | "fetch-failed"
  | "local-changes"
  | "no-upstream"
  | "diverged";

export interface UpdateInfo {
  state: "current" | "available" | "blocked" | "unsupported" | "error";
  reason?: UpdateReason;
  detail?: string;
  repo?: string;
  branch?: string;
  upstream?: string;
  current?: Commit;
  /** Commits on GitHub that this copy does not have yet. */
  behind: number;
  /** Local commits that are not on GitHub. */
  ahead: number;
  commits: Commit[];
  checkedAt: string;
}

export interface UpdateProgress {
  state: "idle" | "running" | "done" | "failed" | "current";
  message?: string;
  at?: string;
  from?: string;
  to?: string;
  /** Last lines of the updater's output. */
  log: string[];
}

const GIT_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"];

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [...GIT_PATH, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function git(repo: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { env: env(), timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? "").trim() }));
      else resolve(String(stdout ?? "").replace(/\s+$/, ""));
    });
  });
}

/** The clone the app was built from: the repository in development, else the one the installer recorded. */
export function findRepo(dataDir: string, devRepo?: string): string | null {
  const ok = (dir: string | undefined) =>
    Boolean(dir && existsSync(path.join(dir, ".git")) && existsSync(path.join(dir, "update-macos.command")));
  if (devRepo && ok(devRepo)) return devRepo;
  try {
    const info = JSON.parse(readFileSync(path.join(dataDir, "install.json"), "utf8")) as { repo?: string };
    if (ok(info.repo)) return info.repo!;
  } catch {
    // Installed by an older installer, or not from a clone.
  }
  return null;
}

function parseCommits(text: string): Commit[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", date = "", ...rest] = line.split("\t");
      return { sha, date, subject: rest.join("\t") };
    });
}

/** Lines of `git status` that block a fast-forward. A lone package-lock.json change is restored by the updater. */
export function blockingChanges(porcelain: string): string[] {
  const lines = porcelain.split("\n").filter((l) => l.trim());
  if (lines.length === 1 && lines[0] === " M package-lock.json") return [];
  return lines;
}

export async function checkForUpdates(options: { repo: string | null; platform: string; packaged: boolean }): Promise<UpdateInfo> {
  const base = { behind: 0, ahead: 0, commits: [] as Commit[], checkedAt: new Date().toISOString() };
  const { repo } = options;
  if (!repo) return { ...base, state: "unsupported", reason: "no-repo" };
  try {
    await git(repo, ["--version"], 5000);
  } catch {
    return { ...base, repo, state: "unsupported", reason: "git-missing" };
  }
  const [head] = parseCommits(await git(repo, ["log", "-1", "--format=%h%x09%cI%x09%s"]));
  const branch = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  const info = { ...base, repo, branch, current: head };
  let upstream: string;
  try {
    upstream = await git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    return { ...info, state: "blocked", reason: "no-upstream" };
  }
  try {
    await git(repo, ["fetch", "--quiet", "--no-tags"], 45_000);
  } catch (e) {
    return { ...info, upstream, state: "error", reason: "fetch-failed", detail: (e as { stderr?: string }).stderr || (e as Error).message };
  }
  const [aheadText = "0", behindText = "0"] = (await git(repo, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).split(/\s+/);
  const ahead = Number(aheadText) || 0;
  const behind = Number(behindText) || 0;
  const commits = behind ? parseCommits(await git(repo, ["log", "--format=%h%x09%cI%x09%s", "-n", "20", "HEAD..@{u}"])) : [];
  const result = { ...info, upstream, ahead, behind, commits };
  if (behind === 0) return { ...result, state: "current" };
  if (ahead > 0) return { ...result, state: "blocked", reason: "diverged" };
  const changes = blockingChanges(await git(repo, ["status", "--porcelain", "--untracked-files=no"]));
  if (changes.length) return { ...result, state: "blocked", reason: "local-changes", detail: changes.slice(0, 10).join("\n") };
  if (options.platform !== "darwin") return { ...result, state: "unsupported", reason: "not-mac" };
  if (!options.packaged) return { ...result, state: "unsupported", reason: "dev" };
  return { ...result, state: "available" };
}

/** Starts the updater in the background. It keeps running after the app quits. */
export function startUpdate(repo: string, dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(path.join(dataDir, "update.log"), "w");
  const child = spawn("/bin/bash", [path.join(repo, "update-macos.command")], {
    cwd: repo,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...env(), AITRACK_UNATTENDED: "1", HOME: process.env.HOME ?? "" },
  });
  child.unref();
}

export function readProgress(dataDir: string): UpdateProgress {
  let status: Partial<UpdateProgress> = {};
  try {
    status = JSON.parse(readFileSync(path.join(dataDir, "update-status.json"), "utf8")) as Partial<UpdateProgress>;
  } catch {
    status = {};
  }
  let log: string[] = [];
  try {
    log = readFileSync(path.join(dataDir, "update.log"), "utf8")
      // Drop terminal colour codes.
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .filter((l) => l.trim())
      .slice(-14);
  } catch {
    log = [];
  }
  const state = ["running", "done", "failed", "current"].includes(String(status.state)) ? (status.state as UpdateProgress["state"]) : "idle";
  return { state, message: status.message, at: status.at, from: status.from, to: status.to, log };
}
