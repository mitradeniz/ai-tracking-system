import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectFileSchema, serializeProject } from "@aitrack/core";
import { startServer, type RunningServer } from "../src/index.ts";
import { normalizeHook } from "../src/runners/hooks.ts";
import { buildInvocation, DEFAULT_RUNNER, OutputParser, splitArgs } from "../src/runners/providers.ts";

process.env.AITRACK_NO_LOGIN_SHELL = "1";
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.mjs");
const TOKEN = "0123456789abcdef0123456789abcdef";

let dir: string;
let file: string;
let running: RunningServer;
let key: string;
let fakeLog: string;

const project = ProjectFileSchema.parse({
  format: "aitrack",
  version: 1,
  project: { id: "demo", name: "Demo" },
  agents: [
    { id: "a", name: "Agent A", tool: "codex" },
    { id: "b", name: "Agent B", tool: "claude" },
  ],
  prompts: { p: { body: "Do it." }, boot: { body: "You are Agent A." } },
  tasks: [
    { id: "T1", title: "One", agent: "a", prompts: ["p"] },
    { id: "T2", title: "Two", agent: "a", dependsOn: ["T1"], prompts: ["p"] },
    { id: "T3", title: "Three", agent: "b", prompts: ["p"] },
  ],
});
project.agents[0]!.bootstrapPrompts = ["boot"];

