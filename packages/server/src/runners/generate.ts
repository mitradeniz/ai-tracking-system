import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { authoringPrompt, type AuthoringInput } from "@aitrack/core";
import { HttpError } from "../manager.ts";
import { agentPath, which } from "./env.ts";
import { buildInvocation, OutputParser, PROVIDER_INFO, type ProviderId, type RunUsage } from "./providers.ts";

/**
 * Writes a project plan with an AI CLI installed on this computer (the "Create with AI" step of the
 * new-project wizard). The CLI runs read-only in the project's folder, so it can look at the code
 * but not change it, and answers with the project file as JSON.
 */

export const GENERATOR_PROVIDERS = ["claude", "codex", "gemini", "copilot"] as const;
export type GeneratorProvider = (typeof GENERATOR_PROVIDERS)[number];

export interface GenerateRequest {
  provider: GeneratorProvider;
  model?: string;
  effort?: string;
  /** Program path when the CLI is not on PATH (tests use a stand-in). */
  binary?: string;
  /** Folder the CLI runs in, usually the repository the project file goes into. */
  cwd: string;
  input: AuthoringInput;
}

export interface GenerateJob {
  id: string;
  provider: GeneratorProvider;
  state: "running" | "done" | "failed" | "stopped";
  startedAt: string;
  endedAt?: string;
  /** Recent activity lines: files read, commands, messages. */
  activity: string[];
  tools: number;
  usage?: RunUsage;
  /** The CLI's final answer, which should contain the JSON document. */
  answer?: string;
  error?: string;
}

interface Job extends GenerateJob {
  child: ChildProcess | null;
  stopRequested: boolean;
}

const MAX_MINUTES = 20;
const clip = (s: string, n = 300) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export class ProjectGenerator {
  private jobs = new Map<string, Job>();

  async start(req: GenerateRequest): Promise<GenerateJob> {
    if (!GENERATOR_PROVIDERS.includes(req.provider)) throw new HttpError(400, `Unknown CLI "${String(req.provider)}".`);
    let cwd = path.resolve(req.cwd);
    if (!existsSync(cwd)) {
      // A folder that does not exist yet (it is created with the project file): nothing to read.
      if (req.input.canReadRepository) throw new HttpError(400, `Folder not found: ${cwd}`);
      cwd = tmpdir();
    } else if (!statSync(cwd).isDirectory()) throw new HttpError(400, `Not a folder: ${cwd}`);
    if (!req.input.plan.trim() && !req.input.canReadRepository) throw new HttpError(400, "Describe the plan first.");
    const prompt = authoringPrompt(req.input);
    if (prompt.length > 400_000) throw new HttpError(400, "The plan is too long; shorten it or split it into milestones.");

    const invocation = buildInvocation({
      runner: {
        provider: req.provider,
        access: "readonly",
        session: "perTask",
        unattended: true,
        network: false,
        model: req.model?.trim() || undefined,
        effort: req.effort?.trim() || undefined,
        binary: req.binary,
      },
      prompt,
      cwd,
      newSessionId: randomUUID(),
    });
    // Claude Code's plan mode answers with a plan instead of the file. In its default mode it may read
    // files, and anything that would change them is refused, because nobody is there to approve it.
    if (invocation.format === "claude") {
      const i = invocation.args.indexOf("--permission-mode");
      if (i >= 0) invocation.args[i + 1] = "default";
      invocation.args.push("--disallowedTools", "Write", "Edit", "NotebookEdit");
    }
    const envPath = await agentPath();
    const binary = which(invocation.command, envPath);
    if (!binary) {
      throw new HttpError(400, `${PROVIDER_INFO[req.provider].name} was not found. Install it and sign in once in a terminal, or choose "Use another AI".`);
    }

    const job: Job = {
      id: `g-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      provider: req.provider,
      state: "running",
      startedAt: new Date().toISOString(),
      activity: [],
      tools: 0,
      child: null,
      stopRequested: false,
    };
    this.jobs.set(job.id, job);
    this.trim();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [path.dirname(binary), envPath].join(path.delimiter),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const parser = new OutputParser(invocation.format);
    const stderrTail: string[] = [];
    let child: ChildProcess;
    try {
      child = spawn(binary, invocation.args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      job.state = "failed";
      job.error = (e as Error).message;
      job.endedAt = new Date().toISOString();
      return this.view(job);
    }
    job.child = child;
    child.stdin?.on("error", () => undefined);
    if (invocation.stdin !== undefined) child.stdin?.end(invocation.stdin);
    else child.stdin?.end();

    const note = (line: string) => {
      job.activity.push(clip(line));
      if (job.activity.length > 40) job.activity.splice(0, job.activity.length - 40);
    };
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        for (const ev of parser.feed(line)) {
          if (ev.kind === "activity") note(ev.text);
          else if (ev.kind === "message" && !ev.partial) note(`» ${ev.text}`);
          else if (ev.kind === "error") note(`! ${ev.text}`);
        }
        job.tools = parser.tools;
        job.usage = { ...parser.usage };
      });
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        if (!line.trim()) return;
        stderrTail.push(line);
        if (stderrTail.length > 20) stderrTail.shift();
      });
    }
    const timer = setTimeout(() => {
      job.error = `Stopped after ${MAX_MINUTES} minutes.`;
      this.kill(job, "SIGTERM");
    }, MAX_MINUTES * 60_000);
    timer.unref?.();

    let settled = false;
    const settle = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      job.child = null;
      job.endedAt = new Date().toISOString();
      job.tools = parser.tools;
      job.usage = { ...parser.usage };
      const answer = parser.finalMessage();
      const result = parser.result;
      if (job.stopRequested) {
        job.state = "stopped";
        return;
      }
      const ok = !error && code === 0 && (result ? result.ok : true) && answer.length > 0;
      if (ok) {
        job.state = "done";
        job.answer = answer;
      } else {
        job.state = "failed";
        job.answer = answer || undefined;
        job.error = clip(
          error ??
            job.error ??
            (result && !result.ok ? result.error : undefined) ??
            parser.errors[parser.errors.length - 1] ??
            (stderrTail.slice(-3).join(" ").trim() || `${PROVIDER_INFO[job.provider].name} exited with code ${code}`),
          2000,
        );
      }
    };
    child.on("error", (e) => settle(null, (e as Error).message));
    child.on("close", (code) => settle(code));
    return this.view(job);
  }

  get(id: string): GenerateJob {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, `Unknown job "${id}"`);
    return this.view(job);
  }

  stop(id: string): GenerateJob {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, `Unknown job "${id}"`);
    if (job.state === "running" && job.child) {
      job.stopRequested = true;
      this.kill(job, "SIGTERM");
      const child = job.child;
      setTimeout(() => {
        if (job.child === child) this.kill(job, "SIGKILL");
      }, 5000).unref?.();
    }
    return this.view(job);
  }

  /** Stops every running job (the app is closing). */
  close(): void {
    for (const job of this.jobs.values()) if (job.state === "running") this.stop(job.id);
  }

  private kill(job: Job, signal: NodeJS.Signals): void {
    const child = job.child;
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

  private trim(): void {
    const old = [...this.jobs.values()].filter((j) => j.state !== "running");
    for (const j of old.slice(0, Math.max(0, old.length - 10))) this.jobs.delete(j.id);
  }

  private view(job: Job): GenerateJob {
    const { child: _child, stopRequested: _stop, ...rest } = job;
    return { ...rest, activity: [...rest.activity] };
  }
}
