import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  explainStep,
  jsonObjectsIn,
  neededPermission,
  parseLimitReason,
  parsePlan,
  permissionGrant,
  REFUSED,
  type Board,
  type IntegrationPlan,
  type ProjectFile,
  type RefusedStep,
  type TaskView,
} from "@aitrack/core";
import { HttpError, type ProjectManager } from "../manager.ts";
import { applyPlan, chatsTable, notesTable, openNotes, PLAN_RULES, PLAN_SHAPE, planTable, proposalsTable } from "../proposals.ts";
import { writeFileAtomic } from "../store.ts";
import type { ProjectGenerator } from "./generate.ts";
import { usageLimit } from "./limits.ts";
import { defaultWorkdir, planFolder, type RunManager } from "./runs.ts";
import { approves, mergesGreen, reviewsWork, type ManagerSettings } from "./store.ts";

/**
 * The manager: an AI CLI that stands in for the person while they are away. When something waits
 * for the person (a chat's question, a failed run, refused steps, work left for later), it reads
 * the situation and answers with actions; the app checks each one and carries it out. The CLI runs
 * read-only and can only choose from the actions below, never run commands of its own (with full
 * automation it may run read-only git and gh commands to review finished work). Payments,
 * credentials, legal terms, publishing, deleting, pushing and risky steps stay with the person;
 * merging into main only when the person turned on "merge green PRs", and then by the task's own chat.
 * With full authority it also grants permissions, moves tasks between chats, takes duplicate tasks
 * out of the plan and has chats merge the PRs a task needs; payments, credentials and accounts,
 * legal terms, deleting data and publishing still stay with the person.
 */

export interface ManagerAction {
  type: string;
  task?: string;
  ok: boolean;
  detail: string;
}

export interface ManagerRun {
  id: string;
  trigger: "auto" | "manual";
  provider: ManagerSettings["provider"];
  state: "running" | "done" | "failed";
  startedAt: string;
  endedAt?: string;
  summary?: string;
  actions: ManagerAction[];
  /** What it left for the person. */
  forYou: string[];
  /** What the person wrote to it for this look, and its answer. */
  message?: string;
  reply?: string;
  error?: string;
}

/** A finished task the manager approved: listed for the person to look over when they want. */
export interface ManagerApproval {
  task: string;
  title: string;
  agent?: string;
  at: string;
  /** Why it approved. */
  note?: string;
  /** What the person may want to look at themselves (a visual check, a real device), and how. */
  check?: string;
  pr?: string;
  run: string;
  /** The person looked at it. */
  seen?: boolean;
}

export interface ManagerState {
  settings: ManagerSettings;
  running: boolean;
  log: ManagerRun[];
  /** Newest first. */
  approvals: ManagerApproval[];
  /** Approvals the person has not looked at yet. */
  unseen: number;
}

interface Options {
  /**
   * Wait this long after a change before looking, so a report and the end of its run, or several
   * chats that stop together, are looked at in one go.
   */
  delayMs?: number;
  /** After a manager run failed (CLI limit, network), try again after these waits; the last one repeats. */
  retryMs?: number[];
}

const STOPPED = "Stopped from the tracker.";
/** A finished task goes back to its chat at most this many times; then it is left for the person. */
const MAX_SEND_BACKS = 2;
/** Read-only commands the manager may run to review finished work itself (full automation, Claude Code). */
export const REVIEW_TOOLS = [
  "Bash(git status:*)",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr checks:*)",
  "Bash(gh pr list:*)",
  "Bash(gh run view:*)",
  "Bash(gh run list:*)",
];
/** What a chat asked to merge its PRs may run for that one reply (Claude Code). */
export const MERGE_TOOLS = [
  "Bash(git fetch:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr checks:*)",
  "Bash(gh pr list:*)",
  "Bash(gh pr edit:*)",
  "Bash(gh pr merge:*)",
  "Bash(gh run view:*)",
  "Bash(gh run list:*)",
  "Bash(gh run watch:*)",
];
/** Risky steps a manager with full authority may allow, as the person would: reaching the network, pushing a branch. */
const AUTHORITY_STEPS = new Set<RefusedStep["what"]>(["network", "gitPush"]);
/** At most this many tasks taken out of the plan in one look: a guard against a manager that clears the plan. */
const MAX_DROPS = 10;
/** Not a setting: only a guard against a loop, when every run of the manager causes another. */
const SAFETY_RUNS_PER_HOUR = 30;
const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** A task that needs a decision: blocked (not waiting for other tasks) or failed, and its chat is not running. */
export interface Attention {
  view: TaskView;
  agent: string;
  provider: string;
  canReply: boolean;
  stopped: boolean;
  /** Where its chat worked (finished tasks): the manager may read it when it reviews the work. */
  folder?: string;
}

/**
 * The manager does not poll: it looks at a project when something changes there (a report, a run
 * that ended, a setting), and only calls its CLI when something new waits for a decision. Besides
 * that, it wakes up only to try a failed run again or when the hourly limit frees up.
 */
export class Supervisor extends EventEmitter {
  private timers = new Map<string, { timer: NodeJS.Timeout; at: number }>();
  private busy = new Set<string>();
  /** Projects that changed while the manager was looking: look again when it is done. */
  private dirty = new Set<string>();
  /** Failed runs in a row, and no automatic run before this time. */
  private failures = new Map<string, number>();
  private retryAt = new Map<string, number>();
  private logs = new Map<string, ManagerRun[]>();
  private approved = new Map<string, ManagerApproval[]>();
  /** What the last run looked at, so the same situation is not sent twice. */
  private handled = new Map<string, string>();
  /** Tasks the manager left for the person, and how they looked then: not shown to it again until they change. */
  private leftFor = new Map<string, string>();
  /** What the person wrote to the manager and it has not read yet. */
  private pending = new Map<string, string[]>();
  private closed = false;
  private readonly delayMs: number;
  private readonly retryMs: number[];

