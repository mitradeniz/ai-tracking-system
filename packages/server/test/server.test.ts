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
});
