import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blockingChanges, checkForUpdates, findRepo, readProgress } from "../src/updater.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aitrack-upd-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A "GitHub" remote plus two clones: the installed one and one that pushes new versions. */
function setup() {
  const root = temp();
  const remote = path.join(root, "remote.git");
  git(root, "init", "--bare", "-q", remote);
  const dev = path.join(root, "dev");
  git(root, "clone", "-q", remote, dev);
  writeFileSync(path.join(dev, "update-macos.command"), "#!/bin/bash\n");
  writeFileSync(path.join(dev, "package-lock.json"), "{}\n");
  git(dev, "add", ".");
  git(dev, "commit", "-q", "-m", "first");
  git(dev, "push", "-q", "-u", "origin", "main");
  const app = path.join(root, "app");
  git(root, "clone", "-q", remote, app);
  const publish = (subject: string) => {
    writeFileSync(path.join(dev, `${subject}.txt`), subject);
    git(dev, "add", ".");
    git(dev, "commit", "-q", "-m", subject);
    git(dev, "push", "-q");
  };
  return { root, app, publish };
}

const opts = (repo: string | null) => ({ repo, platform: "darwin", packaged: true });

describe("updater", () => {
  it("ignores a lone package-lock.json change", () => {
    expect(blockingChanges(" M package-lock.json")).toEqual([]);
    expect(blockingChanges(" M package-lock.json\n M src/a.ts")).toHaveLength(2);
    expect(blockingChanges("")).toEqual([]);
  });

  it("finds the clone from install.json", () => {
    const { app } = setup();
    const data = temp();
    expect(findRepo(data)).toBeNull();
    writeFileSync(path.join(data, "install.json"), JSON.stringify({ repo: app }));
    expect(findRepo(data)).toBe(app);
    writeFileSync(path.join(data, "install.json"), JSON.stringify({ repo: temp() }));
    expect(findRepo(data)).toBeNull();
  });

  it("reports current, available and the new commits", async () => {
    const { app, publish } = setup();
    const none = await checkForUpdates(opts(null));
    expect(none).toMatchObject({ state: "unsupported", reason: "no-repo" });
    expect(await checkForUpdates(opts(app))).toMatchObject({ state: "current", behind: 0, ahead: 0, branch: "main", upstream: "origin/main" });
    publish("second");
    publish("third");
    const info = await checkForUpdates(opts(app));
    expect(info).toMatchObject({ state: "available", behind: 2, ahead: 0 });
    expect(info.commits.map((c) => c.subject)).toEqual(["third", "second"]);
    expect(info.current?.subject).toBe("first");
    expect(await checkForUpdates({ ...opts(app), platform: "linux" })).toMatchObject({ state: "unsupported", reason: "not-mac" });
    expect(await checkForUpdates({ ...opts(app), packaged: false })).toMatchObject({ state: "unsupported", reason: "dev" });
  });

  it("blocks on local changes, diverged history and a branch without upstream", async () => {
    const { app, publish } = setup();
    publish("second");
    writeFileSync(path.join(app, "package-lock.json"), '{"changed":true}\n');
    expect((await checkForUpdates(opts(app))).state).toBe("available");
    writeFileSync(path.join(app, "update-macos.command"), "#!/bin/bash\necho changed\n");
    const dirty = await checkForUpdates(opts(app));
    expect(dirty).toMatchObject({ state: "blocked", reason: "local-changes" });
    expect(dirty.detail).toContain("update-macos.command");
    git(app, "checkout", "--", ".");
    writeFileSync(path.join(app, "local.txt"), "mine");
    git(app, "add", ".");
    git(app, "commit", "-q", "-m", "local");
    expect(await checkForUpdates(opts(app))).toMatchObject({ state: "blocked", reason: "diverged", ahead: 1, behind: 1 });
    git(app, "switch", "-q", "-c", "topic");
    expect(await checkForUpdates(opts(app))).toMatchObject({ state: "blocked", reason: "no-upstream" });
  });

  it("reads progress without colour codes", () => {
    const data = temp();
    expect(readProgress(data)).toEqual({ state: "idle", log: [], message: undefined, at: undefined, from: undefined, to: undefined });
    writeFileSync(path.join(data, "update-status.json"), JSON.stringify({ state: "running", message: "2/4  Building", from: "abc", to: "def" }));
    writeFileSync(path.join(data, "update.log"), "\u001b[1mChecking\u001b[0m\n\n2/4  Building\n");
    expect(readProgress(data)).toMatchObject({ state: "running", message: "2/4  Building", from: "abc", to: "def", log: ["Checking", "2/4  Building"] });
  });
});
