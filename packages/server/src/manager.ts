import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  computeBoard,
  createEmptyProject,
  EditError,
  removeAgentFromFile,
  removePromptFromFile,
  removeTaskFromFile,
  updateProjectInfoInFile,
  upsertAgentInFile,
  upsertPromptInFile,
  upsertTaskInFile,
  EventSchema,
  FILE_EXTENSION,
  newEventId,
  nextTasksFor,
  parseProjectFile,
  parseReports,
  renderBootstrapPrompt,
  renderPrompt,
  renderTaskPrompt,
  reportToEvent,
  serializeBoard,
  serializeProject,
  type AgentChange,
  type Board,
  type BoardSnapshot,
  type EventSource,
  type Issue,
  type ProjectFile,
  type ProjectInfoInput,
  type PromptInput,
  type TaskInput,
  type Report,
  type TrackEvent,
} from "@aitrack/core";
import { archiveInboxFile, discoverInboxDirs, readInbox } from "./inbox.ts";
import { projectKey, Store, writeFileAtomic, type RegistryEntry } from "./store.ts";


export interface ProjectHandle extends RegistryEntry {
  project: ProjectFile | null;
  issues: Issue[];
  mtimeMs: number;
  events: TrackEvent[];
  inboxDirs: string[];
}

export interface ProjectSummary {
  key: string;
  filePath: string;
  addedAt: string;
  pinned: boolean;
  id: string | null;
  name: string;
  ok: boolean;
  errors: number;
  counts: BoardSnapshot["counts"] | null;
}

export interface ProjectDetail extends ProjectSummary {
  project: Omit<ProjectFile, "state"> | null;
  issues: Issue[];
  board: BoardSnapshot | null;
  events: TrackEvent[];
  inboxDirs: string[];
  serverUrl: string;
}

export interface ReportResult {
  key: string;
  task: string;
  status: string;
  next: { id: string; title: string }[];
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const UI_EVENT_TYPES = new Set(["dispatched", "started", "progress", "blocked", "review", "done", "approved", "failed", "reopened", "note"]);

export class ProjectManager extends EventEmitter {
  private handles = new Map<string, ProjectHandle>();
  private timer: NodeJS.Timeout | null = null;
  private lastInboxDiscovery = 0;
  serverUrl = "http://127.0.0.1:4317";

  constructor(readonly store: Store) {
    super();
  }

  async init(): Promise<void> {
    for (const entry of await this.store.readRegistry()) {
      const handle = await this.load(entry);
      this.handles.set(entry.key, handle);
    }
    await this.refreshInboxDirs();
  }

  /** Starts polling project files and report inboxes. */
  startWatching(intervalMs = 1500): void {
    if (this.timer) return;
    const tick = async () => {
      try {
        await this.checkFiles();
        // Worktrees are looked up with git; once a minute is enough.
        if (Date.now() - this.lastInboxDiscovery > 60_000) await this.refreshInboxDirs();
        await this.pollInboxes();
      } catch (e) {
        this.emit("warning", e);
      }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
  }

  stopWatching(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async load(entry: RegistryEntry, existingEvents?: TrackEvent[]): Promise<ProjectHandle> {
    let text = "";
    let mtimeMs = 0;
    try {
      text = await readFile(entry.filePath, "utf8");
      mtimeMs = (await stat(entry.filePath)).mtimeMs;
    } catch (e) {
      return {
        ...entry,
        project: null,
        issues: [{ level: "error", path: "", message: `Cannot read ${entry.filePath}: ${(e as Error).message}` }],
        mtimeMs: 0,
        events: existingEvents ?? (await this.store.readEvents(entry.key)),
        inboxDirs: [],
      };
    }
    const { project, issues } = parseProjectFile(text);
    const events = existingEvents ?? (await this.store.readEvents(entry.key));
    return { ...entry, project, issues, mtimeMs, events, inboxDirs: [] };
  }

  private async checkFiles(): Promise<void> {
    for (const handle of this.handles.values()) {
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(handle.filePath)).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      if (mtimeMs !== handle.mtimeMs) await this.reload(handle.key);
    }
  }

  private async refreshInboxDirs(): Promise<void> {
    this.lastInboxDiscovery = Date.now();
    for (const handle of this.handles.values()) {
      if (!handle.project) continue;
      handle.inboxDirs = await discoverInboxDirs(
        handle.filePath,
        handle.project.settings.inboxDir,
        handle.project.settings.repoPath,
      );
    }
  }

  async pollInboxes(): Promise<number> {
    let processed = 0;
    const seen = new Set<string>();
    for (const handle of this.handles.values()) {
      for (const dir of handle.inboxDirs) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        for (const { file, text } of await readInbox(dir)) {
          const { reports, errors } = parseReports(text);
          const failures: string[] = [...errors];
          for (const report of reports) {
            try {
              await this.recordReport(report, "file", handle.key);
            } catch (e) {
              failures.push((e as Error).message);
            }
          }
          const ok = reports.length > 0 && failures.length === 0;
          try {
            await archiveInboxFile(file, ok, failures.join("\n") || (reports.length === 0 ? "No report found." : undefined));
          } catch (e) {
            this.emit("warning", e);
          }
          processed += 1;
        }
      }
    }
    return processed;
  }

