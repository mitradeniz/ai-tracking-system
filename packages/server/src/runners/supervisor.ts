import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { explainStep, jsonObjectsIn, parsePlan, REFUSED, type Board, type IntegrationPlan, type ProjectFile, type TaskView } from "@aitrack/core";
import { HttpError, type ProjectManager } from "../manager.ts";
import { applyPlan, chatsTable, notesTable, openNotes, PLAN_RULES, PLAN_SHAPE, planTable, proposalsTable } from "../proposals.ts";
import { writeFileAtomic } from "../store.ts";
import type { ProjectGenerator } from "./generate.ts";
import { planFolder, type RunManager } from "./runs.ts";
import type { ManagerSettings } from "./store.ts";

/**
 * The manager: an AI CLI that stands in for the person while they are away. When something waits
 * for the person (a chat's question, a failed run, refused steps, work left for later), it reads
 * the situation and answers with actions; the app checks each one and carries it out. The CLI runs
 * read-only and can only choose from the actions below, never run commands of its own. Payments,
 * credentials, legal terms, publishing, deleting, pushing and risky steps stay with the person.
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
  error?: string;
}

export interface ManagerState {
  settings: ManagerSettings;
  running: boolean;
  log: ManagerRun[];
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
  /** What the last run looked at, so the same situation is not sent twice. */
  private handled = new Map<string, string>();
  /** Tasks the manager left for the person, and how they looked then: not shown to it again until they change. */
  private leftFor = new Map<string, string>();
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
    return { settings: this.settings(key), running: this.busy.has(key), log: this.log(key).slice(-30).reverse() };
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
  async run(key: string, trigger: "auto" | "manual"): Promise<ManagerRun | null> {
    const settings = this.settings(key);
    if (trigger === "auto" && !settings.enabled) return null;
    if (this.busy.has(key)) {
      if (trigger === "manual") throw new HttpError(409, "The manager is already looking at this project.");
      this.dirty.add(key);
      return null;
    }
    const { project, board, filePath } = this.manager.context(key);
    // A look the person asked for also shows what was left for them.
    const attention = this.attention(key, board, settings, trigger === "manual");
    const proposals = board.proposals.filter((p) => p.state === "open");
    const notes = openNotes(board);
    if (!attention.length && !proposals.length && !notes.length) {
      if (trigger === "manual") throw new HttpError(409, "Nothing waits for a decision right now.");
      return null;
    }
    const fingerprint = createHash("sha1")
      .update(
        JSON.stringify([
          attention.map((a) => [a.view.task.id, a.view.status, a.view.runtime.reason, a.view.runtime.lastMessage, a.view.runtime.issues]),
          proposals.map((p) => p.id),
          notes.map((n) => `${n.task}#${n.index}`),
        ]),
      )
      .digest("hex");
    if (trigger === "auto") {
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
    const run: ManagerRun = {
      id: `m-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      trigger,
      provider: settings.provider,
      state: "running",
      startedAt: new Date().toISOString(),
      actions: [],
      forYou: [],
    };
    this.record(key, run);
    try {
      const prompt = managerPrompt(project, board, attention, settings);
      const job = await this.generator.startPrompt({
        provider: settings.provider,
        model: settings.model,
        effort: settings.effort,
        binary: settings.binary,
        cwd: planFolder(filePath),
        prompt,
      });
      const ended = await this.generator.wait(job.id);
      if (ended.state !== "done" || !ended.answer) throw new Error(ended.error || "The manager gave no answer.");
      const answer = parseAnswer(ended.answer);
      run.summary = answer.summary;
      await this.carryOut(key, answer, attention, run);
      run.state = "done";
      this.handled.set(key, fingerprint);
      this.failures.delete(key);
      this.retryAt.delete(key);
    } catch (e) {
      run.state = "failed";
      run.error = clip((e as Error).message, 1000);
      // Try again later, waiting longer each time it fails in a row.
      const n = this.failures.get(key) ?? 0;
      this.failures.set(key, n + 1);
      this.retryAt.set(key, Date.now() + this.retryMs[Math.min(n, this.retryMs.length - 1)]!);
      this.dirty.add(key);
    } finally {
      run.endedAt = new Date().toISOString();
      this.busy.delete(key);
      this.record(key, run);
    }
    if (this.dirty.delete(key)) this.schedule(key);
    return run;
  }

  /** Tasks that wait for the person and that the manager may act on. */
  private attention(key: string, board: Board, settings: ManagerSettings, withLeft = false): Attention[] {
    const out: Attention[] = [];
    for (const view of board.tasks) {
      if (!withLeft && this.leftFor.get(`${key}\u0000${view.task.id}`) === taskPrint(view)) continue;
      // Finished work that waits for approval, when the person let the manager approve it.
      if (view.status === "review") {
        if (!settings.approveDone) continue;
        const agent = view.runtime.agent ?? view.task.agent;
        out.push({ view, agent, provider: this.runs.store.chat(key, agent).provider, canReply: false, stopped: false });
        continue;
      }
      if (view.status !== "blocked" && view.status !== "failed") continue;
      if (view.reasons.some((r) => r.kind === "waiting_for")) continue;
      const agent = view.runtime.agent ?? view.task.agent;
      if (this.runs.isBusy(key, agent)) continue;
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

  private async carryOut(key: string, answer: ManagerAnswer, attention: Attention[], run: ManagerRun): Promise<void> {
    const settings = this.settings(key);
    const listed = new Map(attention.map((a) => [a.view.task.id, a]));
    const acted = new Set<string>();
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
        if (view.status === "review" && type !== "approve") throw new Error("A finished task in review is only approved, or left for the person.");
        switch (type) {
          case "approve": {
            if (!settings.approveDone) throw new Error("Approving finished tasks is turned off.");
            if (view.status !== "review") throw new Error("Only a finished task in review is approved.");
            const open = view.runtime.issues.filter((i) => !i.state && i.kind !== "warning");
            if (open.length) {
              run.forYou.push(`${task}: waits for your approval — it has open problems (${open.map((i) => clip(i.title, 80)).join("; ")}).`);
              throw new Error("It has open problems; left for the person.");
            }
            const why = typeof a.note === "string" ? a.note.trim() : "";
            await this.manager.addEvent(key, { type: "approved", task, message: `Manager: approved${why ? ` — ${why}` : ""}`.slice(0, 2000) }, "manager");
            done(type, task, true, why || "approved");
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
            const safe = steps.filter((s) => s.step.risk !== "risky");
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
        acted.add(task);
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
      try {
        const raw = JSON.parse(readFileSync(this.file(key), "utf8")) as { runs?: ManagerRun[] };
        list = Array.isArray(raw.runs) ? raw.runs : [];
        // A run cut off by quitting the app.
        for (const r of list) if (r.state === "running") Object.assign(r, { state: "failed", error: "The app closed during this run." });
      } catch {
        list = [];
      }
      this.logs.set(key, list);
    }
    return list;
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
    try {
      mkdirSync(path.dirname(this.file(key)), { recursive: true });
    } catch {
      // Written below or not at all.
    }
    void writeFileAtomic(this.file(key), JSON.stringify({ runs: list }, null, 1) + "\n").catch(() => undefined);
    this.changed(key);
  }

  private changed(key: string): void {
    this.emit("manager", { key });
  }
}

interface ManagerAnswer {
  actions: Array<Record<string, unknown>>;
  plan?: IntegrationPlan;
  summary?: string;
}

/** Reads the manager's answer: the last JSON object with "actions" (and maybe "plan"). */
export function parseAnswer(text: string): ManagerAnswer {
  const found = jsonObjectsIn(text)
    .map((o) => o.value)
    .filter((v) => "actions" in v || "plan" in v);
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
  return { actions: actions.slice(0, 40), ...(plan && { plan }), ...(typeof last.summary === "string" && { summary: clip(last.summary, 1000) }) };
}

/** How a task looks to the manager: when this changes, a task left for the person comes back to it. */
function taskPrint(v: TaskView): string {
  return createHash("sha1").update(JSON.stringify([v.status, v.runtime.reason, v.runtime.lastMessage, v.runtime.issues])).digest("hex");
}

function attentionText(a: Attention): string {
  const v = a.view;
  if (v.status === "review") {
    const lines = [`### ${v.task.id} · ${clip(v.task.title, 100)} · chat ${a.agent} · IN REVIEW (finished, waits for approval)`];
    if (v.task.acceptance) lines.push(`Acceptance: ${clip(v.task.acceptance, 800)}`);
    if (v.runtime.summary) lines.push(`Summary: ${clip(v.runtime.summary, 1500)}`);
    if (v.runtime.verify) lines.push(`How to verify: ${clip(v.runtime.verify, 600)}`);
    if (v.runtime.pr) lines.push(`PR: ${clip(v.runtime.pr, 300)}`);
    if (v.runtime.lastMessage) lines.push(`Last message: ${clip(v.runtime.lastMessage, 1500)}`);
    const open = v.runtime.issues.filter((i) => !i.state);
    if (open.length) lines.push(`Open problems: ${open.map((i) => `${i.kind ?? "error"}: ${clip(i.title, 160)}`).join("; ")}`);
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
      lines.push(`  [${index}] ${i.kind ?? "error"}: ${clip(i.title, 200)}${i.detail ? ` — ${clip(i.detail, 400)}` : ""}${choices}`);
    }
  }
  const refused = open.filter(({ i }) => i.title.startsWith(REFUSED));
  if (refused.length) {
    lines.push(
      `Refused steps: ${refused
        .map(({ i }) => {
          const s = explainStep(i.title.slice(REFUSED.length));
          return `[${s.risk === "risky" ? "risky" : "safe"}] ${clip(s.shown, 160)}`;
        })
        .join("; ")}`,
    );
  }
  if (v.task.dependsOn.length) lines.push(`Depends on: ${v.task.dependsOn.join(", ")}`);
  return lines.join("\n");
}

