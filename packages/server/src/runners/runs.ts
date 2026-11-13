import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, realpathSync, statSync, type WriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseReports, renderBootstrapPrompt, renderTaskPrompt, type Report, type TaskIssue } from "@aitrack/core";
import { HttpError, type ProjectManager } from "../manager.ts";
import { agentPath, which } from "./env.ts";
import { hookSnippets, type HookSignal } from "./hooks.ts";
import { buildInvocation, OutputParser, PROVIDER_INFO, type ChatRunner, type ProviderId, type RunUsage } from "./providers.ts";
import { normalizeRunner, type ProjectRunners, type RunnerStore } from "./store.ts";

export type RunState = "running" | "waiting" | "finished" | "failed" | "stopped";

export interface RunSummary {
  id: string;
  key: string;
  task: string;
  agent: string;
  provider: ProviderId;
  /** "task" sends the task prompt; "reply" continues the chat with the person's message. */
  kind: "task" | "reply";
  auto: boolean;
  state: RunState;
  startedAt: string;
  endedAt?: string;
  workdir: string;
  sessionId?: string;
  lastActivity?: string;
  lastMessage?: string;
  error?: string;
  lines: number;
  /** Tool calls so far (commands, edits, searches). */
  tools: number;
  usage?: RunUsage;
  /** Tools the CLI refused because of the chat's access level. */
  denials?: string[];
}

interface Run extends RunSummary {
  child: ChildProcess | null;
  log: string[];
  logBase: number;
  file: WriteStream | null;
  stopRequested: boolean;
  stopNote?: string;
  /** The session this run started (not resumed), and the chat's session before it. */
  freshSession?: string;
  priorSession?: string;
  lastProgressAt: number;
  lastUsageEmit: number;
}

export interface RunnerState {
  settings: ProjectRunners;
  defaultWorkdir: string;
  /** False when the project's code folder (settings.repoPath) does not exist yet. */
  defaultWorkdirExists: boolean;
  /** The repository the project file is in: a working folder to offer when the code folder is missing. */
  planFolder: string;
  runs: RunSummary[];
  errors: Record<string, string>;
  hooks: ReturnType<typeof hookSnippets>;
}

const MAX_LOG = 1500;
const PROGRESS_EVERY_MS = 90_000;
const HOLDING = new Set(["dispatched", "in_progress", "blocked"]);

const clip = (s: string, n: number) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const now = () => new Date().toISOString();

/** The repository a project works in: settings.repoPath, else the git root above the file, else its folder. */
export function defaultWorkdir(filePath: string, repoPath: string | undefined): string {
  if (repoPath) return path.resolve(path.dirname(filePath), repoPath);
  return planFolder(filePath);
}