  list(): ProjectSummary[] {
    return this.ordered().map((h) => this.summary(h));
  }

  /** Pinned projects first; then the order the user chose; then the order they were added in. */
  private ordered(): ProjectHandle[] {
    const rank = (h: ProjectHandle) => (h.order === undefined ? Number.MAX_SAFE_INTEGER : h.order);
    return [...this.handles.values()].sort(
      (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || rank(a) - rank(b) || a.addedAt.localeCompare(b.addedAt),
    );
  }

  async setPinned(key: string, pinned: boolean): Promise<ProjectSummary[]> {
    const h = this.get(key);
    h.pinned = pinned || undefined;
    await this.persistRegistry();
    this.changed(key);
    return this.list();
  }

  /** Puts the projects in the given order; keys not listed keep their place after them. */
  async reorder(keys: string[]): Promise<ProjectSummary[]> {
    const listed = keys.filter((k) => this.handles.has(k));
    const rest = this.ordered()
      .map((h) => h.key)
      .filter((k) => !listed.includes(k));
    [...listed, ...rest].forEach((k, i) => (this.handles.get(k)!.order = i));
    await this.persistRegistry();
    for (const k of listed) this.changed(k);
    return this.list();
  }

  private summary(h: ProjectHandle): ProjectSummary {
    const board = h.project ? computeBoard(h.project, h.events) : null;
    return {
      key: h.key,
      filePath: h.filePath,
      addedAt: h.addedAt,
      pinned: Boolean(h.pinned),
      id: h.project?.project.id ?? null,
      name: h.project?.project.name ?? path.basename(h.filePath),
      ok: Boolean(h.project) && !h.issues.some((i) => i.level === "error"),
      errors: h.issues.filter((i) => i.level === "error").length,
      counts: board ? board.counts : null,
    };
  }

  private get(key: string): ProjectHandle {
    const h = this.handles.get(key);
    if (!h) throw new HttpError(404, `Unknown project "${key}"`);
    return h;
  }

  private requireProject(h: ProjectHandle): ProjectFile {
    if (!h.project) throw new HttpError(409, `Project file has errors: ${h.issues[0]?.message ?? "unknown"}`);
    return h.project;
  }

  /** Keys of the open projects. */
  keys(): string[] {
    return [...this.handles.keys()];
  }

  /** The parsed project and its live board, for the agent runners. */
  context(key: string): { key: string; filePath: string; project: ProjectFile; board: Board } {
    const h = this.get(key);
    const project = this.requireProject(h);
    return { key, filePath: h.filePath, project, board: computeBoard(project, h.events) };
  }

  detail(key: string): ProjectDetail {
    const h = this.get(key);
    const board = h.project ? computeBoard(h.project, h.events) : null;
    let project: Omit<ProjectFile, "state"> | null = null;
    if (h.project) {
      const { state: _state, ...rest } = h.project;
      project = rest;
    }
    return {
      ...this.summary(h),
      project,
      issues: h.issues,
      board: board ? serializeBoard(board) : null,
      events: [...h.events].sort((a, b) => (a.ts < b.ts ? -1 : 1)).slice(-2000),
      inboxDirs: h.inboxDirs,
      serverUrl: this.serverUrl,
    };
  }

  async addProject(filePath: string): Promise<ProjectSummary> {
    const abs = path.resolve(filePath);
    if (!existsSync(abs)) throw new HttpError(400, `File not found: ${abs}`);
    const key = projectKey(abs);
    if (!this.handles.has(key)) {
      const entry: RegistryEntry = { key, filePath: abs, addedAt: new Date().toISOString() };
      const handle = await this.load(entry);
      // Import events embedded in the file (an exported snapshot) that the log does not have yet.
      if (handle.project?.state?.events.length) {
        const known = new Set(handle.events.map((e) => e.id));
        const fresh = handle.project.state.events.filter((e) => !known.has(e.id)).map((e) => ({ ...e }));
        await this.store.appendEvents(key, fresh);
        handle.events.push(...fresh);
      }
      this.handles.set(key, handle);
      await this.persistRegistry();
      await this.refreshInboxDirs();
      this.changed(key);
    }
    return this.summary(this.get(key));
  }

  /**
   * Writes a new project file and opens it: either the given file text (from the wizard's AI step,
   * checked first) or an empty project with the given chats.
   */
  async createProject(
    filePath: string,
    input: { id: string; name: string; language?: "en" | "tr"; agents?: Array<{ id: string; name: string; tool?: string; role?: string }>; text?: string },
  ): Promise<ProjectSummary> {
    let abs = path.resolve(filePath);
    if (!abs.endsWith(FILE_EXTENSION)) abs += FILE_EXTENSION;
    if (existsSync(abs)) throw new HttpError(409, `File already exists: ${abs}`);
    let text: string;
    if (input.text !== undefined) {
      const { project, issues } = parseProjectFile(input.text);
      const errors = issues.filter((i) => i.level === "error");
      if (!project || errors.length > 0) throw new HttpError(400, `The project file has errors: ${errors.map((e) => e.message).join("; ")}`);
      text = input.text.endsWith("\n") ? input.text : `${input.text}\n`;
    } else {
      let project: ProjectFile;
      try {
        project = createEmptyProject(input.id, input.name, { language: input.language, agents: input.agents });
      } catch (e) {
        throw new HttpError(400, `Invalid project: ${(e as Error).message}`);
      }
      const { issues } = parseProjectFile(serializeProject(project));
      const errors = issues.filter((i) => i.level === "error");
      if (errors.length > 0) throw new HttpError(400, errors.map((e) => e.message).join("; "));
      text = serializeProject(project);
    }
    await writeFileAtomic(abs, text);
    return this.addProject(abs);
  }

  async removeProject(key: string): Promise<void> {
    this.get(key);
    this.handles.delete(key);
    await this.persistRegistry();
    this.changed(key);
  }

  async reload(key: string): Promise<void> {
    const h = this.get(key);
    let next = await this.load(h, h.events);
    // An editor or another program may still be writing the file: read it again a moment later
    // before replacing a good plan with errors, so the board does not vanish for a second.
    if (h.project && !next.project) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      next = await this.load(h, h.events);
    }
    next.inboxDirs = h.inboxDirs;
    this.handles.set(key, next);
    if (next.project) {
      next.inboxDirs = await discoverInboxDirs(next.filePath, next.project.settings.inboxDir, next.project.settings.repoPath);
    }
    this.changed(key);
  }

