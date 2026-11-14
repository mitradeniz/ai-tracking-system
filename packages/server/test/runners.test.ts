import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectFileSchema, serializeProject } from "@aitrack/core";
import { startServer, type RunningServer } from "../src/index.ts";
import { clearAutoModeCache, helpHasAutoMode, parseCodexModels, parseCopilotModels } from "../src/runners/env.ts";
import { claudeMemoryDir } from "../src/runners/runs.ts";
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
      detail = (await call("GET", `/api/projects/${key}`)).json;
      expect(detail.board.tasks.find((t: { id: string }) => t.id === "T3").resumes).toBeNull();
    } finally {
      delete process.env.FAKE_WAIT;
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