/** The git root above the project file, else its folder. */
export function planFolder(filePath: string): string {
  const dir = path.dirname(filePath);
  let cur = dir;
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return dir;
    cur = parent;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Short note added to every prompt the tracker sends on its own. */
export function runnerPreamble(taskId: string, runner: ChatRunner, language = "English"): string {
  const lines = [
    `You were started by AI Tracking System for task ${taskId}. Nobody watches this session live: a person reads your final message in the tracker and can reply to it.`,
    `- Reporting: skip the HTTP call and the report files described below. Just end your final message with the aitrack-report block; the tracker reads it from your output.`,
    `- If you need a decision, an approval or anything only a person can do, stop, ask clearly in your final message and report status "blocked" with the question as the reason.`,
    `- List anything that failed, was skipped or is missing under "issues" in the report, with a plain ${language} title, what is needed, and a prompt that would fix it.`,
  ];
  if (runner.unattended) {
    lines.push(
      `- Do not wait for approval of your plan: write it down briefly and carry on. Still stop and report "blocked" before anything involving payments, legal terms, identity checks, credentials, publishing, or deleting data or resources.`,
    );
  }
  return lines.join("\n");
}

export class RunManager extends EventEmitter {
  private runs = new Map<string, Run>();
  private autoTimers = new Map<string, NodeJS.Timeout>();
  private autoBusy = new Set<string>();
  private errors = new Map<string, string>();
  private pendingLines = new Map<string, { key: string; from: number; lines: string[] }>();
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly manager: ProjectManager,
    readonly store: RunnerStore,
    readonly dataDir: string,
  ) {
    super();
  }

  private get runsDir(): string {
    return path.join(this.dataDir, "runs");
  }

  private get activeFile(): string {
    return path.join(this.runsDir, "active.json");
  }

  async init(): Promise<void> {
    await this.store.load();
    await mkdir(this.runsDir, { recursive: true });
    // Runs that were going when the app last quit: tell the board they stopped.
    try {
      const stale = JSON.parse(await readFile(this.activeFile, "utf8")) as RunSummary[];
      for (const r of Array.isArray(stale) ? stale : []) {
        try {
          const status = this.manager.context(r.key).board.byId.get(r.task)?.status;
          if (status && HOLDING.has(status) && status !== "blocked") {
            await this.manager.addEvent(
              r.key,
              { type: "blocked", task: r.task, agent: r.agent, reason: "The run stopped when the app closed. Send it again or reply to continue." },
              "runner",
            );
          }
        } catch {
          // The project is no longer open.
        }
      }
    } catch {
      // No interrupted runs.
    }
    await this.persistActive();
    this.manager.on("changed", ({ key }: { key: string }) => this.scheduleAuto(key));
    for (const key of this.manager.keys()) this.scheduleAuto(key);
  }

  // ---- state for the UI -------------------------------------------------------------------------

  state(key: string): RunnerState {
    const ctx = this.manager.context(key);
    const errors: Record<string, string> = {};
    for (const [k, v] of this.errors) if (k.startsWith(`${key}:`)) errors[k.slice(key.length + 1)] = v;
    const base = defaultWorkdir(ctx.filePath, ctx.project.settings.repoPath);
    return {
      settings: this.store.project(key),
      defaultWorkdir: base,
      defaultWorkdirExists: isDir(base),
      planFolder: planFolder(ctx.filePath),
      runs: [...this.runs.values()].filter((r) => r.key === key).map((r) => this.summary(r)).reverse().slice(0, 50),
      errors,
      hooks: hookSnippets(this.manager.serverUrl),
    };
  }

  private summary(r: Run): RunSummary {
    const { child: _c, log: _l, logBase: _b, file: _f, stopRequested: _s, stopNote: _n, lastProgressAt: _p, lastUsageEmit: _u, ...rest } = r;
    return { ...rest, lines: r.logBase + r.log.length };
  }

  log(runId: string, after = 0): { lines: string[]; next: number; run: RunSummary } {
    const r = this.runs.get(runId);
    if (!r) throw new HttpError(404, `Unknown run "${runId}"`);
    const start = Math.max(after, r.logBase) - r.logBase;
    return { lines: r.log.slice(start), next: r.logBase + r.log.length, run: this.summary(r) };
  }

  async saveChat(key: string, agentId: string, input: unknown): Promise<ChatRunner> {
    const { project } = this.manager.context(key);
    if (!project.agents.some((a) => a.id === agentId)) throw new HttpError(404, `Unknown chat "${agentId}"`);
    let runner: ChatRunner;
    try {
      runner = normalizeRunner(input, this.store.chat(key, agentId));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (runner.workdir && !(existsSync(runner.workdir) && statSync(runner.workdir).isDirectory())) {
      throw new HttpError(400, `Folder not found: ${runner.workdir}`);
    }
    await this.store.setChat(key, agentId, runner);
    this.errors.delete(`${key}:${agentId}`);
    this.emit("runners", { key });
    this.scheduleAuto(key);
    return runner;
  }

  async saveProject(key: string, patch: { autoDispatch?: boolean; maxConcurrent?: number }): Promise<ProjectRunners> {
    this.manager.context(key);
    const settings = await this.store.setProject(key, patch);
    this.emit("runners", { key });
    this.scheduleAuto(key);
    return settings;
  }

  // ---- runs -------------------------------------------------------------------------------------

  private activeFor(key: string, agentId: string): Run | undefined {
    return [...this.runs.values()].find((r) => r.key === key && r.agent === agentId && r.state === "running");
  }

  /** Runs going on in every project. */
  activeTotal(): number {
    return [...this.runs.values()].filter((r) => r.state === "running").length;
  }

  private activeCount(key: string): number {
    return [...this.runs.values()].filter((r) => r.key === key && r.state === "running").length;
  }

  /** Sends a task to a chat: starts or continues the chat's session with the task prompt. */
  async start(key: string, taskId: string, agentId?: string, options: { auto?: boolean; extra?: string } = {}): Promise<RunSummary> {
    const { project, board } = this.manager.context(key);
    const view = board.byId.get(taskId);
    if (!view) throw new HttpError(404, `Unknown task "${taskId}"`);
    const settings = this.store.project(key);
    const runnable = (a: string) => (settings.chats[a]?.provider ?? "manual") !== "manual";
    const eligible = [view.task.agent, ...view.task.alsoAgents];
    const agent =
      agentId ??
      (HOLDING.has(view.status) && view.runtime.agent ? view.runtime.agent : undefined) ??
      view.candidates.find(runnable) ??
      eligible.find(runnable);
    if (!agent || !project.agents.some((a) => a.id === agent)) throw new HttpError(400, "No chat with a runner can take this task.");
    const runner = this.store.chat(key, agent);
    if (runner.provider === "manual") throw new HttpError(409, "This chat is run by hand. Set up how it runs first, or copy the prompt.");
    if ([...this.runs.values()].some((r) => r.key === key && r.task === taskId && r.state === "running")) {
      throw new HttpError(409, `Task ${taskId} is already running.`);
    }
    if (this.activeFor(key, agent)) throw new HttpError(409, "This chat is busy with another run.");
    const heldByOther = HOLDING.has(view.status) && view.runtime.agent && view.runtime.agent !== agent;
    if (view.status === "done" || view.status === "review" || heldByOther) {
      throw new HttpError(409, `Task ${taskId} is ${view.status}${heldByOther ? ` with ${view.runtime.agent}` : ""}.`);
    }
    if (view.status === "waiting") throw new HttpError(409, `Task ${taskId} still waits for its dependencies.`);
    if (!eligible.includes(agent) && !HOLDING.has(view.status)) throw new HttpError(400, `Chat ${agent} cannot take task ${taskId}.`);

    const resume = runner.session === "keep" ? runner.sessionId : undefined;
    const parts: string[] = [];
    if (!resume) {
      const bootstrap = renderBootstrapPrompt(project, agent).trim();
      if (bootstrap) parts.push(bootstrap);
    }
    parts.push(runnerPreamble(taskId, runner, project.settings.language === "tr" ? "Turkish" : "English"));
    parts.push(renderTaskPrompt(project, taskId, { serverUrl: this.manager.serverUrl, agentId: agent }));
    const extra = options.extra?.trim();
    if (extra) parts.push(`ADDITIONAL INSTRUCTIONS FROM THE PERSON (they take precedence):\n${extra}`);
    return this.launch({ key, task: taskId, agent, runner, prompt: parts.join("\n\n---\n\n"), resume, kind: "task", auto: options.auto === true });
  }

  /** Continues a chat's session with the person's message (an answer, an approval, a correction). */
  async reply(key: string, agentId: string, message: string, taskId?: string): Promise<RunSummary> {
    const text = message.trim();
    if (!text) throw new HttpError(400, "The reply is empty.");
    const { board } = this.manager.context(key);
    const runner = this.store.chat(key, agentId);
    if (runner.provider === "manual") throw new HttpError(409, "This chat is run by hand.");
    if (this.activeFor(key, agentId)) throw new HttpError(409, "This chat is still working.");
    const last = [...this.runs.values()].reverse().find((r) => r.key === key && r.agent === agentId);
    const holding = board.agents.find((a) => a.agent.id === agentId)?.holding ?? [];
    const task = taskId ?? (holding.length === 1 ? holding[0] : last?.task) ?? holding[0];
    if (!task) throw new HttpError(409, "This chat holds no task to reply about.");
    const resume = last?.task === task && last.sessionId ? last.sessionId : runner.sessionId;
    if (!resume) throw new HttpError(409, "There is no session to continue yet. Send the task first.");
    return this.launch({ key, task, agent: agentId, runner, prompt: text, resume, kind: "reply", auto: false });
  }

  private async launch(input: {
    key: string;
    task: string;
    agent: string;
    runner: ChatRunner;
    prompt: string;
    resume: string | undefined;
    kind: "task" | "reply";
    auto: boolean;
  }): Promise<RunSummary> {
    const { key, task, agent, runner, prompt, resume, kind, auto } = input;
    const ctx = this.manager.context(key);
    const workdir = runner.workdir || defaultWorkdir(ctx.filePath, ctx.project.settings.repoPath);
    if (!isDir(workdir)) {
      throw new HttpError(
        400,
        runner.workdir
          ? `This chat's working folder was not found: ${workdir}. Choose another one in the chat's run settings.`
          : `The project's code folder does not exist yet: ${workdir} (settings.repoPath in the project file). Create it, or choose a working folder in this chat's run settings.`,
      );
    }
    const provider = runner.provider as ProviderId;
    let invocation;
    try {
      invocation = buildInvocation({ runner, prompt, cwd: workdir, resume, newSessionId: randomUUID() });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const envPath = await agentPath();
    const binary = which(invocation.command, envPath);
    if (!binary) {
      const name = PROVIDER_INFO[provider].name;
      throw new HttpError(400, `${name} was not found (${invocation.command}). Install it, sign in once in a terminal, or set the program path in the chat's run settings.`);
    }
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
      throw new HttpError(400, `Windows: point the program path to the .exe of ${PROVIDER_INFO[provider].name}; .cmd launchers are not supported.`);
    }

    const id = `r-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const run: Run = {
      id,
      key,
      task,
      agent,
      provider,
      kind,
      auto,
      state: "running",
      startedAt: now(),
      workdir,
      sessionId: invocation.sessionId ?? resume,
      lines: 0,
      tools: 0,
      child: null,
      log: [],
      logBase: 0,
      file: null,
      stopRequested: false,
      lastProgressAt: Date.now(),
      lastUsageEmit: 0,
      freshSession: !resume && runner.session === "keep" ? invocation.sessionId : undefined,
      priorSession: runner.sessionId,
    };
    this.runs.set(id, run);
    this.trimRuns();
    this.errors.delete(`${key}:${agent}`);
    try {
      run.file = createWriteStream(path.join(this.runsDir, `${id}.log`), { flags: "a", mode: 0o600 });
      run.file.on("error", () => (run.file = null));
    } catch {
      run.file = null;
    }
    const name = PROVIDER_INFO[provider].name;
    this.append(run, `▶ ${name} · ${kind === "reply" ? "reply" : `task ${task}`} · ${workdir}`);
    this.append(run, `  ${path.basename(binary)} ${invocation.args.map((a) => (a === prompt ? "<prompt>" : a.length > 80 ? `${a.slice(0, 77)}…` : a)).join(" ")}`);

    try {
      if (kind === "task") {
        await this.manager.addEvent(key, { type: "dispatched", task, agent, message: `${auto ? "Auto-sent" : "Sent"} to ${name} (${id}).` }, "runner");
      } else {
        await this.manager.addEvent(key, { type: "started", task, agent, message: `Reply sent: ${clip(prompt, 300)}` }, "runner");
      }
    } catch (e) {
      this.runs.delete(id);
      run.file?.end();
      throw e;
    }
    if (runner.session === "keep" && invocation.sessionId && invocation.sessionId !== runner.sessionId) {
      await this.store.setSession(key, agent, invocation.sessionId);
    }

    const ctxProject = ctx.project.project.id;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [path.dirname(binary), envPath].join(path.delimiter),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color",
      AITRACK_SERVER: this.manager.serverUrl,
      AITRACK_PROJECT: ctxProject,
      AITRACK_CHAT: agent,
      AITRACK_TASK: task,
      AITRACK_RUN: id,
    };
    delete env.ELECTRON_RUN_AS_NODE;

    const parser = new OutputParser(invocation.format);
    const stderrTail: string[] = [];
    let startedReported = kind === "reply";
    let child: ChildProcess;
    try {
      child = spawn(binary, invocation.args, {
        cwd: workdir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      await this.finish(run, { ok: false, error: (e as Error).message, final: "" });
      return this.summary(run);
    }
    run.child = child;
    await this.persistActive();
    this.emit("run", { key, run: this.summary(run) });

    child.stdin?.on("error", () => undefined);
    if (invocation.stdin !== undefined) child.stdin?.end(invocation.stdin);
    else child.stdin?.end();

    const markStarted = () => {
      if (startedReported) return;
      startedReported = true;
      void this.manager
        .addEvent(key, { type: "started", task, agent, message: `${name} is working on it.` }, "runner")
        .catch((e) => this.emit("warning", e));
    };

    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        for (const ev of parser.feed(line)) {
          if (ev.kind === "session") {
            run.sessionId = ev.id;
            markStarted();
            if (runner.session === "keep") void this.store.setSession(key, agent, ev.id).catch(() => undefined);
            this.emit("run", { key, run: this.summary(run) });
          } else if (ev.kind === "activity") {
            markStarted();
            run.lastActivity = clip(ev.text, 300);
            this.append(run, ev.text);
          } else if (ev.kind === "message") {
            markStarted();
            if (!ev.partial) {
              run.lastMessage = clip(ev.text, 2000);
              this.append(run, `» ${ev.text}`);
              this.maybeProgress(run, ev.text);
            }
          } else if (ev.kind === "error") {
            this.append(run, `! ${ev.text}`);
          } else if (ev.kind === "usage" || ev.kind === "tool") {
            run.tools = parser.tools;
            run.usage = { ...parser.usage };
            if (Date.now() - run.lastUsageEmit > 3000) {
              run.lastUsageEmit = Date.now();
              this.emit("run", { key, run: this.summary(run) });
            }
          }
        }
      });
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        if (!line.trim()) return;
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
        this.append(run, `! ${line}`);
      });
    }

    let settled = false;
    const settle = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      const result = parser.result;
      const ok = !error && code === 0 && (result ? result.ok : true);
      const reason =
        error ??
        (result && !result.ok ? result.error : undefined) ??
        parser.errors[parser.errors.length - 1] ??
        stderrTail.slice(-3).join(" ").trim() ??
        "";
      run.tools = parser.tools;
      run.usage = { ...parser.usage };
      if (parser.denials.length) run.denials = [...parser.denials];
      void this.finish(run, {
        ok,
        error: ok ? undefined : clip(reason || `${name} exited with code ${code}`, 2000),
        final: parser.finalMessage(),
      }).catch((e) => this.emit("warning", e));
    };
    child.on("error", (e) => settle(null, (e as Error).message));
    child.on("close", (code) => settle(code));
    return this.summary(run);
  }

  private maybeProgress(run: Run, text: string): void {
    if (Date.now() - run.lastProgressAt < PROGRESS_EVERY_MS) return;
    run.lastProgressAt = Date.now();
    void this.manager
      .addEvent(run.key, { type: "progress", task: run.task, agent: run.agent, message: clip(text, 500) }, "runner")
      .catch(() => undefined);
  }

  private async finish(run: Run, outcome: { ok: boolean; error?: string; final: string }): Promise<void> {
    run.child = null;
    run.endedAt = now();
    const { key, task, agent } = run;
    let status: string | undefined;
    try {
      status = this.manager.context(key).board.byId.get(task)?.status;
    } catch {
      status = undefined;
    }
    const stillOpen = status !== undefined && (status === "dispatched" || status === "in_progress" || status === "blocked");
    const name = PROVIDER_INFO[run.provider].name;
    const denied: TaskIssue[] = (run.denials ?? []).map((tool) => ({
      title: `Permission denied: ${tool}`,
      kind: "needs-you",
      detail: `The chat's access level did not allow "${tool}", so that step was not done.`,
      fix: `The command "${tool}" was not allowed in your environment. Finish the task without it if you can; otherwise stop and tell me exactly which command you need and why.`,
    }));
    const withDenied = (issues: TaskIssue[] | undefined) => (denied.length ? [...(issues ?? []), ...denied] : issues);
    try {
      if (run.stopRequested) {
        run.state = "stopped";
        this.append(run, "■ Stopped.");
        const reason = run.stopNote ?? "Stopped from the tracker. Reply to continue or send it again.";
        if (stillOpen) await this.manager.addEvent(key, { type: "blocked", task, agent, reason }, "runner");
      } else if (!outcome.ok) {
        run.state = "failed";
        run.error = outcome.error;
        this.append(run, `✗ ${outcome.error ?? "failed"}`);
        await this.forgetDeadSession(run, outcome.error ?? "");
        if (status !== "done" && status !== "review") {
          await this.manager.addEvent(key, { type: "failed", task, agent, reason: outcome.error ?? `${name} failed.`, issues: withDenied(undefined) }, "runner");
        }
      } else {
        const report = this.reportFrom(outcome.final, task);
        run.lastMessage = clip(outcome.final, 2000) || run.lastMessage;
        if (report) {
          this.append(run, `✓ report: ${report.status}`);
          await this.manager.recordReport({ ...report, agent: report.agent ?? agent, project: undefined, issues: withDenied(report.issues) }, "runner", key);
        } else if (status === "dispatched" || status === "in_progress") {
          await this.manager.addEvent(
            key,
            { type: "blocked", task, agent, reason: "Waiting for your reply.", message: clip(outcome.final || "(no message)", 4000), issues: withDenied(undefined) },
            "runner",
          );
        }
        const after = this.manager.context(key).board.byId.get(task)?.status;
        run.state = after === "blocked" ? "waiting" : "finished";
        this.append(run, run.state === "waiting" ? "… waiting for your reply" : "✓ finished");
      }
    } catch (e) {
      this.emit("warning", e);
      if (run.state === "running") run.state = outcome.ok ? "finished" : "failed";
    }
    this.flushLines();
    run.file?.end();
    run.file = null;
    await this.persistActive();
    this.emit("run", { key, run: this.summary(run) });
    this.scheduleAuto(key);
  }

  /**
   * A run that failed before the model answered (not signed in, CLI error) leaves no conversation
   * behind, so the next message must start a new session instead of resuming one that does not
   * exist. The same when the CLI says the session it was asked to resume is gone.
   */
  private async forgetDeadSession(run: Run, error: string): Promise<void> {
    const stored = this.store.chat(run.key, run.agent).sessionId;
    if (!stored || stored !== run.sessionId) return;
    const silent = !run.tools && !run.usage?.output;
    if (run.freshSession && silent) {
      await this.store.setSession(run.key, run.agent, run.priorSession === run.freshSession ? undefined : run.priorSession);
      this.append(run, "  (no conversation was started; the next message starts a new session)");
    } else if (/no conversation found|session[^\n]{0,40}not found|unknown session|could not (?:find|resume) (?:the )?session/i.test(error)) {
      await this.store.setSession(run.key, run.agent, undefined);
      this.append(run, "  (the session is gone; the next message starts a new session)");
    }
  }

  /** The report in the agent's final message for this task, unless it is the template's example. */
  private reportFrom(text: string, task: string): Report | null {
    if (!text.includes("aitrack-report")) return null;
    const { reports } = parseReports(text);
    const mine = reports.filter((r) => r.task === task && r.summary !== "..." && r.summary !== "<what changed>");
    return mine[mine.length - 1] ?? null;
  }

  stop(runId: string): RunSummary {
    const run = this.runs.get(runId);
    if (!run) throw new HttpError(404, `Unknown run "${runId}"`);
    if (run.state !== "running" || !run.child) return this.summary(run);
    run.stopRequested = true;
    this.kill(run, "SIGTERM");
    const child = run.child;
    setTimeout(() => {
      if (run.child === child) this.kill(run, "SIGKILL");
    }, 5000).unref?.();
    return this.summary(run);
  }

  private kill(run: Run, signal: NodeJS.Signals): void {
    const child = run.child;
    if (!child || child.pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  // ---- automatic dispatch -----------------------------------------------------------------------

  private scheduleAuto(key: string): void {
    if (this.closed || !this.store.project(key).autoDispatch) return;
    clearTimeout(this.autoTimers.get(key));
    const timer = setTimeout(() => {
      this.autoTimers.delete(key);
      void this.autoDispatch(key).catch((e) => this.emit("warning", e));
    }, 400);
    timer.unref?.();
    this.autoTimers.set(key, timer);
  }

  /** Gives each free chat with a runner its most urgent ready task, within the project's limit. */
  async autoDispatch(key: string): Promise<string[]> {
    const settings = this.store.project(key);
    if (this.closed || !settings.autoDispatch || this.autoBusy.has(key)) return [];
    this.autoBusy.add(key);
    const started: string[] = [];
    try {
      let board;
      try {
        board = this.manager.context(key).board;
      } catch {
        return [];
      }
      const taken = new Set<string>();
      for (const view of board.agents) {
        if (this.activeCount(key) >= settings.maxConcurrent) break;
        const agent = view.agent.id;
        const runner = settings.chats[agent];
        if (!runner || runner.provider === "manual" || !view.hasRoom || this.activeFor(key, agent)) continue;
        const next = view.dispatchable.find((id) => !taken.has(id) && board.byId.get(id)?.status === "ready");
        if (!next) continue;
        taken.add(next);
        try {
          await this.start(key, next, agent, { auto: true });
          started.push(next);
        } catch (e) {
          this.errors.set(`${key}:${agent}`, (e as Error).message);
          this.emit("runners", { key });
        }
      }
    } finally {
      this.autoBusy.delete(key);
    }
    return started;
  }

  // ---- hooks from sessions opened by hand -------------------------------------------------------

  async hook(signal: HookSignal): Promise<{ handled: boolean; detail: string; task?: string }> {
    if (signal.runId && this.runs.get(signal.runId)?.state === "running") return { handled: false, detail: "Run managed by the tracker." };
    if (signal.sessionId && [...this.runs.values()].some((r) => r.state === "running" && r.sessionId === signal.sessionId)) {
      return { handled: false, detail: "Run managed by the tracker." };
    }
    if (signal.event === "start" || signal.event === "end") return { handled: false, detail: "Ignored event." };

    type Match = { key: string; agent: string; strong: boolean };
    const matches: Match[] = [];
    const cwd = signal.cwd ? real(signal.cwd) : undefined;
    for (const key of this.manager.keys()) {
      let ctx;
      try {
        ctx = this.manager.context(key);
      } catch {
        continue;
      }
      if (signal.project && signal.project !== ctx.project.project.id && signal.project !== key) continue;
      const settings = this.store.project(key);
      const base = defaultWorkdir(ctx.filePath, ctx.project.settings.repoPath);
      for (const agent of ctx.project.agents) {
        const runner = settings.chats[agent.id];
        if (signal.chat) {
          if (signal.chat === agent.id) matches.push({ key, agent: agent.id, strong: true });
          continue;
        }
        if (signal.sessionId && runner?.sessionId === signal.sessionId) {
          matches.push({ key, agent: agent.id, strong: true });
          continue;
        }
        const tool = runner && runner.provider !== "manual" ? runner.provider : (agent.tool ?? "").toLowerCase();
        if (!cwd || !tool.includes(signal.tool)) continue;
        if (inside(cwd, real(runner?.workdir || base))) matches.push({ key, agent: agent.id, strong: false });
      }
    }
    const strong = matches.filter((m) => m.strong);
    let pick: Match | undefined = strong.length === 1 ? strong[0] : undefined;
    if (!pick && strong.length === 0) {
      // Among chats that share the folder, prefer the one that holds a task.
      const holdingOnes = matches.filter((m) => (this.manager.context(m.key).board.agents.find((a) => a.agent.id === m.agent)?.holding.length ?? 0) > 0);
      if (holdingOnes.length === 1) pick = holdingOnes[0];
      else if (matches.length === 1) pick = matches[0];
    }
    if (!pick) {
      return {
        handled: false,
        detail: matches.length ? "Several chats match this folder; start the session with AITRACK_CHAT=<chat id>." : "No chat matches this session.",
      };
    }
    const { key, agent } = pick;
    const runner = this.store.chat(key, agent);
    if (signal.sessionId && !runner.sessionId && runner.session === "keep") {
      await this.store.setSession(key, agent, signal.sessionId);
      this.emit("runners", { key });
    }
    const board = this.manager.context(key).board;
    const holding = board.agents.find((a) => a.agent.id === agent)?.holding ?? [];
    if (holding.length !== 1) return { handled: false, detail: holding.length ? "The chat holds several tasks." : "The chat holds no task." };
    const task = holding[0]!;
    const status = board.byId.get(task)?.status;
    const tool = signal.tool === "claude" ? "Claude Code" : signal.tool === "codex" ? "Codex" : signal.tool;
    if (signal.event === "prompt") {
      if (status === "dispatched" || status === "blocked") {
        await this.manager.addEvent(key, { type: "started", task, agent, message: `${tool} is working.` }, "hook");
        return { handled: true, detail: "started", task };
      }
      return { handled: false, detail: "Already in progress.", task };
    }
    if (signal.event === "stop") {
      const report = signal.message ? this.reportFrom(signal.message, task) : null;
      if (report) {
        await this.manager.recordReport({ ...report, agent: report.agent ?? agent, project: undefined }, "hook", key);
        return { handled: true, detail: `report ${report.status}`, task };
      }
      if (status === "dispatched" || status === "in_progress") {
        await this.manager.addEvent(
          key,
          { type: "blocked", task, agent, reason: "Waiting for your reply.", message: signal.message ? clip(signal.message, 4000) : undefined },
          "hook",
        );
        return { handled: true, detail: "waiting", task };
      }
      return { handled: false, detail: "No change.", task };
    }
    if (signal.event === "attention" && (status === "dispatched" || status === "in_progress")) {
      await this.manager.addEvent(key, { type: "blocked", task, agent, reason: `Needs you: ${clip(signal.message ?? tool, 500)}` }, "hook");
      return { handled: true, detail: "attention", task };
    }
    return { handled: false, detail: "No change.", task };
  }

  // ---- housekeeping -----------------------------------------------------------------------------

  private append(run: Run, text: string): void {
    const stamp = new Date().toTimeString().slice(0, 8);
    const lines = text.split("\n").map((l, i) => (i === 0 ? `${stamp} ${l}` : `         ${l}`));
    for (const line of lines) {
      run.log.push(line);
      run.file?.write(line + "\n");
    }
    if (run.log.length > MAX_LOG) {
      const drop = run.log.length - MAX_LOG;
      run.log.splice(0, drop);
      run.logBase += drop;
    }
    const pending = this.pendingLines.get(run.id) ?? { key: run.key, from: run.logBase + run.log.length - lines.length, lines: [] };
    pending.lines.push(...lines);
    this.pendingLines.set(run.id, pending);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushLines(), 250);
      this.flushTimer.unref?.();
    }
  }

  private flushLines(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const [runId, p] of this.pendingLines) {
      const run = this.runs.get(runId);
      this.emit("runlog", { key: p.key, runId, from: p.from, lines: p.lines, lastActivity: run?.lastActivity });
    }
    this.pendingLines.clear();
  }

  private trimRuns(): void {
    const finished = [...this.runs.values()].filter((r) => r.state !== "running");
    for (const r of finished.slice(0, Math.max(0, finished.length - 200))) this.runs.delete(r.id);
  }

  private async persistActive(): Promise<void> {
    const active = [...this.runs.values()].filter((r) => r.state === "running").map((r) => this.summary(r));
    try {
      await writeFile(this.activeFile, JSON.stringify(active, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    } catch {
      // Best effort.
    }
  }

  /** Stops every run; used when the app quits. */
  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.autoTimers.values()) clearTimeout(t);
    this.autoTimers.clear();
    for (const run of this.runs.values()) {
      if (run.state !== "running") continue;
      run.stopRequested = true;
      run.stopNote = "The run stopped when the app closed. Reply to continue or send it again.";
      this.kill(run, "SIGTERM");
    }
  }
}