  /** Adds or updates a chat in the project file on disk. */
  async saveAgent(key: string, change: AgentChange): Promise<ProjectSummary> {
    await this.editFile(key, (text) => upsertAgentInFile(text, change));
    return this.summary(this.get(key));
  }

  /** Removes a chat from the project file on disk; its tasks move to `reassignTo`. */
  async removeAgent(key: string, agentId: string, reassignTo?: string): Promise<ProjectSummary> {
    const h = this.get(key);
    const project = this.requireProject(h);
    const board = computeBoard(project, h.events);
    const holding = board.agents.find((a) => a.agent.id === agentId)?.holding ?? [];
    if (holding.length > 0) {
      throw new HttpError(409, `This chat is still working on ${holding.join(", ")}. Mark those tasks done, failed or reopened first.`);
    }
    await this.editFile(key, (text) => removeAgentFromFile(text, agentId, reassignTo));
    return this.summary(this.get(key));
  }

  /** Adds or changes a task in the project file on disk. */
  async saveTask(key: string, input: TaskInput, mode: "create" | "update"): Promise<ProjectSummary> {
    await this.editFile(key, (text) => upsertTaskInFile(text, input, mode));
    return this.summary(this.get(key));
  }

  /** Removes a task; tasks that depended on it take over its dependencies. */
  async removeTask(key: string, taskId: string): Promise<ProjectSummary> {
    const h = this.get(key);
    const project = this.requireProject(h);
    const status = computeBoard(project, h.events).byId.get(taskId)?.status;
    if (status === "dispatched" || status === "in_progress" || status === "blocked" || status === "review") {
      throw new HttpError(409, `${taskId} is with a chat right now. Mark it done, failed or reopen it before removing it.`);
    }
    await this.editFile(key, (text) => removeTaskFromFile(text, taskId));
    return this.summary(this.get(key));
  }

