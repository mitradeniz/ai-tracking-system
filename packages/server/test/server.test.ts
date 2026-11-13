import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeProject, ProjectFileSchema } from "@aitrack/core";
import { startServer, type RunningServer } from "../src/index.ts";

let dir: string;
let file: string;
let running: RunningServer;

const project = ProjectFileSchema.parse({
  format: "aitrack",
  version: 1,
  project: { id: "demo", name: "Demo" },
  agents: [
    { id: "a", name: "Agent A" },
    { id: "b", name: "Agent B" },
  ],
  prompts: { p: { body: "Do it." } },
  tasks: [
    { id: "T1", title: "One", agent: "a", prompts: ["p"] },
    { id: "T2", title: "Two", agent: "a", dependsOn: ["T1"], prompts: ["p"] },
    { id: "T3", title: "Three", agent: "b", prompts: ["p"] },
  ],
});

function call(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port: running.port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aitrack-test-"));
  file = path.join(dir, "demo.aitrack");
  await writeFile(file, serializeProject(project));
  running = await startServer({ port: 0, dataDir: path.join(dir, "data"), watch: false });
});

afterEach(async () => {
  await running.close();
});

describe("server", () => {
  it("adds a project and shows dispatchable tasks", async () => {
    const added = await call("POST", "/api/projects", { filePath: file });
    expect(added.status).toBe(201);
    const detail = await call("GET", `/api/projects/${added.json.key}`);
    expect(detail.status).toBe(200);
    const ready = detail.json.board.tasks.filter((t: any) => t.dispatchable).map((t: any) => t.id);
    expect(ready).toEqual(["T1", "T3"]);
  });

  it("waits for a project file that is still being written", async () => {
    const { json } = await call("POST", "/api/projects", { filePath: file });
    const good = serializeProject(project);
    // Half a file, as an editor that writes in place leaves it for a moment.
    await writeFile(file, good.slice(0, good.length / 2));
    const reloading = call("POST", `/api/projects/${json.key}/reload`);
    await new Promise((r) => setTimeout(r, 80));
    await writeFile(file, good);
    await reloading;
    const detail = await call("GET", `/api/projects/${json.key}`);
    expect(detail.json.project).not.toBeNull();
    expect(detail.json.issues.filter((i: any) => i.level === "error")).toEqual([]);

    // A file that stays broken still shows its errors.
    await writeFile(file, "{ broken");
    await call("POST", `/api/projects/${json.key}/reload`);
    const broken = await call("GET", `/api/projects/${json.key}`);
    expect(broken.json.project).toBeNull();
    expect(broken.json.issues.some((i: any) => i.level === "error")).toBe(true);
  });

  it("marks a reported problem resolved or ignored, and opens it again", async () => {
    const { json } = await call("POST", "/api/projects", { filePath: file });
    await call("POST", `/api/projects/${json.key}/events`, { task: "T1", type: "dispatched", agent: "a" });
    const report = { project: "demo", task: "T1", agent: "a", status: "blocked", reason: "no key", pr: null, issues: [{ title: "Key missing", kind: "needs-you" }, { title: "Docker missing" }] };
    expect((await call("POST", "/api/report", report)).status).toBe(201);
    const issuesOf = async () => (await call("GET", `/api/projects/${json.key}`)).json.board.tasks.find((t: any) => t.id === "T1").issues;
    expect((await call("POST", `/api/projects/${json.key}/tasks/T1/issues`, { index: 1, title: "Docker missing", state: "ignored" })).status).toBe(201);
    expect((await call("POST", `/api/projects/${json.key}/tasks/T1/issues`, { index: 0, title: "Key missing", state: "resolved" })).status).toBe(201);
    expect((await issuesOf()).map((i: any) => i.state)).toEqual(["resolved", "ignored"]);
    await call("POST", `/api/projects/${json.key}/tasks/T1/issues`, { index: 1, title: "Docker missing", state: "open" });
    expect((await issuesOf()).map((i: any) => i.state ?? null)).toEqual(["resolved", null]);
    expect((await call("POST", `/api/projects/${json.key}/tasks/T1/issues`, { title: "Nope", state: "resolved" })).status).toBe(409);
    expect((await call("POST", `/api/projects/${json.key}/tasks/T1/issues`, { title: "Key missing", state: "maybe" })).status).toBe(400);
    const detail = await call("GET", `/api/projects/${json.key}`);
    expect(detail.json.board.tasks.find((t: any) => t.id === "T1").status).toBe("blocked");
  });

  it("records agent reports and returns the next task", async () => {
    const { json } = await call("POST", "/api/projects", { filePath: file });
    await call("POST", `/api/projects/${json.key}/events`, { task: "T1", type: "dispatched", agent: "a" });
    const res = await call("POST", "/api/report", { project: "demo", task: "T1", agent: "a", status: "done", summary: "ok" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ ok: true, task: "T1", status: "done", next: [{ id: "T2", title: "Two" }] });
    const detail = await call("GET", `/api/projects/${json.key}`);
    expect(detail.json.board.tasks.find((t: any) => t.id === "T1").summary).toBe("ok");
  });

  it("rejects invalid reports and unknown tasks", async () => {
    await call("POST", "/api/projects", { filePath: file });
    expect((await call("POST", "/api/report", { task: "T1", status: "finished" })).status).toBe(400);
    expect((await call("POST", "/api/report", { task: "NOPE", status: "done" })).status).toBe(404);
  });

  it("processes report files dropped in the inbox", async () => {
    await call("POST", "/api/projects", { filePath: file });
    const inbox = path.join(dir, ".aitrack", "inbox");
    await mkdir(inbox, { recursive: true });
    await writeFile(path.join(inbox, "T3-blocked-1.json"), JSON.stringify({ task: "T3", status: "blocked", reason: "Needs a key" }));
    await writeFile(path.join(inbox, "bad.json"), "{ nope");
    expect(await running.manager.pollInboxes()).toBe(2);
    expect(await readdir(path.join(inbox, "processed"))).toEqual(["T3-blocked-1.json"]);
    expect((await readdir(path.join(inbox, "rejected"))).sort()).toEqual(["bad.json", "bad.json.error.txt"]);
    const key = running.manager.list()[0]!.key;
    const t3 = running.manager.detail(key).board!.tasks.find((t) => t.id === "T3")!;
    expect(t3.status).toBe("blocked");
    expect(t3.reason).toBe("Needs a key");
  });

  it("renders prompts with the live server URL", async () => {
    const { json } = await call("POST", "/api/projects", { filePath: file });
    const res = await call("GET", `/api/projects/${json.key}/tasks/T1/prompt`);
    expect(res.json.text).toContain(`curl -s -X POST ${running.url}/api/report`);
  });

  it("refuses foreign hosts, cross-origin writes and non-JSON bodies", async () => {
    expect((await call("GET", "/api/health", undefined, { host: "evil.example:80" })).status).toBe(421);
    expect((await call("POST", "/api/report", { task: "T1", status: "done" }, { origin: "https://evil.example" })).status).toBe(403);
    const plain = await new Promise<number>((resolve) => {
      const req = request(
        { host: "127.0.0.1", port: running.port, path: "/api/report", method: "POST", headers: { "content-type": "text/plain" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.end('{"task":"T1","status":"done"}');
    });
    expect(plain).toBe(415);
  });

  it("exports the project with its state and re-imports it", async () => {
    const { json } = await call("POST", "/api/projects", { filePath: file });
    await call("POST", "/api/report", { task: "T1", status: "done" });
    const target = path.join(dir, "copy.aitrack");
    expect((await call("POST", `/api/projects/${json.key}/export`, { filePath: target })).status).toBe(200);
    const again = await call("POST", "/api/projects", { filePath: target });
    const detail = await call("GET", `/api/projects/${again.json.key}`);
    expect(detail.json.board.tasks.find((t: any) => t.id === "T1").status).toBe("done");
  });

  it("adds, edits and removes chats in the project file", async () => {
    const added = await call("POST", "/api/projects", { filePath: file });
    const key = added.json.key as string;

    const bad = await call("POST", `/api/projects/${key}/agents`, { agent: { id: "has space", name: "X" } });
    expect(bad.status).toBe(400);

    const ok = await call("POST", `/api/projects/${key}/agents`, {
      agent: { id: "c", name: "Agent C", tool: "codex" },
      helpsWith: ["a"],
    });
    expect(ok.status).toBe(200);
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk.agents.map((a: { id: string }) => a.id)).toEqual(["a", "b", "c"]);
    expect(onDisk.tasks.find((t: { id: string }) => t.id === "T1").alsoAgents).toEqual(["c"]);

    const detail = await call("GET", `/api/projects/${key}`);
    expect(detail.json.board.tasks.find((t: { id: string }) => t.id === "T1").candidates).toEqual(["a", "c"]);

    // A chat that holds a task cannot be removed.
    await call("POST", `/api/projects/${key}/events`, { task: "T3", type: "started", agent: "b" });
    const busy = await call("POST", `/api/projects/${key}/agents/b/remove`, { reassignTo: "c" });
    expect(busy.status).toBe(409);

    const needsTarget = await call("POST", `/api/projects/${key}/agents/a/remove`, {});
    expect(needsTarget.status).toBe(409);
    const removed = await call("POST", `/api/projects/${key}/agents/a/remove`, { reassignTo: "c" });
    expect(removed.status).toBe(200);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.agents.map((a: { id: string }) => a.id)).toEqual(["b", "c"]);
    expect(after.tasks.filter((t: { agent: string }) => t.agent === "c").map((t: { id: string }) => t.id)).toEqual(["T1", "T2"]);
  });

  it("creates empty projects, and pins and orders the list", async () => {
    const one = await call("POST", "/api/projects/create", {
      filePath: path.join(dir, "shop"),
      id: "shop",
      name: "Shop",
      language: "tr",
      agents: [{ id: "claude-a", name: "Claude A", tool: "claude" }],
    });
    expect(one.status).toBe(201);
    const onDisk = JSON.parse(await readFile(path.join(dir, "shop.aitrack"), "utf8"));
    expect(onDisk.agents).toEqual([{ id: "claude-a", name: "Claude A", tool: "claude", capabilities: [], maxParallel: 1, bootstrapPrompts: [], quickPrompts: [] }]);
    expect(onDisk.tasks).toEqual([]);
    expect(JSON.stringify(onDisk)).not.toContain("Agent A");
    const again = await call("POST", "/api/projects/create", { filePath: path.join(dir, "shop.aitrack"), id: "shop", name: "Shop" });
    expect(again.status).toBe(409);
    const empty = await call("POST", "/api/projects/create", { filePath: path.join(dir, "blank.aitrack"), id: "blank", name: "Blank" });
    expect(empty.status).toBe(201);
    const demo = await call("POST", "/api/projects", { filePath: file });
    const keys = (await call("GET", "/api/projects")).json.projects.map((p: { key: string }) => p.key);
    expect(keys).toEqual([one.json.key, empty.json.key, demo.json.key]);

    const pinned = await call("POST", `/api/projects/${demo.json.key}/pin`, { pinned: true });
    expect(pinned.json.projects.map((p: { key: string; pinned: boolean }) => [p.key, p.pinned])).toEqual([
      [demo.json.key, true],
      [one.json.key, false],
      [empty.json.key, false],
    ]);
    const ordered = await call("POST", "/api/projects/order", { keys: [empty.json.key, one.json.key] });
    expect(ordered.json.projects.map((p: { key: string }) => p.key)).toEqual([demo.json.key, empty.json.key, one.json.key]);
    const registry = JSON.parse(await readFile(path.join(dir, "data", "registry.json"), "utf8"));
    expect(registry.projects[0]).toMatchObject({ key: demo.json.key, pinned: true });

    // The order survives a restart.
    await running.close();
    running = await startServer({ port: 0, dataDir: path.join(dir, "data"), watch: false });
    const reloaded = (await call("GET", "/api/projects")).json.projects.map((p: { key: string }) => p.key);
    expect(reloaded).toEqual([demo.json.key, empty.json.key, one.json.key]);
    expect((await call("DELETE", `/api/projects/${empty.json.key}`)).status).toBe(200);
    expect((await call("GET", "/api/projects")).json.projects).toHaveLength(2);
  });

  it("adds, edits and removes tasks and prompts in the project file", async () => {
    const key = (await call("POST", "/api/projects", { filePath: file })).json.key as string;
    const prompt = await call("POST", `/api/projects/${key}/prompts`, { prompt: { id: "ctx", title: "Context", body: "We build a demo." }, mode: "create" });
    expect(prompt.status).toBe(200);
    const created = await call("POST", `/api/projects/${key}/tasks`, {
      mode: "create",
      task: { id: "T4", title: "Four", agent: "b", dependsOn: ["T3"], prompts: ["ctx"], acceptance: "It works", estimateDays: 2 },
    });
    expect(created.status).toBe(200);
    let detail = (await call("GET", `/api/projects/${key}`)).json;
    expect(detail.project.tasks.find((t: { id: string }) => t.id === "T4")).toMatchObject({ dependsOn: ["T3"], prompts: ["ctx"], estimateDays: 2 });

    const cycle = await call("POST", `/api/projects/${key}/tasks`, { mode: "update", task: { id: "T3", title: "Three", agent: "b", dependsOn: ["T4"] } });
    expect(cycle.status).toBe(409);
    expect(cycle.json.error).toMatch(/cycle/);
    const unknown = await call("POST", `/api/projects/${key}/tasks`, { mode: "create", task: { id: "T5", title: "Five", agent: "zz" } });
    expect(unknown.status).toBe(400);

    const updated = await call("POST", `/api/projects/${key}/tasks`, { mode: "update", task: { id: "T4", title: "Four!", agent: "a", estimateDays: null } });
    expect(updated.status).toBe(200);
    detail = (await call("GET", `/api/projects/${key}`)).json;
    const t4 = detail.project.tasks.find((t: { id: string }) => t.id === "T4");
    expect(t4).toMatchObject({ title: "Four!", agent: "a", dependsOn: ["T3"] });
    expect(t4.estimateDays).toBeUndefined();

    // A task that is with a chat cannot be removed.
    await call("POST", `/api/projects/${key}/events`, { task: "T3", type: "started", agent: "b" });
    expect((await call("POST", `/api/projects/${key}/tasks/T3/remove`, {})).status).toBe(409);
    expect((await call("POST", `/api/projects/${key}/tasks/T1/remove`, {})).status).toBe(200);
    detail = (await call("GET", `/api/projects/${key}`)).json;
    expect(detail.project.tasks.map((t: { id: string }) => t.id)).toEqual(["T2", "T3", "T4"]);
    expect(detail.project.tasks.find((t: { id: string }) => t.id === "T2").dependsOn).toEqual([]);

    expect((await call("POST", `/api/projects/${key}/prompts/ctx/remove`, {})).status).toBe(200);
    detail = (await call("GET", `/api/projects/${key}`)).json;
    expect(detail.project.prompts.ctx).toBeUndefined();
    expect(detail.project.tasks.find((t: { id: string }) => t.id === "T4").prompts).toEqual([]);

    const info = await call("POST", `/api/projects/${key}/info`, { name: "Demo 2", language: "tr" });
    expect(info.json.name).toBe("Demo 2");
  });

  it("checks an AI's answer and tells what is in a folder", async () => {
    const input = { projectId: "shop", projectName: "Shop", language: "en", chats: [{ id: "a", name: "A" }], plan: "Build it" };
    const prompt = await call("POST", "/api/authoring/prompt", { input });
    expect(prompt.json.text).toContain("- id: a, name: A");
    const answer = "```json\n" + JSON.stringify({ format: "aitrack", version: 1, project: { id: "x", name: "x" }, agents: [{ id: "a", name: "A" }], tasks: [{ id: "T-01", title: "One", agent: "a", instructions: "x" }] }) + "\n```";
    const ok = await call("POST", "/api/authoring/check", { answer, input });
    expect(ok.json.errors).toEqual([]);
    expect(ok.json.summary.tasks).toEqual([{ id: "T-01", title: "One", agent: "a", dependsOn: [] }]);
    expect(JSON.parse(ok.json.text).project).toEqual({ id: "shop", name: "Shop" });
    const bad = await call("POST", "/api/authoring/check", { answer: "I cannot", input });
    expect(bad.json.errors[0]).toMatch(/JSON/);
    const created = await call("POST", "/api/projects/create", { filePath: path.join(dir, "shop.aitrack"), text: ok.json.text });
    expect(created.status).toBe(201);
    const invalid = await call("POST", "/api/projects/create", { filePath: path.join(dir, "bad.aitrack"), text: "{}" });
    expect(invalid.status).toBe(400);

    const folder = await call("POST", "/api/folder", { dir });
    expect(folder.json).toMatchObject({ exists: true, isDir: true, isGit: false });
    expect(folder.json.projectFiles.sort()).toEqual(["demo.aitrack", "shop.aitrack"]);
    expect((await call("POST", "/api/folder", { dir: path.join(dir, "nope") })).json.exists).toBe(false);
    expect((await call("POST", "/api/folder", { dir: "relative/path" })).json.exists).toBe(false);
  });
});