  constructor(
    private readonly manager: ProjectManager,
    private readonly runs: RunManager,
    private readonly generator: ProjectGenerator,
    private readonly dataDir: string,
    options: Options = {},
  ) {
    super();
    this.delayMs = options.delayMs ?? 15_000;
    this.retryMs = options.retryMs?.length ? options.retryMs : [2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
  }

  start(): void {
    // A report, a problem closed, a task added: something may wait for a decision now.
    this.manager.on("changed", ({ key }: { key: string }) => this.schedule(key));
    // A chat that stopped running leaves its question or failure for the manager.
    this.runs.on("run", ({ key, run }: { key: string; run: { state: string } }) => {
      if (run.state !== "running") this.schedule(key);
    });
    // What happened while the app was closed.
    for (const key of this.managing()) this.schedule(key);
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
  }

  /** Projects the manager runs now. */
  managing(): string[] {
    return this.manager.keys().filter((key) => {
      try {
        return this.settings(key).enabled;
      } catch {
        return false;
      }
    });
  }

  private settings(key: string): ManagerSettings {
    return this.runs.store.project(key).manager;
  }

  state(key: string): ManagerState {
    const approvals = this.approvals(key);
    return {
      settings: this.settings(key),
      running: this.busy.has(key),
      log: this.log(key).slice(-30).reverse(),
      approvals: approvals.slice(-50).reverse(),
      unseen: approvals.filter((a) => !a.seen).length,
    };
  }

  /** The person looked over approvals: these tasks, or all of them. */
  markSeen(key: string, tasks?: string[]): ManagerState {
    this.manager.context(key);
    const only = tasks?.length ? new Set(tasks) : null;
    for (const a of this.approvals(key)) if (!only || only.has(a.task)) a.seen = true;
    this.persist(key);
    this.changed(key);
    return this.state(key);
  }

  async setSettings(key: string, patch: unknown): Promise<ManagerState> {
    this.manager.context(key);
    const before = this.settings(key);
    let settings: ManagerSettings;
    try {
      settings = await this.runs.store.setManager(key, patch);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    // The manager keeps work moving through automatic dispatch.
    if (settings.enabled && !before.enabled) {
      await this.runs.saveProject(key, { autoDispatch: true });
      this.handled.delete(key);
      this.failures.delete(key);
      this.retryAt.delete(key);
      this.schedule(key, Math.min(1000, this.delayMs));
    } else if (settings.enabled) {
      // What it may do changed: look again with the new settings.
      this.handled.delete(key);
      this.schedule(key, Math.min(1000, this.delayMs));
    }
    // What it left for the person may be its to do now.
    if (settings.enabled) for (const k of [...this.leftFor.keys()]) if (k.startsWith(`${key}\u0000`)) this.leftFor.delete(k);
    this.changed(key);
    return this.state(key);
  }

  /**
   * Looks at the project after a short wait, unless the manager is off. Changes that come in while
   * a look is already planned join it; changes while the manager is looking bring one more look.
   */
  schedule(key: string, delay = this.delayMs): void {
    if (this.closed) return;
    let enabled = false;
    try {
      enabled = this.settings(key).enabled;
    } catch {
      return;
    }
    if (!enabled) return;
    if (this.busy.has(key)) {
      this.dirty.add(key);
      return;
    }
    const at = Math.max(Date.now() + delay, this.retryAt.get(key) ?? 0);
    const old = this.timers.get(key);
    if (old) {
      if (old.at <= at) return;
      clearTimeout(old.timer);
    }
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.run(key, "auto").catch((e) => this.emit("warning", e));
    }, at - Date.now());
    timer.unref?.();
    this.timers.set(key, { timer, at });
  }

  /**
   * Runs the manager once. An automatic run is skipped when there is nothing to do, when it would
   * look at exactly what the last run already handled, or when the hourly limit is reached.
   */
  /**
   * The person writes to the manager: it looks at once (or right after the look it is in) with the
   * message, acts on it within its rules and answers. A message may ask it to approve finished work.
   */
  async message(key: string, text: string): Promise<ManagerState> {
    const message = String(text ?? "").trim();
    if (!message) throw new HttpError(400, "The message is empty.");
    if (message.length > 4000) throw new HttpError(400, "The message is too long.");
    this.manager.context(key);
    this.pending.set(key, [...(this.pending.get(key) ?? []), message].slice(-5));
    if (!this.busy.has(key)) {
      const look = this.run(key, "manual").catch((e) => this.emit("warning", e));
      await Promise.race([look, new Promise((r) => setTimeout(r, 300))]);
    }
    this.changed(key);
    return this.state(key);
  }