  async savePrompt(key: string, input: PromptInput, mode: "create" | "update"): Promise<ProjectSummary> {
    await this.editFile(key, (text) => upsertPromptInFile(text, input, mode));
    return this.summary(this.get(key));
  }

  async removePrompt(key: string, promptId: string): Promise<ProjectSummary> {
    await this.editFile(key, (text) => removePromptFromFile(text, promptId));
    return this.summary(this.get(key));
  }

  /**
   * Replaces the plan of a project that has no tasks yet with a new file (the "Plan with AI" step
   * for an empty project). The project keeps its id and name.
   */
  async replacePlan(key: string, text: string): Promise<ProjectSummary> {
    const h = this.get(key);
    const current = this.requireProject(h);
    if (current.tasks.length > 0) throw new HttpError(409, "This project already has tasks; add new ones one by one instead.");
    const { project, issues } = parseProjectFile(text);
    const errors = issues.filter((i) => i.level === "error");
    if (!project || errors.length > 0) throw new HttpError(400, `The project file has errors: ${errors.map((e) => e.message).join("; ")}`);
    if (project.project.id !== current.project.id) throw new HttpError(400, `The project id must stay "${current.project.id}".`);
    await writeFileAtomic(h.filePath, text.endsWith("\n") ? text : `${text}\n`);
    await this.reload(key);
    return this.summary(this.get(key));
  }

  async saveInfo(key: string, input: ProjectInfoInput): Promise<ProjectSummary> {
    // A folder picked in the app is absolute; the file keeps it relative to itself, so the plan
    // still works from another clone or another computer.
    const repoPath = input.repoPath?.trim();
    if (repoPath && path.isAbsolute(repoPath)) {
      const rel = path.relative(path.dirname(this.get(key).filePath), repoPath);
      input = { ...input, repoPath: path.isAbsolute(rel) ? repoPath : (rel || ".").split(path.sep).join("/") };
    }
    await this.editFile(key, (text) => updateProjectInfoInFile(text, input));
    return this.summary(this.get(key));
  }

  private async editFile(key: string, edit: (text: string) => string): Promise<void> {
    const h = this.get(key);
    const text = await readFile(h.filePath, "utf8");
    let next: string;
    try {
      next = edit(text);
    } catch (e) {
      if (e instanceof EditError) {
        const status = e.code === "not_found" ? 404 : e.code.startsWith("invalid_") && e.code !== "invalid_file" && e.code !== "invalid_result" ? 400 : 409;
        throw new HttpError(status, e.message);
      }
      throw e;
    }
    if (next !== text) await writeFileAtomic(h.filePath, next);
    await this.reload(key);
  }

