import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Top-level directory of the git repository that contains `dir`, or null. */
export async function gitTopLevel(dir: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 3000 });
    const top = stdout.trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

/** Paths of all worktrees of a repository (the main one included). */
export async function gitWorktrees(repo: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["-C", repo, "worktree", "list", "--porcelain"], { timeout: 3000 });
    return stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Directories scanned for report files:
 * the inbox of the repository holding the project file, and the inbox of every worktree of
 * `settings.repoPath` (relative to the project file).
 */
export async function discoverInboxDirs(projectFile: string, inboxDir: string, repoPath?: string): Promise<string[]> {
  const fileDir = path.dirname(path.resolve(projectFile));
  const roots = new Set<string>();
  roots.add((await gitTopLevel(fileDir)) ?? fileDir);
  if (repoPath) {
    const repo = path.resolve(fileDir, repoPath);
    if (existsSync(repo)) {
      roots.add(repo);
      for (const wt of await gitWorktrees(repo)) roots.add(wt);
    }
  }
  return [...roots].map((root) => path.join(root, inboxDir));
}

export interface InboxFile {
  file: string;
  text: string;
}

/** Reads pending report files (*.json) from an inbox directory, oldest first. */
export async function readInbox(dir: string, maxBytes = 256 * 1024): Promise<InboxFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: { file: string; mtime: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const s = await stat(file);
      if (s.isFile()) files.push({ file, mtime: s.mtimeMs });
    } catch {
      // Vanished between readdir and stat.
    }
  }
  files.sort((a, b) => a.mtime - b.mtime);
  const out: InboxFile[] = [];
  for (const { file } of files) {
    try {
      const s = await stat(file);
      if (s.size > maxBytes) {
        out.push({ file, text: "" });
        continue;
      }
      out.push({ file, text: await readFile(file, "utf8") });
    } catch {
      // Ignore; it will be retried on the next scan.
    }
  }
  return out;
}

/** Moves a processed report file to `processed/` or `rejected/` next to it. */
export async function archiveInboxFile(file: string, ok: boolean, error?: string): Promise<void> {
  const target = path.join(path.dirname(file), ok ? "processed" : "rejected");
  await mkdir(target, { recursive: true });
  const dest = path.join(target, path.basename(file));
  await rename(file, dest);
  if (!ok && error) await writeFile(`${dest}.error.txt`, error + "\n", "utf8");
}