function call(method: string, urlPath: string, body?: unknown, token = true): Promise<{ status: number; json: any }> {
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
          ...(token ? { "x-aitrack-token": TOKEN } : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function statusOf(task: string): Promise<string> {
  const res = await call("GET", `/api/projects/${key}`);
  return res.json.board.tasks.find((t: { id: string }) => t.id === task).status;
}

async function waitFor(task: string, status: string, timeout = 8000): Promise<void> {
  const until = Date.now() + timeout;
  let last = "";
  while (Date.now() < until) {
    last = await statusOf(task);
    if (last === status) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`${task} stayed ${last}, expected ${status}`);
}

async function invocations(): Promise<{ args: string[]; stdin: string; run?: string; chat?: string; cwd: string }[]> {
  try {
    return (await readFile(fakeLog, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function setRunner(agent: string, runner: Record<string, unknown>) {
  const res = await call("POST", `/api/projects/${key}/runners/${agent}`, { runner: { binary: FAKE, ...runner } });
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aitrack-run-"));
  file = path.join(dir, "demo.aitrack");
  fakeLog = path.join(dir, "fake.log");
  process.env.FAKE_LOG = fakeLog;
  process.env.FAKE_SCENARIO = "done";
  process.env.FAKE_FORMAT = "codex";
  await writeFile(file, serializeProject(project));
  running = await startServer({ port: 0, dataDir: path.join(dir, "data"), projects: [file], watch: false, controlToken: TOKEN });
  key = running.manager.list()[0]!.key;
});

afterEach(async () => {
  await running.close();
});

describe("agent runners", () => {
  it("needs the control token to start programs", async () => {
    expect((await call("POST", `/api/projects/${key}/runners/a`, { runner: { provider: "codex" } }, false)).status).toBe(401);
    expect((await call("POST", `/api/projects/${key}/tasks/T1/run`, {}, false)).status).toBe(401);
    expect((await call("GET", "/api/control", undefined, false)).status).toBe(401);
    expect((await call("GET", "/api/control")).status).toBe(200);
  });

  it("refuses to run a chat that is set to manual", async () => {
    const res = await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
    expect(res.status).toBe(400);
  });

  it("sends a task to Codex, reads the report and keeps the session", async () => {
    await setRunner("a", { provider: "codex" });
    const res = await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
    expect(res.status).toBe(201);
    await waitFor("T1", "done");
    const [inv] = await invocations();
    expect(inv!.args.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    expect(inv!.args).toContain("workspace-write");
    expect(inv!.args[inv!.args.length - 1]).toBe("-");
    expect(inv!.stdin).toContain("You are Agent A.");
    expect(inv!.stdin).toContain("TASK T1");
    expect(inv!.chat).toBe("a");

    const state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.settings.chats.a.sessionId).toBe("thread-123");
    const run = state.runs[0];
    expect(run.state).toBe("finished");
    const log = (await call("GET", `/api/runs/${run.id}/log`)).json;
    expect(log.lines.join("\n")).toContain("$ npm test");

    // The next task continues the same Codex thread, without the bootstrap prompt.
    await call("POST", `/api/projects/${key}/tasks/T2/run`, {});
    await waitFor("T2", "done");
    const second = (await invocations())[1]!;
    expect(second.args.slice(-3)).toEqual(["resume", "thread-123", "-"]);
    expect(second.stdin).not.toContain("You are Agent A.");

    const detail = (await call("GET", `/api/projects/${key}`)).json;
    const sources = detail.events.filter((e: { task: string }) => e.task === "T1").map((e: { type: string; source: string }) => `${e.type}:${e.source}`);
    expect(sources).toEqual(["dispatched:runner", "started:runner", "done:runner"]);
  });

  it("waits for a reply when Claude asks, then continues the same session", async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_SCENARIO = "ask";
    await setRunner("b", { provider: "claude", allowedTools: "Bash(npm test:*), Bash(git status)" });
    await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
    await waitFor("T3", "blocked");
    const detail = (await call("GET", `/api/projects/${key}`)).json;
    const t3 = detail.board.tasks.find((t: { id: string }) => t.id === "T3");
    expect(t3.reason).toBe("Waiting for your reply.");
    expect(t3.lastMessage).toContain("Shall I go ahead?");
    const first = (await invocations())[0]!;
    expect(first.args).toContain("--session-id");
    expect(first.args).toContain("acceptEdits");
    expect(first.args.slice(-3)).toEqual(["--allowedTools", "Bash(npm test:*)", "Bash(git status)"]);
    const session = first.args[first.args.indexOf("--session-id") + 1];

    process.env.FAKE_SCENARIO = "done";
    const reply = await call("POST", `/api/projects/${key}/agents/b/reply`, { text: "Yes, go ahead." });
    expect(reply.status).toBe(201);
    await waitFor("T3", "done");
    const second = (await invocations())[1]!;
    expect(second.args[second.args.indexOf("--resume") + 1]).toBe(session);
    expect(second.stdin).toBe("Yes, go ahead.");
  });

  it("marks the task failed when the CLI fails", async () => {
    process.env.FAKE_SCENARIO = "fail";
    await setRunner("a", { provider: "codex" });
    await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
    await waitFor("T1", "failed");
    const detail = (await call("GET", `/api/projects/${key}`)).json;
    expect(detail.board.tasks.find((t: { id: string }) => t.id === "T1").reason).toContain("boom: not signed in");
  });

  it("stops a run and keeps the task with the chat", async () => {
    process.env.FAKE_SCENARIO = "sleep";
    await setRunner("a", { provider: "codex" });
    const run = (await call("POST", `/api/projects/${key}/tasks/T1/run`, {})).json;
    await waitFor("T1", "dispatched");
    expect((await call("POST", `/api/projects/${key}/tasks/T1/run`, {})).status).toBe(409);
    await call("POST", `/api/runs/${run.id}/stop`, {});
    await waitFor("T1", "blocked");
    const state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.runs[0].state).toBe("stopped");
  });

  it("dispatches automatically to free chats and continues down the graph", async () => {
    await setRunner("a", { provider: "codex" });
    process.env.FAKE_FORMAT = "codex";
    await setRunner("b", { provider: "custom", command: `${FAKE} --fake-format text --task {{prompt}}` });
    const res = await call("POST", `/api/projects/${key}/runners`, { autoDispatch: true, maxConcurrent: 2 });
    expect(res.json.autoDispatch).toBe(true);
    await waitFor("T1", "done");
    await waitFor("T3", "done");
    await waitFor("T2", "done");
    const all = await invocations();
    expect(all).toHaveLength(3);
    const custom = all.find((i) => i.chat === "b")!;
    expect(custom.args.slice(0, 3)).toEqual(["--fake-format", "text", "--task"]);
    expect(custom.args[3]).toContain("TASK T3");
    const detail = (await call("GET", `/api/projects/${key}`)).json;
    expect(detail.events.find((e: { type: string; task: string }) => e.type === "dispatched" && e.task === "T1").message).toContain("Auto-sent");
  });

  it("updates status from hooks of sessions opened by hand", async () => {
    await call("POST", `/api/projects/${key}/events`, { type: "dispatched", task: "T3", agent: "b" });
    const hook = (body: unknown, tool = "claude") =>
      call("POST", `/api/hook?tool=${tool}`, body, false).then((r) => r.json);
    // Two chats work in the same folder, but only Agent B (a Claude chat) holds a task.
    let res = await hook({ hook_event_name: "UserPromptSubmit", session_id: "s-1", cwd: dir, prompt: "go" });
    expect(res.handled).toBe(true);
    await waitFor("T3", "in_progress");
    res = await hook({ hook_event_name: "Stop", session_id: "s-1", cwd: dir, last_assistant_message: "Which database?" });
    expect(res.detail).toBe("waiting");
    await waitFor("T3", "blocked");
    // The session was learned, so "Send" would continue this very chat.
    const state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.settings.chats.b.sessionId).toBe("s-1");
    const report = "Done.\n```aitrack-report\n" + JSON.stringify({ task: "T3", status: "done", summary: "ok" }) + "\n```";
    await hook({ hook_event_name: "UserPromptSubmit", session_id: "s-1", cwd: dir, prompt: "postgres" });
    await hook({ hook_event_name: "Stop", session_id: "s-1", cwd: "/elsewhere", last_assistant_message: report });
    await waitFor("T3", "done");
    // Codex notify payloads are understood too.
    await call("POST", `/api/projects/${key}/events`, { type: "dispatched", task: "T1", agent: "a" });
    res = await hook({ type: "agent-turn-complete", "thread-id": "x-9", "turn-id": "1", cwd: dir, "last-assistant-message": "Need a key." }, "codex");
    expect(res.handled).toBe(true);
    await waitFor("T1", "blocked");
    expect((await hook({ unrelated: true })).handled).toBe(false);
  });
});

describe("provider adapters", () => {
  it("splits command lines with quotes", () => {
    expect(splitArgs(`a "b c" 'd e' f\\ g ""`)).toEqual(["a", "b c", "d e", "f g", ""]);
    expect(() => splitArgs(`a "b`)).toThrow();
  });

  it("builds each CLI's command line", () => {
    const base = { ...DEFAULT_RUNNER, model: "m1" };
    const codex = buildInvocation({ runner: { ...base, provider: "codex", access: "edit", network: true }, prompt: "P", cwd: "/w", newSessionId: "u" });
    expect(codex.args).toEqual(["exec", "--json", "--skip-git-repo-check", "-C", "/w", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-m", "m1", "-"]);
    expect(codex.stdin).toBe("P");
    const full = buildInvocation({ runner: { ...base, provider: "codex", access: "full" }, prompt: "P", cwd: "/w", resume: "t", newSessionId: "u" });
    expect(full.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(full.args.slice(-3)).toEqual(["resume", "t", "-"]);
    const gemini = buildInvocation({ runner: { ...base, provider: "gemini", access: "readonly" }, prompt: "P", cwd: "/w", newSessionId: "u" });
    expect(gemini.args).toEqual(["-p", "P", "-o", "stream-json", "--skip-trust", "--session-id", "u", "--approval-mode", "plan", "-m", "m1"]);
    const copilot = buildInvocation({ runner: { ...base, provider: "copilot", access: "edit", allowedTools: "shell(git:*)" }, prompt: "P", cwd: "/w", resume: "s", newSessionId: "u" });
    expect(copilot.args).toEqual(["-p", "P", "-s", "--no-color", "--no-ask-user", "--session-id", "s", "--allow-tool", "write", "--allow-tool", "shell(git:*)", "--model", "m1"]);
    expect(() => buildInvocation({ runner: { ...base, provider: "manual" }, prompt: "P", cwd: "/w", newSessionId: "u" })).toThrow();
  });

  it("reads Gemini's streamed message and Claude's permission denials", () => {
    const g = new OutputParser("gemini");
    g.feed(JSON.stringify({ type: "init", session_id: "g1" }));
    g.feed(JSON.stringify({ type: "message", role: "assistant", content: "Hel", delta: true }));
    g.feed(JSON.stringify({ type: "message", role: "assistant", content: "lo", delta: true }));
    g.feed(JSON.stringify({ type: "result", status: "success" }));
    expect(g.sessionId).toBe("g1");
    expect(g.finalMessage()).toBe("Hello");
    const c = new OutputParser("claude");
    const events = c.feed(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", permission_denials: [{ tool_name: "Bash", tool_input: { command: "rm -rf x" } }] }));
    expect(events[0]).toEqual({ kind: "activity", text: "⛔ permission denied: Bash rm -rf x" });
    expect(c.result?.ok).toBe(true);
  });

  it("normalizes hook payloads", () => {
    expect(normalizeHook({ hook_event_name: "Notification", session_id: "s", message: "Claude needs your permission" })).toMatchObject({ tool: "claude", event: "attention", message: "Claude needs your permission" });
    expect(normalizeHook({ hook_event_name: "PreToolUse" })).toBeNull();
    expect(normalizeHook({ event: "stop", sessionId: "z" }, { tool: "cursor", chat: "a" })).toMatchObject({ tool: "cursor", chat: "a", sessionId: "z" });
  });
});