/** What the manager is told: its job, the limits, the actions, and the project as it is now. */
export function managerPrompt(project: ProjectFile, board: Board, attention: Attention[], settings: ManagerSettings): string {
  const language = project.settings.language === "tr" ? "Turkish" : "English";
  const proposals = board.proposals.filter((p) => p.state === "open");
  const notes = openNotes(board);
  return `You are the manager of the project "${project.project.name}" in AI Tracking System, standing in for the person while they are away. AI chats work on the tasks of the plan, and automatic dispatch sends ready tasks to free chats. Your job is to keep the work moving: decide what the person would decide when it is safe and easy to undo, answer the chats, and keep the plan up to date. You only read (you may look at the files in this folder); the app carries out the actions you return.

ACTIONS
- reply: answer a chat waiting on a task (its question, the approval of its plan, "go on"). Be concrete and decisive. Prefer the chat's own recommendation when it is sensible.
- choose: pick one of the options a chat offered on a problem ("issue" and "choice" are the numbers in brackets).
- allow: allow the refused steps of a task marked [safe], and let its chat go on.
- wait: when a task cannot go on until other tasks of the plan are done, park it; it goes back to its chat when they are done.
- resend: send a failed task again, with a short note on what to do differently.
- close: mark problems of a task resolved or ignored when nothing has to be done about them.
- leave: leave something for the person, in one clear sentence, when only they can do it.${
    settings.approveDone
      ? "\n- approve: accept a task IN REVIEW when its report shows the work is done as asked: the summary covers the task and its acceptance, it says how it was verified, and nothing is left open. Give the reason in \"note\". When in doubt, leave it for the person with what to check."
      : ""
  }
- plan: fold the proposals and notes into the plan (rules below).
At most one action per task, plus "close".

NEVER: approve payments, enter or ask for credentials, accept legal terms, publish, delete data, push to or merge into a main branch, or allow [risky] steps. Leave those for the person.${
    settings.approveDone ? " Never approve a task whose report mentions failing checks, skipped parts or work left undone." : ""
  } Act only on the tasks listed under ATTENTION.${settings.resumeStopped ? " A task STOPPED BY THE PERSON may be continued with a reply when its messages give no reason to keep it stopped." : ""}
Write replies, notes and the summary in ${language}.

PLAN RULES
${PLAN_RULES}
- Write titles, instructions and acceptance in ${language}.

Answer with one JSON object in a \`\`\`json fence, and nothing after it:
{"actions":[{"type":"reply","task":"<id>","text":"…"},{"type":"choose","task":"<id>","issue":0,"choice":0},{"type":"allow","task":"<id>"},{"type":"wait","task":"<id>","for":["<task id>"]},{"type":"resend","task":"<id>","note":"…"},{"type":"close","task":"<id>","issues":[0],"state":"resolved"},{"type":"leave","task":"<id>","message":"…"}${settings.approveDone ? ',{"type":"approve","task":"<id>","note":"…"}' : ""}],"plan":${PLAN_SHAPE},"summary":"<what you did, in one or two sentences>"}
Leave out what you do not use.

ATTENTION (tasks waiting for a decision, failed${settings.approveDone ? ", or finished and waiting for approval" : ""})
${attention.length ? attention.map(attentionText).join("\n\n") : "(none)"}

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