  private async persistRegistry(): Promise<void> {
    await this.store.writeRegistry(
      this.ordered().map(({ key, filePath, addedAt, pinned, order }) => ({
        key,
        filePath,
        addedAt,
        ...(pinned ? { pinned: true } : {}),
        ...(order !== undefined ? { order } : {}),
      })),
    );
  }

  private changed(key: string): void {
    this.emit("changed", { key });
  }

  /**
   * Marks one of a task's reported problems resolved or ignored, or opens it again. Recorded as a
   * note with the task's updated problem list, so the log keeps who closed what and when.
   */
  async setIssueState(
    key: string,
    taskId: string,
    target: { index?: number; title: string; state: "resolved" | "ignored" | "open" },
  ): Promise<TrackEvent> {
    return this.setIssueStates(key, taskId, [target], target.state);
  }

  /** Resolves, ignores or reopens several problems of a task at once, in one event. */
  async setIssueStates(
    key: string,
    taskId: string,
    targets: Array<{ index?: number; title: string }>,
    state: "resolved" | "ignored" | "open",
  ): Promise<TrackEvent> {
    const { board } = this.context(key);
    const view = board.tasks.find((t) => t.task.id === taskId);
    if (!view) throw new HttpError(404, `Unknown task "${taskId}"`);
    if (targets.length === 0) throw new HttpError(400, "No problem given.");
    const issues = view.runtime.issues.map((i) => ({ ...i }));
    const titles: string[] = [];
    const taken = new Set<number>();
    for (const target of targets) {
      // The index the app saw, unless the list changed since; then the first problem with that title.
      const at =
        target.index !== undefined && issues[target.index]?.title === target.title && !taken.has(target.index)
          ? target.index
          : issues.findIndex((i, n) => i.title === target.title && !taken.has(n));
      if (at < 0) throw new HttpError(409, "That problem is no longer reported for this task.");
      taken.add(at);
      const issue = issues[at]!;
      if (state === "open") delete issue.state;
      else issue.state = state;
      titles.push(issue.title);
    }
    const verb = state === "open" ? "reopened" : state;
    const message = titles.length === 1 ? `Problem ${verb}: ${titles[0]}` : `${titles.length} problems ${verb}: ${titles.join("; ")}`;
    return this.addEvent(key, { type: "note", task: taskId, message: message.slice(0, 2000), issues }, "ui");
  }

  async addEvent(key: string, input: Record<string, unknown>, source: EventSource): Promise<TrackEvent> {
    const h = this.get(key);
    const project = this.requireProject(h);
    const type = String(input.type ?? "");
    if (!UI_EVENT_TYPES.has(type)) throw new HttpError(400, `Unknown event type "${type}"`);
    const task = String(input.task ?? "");
    if (!project.tasks.some((t) => t.id === task)) throw new HttpError(400, `Unknown task "${task}"`);
    const now = new Date();
    const parsed = EventSchema.safeParse({
      id: newEventId(now),
      ts: now.toISOString(),
      task,
      type,
      agent: input.agent ? String(input.agent) : undefined,
      message: input.message ? String(input.message) : undefined,
      reason: input.reason ? String(input.reason) : undefined,
      pr: input.pr ? String(input.pr) : undefined,
      verify: input.verify ? String(input.verify) : undefined,
      issues: Array.isArray(input.issues) ? input.issues : undefined,
      source,
    });
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
    await this.store.appendEvents(key, [parsed.data]);
    h.events.push(parsed.data);
    this.changed(key);
    this.emit("activity", { key, event: parsed.data, projectName: project.project.name });
    return parsed.data;
  }