  async run(key: string, trigger: "auto" | "manual"): Promise<ManagerRun | null> {
    const settings = this.settings(key);
    const messages = this.pending.get(key) ?? [];
    const asked = messages.length > 0;
    if (trigger === "auto" && !settings.enabled && !asked) return null;
    if (this.busy.has(key)) {
      if (trigger === "manual" && !asked) throw new HttpError(409, "The manager is already looking at this project.");
      this.dirty.add(key);
      return null;
    }
    // What the person wrote may ask for an approval, even when approving is otherwise off.
    // With full authority it also continues tasks the person stopped.
    const effective: ManagerSettings = { ...settings, ...(asked && { approveDone: true }), ...(settings.fullAuthority && { resumeStopped: true }) };
    const { project, board, filePath } = this.manager.context(key);
    const ctxPlan = planFolder(filePath);
    // A look the person asked for also shows what was left for them.
    const attention = this.attention(key, board, effective, trigger === "manual" || asked);
    const proposals = board.proposals.filter((p) => p.state === "open");
    const notes = openNotes(board);
    if (!asked && !attention.length && !proposals.length && !notes.length) {
      if (trigger === "manual") throw new HttpError(409, "Nothing waits for a decision right now.");
      return null;
    }
    const fingerprint = createHash("sha1")
      .update(
        JSON.stringify([
          attention.map((a) => [a.view.task.id, a.view.status, lastEvent(a.view), a.view.runtime.reason, a.view.runtime.lastMessage, a.view.runtime.issues]),
          proposals.map((p) => p.id),
          notes.map((n) => `${n.task}#${n.index}`),
        ]),
      )
      .digest("hex");
    if (trigger === "auto" && !asked) {
      if (this.handled.get(key) === fingerprint) return null;
      const hourAgo = Date.now() - 3_600_000;
      const recent = this.log(key).filter((r) => Date.parse(r.startedAt) > hourAgo);
      if (recent.length >= SAFETY_RUNS_PER_HOUR) {
        // Wake up once when the oldest of them is an hour old.
        const oldest = Math.min(...recent.map((r) => Date.parse(r.startedAt)));
        this.schedule(key, oldest + 3_600_000 - Date.now() + 1000);
        return null;
      }
    }

    this.busy.add(key);
    this.pending.delete(key);
    const run: ManagerRun = {
      id: `m-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      trigger: asked ? "manual" : trigger,
      provider: settings.provider,
      state: "running",
      startedAt: new Date().toISOString(),
      actions: [],
      forYou: [],
      ...(asked && { message: messages.join("\n\n") }),
    };
    this.record(key, run);
    try {
      const prompt = managerPrompt(project, board, attention, effective, messages);
      // Reviewing finished work itself: it may read the chats' folders and run read-only git and gh commands.
      const reviews = reviewsWork(effective) ? attention.filter((a) => a.view.status === "review") : [];
      const job = await this.generator.startPrompt({
        provider: settings.provider,
        model: settings.model,
        effort: settings.effort,
        binary: settings.binary,
        cwd: ctxPlan,
        prompt,
        ...(reviews.length && {
          readTools: REVIEW_TOOLS,
          addDirs: [...new Set(reviews.map((a) => a.folder).filter((d): d is string => Boolean(d) && d !== ctxPlan))],
        }),
      });
      const ended = await this.generator.wait(job.id);
      if (ended.state !== "done" || !ended.answer) throw new Error(ended.error || "The manager gave no answer.");
      const answer = parseAnswer(ended.answer);
      run.summary = answer.summary;
      if (answer.reply) run.reply = answer.reply;
      await this.carryOut(key, answer, attention, run, effective);
      run.state = "done";
      this.handled.set(key, fingerprint);
      this.failures.delete(key);
      this.retryAt.delete(key);
    } catch (e) {
      run.state = "failed";
      run.error = clip((e as Error).message, 1000);
      // Its own CLI hit its usage limit: look again when it resets. Otherwise later, longer each time it fails in a row.
      const limit = usageLimit(run.error ?? "", Date.now(), { provider: run.provider });
      const n = this.failures.get(key) ?? 0;
      this.failures.set(key, n + 1);
      this.retryAt.set(key, limit?.known ? limit.until : Date.now() + Math.max(limit ? limit.until - Date.now() : 0, this.retryMs[Math.min(n, this.retryMs.length - 1)]!));
      this.dirty.add(key);
      // What the person wrote is read again on the next look.
      if (asked) this.pending.set(key, [...messages, ...(this.pending.get(key) ?? [])].slice(-5));
    } finally {
      run.endedAt = new Date().toISOString();
      this.busy.delete(key);
      this.record(key, run);
    }
    // A message that came in during this look gets its own look now, even with the manager off.
    if (this.pending.get(key)?.length && run.state === "done") {
      this.dirty.delete(key);
      void this.run(key, "manual").catch((e) => this.emit("warning", e));
    } else if (this.dirty.delete(key)) this.schedule(key);
    return run;
  }

  /** Tasks that wait for the person and that the manager may act on. */
  private attention(key: string, board: Board, settings: ManagerSettings, withLeft = false): Attention[] {
    const out: Attention[] = [];
    for (const view of board.tasks) {
      if (!withLeft && this.leftFor.get(`${key}\u0000${view.task.id}`) === taskPrint(view)) continue;
      // Finished work that waits for approval, when the person let the manager approve it.
      if (view.status === "review") {
        if (!approves(settings)) continue;
        const agent = view.runtime.agent ?? view.task.agent;
        const runner = this.runs.store.chat(key, agent);
        const lastRun = this.runs.state(key).runs.find((r) => r.task === view.task.id && r.agent === agent);
        let folder = lastRun?.workdir;
        if (!folder) {
          try {
            const ctx = this.manager.context(key);
            folder = runner.workdir || defaultWorkdir(ctx.filePath, ctx.project.settings.repoPath);
          } catch {
            folder = runner.workdir;
          }
        }
        out.push({
          view,
          agent,
          provider: runner.provider,
          canReply: runner.provider !== "manual" && Boolean(lastRun?.sessionId || runner.sessionId),
          stopped: false,
          ...(folder && { folder }),
        });
        continue;
      }
      if (view.status !== "blocked" && view.status !== "failed") continue;
      // A task parked by a usage limit goes on by itself when it resets; a chat whose CLI waits is left alone.
      if (parseLimitReason(view.runtime.reason)) continue;
      if (view.reasons.some((r) => r.kind === "waiting_for")) continue;
      const agent = view.runtime.agent ?? view.task.agent;
      if (this.runs.isBusy(key, agent) || this.runs.isLimited(key, agent)) continue;
      const stopped = (view.runtime.reason ?? "").startsWith(STOPPED);
      if (stopped && !settings.resumeStopped) continue;
      const runner = this.runs.store.chat(key, agent);
      const lastRun = this.runs.state(key).runs.find((r) => r.task === view.task.id && r.agent === agent);
      out.push({
        view,
        agent,
        provider: runner.provider,
        canReply: runner.provider !== "manual" && Boolean(lastRun?.sessionId || runner.sessionId),
        stopped,
      });
    }
    return out;
  }

  private async carryOut(key: string, answer: ManagerAnswer, attention: Attention[], run: ManagerRun, settings: ManagerSettings): Promise<void> {
    const listed = new Map(attention.map((a) => [a.view.task.id, a]));
    const acted = new Set<string>();
    let dropped = 0;
    const done = (type: string, task: string | undefined, ok: boolean, detail: string) => {
      run.actions.push({ type, ...(task && { task }), ok, detail: clip(detail, 500) });
      this.record(key, run);
    };
    const note = (task: string, message: string) =>
      this.manager.addEvent(key, { type: "note", task, message: `Manager: ${message}`.slice(0, 2000) }, "manager").catch(() => undefined);

    for (const a of answer.actions) {
      const type = String(a.type ?? "");
      const task = typeof a.task === "string" ? a.task : undefined;
      try {
        if (type === "leave") {
          const message = String(a.message ?? "").trim();
          if (!message) continue;
          if (task && listed.has(task)) this.leftFor.set(`${key}\u0000${task}`, taskPrint(listed.get(task)!.view));
          run.forYou.push(task ? `${task}: ${message}` : message);
          if (task && this.manager.context(key).board.byId.has(task)) await note(task, `left for you — ${message}`);
          done(type, task, true, message);
          continue;
        }
        // With full authority it changes who does a task, or takes one nobody started out of the plan.
        if (type === "assign" || type === "drop") {
          if (!settings.fullAuthority) throw new Error("Moving and removing tasks needs full authority; left for the person.");
          if (!task) throw new Error("No task given.");
          if (acted.has(task)) throw new Error("Only one action per task.");
          const detail = type === "drop" ? await this.drop(key, task, a, (dropped += 1)) : await this.assign(key, task, a);
          acted.add(task);
          done(type, task, true, detail);
          continue;
        }
        if (!task || !listed.has(task)) {
          if (type !== "plan") done(type, task, false, "Not a task waiting for a decision.");
          continue;
        }
        const item = listed.get(task)!;
        if (acted.has(task) && type !== "close") {
          done(type, task, false, "Only one action per task.");
          continue;
        }
        const view = this.manager.context(key).board.byId.get(task)!;
        // A finished task in review can have notes closed (work that other tasks cover) and be approved;
        // with full automation also sent back, and its PRs merged when that is allowed. Nothing else.
        const forReview = ["approve", "close", ...(reviewsWork(settings) ? ["revise"] : []), ...(mergesGreen(settings) ? ["merge"] : [])];
        if (view.status === "review" && !forReview.includes(type)) throw new Error("A finished task in review is only approved, or left for the person.");
        switch (type) {
          case "approve": {
            if (!approves(settings)) throw new Error("Approving finished tasks is turned off.");
            if (view.status !== "review") throw new Error("Only a finished task in review is approved.");
            const open = view.runtime.issues.filter((i) => !i.state && i.kind !== "warning");
            if (open.length) {
              run.forYou.push(`${task}: waits for your approval — it has open problems (${open.map((i) => clip(i.title, 80)).join("; ")}).`);
              throw new Error("It has open problems; left for the person.");
            }
            const why = typeof a.note === "string" ? a.note.trim() : "";
            const check = typeof a.check === "string" ? a.check.trim().slice(0, 1500) : "";
            await this.manager.addEvent(
              key,
              { type: "approved", task, message: `Manager: approved${why ? ` — ${why}` : ""}${check ? ` · To look at: ${check}` : ""}`.slice(0, 2000) },
              "manager",
            );
            this.addApproval(key, {
              task,
              title: view.task.title,
              agent: item.agent,
              at: new Date().toISOString(),
              ...(why && { note: clip(why, 1000) }),
              ...(check && { check }),
              ...(view.runtime.pr && { pr: view.runtime.pr }),
              run: run.id,
            });
            done(type, task, true, [why || "approved", check].filter(Boolean).join(" · "));
            break;
          }
          case "revise": {
            if (!reviewsWork(settings) || view.status !== "review") throw new Error("Only finished work is sent back, with full automation on.");
            const text = String(a.text ?? "").trim();
            if (!text) throw new Error("Nothing to fix was given.");
            const before = view.runtime.history.filter((e) => e.type === "note" && e.message?.startsWith("Manager: sent back")).length;
            if (before >= MAX_SEND_BACKS) {
              run.forYou.push(`${task}: sent back ${before} times already and still not done as asked — ${clip(text, 300)}`);
              throw new Error(`Sent back ${before} times already; left for the person.`);
            }
            if (!item.canReply) throw new Error("Its chat has no session to continue; left for the person.");
            await this.runs.reply(key, item.agent, `${REVISE_INTRO}\n${text}\n${REVISE_END}`, task);
            await note(task, `sent back — ${text}`);
            done(type, task, true, text);
            break;
          }
          case "merge": {
            // A task in review merges its own PRs; with full authority a waiting task may also have the PRs it needs merged.
            if (!mergesGreen(settings) || (view.status !== "review" && !settings.fullAuthority)) throw new Error("Merging is not turned on.");
            if (view.runtime.history.some((e) => e.type === "note" && e.message?.startsWith("Manager: asked to merge"))) {
              throw new Error("Its chat was asked to merge once already; approve it, or it is left for the person.");
            }
            const open = view.runtime.issues.filter((i) => !i.state && i.kind !== "warning");
            if (open.length) throw new Error("It has open problems; close them or leave it for the person.");
            if (!item.canReply) throw new Error("Its chat has no session to continue; left for the person.");
            const which = typeof a.note === "string" ? a.note.trim() : "";
            if (view.status !== "review" && !which) throw new Error("Name the PRs to merge.");
            await this.runs.reply(key, item.agent, mergeText(task, which || view.runtime.pr || "", settings.fullAuthority), task, { extraTools: MERGE_TOOLS });
            await note(task, `asked to merge${which ? ` — ${which}` : ""}`);
            done(type, task, true, which || "asked its chat to merge its PRs");
            break;
          }
          case "reply": {
            const text = String(a.text ?? "").trim();
            if (!text) throw new Error("An empty reply.");
            await this.say(key, item, view, text);
            await note(task, `replied — ${text}`);
            done(type, task, true, text);
            break;
          }
          case "choose": {
            const issue = view.runtime.issues[Number(a.issue)];
            const choice = issue?.choices?.[Number(a.choice)];
            if (!issue || issue.state || !choice) throw new Error("No such option.");
            const text = [`About "${issue.title}", I choose: "${choice.label}".`, choice.reply?.trim() && choice.reply.trim() !== choice.label ? choice.reply.trim() : "", "Go on with this and report again."]
              .filter(Boolean)
              .join("\n");
            await this.say(key, item, view, text);
            await this.manager.setIssueStates(key, task, [{ index: Number(a.issue), title: issue.title }], "resolved").catch(() => undefined);
            await note(task, `chose "${choice.label}" for "${issue.title}"`);
            done(type, task, true, `${issue.title} → ${choice.label}`);
            break;
          }
          case "allow": {
            const refused = view.runtime.issues
              .map((i, index) => ({ i, index }))
              .filter(({ i }) => !i.state && i.title.startsWith(REFUSED));
            const lastRun = this.runs.state(key).runs.find((r) => r.task === task);
            const steps = refused.map(({ i, index }) => ({ index, title: i.title, step: explainStep(i.title.slice(REFUSED.length), lastRun?.workdir) }));
            const safe = steps.filter((s) => s.step.risk !== "risky" || (settings.fullAuthority && AUTHORITY_STEPS.has(s.step.what)));
            if (!safe.length) throw new Error("No refused step that is safe to allow.");
            if (item.provider !== "claude") throw new Error("Steps can be allowed only for Claude Code chats.");
            const runner = this.runs.store.chat(key, item.agent);
            const tools = (runner.allowedTools ?? "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
            const dirs = (runner.extraDirs ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
            const rules = [...new Set(safe.flatMap((s) => s.step.rules))].filter((r) => !tools.includes(r));
            const folders = [...new Set(safe.map((s) => s.step.folder).filter((f): f is string => Boolean(f)))].filter((f) => !dirs.includes(f));
            await this.runs.saveChat(key, item.agent, { allowedTools: [...tools, ...rules].join("\n"), extraDirs: [...dirs, ...folders].join("\n") });
            await this.manager.setIssueStates(key, task, safe.map((s) => ({ index: s.index, title: s.title })), "resolved");
            const text = ["The steps your permissions refused are allowed now:", ...safe.map((s) => `- ${s.step.shown}`), "Do them now and go on with the task where you stopped. Report again when you are done or need something."].join("\n");
            await this.say(key, item, this.manager.context(key).board.byId.get(task)!, text);
            await note(task, `allowed ${safe.map((s) => s.step.shown).join("; ")}`);
            done(type, task, true, safe.map((s) => s.step.shown).join("; "));
            break;
          }
          case "grant": {
            if (!settings.fullAuthority) throw new Error("Permissions are granted by the person; left for the person.");
            if (item.provider === "manual") throw new Error("This chat is run by hand; left for the person.");
            const detail = await this.grant(key, item, view, a.issue);
            await this.say(key, item, this.manager.context(key).board.byId.get(task)!, grantText(detail));
            await note(task, `granted — ${detail}`);
            done(type, task, true, detail);
            break;
          }
          case "wait": {
            const board = this.manager.context(key).board;
            const ids = (Array.isArray(a.for) ? a.for : [a.for]).filter((x): x is string => typeof x === "string" && board.byId.has(x) && x !== task);
            const open = ids.filter((id) => board.byId.get(id)?.status !== "done");
            if (!open.length) throw new Error("Those tasks are done already, or unknown.");
            await this.manager.addEvent(
              key,
              { type: "blocked", task, agent: item.agent, reason: view.runtime.reason ?? `Waits for ${open.join(", ")}.`, waitingFor: open },
              "manager",
            );
            await this.manager.addWaitDependencies(key, task, open);
            done(type, task, true, `waits for ${open.join(", ")}`);
            break;
          }
          case "resend": {
            if (view.status !== "failed") throw new Error("Only a failed task is sent again; reply to a blocked one.");
            if (item.provider === "manual") throw new Error("This chat is run by hand.");
            const extra = typeof a.note === "string" && a.note.trim() ? a.note.trim() : undefined;
            await this.runs.start(key, task, item.agent, { auto: true, extra });
            await note(task, `sent it again${extra ? ` — ${extra}` : ""}`);
            done(type, task, true, extra ?? "sent again");
            break;
          }
          case "close": {
            const state = a.state === "ignored" ? "ignored" : "resolved";
            const indices = (Array.isArray(a.issues) ? a.issues : [a.issues]).map(Number).filter((n) => Number.isInteger(n));
            const targets = indices
              .map((index) => ({ index, issue: view.runtime.issues[index] }))
              .filter((x) => x.issue && !x.issue.state)
              .map((x) => ({ index: x.index, title: x.issue!.title }));
            if (!targets.length) throw new Error("No such open problem.");
            await this.manager.setIssueStates(key, task, targets, state);
            done(type, task, true, `${state}: ${targets.map((t) => t.title).join("; ")}`);
            break;
          }
          default:
            done(type || "?", task, false, "Unknown action.");
            continue;
        }
        // Closing problems goes with the one action a task gets (approving it after, say).
        if (type !== "close") acted.add(task);
      } catch (e) {
        const message = (e as Error).message;
        if (task && listed.has(task) && message.includes("left for the person")) this.leftFor.set(`${key}\u0000${task}`, taskPrint(listed.get(task)!.view));
        done(type, task, false, message);
      }
    }

    if (answer.plan && (answer.plan.tasks.length || answer.plan.links.length || answer.plan.ignore.length)) {
      try {
        const result = await applyPlan(this.manager, key, answer.plan, "manager");
        const parts = [
          result.created.length ? `added ${result.created.join(", ")}` : "",
          result.linked.length ? `linked ${result.linked.length}` : "",
          result.ignored.length ? `ignored ${result.ignored.length}` : "",
          result.closedNotes ? `closed ${result.closedNotes} notes` : "",
        ].filter(Boolean);
        done("plan", undefined, result.errors.length === 0, [parts.join(", ") || "no change", ...result.errors].join(" · "));
      } catch (e) {
        done("plan", undefined, false, (e as Error).message);
      }
    }
  }

  /**
   * Gives a task's chat the permission one of its problems needs, for good, and closes every problem
   * the same permission settles. Returns what was allowed.
   */
  private async grant(key: string, item: Attention, view: TaskView, issue: unknown): Promise<string> {
    const runner = this.runs.store.chat(key, item.agent);
    const open = view.runtime.issues.map((i, index) => ({ i, index })).filter(({ i }) => !i.state && i.kind !== "warning" && !i.title.startsWith(REFUSED));
    const picked = issue === undefined || issue === null ? open : open.filter((x) => x.index === Number(issue));
    const need = picked.map((x) => neededPermission(x.i, item.provider)).find(Boolean) ?? neededPermission({ title: view.runtime.reason ?? "" }, item.provider);
    if (!need) throw new Error("No problem of this task asks for a permission.");
    const grant = permissionGrant(runner, need);
    if (grant.how !== "none") await this.runs.saveChat(key, item.agent, grant.patch);
    const settled = open.filter(({ i }) => {
      const p = neededPermission(i, item.provider);
      if (!p) return false;
      const g = permissionGrant(runner, p);
      return grant.how === "full" || (g.how === grant.how && g.shown === grant.shown);
    });
    if (settled.length) await this.manager.setIssueStates(key, view.task.id, settled.map(({ i, index }) => ({ index, title: i.title })), "resolved");
    return grant.how === "full" ? "full access" : grant.how === "none" ? `${grant.shown} (it had it already)` : grant.shown;
  }

  /** Gives a task to another chat; a task its chat holds is released first. Returns what was done. */
  private async assign(key: string, task: string, a: Record<string, unknown>): Promise<string> {
    const { project, board } = this.manager.context(key);
    const view = board.byId.get(task);
    if (!view) throw new Error("Unknown task.");
    const to = String(a.to ?? "").trim();
    if (!project.agents.some((x) => x.id === to)) throw new Error(`Unknown chat "${to}".`);
    if (["dispatched", "in_progress", "review", "done"].includes(view.status)) throw new Error(`It is ${view.status}; only a task that waits, is ready, blocked or failed moves.`);
    const holder = view.runtime.agent;
    if (to === view.task.agent && (!holder || holder === to)) throw new Error(`It is ${to}'s task already.`);
    const why = typeof a.note === "string" ? clip(a.note, 500) : "";
    // The chat that holds it lets it go; the new chat starts it over.
    if (holder) await this.manager.addEvent(key, { type: "reopened", task }, "manager");
    await this.manager.saveTask(key, { id: task, title: view.task.title, agent: to }, "update");
    await this.manager
      .addEvent(key, { type: "note", task, message: `Manager: moved to ${to}${why ? ` — ${why}` : ""}` }, "manager")
      .catch(() => undefined);
    return `to ${to}${why ? ` — ${why}` : ""}`;
  }

  /** Takes a task nobody started out of the plan (a duplicate, or work another task covers). */
  private async drop(key: string, task: string, a: Record<string, unknown>, count: number): Promise<string> {
    if (count > MAX_DROPS) throw new Error(`At most ${MAX_DROPS} tasks are taken out in one look.`);
    const view = this.manager.context(key).board.byId.get(task);
    if (!view) throw new Error("Unknown task.");
    if (view.status !== "waiting" && view.status !== "ready") throw new Error("Only a task no chat has started is taken out of the plan.");
    const why = typeof a.note === "string" ? clip(a.note, 500) : "";
    if (!why) throw new Error("Say why it is not needed: the task it duplicates or that covers it.");
    await this.manager.removeTask(key, task);
    return `${view.task.title} — ${why}`;
  }

  /** Gives text to the chat of a task: continues its session, or sends the task again with it. */
  private async say(key: string, item: Attention, view: TaskView, text: string): Promise<void> {
    if (item.provider === "manual") throw new Error("This chat is run by hand; left for the person.");
    if (item.canReply && view.status === "blocked") {
      await this.runs.reply(key, item.agent, text, view.task.id);
      return;
    }
    await this.runs.start(key, view.task.id, item.agent, { auto: true, extra: text });
  }

  private log(key: string): ManagerRun[] {
    let list = this.logs.get(key);
    if (!list) {
      let raw: { runs?: ManagerRun[]; approvals?: ManagerApproval[] } = {};
      try {
        raw = JSON.parse(readFileSync(this.file(key), "utf8")) as typeof raw;
      } catch {
        raw = {};
      }
      list = Array.isArray(raw.runs) ? raw.runs : [];
      // A run cut off by quitting the app.
      for (const r of list) if (r.state === "running") Object.assign(r, { state: "failed", error: "The app closed during this run." });
      this.logs.set(key, list);
      this.approved.set(key, Array.isArray(raw.approvals) ? raw.approvals.filter((a) => a && typeof a.task === "string") : []);
    }
    return list;
  }

  private approvals(key: string): ManagerApproval[] {
    this.log(key);
    return this.approved.get(key) ?? [];
  }

  private addApproval(key: string, approval: ManagerApproval): void {
    const list = this.approvals(key);
    list.push(approval);
    if (list.length > 100) list.splice(0, list.length - 100);
    this.persist(key);
  }

  private file(key: string): string {
    return path.join(this.dataDir, "manager", `${key}.json`);
  }

  private record(key: string, run: ManagerRun): void {
    const list = this.log(key);
    const i = list.findIndex((r) => r.id === run.id);
    if (i >= 0) list[i] = { ...run, actions: [...run.actions], forYou: [...run.forYou] };
    else list.push({ ...run, actions: [...run.actions], forYou: [...run.forYou] });
    if (list.length > 50) list.splice(0, list.length - 50);
    this.persist(key);
    this.changed(key);
  }

  private persist(key: string): void {
    try {
      mkdirSync(path.dirname(this.file(key)), { recursive: true });
    } catch {
      // Written below or not at all.
    }
    const body = { runs: this.log(key), approvals: this.approvals(key) };
    void writeFileAtomic(this.file(key), JSON.stringify(body, null, 1) + "\n").catch(() => undefined);
  }

  private changed(key: string): void {
    this.emit("manager", { key });
  }
}

interface ManagerAnswer {
  actions: Array<Record<string, unknown>>;
  plan?: IntegrationPlan;
  summary?: string;
  /** Its answer to what the person wrote. */
  reply?: string;
}

/** Reads the manager's answer: the last JSON object with "actions" (and maybe "plan"). */
export function parseAnswer(text: string): ManagerAnswer {
  const found = jsonObjectsIn(text)
    .map((o) => o.value)
    .filter((v) => "actions" in v || "plan" in v || "reply" in v);
  const last = found[found.length - 1];
  if (!last) throw new Error("The manager's answer has no actions.");
  const actions = Array.isArray(last.actions) ? last.actions.filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object") : [];
  let plan: IntegrationPlan | undefined;
  if (last.plan && typeof last.plan === "object") {
    try {
      plan = parsePlan(JSON.stringify(last.plan));
    } catch {
      plan = undefined;
    }
  }
  return {
    actions: actions.slice(0, 40),
    ...(plan && { plan }),
    ...(typeof last.summary === "string" && { summary: clip(last.summary, 1000) }),
    ...(typeof last.reply === "string" && last.reply.trim() && { reply: last.reply.trim().slice(0, 4000) }),
  };
}

const REVISE_INTRO = "The manager reviewed this task and it is not done as asked yet. Fix this, then report the task again:";
const REVISE_END = "Keep to the task and its acceptance; do not push to main or merge.";

/** What a chat is told after the manager gave it a permission for good. */
export function grantText(what: string): string {
  return `The manager allowed this for you from now on: ${what}. Do the step that needed it now and go on with the task where you stopped. Report again when you are done or need something.`;
}

/**
 * What a reviewed task's chat is told when the manager lets it merge its own PRs. With full
 * authority the PRs named may also be other tasks' PRs that this task needs in main.
 */
export function mergeText(task: string, which: string, others = false): string {
  if (others) {
    return [
      `The manager decided that these pull requests go into main now: ${which || "this task's own PRs"}. Merge them yourself; task ${task} needs them.`,
      "- Only when CI and the required checks are green on the latest commit. If they are still running, wait for them; if they stay red, do not merge and report why.",
      "- Use a merge commit (gh pr merge <number> --merge). Do not delete branches, do not force-push, never push to main directly.",
      "- Stacked PRs: start with the lowest one, and point the next one at main (gh pr edit <number> --base main) before you merge it.",
      "- They may belong to other tasks or chats: the manager decided it, as the person would. Merge only the PRs named here.",
      `When you are done, go on with task ${task}, or report it done again with the PRs you merged and their merge commits.`,
    ].join("\n");
  }
  return [
    `The manager reviewed task ${task} and it may go into main now. Merge its own pull requests yourself${which ? `: ${which}` : "."}`,
    "- Only when CI and the required checks are green on the latest commit. If they are still running, wait for them; if they stay red, do not merge and report why.",
    "- Use a merge commit (gh pr merge <number> --merge). Do not delete branches, do not force-push, never push to main directly.",
    "- Stacked PRs: start with the lowest one, and point the next one at main (gh pr edit <number> --base main) before you merge it.",
    "- Merge only this task's own PRs, nothing of other chats.",
    "When you are done, report the task done again and list the PRs you merged, with their merge commits.",
  ].join("\n");
}

/** How a task looks to the manager: when this changes, a task left for the person comes back to it. */
function taskPrint(v: TaskView): string {
  return createHash("sha1").update(JSON.stringify([v.status, lastEvent(v), v.runtime.reason, v.runtime.lastMessage, v.runtime.issues])).digest("hex");
}

/** The task's last event other than a note: a chat that reports again, even with the same words, is something new. */
function lastEvent(v: TaskView): string | undefined {
  for (let i = v.runtime.history.length - 1; i >= 0; i -= 1) if (v.runtime.history[i]!.type !== "note") return v.runtime.history[i]!.id;
  return undefined;
}

function attentionText(a: Attention, settings: ManagerSettings): string {
  const v = a.view;
  if (v.status === "review") {
    const back = v.runtime.history.filter((e) => e.type === "note" && e.message?.startsWith("Manager: sent back")).length;
    const merging = v.runtime.history.some((e) => e.type === "note" && e.message?.startsWith("Manager: asked to merge"));
    const lines = [
      `### ${v.task.id} · ${clip(v.task.title, 100)} · chat ${a.agent} (${a.canReply ? `${a.provider}, can be sent back` : `${a.provider}, no session`}) · IN REVIEW (finished, waits for approval)${back ? ` · sent back ${back} time(s)` : ""}${merging ? " · its chat was already asked to merge" : ""}`,
    ];
    if (v.task.instructions) lines.push(`Task: ${clip(v.task.instructions, 800)}`);
    if (v.task.acceptance) lines.push(`Acceptance: ${clip(v.task.acceptance, 800)}`);
    if (v.runtime.summary) lines.push(`Summary: ${clip(v.runtime.summary, 1500)}`);
    if (v.runtime.verify) lines.push(`How to verify: ${clip(v.runtime.verify, 600)}`);
    if (v.runtime.pr) lines.push(`PR: ${clip(v.runtime.pr, 300)}`);
    if (a.folder) lines.push(`Chat's folder: ${a.folder}`);
    if (v.runtime.lastMessage) lines.push(`Last message: ${clip(v.runtime.lastMessage, 1500)}`);
    const open = v.runtime.issues.map((i, index) => ({ i, index })).filter(({ i }) => !i.state);
    if (open.length) {
      lines.push("Open problems:");
      for (const { i, index } of open) lines.push(`  [${index}] ${i.kind ?? "error"}: ${clip(i.title, 200)}${i.detail ? ` — ${clip(i.detail, 300)}` : ""}`);
    }
    return lines.join("\n");
  }
  const lines = [
    `### ${v.task.id} · ${clip(v.task.title, 100)} · chat ${a.agent} (${a.provider === "manual" ? "run by hand: you cannot reply, only leave it for the person" : a.canReply ? `${a.provider}, can reply` : `${a.provider}, no session: a reply sends the task again`}) · ${v.status}${a.stopped ? " · STOPPED BY THE PERSON" : ""}`,
  ];
  if (v.runtime.reason) lines.push(`Reason: ${clip(v.runtime.reason, 800)}`);
  if (v.runtime.lastMessage) lines.push(`Last message: ${clip(v.runtime.lastMessage, 1500)}`);
  const open = v.runtime.issues.map((i, index) => ({ i, index })).filter(({ i }) => !i.state);
  const problems = open.filter(({ i }) => !i.title.startsWith(REFUSED));
  if (problems.length) {
    lines.push("Problems:");
    for (const { i, index } of problems) {
      const choices = i.choices?.length
        ? ` | options: ${i.choices.map((c, n) => `[${n}] ${c.label}${c.recommended ? " (recommended)" : ""}`).join(", ")}`
        : "";
      const need = neededPermission(i, a.provider);
      const asks = need ? ` [${need.inferred ? "needs permission (read from the problem)" : "asks permission"}: ${need.kind}${need.value ? ` ${clip(need.value, 120)}` : ""}]` : "";
      lines.push(`  [${index}] ${i.kind ?? "error"}: ${clip(i.title, 200)}${i.detail ? ` — ${clip(i.detail, 400)}` : ""}${choices}${asks}`);
    }
  }
  const refused = open.filter(({ i }) => i.title.startsWith(REFUSED));
  if (refused.length) {
    lines.push(
      `Refused steps: ${refused
        .map(({ i }) => {
          const s = explainStep(i.title.slice(REFUSED.length));
          const may = s.risk !== "risky" || (settings.fullAuthority && AUTHORITY_STEPS.has(s.what));
          return `[${may ? "safe" : "risky"}] ${clip(s.shown, 160)}`;
        })
        .join("; ")}`,
    );
  }
  if (v.task.dependsOn.length) lines.push(`Depends on: ${v.task.dependsOn.join(", ")}`);
  if (settings.fullAuthority && !open.some(({ i }) => neededPermission(i, a.provider))) {
    const need = neededPermission({ title: v.runtime.reason ?? "" }, a.provider);
    if (need) lines.push(`[needs permission (read from the reason): ${need.kind}]`);
  }
  return lines.join("\n");
}

const mergeAllowed = mergesGreen;

/** The actions on finished tasks, as the settings allow them. */
function reviewActions(s: ManagerSettings): string {
  if (!approves(s)) return "";
  const lines: string[] = [];
  if (reviewsWork(s)) {
    lines.push(
      "- approve: you review finished work for the person. Accept a task IN REVIEW when the work does what the task and its acceptance ask. Look at the change yourself when you can, read-only: the chat's folder, git status/log/diff/show there, gh pr view/diff/checks for its PR (with --repo or the PR's URL); if you cannot, judge from the report and say so in \"note\". Gaps that do not stop other work do not hold it back: a test that is skipped or not in CI yet, a check only a person can do (comparing with a design, a real device), a small deviation the chat explains. Close those problems first (\"close\"), add real remaining work to the plan, put what the person may want to look at in \"check\" (what and how, in one or two sentences), and approve. Give the reason in \"note\".",
      `- revise: send a task IN REVIEW back to its chat with what to fix ("text"), when the work does not do what was asked or its checks fail. At most ${MAX_SEND_BACKS} times per task; after that leave it for the person.`,
    );
  } else {
    lines.push(
      "- approve: accept a task IN REVIEW when its report shows the work is done as asked: the summary covers the task and its acceptance, it says how it was verified, and nothing is left open. Give the reason in \"note\". When in doubt, leave it for the person with what to check.",
    );
  }
  if (mergeAllowed(s) && s.fullAuthority) {
    lines.push(
      "- merge: have a task's chat merge green PRs into main (\"note\": which PRs, in what order). For a task IN REVIEW that is good to approve: its own PRs. For a task that waits because PRs of other tasks are not in main yet: those PRs (name them). The chat merges only with green checks and reports again. Once per task.",
    );
  } else if (mergeAllowed(s)) {
    lines.push(
      "- merge: when a task IN REVIEW is good to approve but its own PRs are not merged into main yet, have its chat merge them (\"note\": which PRs, in what order). The chat merges only with green checks, then reports again and you approve it then. Once per task; do not use it for work that is not done, or whose PRs belong to other tasks or are already merged.",
    );
  }
  return `\n${lines.join("\n")}`;
}

function reviewShapes(s: ManagerSettings): string {
  if (!approves(s)) return "";
  return [
    reviewsWork(s) ? ',{"type":"approve","task":"<id>","note":"…","check":"…"},{"type":"revise","task":"<id>","text":"…"}' : ',{"type":"approve","task":"<id>","note":"…"}',
    mergeAllowed(s) ? ',{"type":"merge","task":"<id>","note":"…"}' : "",
  ].join("");
}

/** What a manager with full authority may do besides answering chats. */
function authorityActions(s: ManagerSettings): string {
  if (!s.fullAuthority) return "";
  return `
- grant: give a task's chat, for good, the permission one of its problems needs (marked [asks permission] or [needs permission]; "issue" is its number, or leave it out). The app changes the chat's run settings: an allowed command, network in its sandbox, another folder, or full access when its CLI has nothing finer. Then the chat goes on.
- assign: give a task to another chat ("to": the chat id, "note": why). Any task of the plan that waits, is ready, blocked or failed; one its chat holds starts over with the new chat. Use it to spread work (PR and computer-use work to the chat that can do it, say) and for a chat that cannot do the task.
- drop: take a task no chat has started out of the plan when it is not needed: it duplicates another task, or another task covers it ("note": which one). Tasks that depended on it take over its dependencies.`;
}

/** What the manager is told: its job, the limits, the actions, and the project as it is now. */
export function managerPrompt(project: ProjectFile, board: Board, attention: Attention[], settings: ManagerSettings, messages: string[] = []): string {
  const language = project.settings.language === "tr" ? "Turkish" : "English";
  const fromPerson = messages.length
    ? `MESSAGE FROM THE PERSON (written to you just now; it comes before your usual choices, never before NEVER)
${messages.map((m) => `> ${m.replace(/\n/g, "\n> ")}`).join("\n\n")}
Do what it asks with the actions you have, on the tasks listed below (a finished task in review may be approved when it asks). Answer it in "reply", in ${language}: what you did, or why you could not and what the person can do.

`
    : "";
  const proposals = board.proposals.filter((p) => p.state === "open");
  const notes = openNotes(board);
  return `You are the manager of the project "${project.project.name}" in AI Tracking System, standing in for the person while they are away. AI chats work on the tasks of the plan, and automatic dispatch sends ready tasks to free chats. Your job is to keep the work moving: decide what the person would decide when it is safe and easy to undo, answer the chats, and keep the plan up to date. You only read (you may look at the files in this folder${reviewsWork(settings) ? ", and run the read-only git and gh commands named below to review finished work" : ""}); the app carries out the actions you return.

ACTIONS
- reply: answer a chat waiting on a task (its question, the approval of its plan, "go on"). Be concrete and decisive. Prefer the chat's own recommendation when it is sensible.
- choose: pick one of the options a chat offered on a problem ("issue" and "choice" are the numbers in brackets).
- allow: allow the refused steps of a task marked [safe], and let its chat go on.
- wait: when a task cannot go on until other tasks of the plan are done, park it; it goes back to its chat when they are done.
- resend: send a failed task again, with a short note on what to do differently.
- close: mark problems of a task resolved or ignored when nothing has to be done about them.
- leave: leave something for the person, in one clear sentence, when only they can do it.
A problem marked [asks permission] or [needs permission] is not something its chat can fix: do not reply asking it to get the permission, another environment or a workaround${settings.fullAuthority ? "; grant it" : "; leave it for the person (one sentence, saying which permission)"}.${reviewActions(settings)}${authorityActions(settings)}
- plan: fold the proposals and notes into the plan (rules below).
At most one action per task, plus "close" (put "close" before the action it makes possible).
${
  settings.fullAuthority
    ? `
FULL AUTHORITY: the person gave you their authority over this project. Decide and act as they would; do not leave them what you can do with your actions: grant the permissions chats need, move tasks between chats, take duplicates out of the plan, have green PRs merged, continue stopped work, choose between options. What you left for the person before comes back to you below: handle it now. "leave" is only for what a person has to do themselves: pay, sign in or create an account, accept terms, a check on a real device or by eye that the task asks the person for. Act on the tasks under ATTENTION; "assign" and "drop" may also name any task of the plan.
`
    : ""
}
NEVER: approve payments, enter or ask for credentials or create accounts, accept legal terms, publish or deploy to production, delete data or branches, push to a main branch${
    mergeAllowed(settings) ? ", merge into it other than with the \"merge\" action" : " or merge into it"
  }${
    settings.fullAuthority
      ? ". Leave those for the person."
      : ', allow [risky] steps, or grant a problem marked [asks permission] or [needs permission] (the person allows those for the chat for good). Leave those for the person.'
  }${
    reviewsWork(settings)
      ? " Never approve work whose checks fail or that does not do what the task asks: send it back instead."
      : approves(settings)
        ? " Never approve a task whose report mentions failing checks, skipped parts or work left undone."
        : ""
  } ${settings.fullAuthority ? "" : "Act only on the tasks listed under ATTENTION."}${settings.resumeStopped ? " A task STOPPED BY THE PERSON may be continued with a reply when its messages give no reason to keep it stopped." : ""}
Write replies, notes, checks and the summary in ${language}.

PLAN RULES
${PLAN_RULES}
- Write titles, instructions and acceptance in ${language}.

Answer with one JSON object in a \`\`\`json fence, and nothing after it:
{"actions":[{"type":"reply","task":"<id>","text":"…"},{"type":"choose","task":"<id>","issue":0,"choice":0},{"type":"allow","task":"<id>"},{"type":"wait","task":"<id>","for":["<task id>"]},{"type":"resend","task":"<id>","note":"…"},{"type":"close","task":"<id>","issues":[0],"state":"resolved"},{"type":"leave","task":"<id>","message":"…"}${reviewShapes(settings)}${
    settings.fullAuthority ? ',{"type":"grant","task":"<id>","issue":0},{"type":"assign","task":"<id>","to":"<chat id>","note":"…"},{"type":"drop","task":"<id>","note":"…"}' : ""
  }],"plan":${PLAN_SHAPE},"summary":"<what you did, in one or two sentences>"${messages.length ? ',"reply":"<your answer to the person>"' : ""}}
Leave out what you do not use.

${fromPerson}ATTENTION (tasks waiting for a decision, failed${approves(settings) ? ", or finished and waiting for approval" : ""})
${attention.length ? attention.map((a) => attentionText(a, settings)).join("\n\n") : "(none)"}

PROPOSALS (work chats left for later)
${proposals.length ? proposalsTable(proposals) : "(none)"}

NOTES (written by chats; nobody has to act on them right away)
${notes.length ? notesTable(notes) : "(none)"}

CHATS (id | name | role)
${chatsTable(project)}

TASKS OF THE PLAN (id | title | chat | status | depends on)
${planTable(project, board)}
`;
}
