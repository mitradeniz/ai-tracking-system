import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectFileSchema, serializeProject } from "@aitrack/core";
import { startServer, type RunningServer } from "../src/index.ts";
import { clearAutoModeCache, helpHasAutoMode, parseAgyModels, parseCodexModels, parseCopilotModels, parseCursorModels } from "../src/runners/env.ts";
import { claudeMemoryDir, conversationUsage, gitCommonDir, runUsage } from "../src/runners/runs.ts";
import { normalizeHook } from "../src/runners/hooks.ts";
import { normalizeRunner, RunnerStore } from "../src/runners/store.ts";
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
  running = await startServer({ port: 0, dataDir: path.join(dir, "data"), projects: [file], watch: false, controlToken: TOKEN, managerDelayMs: 80 });
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

  it("gives a conversation that goes on its session prompt again when the prompt changed", async () => {
    await setRunner("a", { provider: "codex" });
    await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
    await waitFor("T1", "done");
    // The protocol changes while the chat's conversation goes on.
    expect((await call("POST", `/api/projects/${key}/prompts`, { prompt: { id: "boot", body: "You are Agent A. Push once, as a draft." }, mode: "update" })).status).toBe(200);
    await call("POST", `/api/projects/${key}/tasks/T2/run`, {});
    await waitFor("T2", "done");
    const second = (await invocations())[1]!;
    expect(second.args.slice(-3)).toEqual(["resume", "thread-123", "-"]);
    expect(second.stdin).toContain("SESSION PROMPT HAS CHANGED");
    expect(second.stdin).toContain("Push once, as a draft.");
    // Once read, it is not given again.
    await call("POST", `/api/projects/${key}/events`, { task: "T2", type: "reopened" });
    await call("POST", `/api/projects/${key}/tasks/T2/run`, {});
    await waitFor("T2", "done");
    expect((await invocations())[2]!.stdin).not.toContain("SESSION PROMPT HAS CHANGED");
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
    expect(first.args).toContain("--allowedTools");
    expect(first.args.slice(-2)).toEqual(["Bash(npm test:*)", "Bash(git status)"]);
    expect(first.args).toContain("Bash(grep:*)");
    const session = first.args[first.args.indexOf("--session-id") + 1];

    process.env.FAKE_SCENARIO = "done";
    const reply = await call("POST", `/api/projects/${key}/agents/b/reply`, { text: "Yes, go ahead." });
    expect(reply.status).toBe(201);
    await waitFor("T3", "done");
    const second = (await invocations())[1]!;
    expect(second.args[second.args.indexOf("--resume") + 1]).toBe(session);
    expect(second.stdin).toBe("Yes, go ahead.");
  });

  it("starts a new conversation when the one to continue is gone, and when a chat moves to another CLI", async () => {
    // A chat moved from Codex to Claude Code: its Codex thread is not Claude's.
    await setRunner("a", { provider: "codex" });
    await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
    await waitFor("T1", "done");
    expect((await call("GET", `/api/projects/${key}/runners`)).json.settings.chats.a).toMatchObject({ sessionId: "thread-123", sessionProvider: "codex" });
    await setRunner("a", { provider: "claude" });
    const moved = (await call("GET", `/api/projects/${key}/runners`)).json.settings.chats.a;
    expect(moved.sessionId).toBeUndefined();
    expect(moved.sessionProvider).toBeUndefined();
    // An id pasted by hand belongs to the chat's CLI.
    await setRunner("a", { sessionId: "4a6f1ed1-028f-4211-ba7e-7c2fb199efda" });
    expect((await call("GET", `/api/projects/${key}/runners`)).json.settings.chats.a.sessionProvider).toBe("claude");

    // A conversation the CLI no longer has: one new start, not a failed task.
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_GONE = "0b5a0c2e-dead-4bee-9000-000000000001";
    try {
      await setRunner("b", { provider: "claude", sessionId: process.env.FAKE_GONE });
      await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
      await waitFor("T3", "done");
      const calls = (await invocations()).filter((i) => i.chat === "b");
      expect(calls).toHaveLength(2);
      expect(calls[0]!.args[calls[0]!.args.indexOf("--resume") + 1]).toBe(process.env.FAKE_GONE);
      expect(calls[1]!.args).toContain("--session-id");
      expect(calls[1]!.args).not.toContain("--resume");
      expect(calls[1]!.stdin).toContain("TASK T3");
      const state = (await call("GET", `/api/projects/${key}/runners`)).json;
      expect(state.settings.chats.b.sessionId).not.toBe(process.env.FAKE_GONE);
      const failed = state.runs.find((r: { agent: string; state: string }) => r.agent === "b" && r.state === "failed");
      expect(failed.error).toContain("No conversation found");
      const detail = (await call("GET", `/api/projects/${key}`)).json;
      expect(detail.events.some((e: { task: string; type: string }) => e.task === "T3" && e.type === "failed")).toBe(false);
      // The person is told why it started over.
      expect(detail.events.find((e: { task: string; type: string }) => e.task === "T3" && e.type === "note").message).toBe(
        `Runner: Claude Code did not find the conversation to continue (${process.env.FAKE_GONE}); the task started again in a new conversation.`,
      );
    } finally {
      delete process.env.FAKE_GONE;
    }
  });

  it("keeps run metrics and turns refused tools into problems with a fix prompt", async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_DENY = "1";
    try {
      await setRunner("b", { provider: "claude" });
      await call("POST", `/api/projects/${key}/tasks/T3/run`, { extra: "Use tabs, not spaces." });
      await waitFor("T3", "done");
    } finally {
      delete process.env.FAKE_DENY;
    }
    expect((await invocations())[0]!.stdin).toContain("ADDITIONAL INSTRUCTIONS FROM THE PERSON (they take precedence):\nUse tabs, not spaces.");
    const run = (await call("GET", `/api/projects/${key}/runners`)).json.runs[0];
    expect(run.tools).toBe(1);
    expect(run.usage).toMatchObject({ context: 32100, contextWindow: 1000000, costUsd: 0.05, turns: 2, input: 62020, cached: 60000, output: 150 });
    expect(run.denials).toEqual(["Bash npm test"]);
    // The chat finished anyway: the skipped step needs nothing from the person.
    const done = (await call("GET", `/api/projects/${key}`)).json.board.tasks.find((t: { id: string }) => t.id === "T3");
    expect(done.issues ?? []).toHaveLength(0);

    // A chat that stops with a refused step: that step becomes a problem.
    process.env.FAKE_DENY = "1";
    process.env.FAKE_SCENARIO = "ask";
    try {
      await call("POST", `/api/projects/${key}/events`, { task: "T3", type: "reopened" });
      await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
      await waitFor("T3", "blocked");
    } finally {
      delete process.env.FAKE_DENY;
    }
    const t3 = (await call("GET", `/api/projects/${key}`)).json.board.tasks.find((t: { id: string }) => t.id === "T3");
    expect(t3.issues).toHaveLength(1);
    expect(t3.issues[0]).toMatchObject({ title: "Permission denied: Bash npm test", kind: "needs-you" });
    expect(t3.issues[0].fix).toContain("npm test");
  });

  it("parks a task the chat stopped until another one is done, writes the wait into the plan, and sends the task back by itself", async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_SCENARIO = "wait";
    process.env.FAKE_WAIT = "T1";
    try {
      await setRunner("b", { provider: "claude" });
      await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
      await waitFor("T3", "blocked");
      let detail = (await call("GET", `/api/projects/${key}`)).json;
      const t3 = detail.board.tasks.find((t: { id: string }) => t.id === "T3");
      expect(t3.reasons).toEqual([{ kind: "waiting_for", tasks: ["T1"] }]);
      // The wait is now a dependency in the plan file, with a note in the task's history.
      expect(detail.project.tasks.find((t: { id: string }) => t.id === "T3").dependsOn).toEqual(["T1"]);
      expect(await readFile(file, "utf8")).toMatch(/"id": "T3"[\s\S]*"dependsOn": \[\s*"T1"\s*\]/);
      expect(detail.events.some((e: { type: string; message?: string }) => e.type === "note" && e.message?.includes("T3 now waits for T1"))).toBe(true);

      // T1 is done: with automatic dispatch on, T3 goes back to chat b and is told what it waited for.
      process.env.FAKE_SCENARIO = "done";
      await call("POST", `/api/projects/${key}/runners`, { autoDispatch: true });
      await call("POST", `/api/projects/${key}/events`, { task: "T1", type: "done", message: "Contract merged" });
      await waitFor("T3", "done");
      const second = (await invocations())[1]!;
      expect(second.stdin).toContain("THE TASKS YOU WAITED FOR ARE DONE");
      expect(second.stdin).toContain("- T1 (One): Contract merged");
      expect(second.stdin).toContain("go back to this task's branch");
      detail = (await call("GET", `/api/projects/${key}`)).json;
      expect(detail.board.tasks.find((t: { id: string }) => t.id === "T3").resumes).toBeNull();
    } finally {
      delete process.env.FAKE_WAIT;
    }
  });

  it("turns work a chat left for later into proposed tasks, adds or ignores them, and folds them in with a CLI", async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_SCENARIO = "followups";
    await setRunner("b", { provider: "claude" });
    await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
    await waitFor("T3", "done");
    let detail = (await call("GET", `/api/projects/${key}`)).json;
    const proposals = detail.board.proposals;
    expect(proposals.map((p: { title: string; state: string }) => [p.title, p.state])).toEqual([
      ["Replace placeholder images", "open"],
      ["Add web checks to CI", "open"],
    ]);
    expect(proposals[0]).toMatchObject({ from: "T3", by: "b", agent: "a", after: ["T1"] });

    // One added with defaults: after the task it came from and what it waits for, for the chat it names.
    const added = await call("POST", `/api/projects/${key}/proposals/add`, { id: proposals[0].id });
    expect(added.status).toBe(201);
    expect(added.json.created).toEqual(["T3-F1"]);
    detail = (await call("GET", `/api/projects/${key}`)).json;
    expect(detail.project.tasks.find((t: { id: string }) => t.id === "T3-F1")).toMatchObject({ agent: "a", dependsOn: ["T3", "T1"], prompts: ["p"] });
    expect(detail.board.proposals[0]).toMatchObject({ state: "added", task: "T3-F1" });

    // The other one folded in by a CLI: preview first, then written.
    process.env.FAKE_PLAN_ANSWER = JSON.stringify({
      tasks: [{ title: "CI: web checks", agent: "b", dependsOn: ["T3", "NOPE"], instructions: "Add lint and tests for web.", covers: { proposals: [proposals[1].id] } }],
      summary: "One task for CI.",
    });
    await setRunner("b", { provider: "claude" });
    const job = await call("POST", `/api/projects/${key}/proposals/integrate`, { provider: "claude", binary: FAKE });
    expect(job.status).toBe(201);
    let ended = job.json;
    for (let i = 0; i < 100 && ended.state === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 60));
      ended = (await call("GET", `/api/authoring/generate/${job.json.id}`)).json;
    }
    expect(ended.state).toBe("done");
    const preview = await call("POST", `/api/projects/${key}/proposals/preview`, { answer: ended.answer });
    expect(preview.status).toBe(200);
    expect(preview.json.plan.tasks[0]).toMatchObject({ id: "T3-F2", agent: "b", dependsOn: ["T3"] });
    expect(preview.json.dropped).toEqual(["T3-F2: unknown dependency NOPE"]);
    const applied = await call("POST", `/api/projects/${key}/proposals/apply`, { plan: preview.json.plan });
    expect(applied.json).toMatchObject({ created: ["T3-F2"], errors: [] });
    detail = (await call("GET", `/api/projects/${key}`)).json;
    expect(detail.board.proposals.every((p: { state: string }) => p.state === "added")).toBe(true);
    expect((await call("POST", `/api/projects/${key}/proposals/integrate`, { provider: "claude", binary: FAKE })).status).toBe(409);
    delete process.env.FAKE_PLAN_ANSWER;
  });

  it("lets a manager CLI answer a waiting chat, keep the plan up to date and leave the rest for the person", { timeout: 20000 }, async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_SCENARIO = "askonce";
    process.env.FAKE_MANAGER_ANSWER = JSON.stringify({
      actions: [
        { type: "reply", task: "T3", text: "Yes, go ahead with the plan." },
        { type: "reply", task: "T1", text: "Not waiting: must be refused." },
        { type: "leave", message: "Buy the domain name." },
      ],
      plan: { tasks: [{ title: "Write the launch notes", agent: "a", dependsOn: ["T3"] }] },
      summary: "Answered T3.",
    });
    const managerCalls = async () => (await invocations()).filter((i) => i.stdin.includes("You are the manager")).length;
    const managerState = async () => (await call("GET", `/api/projects/${key}/runners`)).json.manager;
    try {
      await setRunner("b", { provider: "claude" });
      const settings = await call("POST", `/api/projects/${key}/manager`, { enabled: true, provider: "claude", binary: FAKE });
      expect(settings.status).toBe(200);
      expect(settings.json.settings).toMatchObject({ enabled: true, provider: "claude", resumeStopped: true, approveDone: false });
      expect(settings.json.settings.maxRunsPerHour).toBeUndefined();
      // Turning the manager on turns automatic dispatch on.
      expect((await call("GET", `/api/projects/${key}/runners`)).json.settings.autoDispatch).toBe(true);
      expect((await call("POST", `/api/projects/${key}/manager/run`, {}, false)).status).toBe(401);

      // Auto-dispatch sends T3; its chat asks something: the manager looks by itself, once.
      await waitFor("T3", "blocked");
      let state = await managerState();
      for (let i = 0; i < 150 && state.log[0]?.state !== "done"; i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        state = await managerState();
      }
      const run = state.log[0];
      expect(run).toMatchObject({ state: "done", trigger: "auto", summary: "Answered T3.", forYou: ["Buy the domain name."] });
      expect(run.actions.map((a: { type: string; ok: boolean }) => `${a.type}:${a.ok}`)).toEqual(["reply:true", "reply:false", "leave:true", "plan:true"]);
      await waitFor("T3", "done");
      expect((await invocations()).some((i) => i.stdin.includes("Yes, go ahead with the plan."))).toBe(true);
      const detail = (await call("GET", `/api/projects/${key}`)).json;
      expect(detail.project.tasks.some((t: { title: string }) => t.title === "Write the launch notes")).toBe(true);
      expect(detail.events.some((e: { source: string; message?: string }) => e.source === "manager" && e.message?.startsWith("Manager: replied"))).toBe(true);
      // What follows (the reply's run, the new task) needs no decision: no second call, no polling.
      await new Promise((r) => setTimeout(r, 500));
      expect(await managerCalls()).toBe(1);
      expect((await call("POST", `/api/projects/${key}/manager/run`, {})).status).toBe(409);
    } finally {
      delete process.env.FAKE_MANAGER_ANSWER;
    }
  });

  it("approves finished work for the person only when allowed, and never work with open problems", async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_MANAGER_ANSWER = JSON.stringify({
      actions: [
        { type: "approve", task: "T1", note: "Summary covers the task and the tests pass." },
        { type: "approve", task: "T3", note: "Looks done." },
        { type: "close", task: "T2", issues: [0] },
        { type: "close", task: "T2", issues: [0], state: "ignored" },
        { type: "approve", task: "T2", note: "The CI note is covered by T1." },
      ],
      summary: "Approved T1 and T2.",
    });
    const managerCalls = async () => (await invocations()).filter((i) => i.stdin.includes("You are the manager")).length;
    const status = async (id: string) =>
      (await call("GET", `/api/projects/${key}`)).json.board.tasks.find((t: { id: string }) => t.id === id).status as string;
    try {
      expect((await call("POST", `/api/projects/${key}/info`, { requireApproval: true })).status).toBe(200);
      await call("POST", "/api/report", { project: "demo", task: "T1", agent: "a", status: "done", summary: "Built and tested.", verify: "npm test" });
      // T2 is finished too, with a note that other work covers.
      await call("POST", "/api/report", { project: "demo", task: "T2", agent: "a", status: "done", summary: "Done.", issues: [{ title: "Tests do not run in CI yet", kind: "error" }] });
      await call("POST", "/api/report", {
        project: "demo",
        task: "T3",
        agent: "b",
        status: "done",
        summary: "Mostly done.",
        issues: [{ title: "The payment step was not tried", kind: "needs-you" }],
      });
      expect(await status("T1")).toBe("review");
      // Off by default: finished work waits for the person, and the manager is not even called.
      await call("POST", `/api/projects/${key}/manager`, { enabled: true, provider: "claude", binary: FAKE });
      await new Promise((r) => setTimeout(r, 400));
      expect(await managerCalls()).toBe(0);

      const on = await call("POST", `/api/projects/${key}/manager`, { approveDone: true });
      expect(on.json.settings.approveDone).toBe(true);
      let log = on.json.log;
      for (let i = 0; i < 150 && log[0]?.state !== "done"; i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        log = (await call("GET", `/api/projects/${key}/runners`)).json.manager.log;
      }
      expect(log[0].actions.map((a: { type: string; task: string; ok: boolean }) => `${a.type}:${a.task}:${a.ok}`)).toEqual([
        "approve:T1:true",
        "approve:T3:false",
        "close:T2:true",
        "close:T2:false",
        "approve:T2:true",
      ]);
      expect(await status("T2")).toBe("done");
      expect(log[0].forYou[0]).toContain("T3: waits for your approval");
      expect(await status("T1")).toBe("done");
      expect(await status("T3")).toBe("review");
      // T3 is the person's now: the approval of T1 changed the board, but the manager is not called about T3 again.
      await new Promise((r) => setTimeout(r, 500));
      expect(await managerCalls()).toBe(1);
      const events = (await call("GET", `/api/projects/${key}`)).json.events;
      expect(events.some((e: { type: string; source: string; message?: string }) => e.type === "approved" && e.source === "manager" && e.message?.includes("tests pass"))).toBe(true);
    } finally {
      delete process.env.FAKE_MANAGER_ANSWER;
    }
  });

  it("reviews finished work itself with full automation: approves with what to look at, sends back the rest, at most twice", { timeout: 30000 }, async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_MANAGER_ANSWER = JSON.stringify({
      actions: [
        { type: "close", task: "T3", issues: [0], state: "resolved" },
        { type: "approve", task: "T3", note: "Does what the task asks.", check: "Compare the screen with the design." },
        { type: "revise", task: "T1", text: "Add the missing test." },
        { type: "merge", task: "T1" },
      ],
      summary: "Approved T3, sent T1 back.",
    });
    const managerRuns = async () => (await invocations()).filter((i) => i.stdin.includes("You are the manager"));
    const status = async (id: string) =>
      (await call("GET", `/api/projects/${key}`)).json.board.tasks.find((t: { id: string }) => t.id === id).status as string;
    try {
      expect((await call("POST", `/api/projects/${key}/info`, { requireApproval: true })).status).toBe(200);
      // T1 was done by chat a (it has a session to continue); T3 is reported finished with a check only a person can do.
      await setRunner("a", { provider: "claude" });
      await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
      await waitFor("T1", "review");
      await call("POST", "/api/report", {
        project: "demo",
        task: "T3",
        agent: "b",
        status: "done",
        summary: "Screen built.",
        issues: [{ title: "The design comparison needs you", kind: "needs-you" }],
      });
      const on = await call("POST", `/api/projects/${key}/manager`, { enabled: true, provider: "claude", binary: FAKE, fullAuto: true });
      expect(on.json.settings).toMatchObject({ fullAuto: true, approveDone: false, mergeGreen: false });
      let state = on.json;
      for (let i = 0; i < 150 && state.log.at(-1)?.state !== "done"; i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        state = (await call("GET", `/api/projects/${key}/runners`)).json.manager;
      }
      const first = state.log.at(-1);
      expect(first.actions.map((a: { type: string; task: string; ok: boolean }) => `${a.type}:${a.task}:${a.ok}`)).toEqual([
        "close:T3:true",
        "approve:T3:true",
        "revise:T1:true",
        "merge:T1:false",
      ]);
      expect(await status("T3")).toBe("done");
      // The approval is listed for the person, with what to look at.
      expect(state.approvals[0]).toMatchObject({ task: "T3", title: "Three", note: "Does what the task asks.", check: "Compare the screen with the design." });
      expect(state.unseen).toBe(1);
      // It reviewed with read-only git and gh commands, and was told how.
      const look = (await managerRuns())[0]!;
      expect(look.stdin).toContain("you review finished work for the person");
      expect(look.stdin).toContain('"check"');
      expect(look.stdin).not.toContain('"type":"merge"');
      expect(look.args).toContain("Bash(gh pr diff:*)");
      expect(look.args).not.toContain("Bash(gh pr merge:*)");

      // T1 goes back to its chat with what to fix; each time it reports again, the manager looks again.
      // After two send-backs it is left for the person.
      for (let i = 0; i < 300; i += 1) {
        state = (await call("GET", `/api/projects/${key}/runners`)).json.manager;
        if (state.log.some((r: { actions: { type: string; ok: boolean }[] }) => r.actions.some((a) => a.type === "revise" && !a.ok))) break;
        await new Promise((r) => setTimeout(r, 60));
      }
      const sentBack = (await invocations()).filter((i) => i.stdin.includes("it is not done as asked yet"));
      expect(sentBack).toHaveLength(2);
      expect(sentBack[0]!.stdin).toContain("Add the missing test.");
      const last = state.log.find((r: { actions: { type: string; ok: boolean }[] }) => r.actions.some((a) => a.type === "revise" && !a.ok));
      expect(last.forYou.some((f: string) => f.startsWith("T1: sent back 2 times"))).toBe(true);
      expect(await status("T1")).toBe("review");

      // The person looked over the approvals.
      const seen = await call("POST", `/api/projects/${key}/manager/approvals/seen`, {});
      expect(seen.json.unseen).toBe(0);
      expect(seen.json.approvals[0].seen).toBe(true);
    } finally {
      delete process.env.FAKE_MANAGER_ANSWER;
    }
  });

  it("has a reviewed task's own chat merge its PRs only when merging is turned on, once", { timeout: 20000 }, async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_MANAGER_ANSWER = JSON.stringify({ actions: [{ type: "merge", task: "T1", note: "PR #5" }], summary: "T1's chat merges #5." });
    try {
      expect((await call("POST", `/api/projects/${key}/info`, { requireApproval: true })).status).toBe(200);
      await setRunner("a", { provider: "claude" });
      await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
      await waitFor("T1", "review");
      await call("POST", `/api/projects/${key}/manager`, { enabled: true, provider: "claude", binary: FAKE, approveDone: true, mergeGreen: true });
      let state = (await call("GET", `/api/projects/${key}/runners`)).json.manager;
      for (let i = 0; i < 200 && !(state.log.length >= 2 && state.log[0].state === "done"); i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        state = (await call("GET", `/api/projects/${key}/runners`)).json.manager;
      }
      const runs = [...state.log].reverse();
      expect(runs[0].actions[0]).toMatchObject({ type: "merge", task: "T1", ok: true, detail: "PR #5" });
      // Asked once: the second look (after the chat reported again) does not ask again.
      expect(runs[1].actions[0]).toMatchObject({ type: "merge", task: "T1", ok: false });
      const merge = (await invocations()).find((i) => i.stdin.includes("may go into main now"))!;
      expect(merge.stdin).toContain("Merge its own pull requests yourself: PR #5");
      expect(merge.stdin).toContain("--merge");
      // The merge commands are allowed for that one reply only.
      expect(merge.args).toContain("Bash(gh pr merge:*)");
      expect((await call("GET", `/api/projects/${key}/runners`)).json.settings.chats.a.allowedTools ?? "").not.toContain("gh pr merge");
      const prompt = (await invocations()).find((i) => i.stdin.includes("You are the manager"))!.stdin;
      expect(prompt).toContain('{"type":"merge"');
      expect(prompt).toContain('merge into it other than with the "merge" action');
    } finally {
      delete process.env.FAKE_MANAGER_ANSWER;
    }
  });

  it("acts with the person's authority only when given: grants what a sandbox kept out, moves a task, takes a duplicate out", { timeout: 30000 }, async () => {
    process.env.FAKE_FORMAT = "codex";
    process.env.FAKE_SCENARIO = "sandbox";
    const answer = {
      actions: [
        { type: "grant", task: "T1" },
        { type: "drop", task: "T2", note: "T1 covers it" },
        { type: "assign", task: "T3", to: "a", note: "Agent A has the browser" },
      ],
      summary: "Unblocked T1.",
    };
    process.env.FAKE_MANAGER_ANSWER = JSON.stringify(answer);
    const managerState = async () => (await call("GET", `/api/projects/${key}/runners`)).json.manager;
    const looks = async (n: number) => {
      let state = await managerState();
      for (let i = 0; i < 250 && !(state.log.length >= n && state.log[0].state === "done"); i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        state = await managerState();
      }
      return state;
    };
    try {
      await setRunner("a", { provider: "codex" });
      await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
      await waitFor("T1", "blocked");
      // Without full authority all three are refused and left for the person.
      await call("POST", `/api/projects/${key}/manager`, { enabled: true, provider: "codex", binary: FAKE });
      let state = await looks(1);
      expect(state.log[0].actions.map((a: { type: string; ok: boolean }) => `${a.type}:${a.ok}`)).toEqual(["grant:false", "drop:false", "assign:false"]);
      expect((await call("GET", `/api/projects/${key}/runners`)).json.settings.chats.a.network).toBe(false);
      const plain = (await invocations()).find((i) => i.stdin.includes("You are the manager"))!.stdin;
      expect(plain).toContain("[needs permission (read from the problem): network]");
      expect(plain).not.toContain("FULL AUTHORITY");

      // With full authority it does them; the chat goes on in its conversation.
      process.env.FAKE_SCENARIO = "done";
      const on = await call("POST", `/api/projects/${key}/manager`, { fullAuthority: true });
      expect(on.json.settings).toMatchObject({ fullAuthority: true });
      state = await looks(2);
      const run = state.log[0];
      expect(run.actions.map((a: { type: string; ok: boolean }) => `${a.type}:${a.ok}`)).toEqual(["grant:true", "drop:true", "assign:true"]);
      expect(run.actions[0].detail).toBe("network");
      const prompt = [...(await invocations())].reverse().find((i) => i.stdin.includes("You are the manager"))!.stdin;
      expect(prompt).toContain("FULL AUTHORITY");
      expect(prompt).toContain('{"type":"grant"');
      // It remembers its last looks: what it was refused before.
      expect(prompt).toContain("YOUR RECENT LOOKS");
      expect(prompt).toMatch(/drop T2 refused — Moving and removing tasks needs full authority/);
      await waitFor("T1", "done");
      const settings = (await call("GET", `/api/projects/${key}/runners`)).json.settings;
      expect(settings.chats.a.network).toBe(true);
      expect(settings.chats.a.access).not.toBe("full");
      const reply = (await invocations()).find((i) => i.stdin.startsWith("The manager allowed this for you from now on: network"))!;
      expect(reply.args.slice(-3)).toEqual(["resume", "thread-123", "-"]);
      const detail = (await call("GET", `/api/projects/${key}`)).json;
      const t1 = detail.board.tasks.find((t: { id: string }) => t.id === "T1");
      expect(t1.issues.every((i: { state?: string }) => i.state === "resolved")).toBe(true);
      expect(detail.project.tasks.map((t: { id: string }) => t.id)).toEqual(["T1", "T3"]);
      expect(detail.project.tasks.find((t: { id: string }) => t.id === "T3").agent).toBe("a");
      expect(detail.events.some((e: { message?: string }) => e.message === "Manager: moved to a — Agent A has the browser")).toBe(true);
    } finally {
      delete process.env.FAKE_MANAGER_ANSWER;
    }
  });

  it("keeps a task a chat holds when it moves it: the new chat starts it over; and takes out only tasks nobody started", { timeout: 20000 }, async () => {
    process.env.FAKE_FORMAT = "codex";
    process.env.FAKE_SCENARIO = "sandbox";
    process.env.FAKE_MANAGER_ANSWER = JSON.stringify({
      actions: [
        { type: "drop", task: "T1", note: "duplicate" },
        { type: "assign", task: "T1", to: "b", note: "b can reach the network" },
        { type: "drop", task: "T2" },
      ],
    });
    try {
      await setRunner("a", { provider: "codex" });
      await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
      await waitFor("T1", "blocked");
      await call("POST", `/api/projects/${key}/manager`, { enabled: true, provider: "codex", binary: FAKE, fullAuthority: true });
      let state = (await call("GET", `/api/projects/${key}/runners`)).json.manager;
      for (let i = 0; i < 200 && state.log[0]?.state !== "done"; i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        state = (await call("GET", `/api/projects/${key}/runners`)).json.manager;
      }
      const acts = state.log[0].actions;
      // A started task is not taken out; one drop needs a reason.
      expect(acts.map((a: { type: string; ok: boolean }) => `${a.type}:${a.ok}`)).toEqual(["drop:false", "assign:true", "drop:false"]);
      expect(acts[2].detail).toContain("Say why");
      const detail = (await call("GET", `/api/projects/${key}`)).json;
      const t1 = detail.board.tasks.find((t: { id: string }) => t.id === "T1");
      expect(detail.project.tasks.find((t: { id: string }) => t.id === "T1").agent).toBe("b");
      // Released by Agent A; Agent B is run by hand, so it waits there as ready.
      expect(t1.status).toBe("ready");
      expect(t1.agent ?? null).toBeNull();
    } finally {
      delete process.env.FAKE_MANAGER_ANSWER;
    }
  });

  it("in saving mode gives each task a conversation of its own and passes on what chats checked", { timeout: 20000 }, async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_SCENARIO = "facts";
    await setRunner("a", { provider: "claude" });
    expect((await call("POST", `/api/projects/${key}/runners`, { saving: true })).json.saving).toBe(true);
    await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
    await waitFor("T1", "done");
    let state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.settings.saving).toBe(true);
    expect(state.facts.map((f: { text: string }) => f.text)).toEqual(["pgvector 0.8 is enabled on the dev database (psql -c '\\dx')"]);
    expect(state.facts[0]).toMatchObject({ task: "T1" });
    // What the tracker keeps for itself is not sent to the app.
    expect(state.settings.taskSessions).toBeUndefined();
    expect(state.settings.sessionUsage).toBeUndefined();

    process.env.FAKE_SCENARIO = "done";
    await call("POST", `/api/projects/${key}/tasks/T2/run`, {});
    await waitFor("T2", "done");
    const [first, second] = await invocations();
    const s1 = first!.args[first!.args.indexOf("--session-id") + 1];
    // A new task: a new conversation, with the session prompt and what was checked.
    expect(second!.args).toContain("--session-id");
    expect(second!.args).not.toContain("--resume");
    expect(second!.args[second!.args.indexOf("--session-id") + 1]).not.toBe(s1);
    expect(second!.stdin).toContain("You are Agent A.");
    expect(second!.stdin).toContain("ALREADY CHECKED IN THIS PROJECT");
    expect(second!.stdin).toContain("pgvector 0.8 is enabled");
    expect(second!.stdin).toContain("(T1, ");

    // The same task again goes on in its own conversation.
    await call("POST", `/api/projects/${key}/events`, { task: "T1", type: "reopened" });
    await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
    await waitFor("T1", "done");
    const third = (await invocations())[2]!;
    expect(third.args[third.args.indexOf("--resume") + 1]).toBe(s1);
    expect(third.stdin).not.toContain("You are Agent A.");

    // The person removes a fact that is out of date.
    const removed = await call("POST", `/api/projects/${key}/facts/remove`, { all: true });
    expect(removed.json.facts).toEqual([]);
    expect((await call("POST", `/api/projects/${key}/facts/remove`, {})).status).toBe(400);
  });

  it("shows what a run used, also when the CLI counts its whole conversation", async () => {
    process.env.FAKE_FORMAT = "codex";
    await setRunner("a", { provider: "codex" });
    process.env.FAKE_CODEX_USAGE = "1000,800,50";
    try {
      await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
      await waitFor("T1", "done");
      process.env.FAKE_CODEX_USAGE = "1600,1300,80";
      await call("POST", `/api/projects/${key}/tasks/T2/run`, {});
      await waitFor("T2", "done");
      const runs = (await call("GET", `/api/projects/${key}/runners`)).json.runs;
      expect(runs[1].usage).toMatchObject({ input: 1000, cached: 800, output: 50 });
      expect(runs[0].usage).toMatchObject({ input: 600, cached: 500, output: 30 });
    } finally {
      delete process.env.FAKE_CODEX_USAGE;
    }
  });

  it("lets the person write to the manager: it looks at once, acts on the message and answers", { timeout: 20000 }, async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_MANAGER_ANSWER = JSON.stringify({
      actions: [{ type: "approve", task: "T1", note: "The person asked for it." }],
      summary: "Approved T1 as asked.",
      reply: "T1 onaylandı.",
    });
    try {
      expect((await call("POST", `/api/projects/${key}/info`, { requireApproval: true })).status).toBe(200);
      await call("POST", "/api/report", { project: "demo", task: "T1", agent: "a", status: "done", summary: "Built." });
      // The manager is off and approving is off: the message is enough for this look.
      await call("POST", `/api/projects/${key}/manager`, { provider: "claude", binary: FAKE });
      expect((await call("POST", `/api/projects/${key}/manager/message`, { text: "T1'i onayla." }, false)).status).toBe(401);
      expect((await call("POST", `/api/projects/${key}/manager/message`, { text: "  " })).status).toBe(400);
      expect((await call("POST", `/api/projects/${key}/manager/message`, { text: "T1'i onayla." })).status).toBe(202);
      let log = (await call("GET", `/api/projects/${key}/runners`)).json.manager.log;
      for (let i = 0; i < 150 && log[0]?.state !== "done"; i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        log = (await call("GET", `/api/projects/${key}/runners`)).json.manager.log;
      }
      expect(log[0]).toMatchObject({ state: "done", trigger: "manual", message: "T1'i onayla.", reply: "T1 onaylandı." });
      expect(log[0].actions[0]).toMatchObject({ type: "approve", task: "T1", ok: true });
      const prompt = (await invocations()).filter((i) => i.stdin.includes("You are the manager")).at(-1)!.stdin;
      expect(prompt).toContain("MESSAGE FROM THE PERSON");
      expect(prompt).toContain("> T1'i onayla.");
      expect((await call("GET", `/api/projects/${key}`)).json.board.tasks.find((t: { id: string }) => t.id === "T1").status).toBe("done");
    } finally {
      delete process.env.FAKE_MANAGER_ANSWER;
    }
  });

  it("tries a failed manager run again later, not on every change", async () => {
    await running.close();
    running = await startServer({ port: 0, dataDir: path.join(dir, "data"), projects: [file], watch: false, controlToken: TOKEN, managerDelayMs: 50, managerRetryMs: [600] });
    key = running.manager.list()[0]!.key;
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_MANAGER_ANSWER = "not json";
    try {
      await call("POST", "/api/report", { project: "demo", task: "T3", agent: "b", status: "blocked", reason: "Which colour?" });
      await call("POST", `/api/projects/${key}/manager`, { enabled: true, provider: "claude", binary: FAKE });
      const log = async () => (await call("GET", `/api/projects/${key}/runners`)).json.manager.log as Array<{ state: string; error?: string }>;
      let list = await log();
      for (let i = 0; i < 100 && list[0]?.state !== "failed"; i += 1) {
        await new Promise((r) => setTimeout(r, 30));
        list = await log();
      }
      expect(list).toHaveLength(1);
      // A change right after the failure waits for the retry.
      await call("POST", "/api/report", { project: "demo", task: "T1", agent: "a", status: "progress", summary: "Working." });
      await new Promise((r) => setTimeout(r, 250));
      expect(await log()).toHaveLength(1);
      for (let i = 0; i < 100 && list.length < 2; i += 1) {
        await new Promise((r) => setTimeout(r, 30));
        list = await log();
      }
      expect(list.length).toBe(2);
    } finally {
      delete process.env.FAKE_MANAGER_ANSWER;
    }
  });

  it("runs Claude Code in auto mode when the CLI has it, and falls back when it cannot use it", async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_AUTO = "1";
    const config = path.join(dir, "claude-config");
    process.env.CLAUDE_CONFIG_DIR = config;
    const memory = claudeMemoryDir(dir, config);
    await mkdir(memory, { recursive: true });
    clearAutoModeCache();
    try {
      await setRunner("b", { provider: "claude" });
      await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
      await waitFor("T3", "done");
      const first = (await invocations())[0]!;
      expect(first.args[first.args.indexOf("--permission-mode") + 1]).toBe("auto");
      // Edits in the chat's folders need no review, and Claude Code may look at its own notes.
      expect(first.args).toContain(`Edit(/${dir}/**)`);
      expect(first.args.join(" ")).toContain(`--add-dir ${memory}`);
      expect(first.args).toContain("Bash(sysctl:*)");

      // The account cannot use auto mode: the CLI runs in its default mode, the next run gets the usual permissions.
      process.env.FAKE_MODE = "default";
      await call("POST", `/api/projects/${key}/events`, { task: "T3", type: "reopened" });
      await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
      await waitFor("T3", "done");
      const log = (await call("GET", `/api/projects/${key}/runners`)).json.runs[0];
      const lines = (await call("GET", `/api/runs/${log.id}/log`)).json.lines.join("\n");
      expect(lines).toContain("could not use auto mode");
      delete process.env.FAKE_MODE;
      await call("POST", `/api/projects/${key}/events`, { task: "T3", type: "reopened" });
      await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
      await waitFor("T3", "done");
      const third = (await invocations())[2]!;
      expect(third.args[third.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");

      // Turned off in the chat's settings.
      await setRunner("b", { provider: "claude", autoPermissions: false });
      const off = (await call("GET", `/api/projects/${key}/runners`)).json.settings.chats.b;
      expect(off.autoPermissions).toBe(false);
    } finally {
      delete process.env.FAKE_AUTO;
      delete process.env.FAKE_MODE;
      delete process.env.CLAUDE_CONFIG_DIR;
      clearAutoModeCache();
    }
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
    // Sent again: the same conversation, told to go on from where it stopped.
    process.env.FAKE_SCENARIO = "done";
    await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
    await waitFor("T1", "done");
    // The run was stopped before the CLI started a conversation: it checks the folder and goes on.
    const again = (await invocations()).at(-1)!;
    expect(again.stdin).toContain("TASK T1 WAS STARTED BEFORE and interrupted");
  });

  it("parks a task when the CLI's usage limit is used up, sends nothing else to that CLI, and goes on when it resets", async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_SCENARIO = "limitonce";
    await setRunner("b", { provider: "claude" });
    await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
    await waitFor("T3", "blocked");
    let detail = (await call("GET", `/api/projects/${key}`)).json;
    const view = detail.board.tasks.find((t: { id: string }) => t.id === "T3");
    expect(view.reason).toMatch(/^Usage limit: Claude Code · until \d{4}-/);
    let state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.limits).toEqual([expect.objectContaining({ agent: "b", cli: "Claude Code", known: true })]);
    expect(Date.parse(state.limits[0].until)).toBeGreaterThan(Date.now() + 3_500_000);
    // Not a failure, nothing for the person: automatic dispatch and the manager leave it alone.
    expect(detail.events.some((e: { task: string; type: string }) => e.task === "T3" && e.type === "failed")).toBe(false);
    expect(state.limits[0].basis).toBe("message");
    expect(running.runs.isLimited(key, "b")).toBe(true);
    // The limit resets (here the person says it is over): the task goes on with its chat by itself.
    expect((await call("POST", `/api/projects/${key}/limits/retry`, { agent: "b" }, false)).status).toBe(401);
    expect((await call("POST", `/api/projects/${key}/limits/retry`, { agent: "b" })).status).toBe(200);
    await waitFor("T3", "done");
    state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.limits).toEqual([]);
    expect((await call("POST", `/api/projects/${key}/limits/retry`, { agent: "b" })).status).toBe(409);
  });

  it("goes on by the clock when the limit resets, also right after the computer wakes up", async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_SCENARIO = "limitonce";
    await setRunner("b", { provider: "claude" });
    await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
    await waitFor("T3", "blocked");
    expect(running.runs.hasLimits()).toBe(true);
    await running.runs.checkLimits();
    expect(running.runs.hasLimits()).toBe(true);
    // The reset time has passed (the computer slept through it): the next look of the clock lets it go on.
    const limits = (running.runs as unknown as { limits: Map<string, { until: number }> }).limits;
    for (const l of limits.values()) l.until = Date.now() - 1000;
    await running.runs.checkLimits();
    await waitFor("T3", "done");
    expect(running.runs.hasLimits()).toBe(false);
    const last = (await invocations()).at(-1)!;
    expect(last.stdin).toMatch(/WAS STARTED BEFORE|usage limit has reset|ALREADY WORKED ON TASK/);
  });

  it("leaves a chat the person stopped alone, and stops everything at once", async () => {
    process.env.FAKE_SCENARIO = "sleep";
    await setRunner("a", { provider: "codex" });
    await call("POST", `/api/projects/${key}/runners`, { autoDispatch: true, maxConcurrent: 1 });
    await waitFor("T1", "dispatched");
    let state = (await call("GET", `/api/projects/${key}/runners`)).json;
    await call("POST", `/api/runs/${state.runs[0].id}/stop`, {});
    await waitFor("T1", "blocked");
    state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.held).toEqual(["a"]);
    // Ready again, but automatic dispatch does not hand it back to the stopped chat.
    await call("POST", `/api/projects/${key}/events`, { task: "T1", type: "reopened" });
    await new Promise((r) => setTimeout(r, 1200));
    const status = async () => (await call("GET", `/api/projects/${key}`)).json.board.tasks.find((t: { id: string }) => t.id === "T1").status;
    expect(await status()).toBe("ready");
    // Sending it by hand releases the chat.
    expect((await call("POST", `/api/projects/${key}/tasks/T1/run`, {})).status).toBe(201);
    await waitFor("T1", "dispatched");
    expect((await call("GET", `/api/projects/${key}/runners`)).json.held).toEqual([]);
    expect((await call("POST", `/api/projects/${key}/runs/stop`, {}, false)).status).toBe(401);
    const all = await call("POST", `/api/projects/${key}/runs/stop`, {});
    expect(all.json).toEqual({ stopped: 1 });
    await waitFor("T1", "blocked");
    expect((await call("GET", `/api/projects/${key}/runners`)).json.settings.autoDispatch).toBe(false);
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
  it("counts what a run added to a conversation the CLI counts as a whole", () => {
    expect(runUsage("codex", { input: 1600, cached: 1300, output: 80 }, { input: 1000, cached: 800, output: 50 })).toEqual({ input: 600, cached: 500, output: 30 });
    // Smaller than before: the CLI counted the run alone (or a new conversation).
    expect(runUsage("codex", { input: 300 }, { input: 1000 })).toEqual({ input: 300 });
    expect(runUsage("claude", { input: 900, costUsd: 12.5 }, { costUsd: 10 })).toEqual({ input: 900, costUsd: 2.5 });
    expect(runUsage("gemini", { input: 5 }, { input: 1 })).toEqual({ input: 5 });
    expect(conversationUsage("codex", { input: 1, cached: 0, output: 2, context: 9 })).toEqual({ input: 1, cached: 0, output: 2 });
    expect(conversationUsage("claude", { input: 1 })).toBeUndefined();
    expect(conversationUsage("gemini", { input: 1 })).toBeUndefined();
  });

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
    const cursor = buildInvocation({ runner: { ...base, provider: "cursor", access: "edit" }, prompt: "P", cwd: "/w", resume: "c1", newSessionId: "u" });
    expect(cursor.args).toEqual(["-p", "--output-format", "stream-json", "--trust", "--workspace", "/w", "--resume=c1", "--force", "--sandbox", "enabled", "--model", "m1", "P"]);
    expect(cursor).toMatchObject({ command: "cursor-agent", format: "cursor" });
    expect(cursor.sessionId).toBeUndefined();
    const ask = buildInvocation({ runner: { ...base, provider: "cursor", access: "readonly", model: "auto" }, prompt: "P", cwd: "/w", newSessionId: "u" });
    expect(ask.args).toEqual(["-p", "--output-format", "stream-json", "--trust", "--workspace", "/w", "--mode", "ask", "P"]);
    expect(() => buildInvocation({ runner: { ...base, provider: "manual" }, prompt: "P", cwd: "/w", newSessionId: "u" })).toThrow();
  });

  it("reads Cursor CLI's stream and its model list", () => {
    const c = new OutputParser("cursor");
    c.feed(JSON.stringify({ type: "system", subtype: "init", apiKeySource: "login", cwd: "/w", session_id: "chat-1", model: "GPT-5", permissionMode: "default" }));
    const tool = c.feed(JSON.stringify({ type: "tool_call", subtype: "started", call_id: "1", tool_call: { readToolCall: { args: { path: "README.md" } } }, session_id: "chat-1" }));
    expect(tool).toEqual([{ kind: "tool" }, { kind: "activity", text: "⚙ read README.md" }]);
    c.feed(JSON.stringify({ type: "tool_call", subtype: "started", call_id: "2", tool_call: { writeToolCall: { args: { path: "src/a.ts", fileText: "x" } } } }));
    c.feed(JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "2", tool_call: { writeToolCall: { args: {}, result: { success: {} } } } }));
    c.feed(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hel" }] }, timestamp_ms: 1 }));
    c.feed(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] }, session_id: "chat-1" }));
    c.feed(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "chat-1" }));
    expect(c.sessionId).toBe("chat-1");
    expect(c.tools).toBe(2);
    expect(c.usage.model).toBe("GPT-5");
    expect(c.finalMessage()).toBe("Done.");
    expect(c.result?.ok).toBe(true);
    expect(parseCursorModels("Available models:\n  auto - Auto (current)\n  gpt-5 - GPT-5\n  sonnet-4.5\nTip: use --model\n").map((m) => [m.id, m.label])).toEqual([
      ["auto", "Auto"],
      ["gpt-5", "GPT-5"],
      ["sonnet-4.5", "sonnet-4.5"],
    ]);
  });

  it("runs a task with Cursor CLI and continues its chat", async () => {
    process.env.FAKE_SCENARIO = "done";
    await setRunner("b", { provider: "cursor", extraArgs: "--fake-format cursor" });
    await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
    await waitFor("T3", "done");
    const state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.runs[0]).toMatchObject({ provider: "cursor", state: "finished", sessionId: "cursor-chat-1", tools: 1 });
    expect(state.settings.chats.b.sessionId).toBe("cursor-chat-1");
    const first = (await invocations()).at(-1)!;
    expect(first.args.slice(0, 6)).toEqual(["-p", "--output-format", "stream-json", "--trust", "--workspace", first.cwd]);
    expect(first.args.at(-1)).toContain("TASK T3");
    // The next message goes to the same chat.
    await call("POST", `/api/projects/${key}/agents/b/reply`, { text: "One more thing.", task: "T3" });
    for (let i = 0; i < 50 && !(await invocations()).some((x) => x.args.includes("--resume=cursor-chat-1")); i += 1) await new Promise((r) => setTimeout(r, 60));
    expect((await invocations()).some((x) => x.args.includes("--resume=cursor-chat-1") && x.args.at(-1) === "One more thing.")).toBe(true);
  });

  it("builds DeepSeek CLI's command line: one task per run, its model as an overlay, the same session next time", () => {
    const base = { ...DEFAULT_RUNNER, provider: "deepseek" as const };
    const edit = buildInvocation({ runner: { ...base, model: "deepseek-v4-pro", effort: "high" }, prompt: "P", cwd: "/w", newSessionId: "u", addDirs: ["/plan", "/repo/.git"] });
    const patch = path.join(tmpdir(), "aitrack-deepseek", "deepseek-v4-pro-high.yml");
    expect(edit).toMatchObject({ command: "dsh", format: "dsh", stdin: "P" });
    expect(edit.args).toEqual([
      "--profile", "headless", "--patch", patch, "--json",
      "--permission-mode", "workspace-write", "--approval-policy", "never",
      "--add-dir", "/plan", "--add-dir", "/repo/.git", "-",
    ]);
    expect(edit.sessionId).toBeUndefined();
    expect(edit.files).toEqual([{ path: patch, content: expect.stringContaining('model: "deepseek-v4-pro"') }]);
    expect(edit.files![0]!.content).toContain('reasoningEffort: "high"');
    expect(edit.files![0]!.content).toContain("- id: agent-default-model");
    // Read only, a session to continue, no model chosen: no overlay, no folders granted.
    const ask = buildInvocation({ runner: { ...base, access: "readonly" }, prompt: "P", cwd: "/w", resume: "session-9", newSessionId: "u", addDirs: ["/plan"] });
    expect(ask.args).toEqual(["--profile", "headless", "--json", "--permission-mode", "read-only", "--approval-policy", "never", "--session-id", "session-9", "-"]);
    expect(ask.files).toBeUndefined();
    const full = buildInvocation({ runner: { ...base, access: "full", effort: "max" }, prompt: "P", cwd: "/w", newSessionId: "u" });
    expect(full.args).toContain("danger-full-access");
    expect(full.files![0]!.content).toContain('model: "deepseek-flash"');
  });

  it("reads DeepSeek CLI's events: session, tools, refused steps, tokens and the answer", () => {
    const d = new OutputParser("dsh");
    d.feed(JSON.stringify({ type: "session", sessionId: "session-1", cwd: "/w" }));
    d.feed(JSON.stringify({ type: "thinking", text: "hmm" }));
    expect(d.feed(JSON.stringify({ type: "tool_call", callId: "a", tool: "bash", input: { command: "npm test" } }))).toEqual([{ kind: "tool" }, { kind: "activity", text: "$ npm test" }]);
    expect(d.feed(JSON.stringify({ type: "tool_result", callId: "a", status: "error", result: "no", error: { name: "ApprovalError", code: "APPROVAL_REJECTED" } }))).toEqual([
      { kind: "denied", tool: "Bash npm test" },
      { kind: "activity", text: "⛔ permission denied: Bash npm test" },
    ]);
    expect(d.feed(JSON.stringify({ type: "tool_call", callId: "b", tool: "write", input: { path: "src/a.ts", content: "x" } }))[1]).toEqual({ kind: "activity", text: "✎ src/a.ts" });
    d.feed(JSON.stringify({ type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 20 } }));
    d.feed(JSON.stringify({ type: "status", phase: "step_end", turn: 1, step: 2, usage: { inputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 10, outputTokens: 30 } }));
    d.feed(JSON.stringify({ type: "text", text: "Done." }));
    d.feed(JSON.stringify({ type: "final", sessionId: "session-1", reason: { kind: "completed" }, text: "Done." }));
    expect(d.sessionId).toBe("session-1");
    expect(d.tools).toBe(2);
    expect(d.denials).toEqual(["Bash npm test"]);
    expect(d.usage).toMatchObject({ input: 2060, cached: 1900, output: 50, context: 1090, turns: 2 });
    expect(d.finalMessage()).toBe("Done.");
    expect(d.result).toMatchObject({ ok: true });
    // A run that ends in an error says why.
    const e = new OutputParser("dsh");
    e.feed(JSON.stringify({ type: "final", sessionId: "s", reason: { kind: "error", error: { message: "no API key", code: "MISSING_CREDENTIAL" } }, text: "" }));
    expect(e.result).toEqual({ ok: false, error: "MISSING_CREDENTIAL: no API key" });
  });

  it("runs a task with DeepSeek CLI, writes its model overlay and continues its session", async () => {
    process.env.FAKE_SCENARIO = "done";
    await setRunner("b", { provider: "deepseek", model: "deepseek-v4-pro", effort: "high", extraArgs: "--fake-format dsh" });
    await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
    await waitFor("T3", "done");
    const state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.runs[0]).toMatchObject({ provider: "deepseek", state: "finished", sessionId: "session-dsh-1", tools: 2 });
    expect(state.runs[0].usage).toMatchObject({ input: 2100, cached: 2000, output: 50 });
    expect(state.settings.chats.b.sessionId).toBe("session-dsh-1");
    const first = (await invocations()).at(-1)!;
    expect(first.args.slice(0, 2)).toEqual(["--profile", "headless"]);
    expect(first.args.at(-1)).toBe("-");
    expect(first.stdin).toContain("TASK T3");
    const overlay = first.args[first.args.indexOf("--patch") + 1]!;
    expect(await readFile(overlay, "utf8")).toContain('model: "deepseek-v4-pro"');
    // The next message goes to the same session.
    await call("POST", `/api/projects/${key}/agents/b/reply`, { text: "One more thing.", task: "T3" });
    for (let i = 0; i < 50 && !(await invocations()).some((x) => x.args.includes("session-dsh-1")); i += 1) await new Promise((r) => setTimeout(r, 60));
    const second = (await invocations()).find((x) => x.args.includes("--session-id"))!;
    expect(second.args[second.args.indexOf("--session-id") + 1]).toBe("session-dsh-1");
    expect(second.stdin).toBe("One more thing.");
  });

  it("builds Antigravity CLI's command line: print mode, its permission modes, the same conversation next time", () => {
    const base = { ...DEFAULT_RUNNER, provider: "antigravity" as const };
    const edit = buildInvocation({ runner: { ...base, model: "claude-opus-5.5-thinking", effort: "high" }, prompt: "P", cwd: "/w", newSessionId: "u", addDirs: ["/plan"] });
    expect(edit.command).toBe("agy");
    expect(edit.args).toEqual(["-p", "P", "--output-format", "stream-json", "--mode", "auto", "--add-dir", "/plan", "--model", "claude-opus-5.5-thinking", "--effort", "high"]);
    expect(edit.format).toBe("agy");
    expect(edit.sessionId).toBeUndefined();
    const again = buildInvocation({ runner: { ...base, access: "readonly" }, prompt: "P", cwd: "/w", resume: "conv-9", newSessionId: "u" });
    expect(again.args).toEqual(["-p", "P", "--output-format", "stream-json", "--conversation", "conv-9", "--mode", "plan"]);
    expect(buildInvocation({ runner: { ...base, access: "full" }, prompt: "P", cwd: "/w", newSessionId: "u" }).args).toContain("--dangerously-skip-permissions");
    // Its quoted model names are taken as they are.
    expect(normalizeRunner({ provider: "antigravity", model: "Orchestrator (Carbon)" }).model).toBe("Orchestrator (Carbon)");
    expect(() => normalizeRunner({ provider: "antigravity", model: "two words" })).toThrow();
  });

  it("reads Antigravity CLI's events and the models of the signed-in account", () => {
    const p = new OutputParser("agy");
    const lines = [
      { event: "init", conversation_id: "c-1", init: { cwd: "/w", model: "gemini-3.8-flash-medium" } },
      { event: "step_update", step_update: { conversation_id: "c-1", state: "ACTIVE", step_type: "tool", tool_info: { name: "run_command", parameters: { CommandLine: "npm ci" } } } },
      { event: "step_update", step_update: { conversation_id: "c-1", state: "DONE", step_type: "tool", tool_info: { name: "run_command", parameters: { CommandLine: "npm ci" }, error: { type: "PERMISSION_DENIED", message: "soft-denied" } } } },
      { event: "step_update", step_update: { conversation_id: "c-1", state: "ACTIVE", step_type: "agent_response", text_delta: "Hello " } },
      { event: "step_update", step_update: { conversation_id: "c-1", state: "ACTIVE", step_type: "agent_response", text_delta: "there." } },
      { event: "step_update", step_update: { conversation_id: "c-1", state: "DONE", step_type: "agent_response" } },
      { event: "result", result: { conversation_id: "c-1", status: "SUCCESS", response: "Hello there.", num_turns: 3, usage: { input_tokens: 500, cache_read_tokens: 300, output_tokens: 20 } } },
    ];
    const events = lines.flatMap((l) => p.feed(JSON.stringify(l)));
    expect(p.sessionId).toBe("c-1");
    expect(events.find((e) => e.kind === "activity")).toEqual({ kind: "activity", text: "$ npm ci" });
    expect(p.denials).toEqual(["Bash npm ci"]);
    expect(p.tools).toBe(1);
    expect(p.finalMessage()).toBe("Hello there.");
    expect(p.result).toMatchObject({ ok: true });
    expect(p.usage).toMatchObject({ model: "gemini-3.8-flash-medium", input: 500, cached: 300, output: 20, turns: 3 });
    const failed = new OutputParser("agy");
    failed.feed(JSON.stringify({ event: "result", result: { status: "ERROR", error: { message: "unknown model" } } }));
    expect(failed.result).toEqual({ ok: false, error: "unknown model" });

    expect(parseAgyModels('Available models:\n  gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)\n  * claude-opus-5.5-thinking - Claude Opus 5.5 (Thinking)\n  "Orchestrator (Carbon)"\n')).toEqual([
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "claude-opus-5.5-thinking", label: "Claude Opus 5.5 (Thinking)" },
      { id: "Orchestrator (Carbon)", label: "Orchestrator (Carbon)" },
    ]);
    expect(parseAgyModels('[{"slug":"gpt-oss-120b","display_name":"GPT-OSS-120b"}]')).toEqual([{ id: "gpt-oss-120b", label: "GPT-OSS-120b" }]);
  });

  it("runs a task with Antigravity CLI and continues its conversation", async () => {
    process.env.FAKE_FORMAT = "agy";
    process.env.FAKE_SCENARIO = "ask";
    await setRunner("b", { provider: "antigravity" });
    await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
    await waitFor("T3", "blocked");
    const state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.settings.chats.b.sessionId).toBe("conv-1");
    expect(state.runs[0].usage).toMatchObject({ input: 1200, cached: 900, output: 80 });
    process.env.FAKE_SCENARIO = "done";
    await call("POST", `/api/projects/${key}/agents/b/reply`, { text: "Go on." });
    await waitFor("T3", "done");
    const second = (await invocations())[1]!;
    expect(second.args.slice(0, 2)).toEqual(["-p", "Go on."]);
    expect(second.args[second.args.indexOf("--conversation") + 1]).toBe("conv-1");
  });

  it("finds the shared git folder of a worktree, for DeepSeek's sandbox", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "aitrack-git-"));
    const common = path.join(repo, "main", ".git");
    await mkdir(path.join(common, "worktrees", "w"), { recursive: true });
    await writeFile(path.join(common, "worktrees", "w", "commondir"), "../..\n");
    const tree = path.join(repo, "w");
    await mkdir(tree);
    await writeFile(path.join(tree, ".git"), `gitdir: ${path.join(common, "worktrees", "w")}\n`);
    expect(gitCommonDir(tree)).toBe(await realpath(common));
    // An ordinary checkout keeps its .git inside.
    expect(gitCommonDir(path.join(repo, "main"))).toBeNull();
    expect(gitCommonDir(path.join(repo, "nope"))).toBeNull();
  });

  it("lets Claude Code run the usual work commands when it may edit files", () => {
    const base = { ...DEFAULT_RUNNER, provider: "claude" as const };
    const edit = buildInvocation({ runner: { ...base, allowedTools: "WebFetch" }, prompt: "P", cwd: "/w", newSessionId: "u", addDirs: ["/plan", "/w"] });
    const tools = edit.args.slice(edit.args.indexOf("--allowedTools") + 1);
    expect(tools).toEqual(expect.arrayContaining(["Bash(grep:*)", "Bash(find:*)", "Bash(node:*)", "Bash(git commit:*)", "WebFetch"]));
    expect(tools).not.toContain("Bash(rm:*)");
    expect(tools).not.toContain("Bash(git push:*)");
    expect(edit.args.join(" ")).toContain("--add-dir /plan --allowedTools");
    const off = buildInvocation({ runner: { ...base, workCommands: false }, prompt: "P", cwd: "/w", newSessionId: "u" });
    expect(off.args).not.toContain("--allowedTools");
    const readonly = buildInvocation({ runner: { ...base, access: "readonly" }, prompt: "P", cwd: "/w", newSessionId: "u" });
    expect(readonly.args).not.toContain("--allowedTools");
    expect(readonly.args).toContain("plan");
  });

  it("asks Claude Code for auto mode only with edit access, and reads the mode it really runs in", () => {
    const base = { ...DEFAULT_RUNNER, provider: "claude" as const };
    const auto = buildInvocation({ runner: base, prompt: "P", cwd: "/w", newSessionId: "u", addDirs: ["/plan"], autoMode: true });
    expect(auto.permissionMode).toBe("auto");
    expect(auto.args).toEqual(expect.arrayContaining(["--permission-mode", "auto", "Edit(//w/**)", "Edit(//plan/**)", "Bash(system_profiler:*)"]));
    expect(buildInvocation({ runner: base, prompt: "P", cwd: "/w", newSessionId: "u" }).permissionMode).toBe("acceptEdits");
    expect(buildInvocation({ runner: { ...base, autoPermissions: false }, prompt: "P", cwd: "/w", newSessionId: "u", autoMode: true }).permissionMode).toBe("acceptEdits");
    expect(buildInvocation({ runner: { ...base, access: "readonly" }, prompt: "P", cwd: "/w", newSessionId: "u", autoMode: true }).permissionMode).toBe("plan");
    const plain = buildInvocation({ runner: base, prompt: "P", cwd: "/w", newSessionId: "u" });
    expect(plain.args.some((a) => a.startsWith("Edit("))).toBe(false);

    expect(helpHasAutoMode('  --permission-mode <mode>  Permission mode\n      (choices: "acceptEdits", "auto",\n      "bypassPermissions", "plan")')).toBe(true);
    expect(helpHasAutoMode('  --permission-mode <mode>  Permission mode (choices: "acceptEdits", "bypassPermissions", "plan")\n  --auto-update "auto"')).toBe(false);

    const parser = new OutputParser("claude");
    const events = parser.feed(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", permissionMode: "default" }));
    expect(events).toEqual([{ kind: "session", id: "s-1" }, { kind: "mode", mode: "default" }]);
    expect(parser.mode).toBe("default");
  });

  it("keeps the other folders a Claude chat may use, as full paths", () => {
    expect(normalizeRunner({ provider: "claude", extraDirs: "/a/b/\n\n/c/d\n/a/b" }).extraDirs).toBe("/a/b\n/c/d");
    expect(() => normalizeRunner({ provider: "claude", extraDirs: "relative/dir" })).toThrow(/absolute/);
    expect(claudeMemoryDir("/Users/me/my_app.v2", "/cfg")).toBe("/cfg/projects/-Users-me-my-app-v2/memory");
    // Copilot takes them as --add-dir, Gemini as --include-directories.
    const copilot = buildInvocation({ runner: { ...DEFAULT_RUNNER, provider: "copilot" }, prompt: "P", cwd: "/w", newSessionId: "u", addDirs: ["/a", "/b"] });
    expect(copilot.args.join(" ")).toContain("--add-dir /a --add-dir /b");
    const gemini = buildInvocation({ runner: { ...DEFAULT_RUNNER, provider: "gemini" }, prompt: "P", cwd: "/w", newSessionId: "u", addDirs: ["/a", "/b", "/w"] });
    expect(gemini.args.slice(gemini.args.indexOf("--include-directories"), gemini.args.indexOf("--include-directories") + 2)).toEqual(["--include-directories", "/a,/b"]);
  });

  it("gives every chat of a project the project's folders, on top of its own", async () => {
    process.env.FAKE_FORMAT = "claude";
    const own = path.join(dir, "own");
    const shared = path.join(dir, "shared");
    await mkdir(own);
    await mkdir(shared);
    expect((await call("POST", `/api/projects/${key}/runners`, { extraDirs: "relative/dir" })).status).toBe(400);
    const saved = await call("POST", `/api/projects/${key}/runners`, { extraDirs: `${shared}\n\n${path.join(dir, "gone")}` });
    expect(saved.json.extraDirs).toBe(`${shared}\n${path.join(dir, "gone")}`);
    await setRunner("b", { provider: "claude", extraDirs: own });
    await call("POST", `/api/projects/${key}/tasks/T3/run`, {});
    await waitFor("T3", "done");
    const [inv] = await invocations();
    const at = inv!.args.indexOf("--add-dir");
    expect(inv!.args.slice(at + 1, at + 4)).toEqual(expect.arrayContaining([own, shared]));
    // A folder that is gone would stop the CLI: it is left out.
    expect(inv!.args).not.toContain(path.join(dir, "gone"));
    expect((await call("GET", `/api/projects/${key}/runners`)).json.settings.extraDirs).toBe(`${shared}\n${path.join(dir, "gone")}`);
  });

  it("passes the model and reasoning effort to each CLI", () => {
    const base = { ...DEFAULT_RUNNER, effort: "xhigh" };
    const codex = buildInvocation({ runner: { ...base, provider: "codex", model: "gpt-6-sol" }, prompt: "P", cwd: "/w", newSessionId: "u" });
    expect(codex.args).toEqual(expect.arrayContaining(["-m", "gpt-6-sol", "-c", 'model_reasoning_effort="xhigh"']));
    const claude = buildInvocation({ runner: { ...base, provider: "claude", model: "opus" }, prompt: "P", cwd: "/w", newSessionId: "u" });
    expect(claude.args.join(" ")).toContain("--model opus --effort xhigh");
    const copilot = buildInvocation({ runner: { ...base, provider: "copilot", model: "auto" }, prompt: "P", cwd: "/w", newSessionId: "u" });
    expect(copilot.args.join(" ")).toContain("--model auto --reasoning-effort xhigh");
    const gemini = buildInvocation({ runner: { ...base, provider: "gemini", model: "pro" }, prompt: "P", cwd: "/w", newSessionId: "u" });
    expect(gemini.args.join(" ")).not.toContain("xhigh");
  });

  it("refuses model names the CLI would not understand, and keeps the runner when loading an old one", async () => {
    expect(() => normalizeRunner({ provider: "claude", model: "Opus 5.5 Extra High" })).toThrow(/not a model name/);
    expect(normalizeRunner({ provider: "claude", model: "claude-opus-5-5", effort: "max" })).toMatchObject({ model: "claude-opus-5-5", effort: "max" });
    const dataDir = await mkdtemp(path.join(tmpdir(), "aitrack-store-"));
    await writeFile(path.join(dataDir, "runners.json"), JSON.stringify({ projects: { k: { chats: { a: { provider: "claude", model: "Opus 5.5 Extra High" } } } } }));
    const store = new RunnerStore(dataDir);
    await store.load();
    expect(store.chat("k", "a")).toMatchObject({ provider: "claude", model: undefined });
  });

  it("reads the model lists of Codex and Copilot", () => {
    const codex = parseCodexModels(
      JSON.stringify({
        models: [
          { slug: "b", display_name: "B", visibility: "list", priority: 2, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "low" },
          { slug: "hidden", visibility: "hide", priority: 0 },
          { slug: "a", display_name: "A", visibility: "list", priority: 1 },
        ],
      }),
    );
    expect(codex.map((m) => m.id)).toEqual(["a", "b"]);
    expect(codex[1]).toMatchObject({ efforts: ["low", "high"], defaultEffort: "low" });
    const help = 'Settings:\n  `model`: AI model to use; see /model.\n    - "claude-sonnet-5.5"\n    - "gpt-6-sol"\n\n  `other`: x\n';
    expect(parseCopilotModels(help).map((m) => m.id)).toEqual(["claude-sonnet-5.5", "gpt-6-sol"]);
    expect(parseCopilotModels("nothing here")).toEqual([]);
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
    expect(events.slice(0, 2)).toEqual([
      { kind: "denied", tool: "Bash rm -rf x" },
      { kind: "activity", text: "⛔ permission denied: Bash rm -rf x" },
    ]);
    expect(c.denials).toEqual(["Bash rm -rf x"]);
    expect(c.result?.ok).toBe(true);
  });

  it("normalizes hook payloads", () => {
    expect(normalizeHook({ hook_event_name: "Notification", session_id: "s", message: "Claude needs your permission" })).toMatchObject({ tool: "claude", event: "attention", message: "Claude needs your permission" });
    expect(normalizeHook({ hook_event_name: "PreToolUse" })).toBeNull();
    expect(normalizeHook({ event: "stop", sessionId: "z" }, { tool: "cursor", chat: "a" })).toMatchObject({ tool: "cursor", chat: "a", sessionId: "z" });
  });

  it("writes a project plan with an installed CLI, read-only, and can be stopped", async () => {
    const input = { projectId: "shop", projectName: "Shop", language: "en", chats: [{ id: "claude-a", name: "Claude A" }], plan: "A landing page.", canReadRepository: true };
    expect((await call("POST", "/api/authoring/generate", { provider: "claude", binary: FAKE, cwd: dir, input }, false)).status).toBe(401);
    expect((await call("POST", "/api/authoring/generate", { provider: "custom", binary: FAKE, cwd: dir, input })).status).toBe(400);
    expect((await call("POST", "/api/authoring/generate", { provider: "claude", binary: FAKE, cwd: path.join(dir, "nope"), input })).status).toBe(400);

    process.env.FAKE_SCENARIO = "project";
    process.env.FAKE_FORMAT = "claude";
    const started = await call("POST", "/api/authoring/generate", { provider: "claude", binary: FAKE, cwd: dir, input });
    expect(started.status).toBe(201);
    let job = started.json;
    for (let i = 0; i < 100 && job.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await call("GET", `/api/authoring/generate/${job.id}`)).json;
    }
    expect(job.state).toBe("done");
    expect(job.activity.some((a: string) => a.includes("Read README.md"))).toBe(true);
    const logged = (await readFile(fakeLog, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).pop();
    expect(logged.cwd).toBe(dir);
    expect(logged.args[logged.args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(logged.args).toContain("--disallowedTools");
    expect(logged.stdin).toContain("Do not change, create or delete any file");
    const check = await call("POST", "/api/authoring/check", { answer: job.answer, input });
    expect(check.json.errors).toEqual([]);
    expect(check.json.summary.tasks.map((t: { id: string }) => t.id)).toEqual(["T-01", "T-02", "T-03", "T-04"]);

    process.env.FAKE_SCENARIO = "sleep";
    process.env.FAKE_FORMAT = "codex";
    const slow = await call("POST", "/api/authoring/generate", { provider: "codex", binary: FAKE, cwd: dir, input });
    const codexArgs = await (async () => {
      for (let i = 0; i < 40; i++) {
        const lines = (await readFile(fakeLog, "utf8")).trim().split("\n");
        const last = JSON.parse(lines[lines.length - 1]!);
        if (last.args.includes("read-only")) return last.args as string[];
        await new Promise((r) => setTimeout(r, 50));
      }
      return [];
    })();
    expect(codexArgs).toEqual(expect.arrayContaining(["-s", "read-only"]));
    const stopped = await call("POST", `/api/authoring/generate/${slow.json.id}/stop`, {});
    expect(stopped.status).toBe(200);
    let s2 = stopped.json;
    for (let i = 0; i < 100 && s2.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      s2 = (await call("GET", `/api/authoring/generate/${slow.json.id}`)).json;
    }
    expect(s2.state).toBe("stopped");
  });

  it("explains a missing code folder and offers the plan's folder", async () => {
    const other = path.join(dir, "plan", "docs");
    await mkdir(other, { recursive: true });
    const planFile = path.join(other, "p.aitrack");
    await writeFile(planFile, serializeProject({ ...project, project: { ...project.project, id: "p2" }, settings: { ...project.settings, repoPath: "../../code" } }));
    const added = await call("POST", "/api/projects", { filePath: planFile });
    const k = added.json.key as string;
    const state = (await call("GET", `/api/projects/${k}/runners`)).json;
    expect(state.defaultWorkdir).toBe(path.join(dir, "code"));
    expect(state.defaultWorkdirExists).toBe(false);
    expect(state.planFolder).toBe(other);
    await call("POST", `/api/projects/${k}/runners/a`, { runner: { provider: "codex", binary: FAKE } });
    const res = await call("POST", `/api/projects/${k}/tasks/T1/run`, {});
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/code folder does not exist yet/);
    expect((await call("POST", `/api/projects/${k}/runners/a`, { runner: { provider: "codex", binary: FAKE, workdir: path.join(dir, "nope") } })).status).toBe(400);
    const gone = path.join(dir, "gone");
    await mkdir(gone);
    await call("POST", `/api/projects/${k}/runners/a`, { runner: { provider: "codex", binary: FAKE, workdir: gone } });
    await rm(gone, { recursive: true });
    const res2 = await call("POST", `/api/projects/${k}/tasks/T1/run`, {});
    expect(res2.json.error).toMatch(/working folder was not found/);
    await call("POST", `/api/projects/${k}/runners/a`, { runner: { provider: "codex", binary: FAKE, workdir: other } });
    expect((await call("POST", `/api/projects/${k}/tasks/T1/run`, {})).status).toBe(201);
  });

  it("creates a missing code folder or points the plan at another one", async () => {
    const docs = path.join(dir, "site", "docs");
    await mkdir(docs, { recursive: true });
    const planFile = path.join(docs, "p.aitrack");
    await writeFile(planFile, serializeProject({ ...project, project: { ...project.project, id: "p3" }, settings: { ...project.settings, repoPath: "../../platform" } }));
    const k = (await call("POST", "/api/projects", { filePath: planFile })).json.key as string;
    expect((await call("POST", `/api/projects/${k}/code-folder`, {}, false)).status).toBe(401);
    const made = await call("POST", `/api/projects/${k}/code-folder`, {});
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ path: path.join(dir, "platform"), created: true, git: true });
    expect(existsSync(path.join(dir, "platform", ".git"))).toBe(true);
    expect((await call("GET", `/api/projects/${k}/runners`)).json.defaultWorkdirExists).toBe(true);
    expect((await call("POST", `/api/projects/${k}/code-folder`, {})).json.created).toBe(false);

    // A folder picked in the app is kept relative to the project file.
    const elsewhere = path.join(dir, "elsewhere");
    await mkdir(elsewhere);
    await call("POST", `/api/projects/${k}/info`, { repoPath: elsewhere });
    expect(JSON.parse(await readFile(planFile, "utf8")).settings.repoPath).toBe("../../elsewhere");
    expect((await call("GET", `/api/projects/${k}/runners`)).json.defaultWorkdir).toBe(elsewhere);
    // No code folder: the git repository the plan is in, else its folder.
    await call("POST", `/api/projects/${k}/info`, { repoPath: null });
    expect(JSON.parse(await readFile(planFile, "utf8")).settings.repoPath).toBeUndefined();
    expect((await call("GET", `/api/projects/${k}/runners`)).json.defaultWorkdir).toBe(docs);
  });

  it("starts a new session after a run that never got going", async () => {
    process.env.FAKE_FORMAT = "claude";
    process.env.FAKE_SCENARIO = "noauth";
    await setRunner("a", { provider: "claude" });
    await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
    await waitFor("T1", "failed");
    let state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.settings.chats.a.sessionId).toBeUndefined();
    process.env.FAKE_SCENARIO = "done";
    await call("POST", `/api/projects/${key}/tasks/T1/run`, {});
    await waitFor("T1", "done");
    const calls = (await readFile(fakeLog, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const second = calls[calls.length - 1].args as string[];
    expect(second).toContain("--session-id");
    expect(second).not.toContain("--resume");
    state = (await call("GET", `/api/projects/${key}/runners`)).json;
    expect(state.settings.chats.a.sessionId).toBe(second[second.indexOf("--session-id") + 1]);
  });
});