  /** Records a report from an agent. Finds the project by id, by key, or by the task id. */
  async recordReport(report: Report, source: EventSource, preferKey?: string): Promise<ReportResult> {
    const candidates = [...this.handles.values()].filter((h) => h.project);
    let target: ProjectHandle | undefined;
    const hasTask = (h: ProjectHandle) => Boolean(h.project?.tasks.some((t) => t.id === report.task));
    if (preferKey) {
      const h = this.handles.get(preferKey);
      if (h && hasTask(h) && (!report.project || h.project?.project.id === report.project)) target = h;
    }
    if (!target && report.project) {
      target = candidates.find((h) => (h.project?.project.id === report.project || h.key === report.project) && hasTask(h));
    }
    if (!target && !report.project) {
      const matches = candidates.filter(hasTask);
      if (matches.length > 1) {
        throw new HttpError(409, `Task "${report.task}" exists in several projects; add "project" to the report.`);
      }
      target = matches[0];
    }
    if (!target) {
      throw new HttpError(404, `No open project has task "${report.task}"${report.project ? ` (project "${report.project}")` : ""}.`);
    }
    const event = reportToEvent(report, source);
    await this.store.appendEvents(target.key, [event]);
    target.events.push(event);
    this.changed(target.key);
    this.emit("activity", { key: target.key, event, projectName: target.project?.project.name });

    const project = target.project as ProjectFile;
    const board = computeBoard(project, target.events);
    const agent = report.agent ?? board.byId.get(report.task)?.runtime.agent ?? project.tasks.find((t) => t.id === report.task)?.agent;
    const next = agent ? nextTasksFor(board, agent).map((v) => ({ id: v.task.id, title: v.task.title })) : [];
    return { key: target.key, task: report.task, status: board.byId.get(report.task)?.status ?? "unknown", next };
  }

  async paste(key: string, text: string): Promise<{ recorded: number; errors: string[] }> {
    const { reports, errors } = parseReports(text);
    let recorded = 0;
    for (const r of reports) {
      try {
        await this.recordReport(r, "paste", key);
        recorded += 1;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (reports.length === 0 && errors.length === 0) errors.push("No aitrack-report block found.");
    return { recorded, errors };
  }

  taskPrompt(key: string, taskId: string, agentId?: string): string {
    const project = this.requireProject(this.get(key));
    if (!project.tasks.some((t) => t.id === taskId)) throw new HttpError(404, `Unknown task "${taskId}"`);
    return renderTaskPrompt(project, taskId, { serverUrl: this.serverUrl, agentId });
  }

  bootstrapPrompt(key: string, agentId: string): string {
    const project = this.requireProject(this.get(key));
    if (!project.agents.some((a) => a.id === agentId)) throw new HttpError(404, `Unknown agent "${agentId}"`);
    return renderBootstrapPrompt(project, agentId);
  }

  libraryPrompt(key: string, promptId: string): string {
    const project = this.requireProject(this.get(key));
    if (!project.prompts[promptId]) throw new HttpError(404, `Unknown prompt "${promptId}"`);
    return renderPrompt(project, promptId);
  }

  next(key: string, agentId: string): { tasks: { id: string; title: string }[]; prompt: string | null } {
    const project = this.requireProject(this.get(key));
    const board = computeBoard(project, this.get(key).events);
    const tasks = nextTasksFor(board, agentId).map((v) => ({ id: v.task.id, title: v.task.title }));
    const first = tasks[0];
    return { tasks, prompt: first ? this.taskPrompt(key, first.id, agentId) : null };
  }

  exportText(key: string, includeState: boolean): { fileName: string; text: string } {
    const h = this.get(key);
    const project = this.requireProject(h);
    const text = serializeProject(project, includeState ? { events: h.events } : {});
    return { fileName: `${project.project.id}${FILE_EXTENSION}`, text };
  }

  async exportTo(key: string, target: string, includeState: boolean): Promise<string> {
    const abs = path.resolve(target);
    if (!abs.endsWith(FILE_EXTENSION) && !abs.endsWith(".json")) {
      throw new HttpError(400, `Export target must end with ${FILE_EXTENSION} or .json`);
    }
    const { text } = this.exportText(key, includeState);
    await writeFileAtomic(abs, text);
    return abs;
  }
}
