import type { BoardSnapshot, IntegrationPlan, Issue, ProjectFile, TrackEvent } from "@aitrack/core";

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

export interface AgentPayload {
  id: string;
  name: string;
  tool?: string;
  role?: string;
  maxParallel?: number;
  bootstrapPrompts?: string[];
}

export type ProviderId = "codex" | "claude" | "copilot" | "gemini" | "custom";
export type RunnerProvider = ProviderId | "manual";

/** How a chat is run on this computer. Kept by the local tracker, never in the project file. */
export interface ChatRunner {
  provider: RunnerProvider;
  /** Claude Code with "edit files": the usual work commands run without asking (default on). */
  workCommands?: boolean;
  /** Claude Code with "edit files": auto mode approves routine steps and blocks risky ones (default on). */
  autoPermissions?: boolean;
  /** Claude Code: other folders the chat may use, one absolute path per line. */
  extraDirs?: string;
  workdir?: string;
  model?: string;
  effort?: string;
  access: "readonly" | "edit" | "full";
  session: "keep" | "perTask";
  sessionId?: string;
  unattended: boolean;
  network: boolean;
  allowedTools?: string;
  extraArgs?: string;
  binary?: string;
  command?: string;
}

export interface RunSummary {
  id: string;
  key: string;
  task: string;
  agent: string;
  provider: ProviderId;
  kind: "task" | "reply";
  auto: boolean;
  state: "running" | "waiting" | "finished" | "failed" | "stopped";
  startedAt: string;
  endedAt?: string;
  workdir: string;
  sessionId?: string;
  lastActivity?: string;
  lastMessage?: string;
  error?: string;
  lines: number;
  tools: number;
  usage?: {
    input?: number;
    cached?: number;
    output?: number;
    context?: number;
    contextWindow?: number;
    costUsd?: number;
    turns?: number;
    model?: string;
  };
  denials?: string[];
}

export type ManagerProvider = "claude" | "codex" | "gemini" | "copilot";

/** A CLI that takes the decisions while the person is away. */
export interface ManagerSettings {
  enabled: boolean;
  provider: ManagerProvider;
  model?: string;
  effort?: string;
  binary?: string;
  maxRunsPerHour: number;
  /** Also continue tasks the person stopped. */
  resumeStopped: boolean;
  /** Also approve finished tasks that wait in review. */
  approveDone: boolean;
}

export interface ManagerAction {
  type: string;
  task?: string;
  ok: boolean;
  detail: string;
}

export interface ManagerRun {
  id: string;
  trigger: "auto" | "manual";
  provider: ManagerProvider;
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

/** What writing a plan changed. */
export interface ApplyResult {
  created: string[];
  linked: string[];
  ignored: string[];
  closedNotes: number;
  errors: string[];
}

export interface RunnerState {
  manager?: ManagerState;
  settings: { autoDispatch: boolean; maxConcurrent: number; chats: Record<string, ChatRunner> };
  /** Chats the person stopped; automatic dispatch leaves them alone until they get a task again. */
  held?: string[];
  defaultWorkdir: string;
  defaultWorkdirExists?: boolean;
  planFolder?: string;
  runs: RunSummary[];
  errors: Record<string, string>;
  hooks: { claude: string; codex: string; generic: string };
}

export interface ModelChoice {
  id: string;
  label: string;
  efforts?: string[];
  defaultEffort?: string;
}

export interface DetectedProvider {
  id: ProviderId;
  name: string;
  path: string | null;
  version: string | null;
  models: ModelChoice[];
  efforts: string[];
  /** Claude Code: whether the installed version has auto mode. */
  autoMode?: boolean;
}

export interface RunLogEvent {
  key: string;
  runId: string;
  from: number;
  lines: string[];
  lastActivity?: string;
}

export interface UpdateCommit {
  sha: string;
  date: string;
  subject: string;
}

export interface UpdateInfo {
  state: "current" | "available" | "blocked" | "unsupported" | "error";
  reason?: string;
  detail?: string;
  repo?: string;
  branch?: string;
  upstream?: string;
  current?: UpdateCommit;
  behind: number;
  ahead: number;
  commits: UpdateCommit[];
  checkedAt: string;
}

export interface UpdateProgress {
  state: "idle" | "running" | "done" | "failed" | "current";
  message?: string;
  at?: string;
  from?: string;
  to?: string;
  log: string[];
}

export interface TaskPayload {
  id: string;
  title: string;
  agent: string;
  description?: string;
  alsoAgents?: string[];
  dependsOn?: string[];
  prompts?: string[];
  instructions?: string;
  scope?: string;
  allowedPaths?: string[];
  acceptance?: string;
  milestone?: string;
  estimateDays?: number | null;
  tags?: string[];
}

export interface AuthoringChat {
  id: string;
  name: string;
  tool?: string;
  role?: string;
}

export interface AuthoringInput {
  projectId: string;
  projectName: string;
  language?: "en" | "tr";
  chats: AuthoringChat[];
  plan: string;
  canReadRepository?: boolean;
  previous?: { text: string; errors: string[] };
}

export interface AuthoringCheck {
  text: string | null;
  errors: string[];
  warnings: string[];
  summary: {
    chats: { id: string; name: string; tool: string | null }[];
    tasks: { id: string; title: string; agent: string; dependsOn: string[] }[];
    prompts: number;
    milestones: string[];
  } | null;
}

export interface GenerateJob {
  id: string;
  provider: "claude" | "codex" | "gemini" | "copilot";
  state: "running" | "done" | "failed" | "stopped";
  startedAt: string;
  endedAt?: string;
  activity: string[];
  tools: number;
  answer?: string;
  error?: string;
}

export interface FolderInfo {
  path: string;
  exists: boolean;
  isDir: boolean;
  isGit: boolean;
  projectFiles: string[];
  name: string;
}

export interface Activity {
  key: string;
  projectName?: string;
  event: TrackEvent;
}

/** Native helpers exposed by the desktop app's preload script. Absent in a plain browser. */
export interface DesktopBridge {
  isDesktop: true;
  openProjectDialog(): Promise<string | null>;
  saveProjectDialog(defaultName: string): Promise<string | null>;
  newProjectDialog(): Promise<string | null>;
  /** Picks a folder (the new-project wizard). */
  chooseFolder?(defaultPath?: string): Promise<string | null>;
  /** Removes a project from the list and moves its .aitrack file to the Trash. */
  trashProject?(key: string): Promise<{ ok: boolean; error?: string }>;
  showInFolder(filePath: string): Promise<void>;
  platform?: string;
  /** The window is translucent (macOS vibrancy). */
  vibrancy?: boolean;
  /** Makes native materials follow the app theme. */
  setTheme?(theme: "dark" | "light" | "system"): Promise<void>;
  /** Opens (or focuses) the floating window. */
  openMini?(): Promise<void>;
  /** Hides the floating window (called from inside it). */
  closeMini?(): Promise<void>;
  /** Floating window options. */
  setMini?(options: { pinned?: boolean; opacity?: number }): Promise<void>;
  /** Brings the main window forward, optionally on a project and task. */
  focusMain?(projectKey?: string, taskId?: string): Promise<void>;
  /** In-app updates (desktop app built from a git clone). */
  updates?: {
    check(): Promise<UpdateInfo | null>;
    run(): Promise<{ ok: boolean; error?: string }>;
    progress(): Promise<UpdateProgress | null>;
    onOpen(callback: () => void): () => void;
  };
  /** The tracker's control token, needed to start agents. */
  controlToken?(): Promise<string | null>;
  /** Whether this window is in front (focused and visible); called when it changes. */
  onActive?(callback: (active: boolean) => void): () => void;
  /** Main window: called when the floating window asks to show a task. Returns an unsubscribe function. */
  onOpenTask?(callback: (projectKey: string | undefined, taskId: string | undefined) => void): () => void;
}

declare global {
  interface Window {
    aitrackDesktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined = typeof window !== "undefined" ? window.aitrackDesktop : undefined;

let tokenPromise: Promise<string | null> | null = null;

/**
 * The control token lets this window start agents. The desktop app hands it over; in a browser it
 * comes from the link printed by `aitrack serve` (#token=...) and is remembered on this computer.
 */
export function controlToken(): Promise<string | null> {
  tokenPromise ??= (async () => {
    const fromHash = typeof location !== "undefined" ? /(?:^|[#&])token=([A-Za-z0-9]{16,128})/.exec(location.hash)?.[1] : undefined;
    if (fromHash) {
      try {
        localStorage.setItem("aitrack.token", fromHash);
      } catch {
        // Kept for this page only.
      }
      history.replaceState(null, "", location.pathname + location.search);
      return fromHash;
    }
    if (desktop?.controlToken) {
      try {
        const token = await desktop.controlToken();
        if (token) return token;
      } catch {
        // Fall through.
      }
    }
    try {
      return localStorage.getItem("aitrack.token");
    } catch {
      return null;
    }
  })();
  return tokenPromise;
}

/** An error answer from the tracker, with its HTTP status (0 when the tracker could not be reached). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const token = await controlToken();
  const headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
  if (token) headers["x-aitrack-token"] = token;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : res.statusText;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  projects: () => request<{ projects: ProjectSummary[] }>("GET", "/api/projects").then((r) => r.projects),
  project: (key: string) => request<ProjectDetail>("GET", `/api/projects/${enc(key)}`),
  addProject: (filePath: string) => request<ProjectSummary>("POST", "/api/projects", { filePath }),
  createProject: (input: {
    filePath: string;
    id?: string;
    name?: string;
    language?: "en" | "tr";
    agents?: AuthoringChat[];
    /** A checked project file (from the AI step). */
    text?: string;
  }) => request<ProjectSummary>("POST", "/api/projects/create", input),
  removeProject: (key: string) => request<{ ok: true }>("DELETE", `/api/projects/${enc(key)}`),
  pinProject: (key: string, pinned: boolean) =>
    request<{ projects: ProjectSummary[] }>("POST", `/api/projects/${enc(key)}/pin`, { pinned }).then((r) => r.projects),
  orderProjects: (keys: string[]) => request<{ projects: ProjectSummary[] }>("POST", "/api/projects/order", { keys }).then((r) => r.projects),
  saveInfo: (
    key: string,
    info: { name?: string; description?: string; language?: "en" | "tr" | null; requireApproval?: boolean; repoPath?: string | null },
  ) => request<ProjectSummary>("POST", `/api/projects/${enc(key)}/info`, info),
  createCodeFolder: (key: string) =>
    request<{ path: string; created: boolean; git: boolean }>("POST", `/api/projects/${enc(key)}/code-folder`, {}),
  replacePlan: (key: string, text: string) => request<ProjectSummary>("POST", `/api/projects/${enc(key)}/plan`, { text }),
  saveTask: (key: string, task: TaskPayload, mode: "create" | "update") =>
    request<ProjectSummary>("POST", `/api/projects/${enc(key)}/tasks`, { task, mode }),
  removeTask: (key: string, task: string) => request<ProjectSummary>("POST", `/api/projects/${enc(key)}/tasks/${enc(task)}/remove`, {}),
  savePrompt: (key: string, prompt: { id: string; title?: string; body: string }, mode: "create" | "update") =>
    request<ProjectSummary>("POST", `/api/projects/${enc(key)}/prompts`, { prompt, mode }),
  removePrompt: (key: string, prompt: string) =>
    request<ProjectSummary>("POST", `/api/projects/${enc(key)}/prompts/${enc(prompt)}/remove`, {}),
  folder: (dir: string) => request<FolderInfo>("POST", "/api/folder", { dir }),
  authoringPrompt: (input: AuthoringInput) => request<{ text: string }>("POST", "/api/authoring/prompt", { input }).then((r) => r.text),
  checkAnswer: (answer: string, input: AuthoringInput) => request<AuthoringCheck>("POST", "/api/authoring/check", { answer, input }),
  generate: (provider: GenerateJob["provider"], cwd: string, input: AuthoringInput, model?: string) =>
    request<GenerateJob>("POST", "/api/authoring/generate", { provider, cwd, input, model }),
  generateStatus: (id: string) => request<GenerateJob>("GET", `/api/authoring/generate/${enc(id)}`),
  stopGenerate: (id: string) => request<GenerateJob>("POST", `/api/authoring/generate/${enc(id)}/stop`, {}),
  reload: (key: string) => request<{ ok: true }>("POST", `/api/projects/${enc(key)}/reload`),
  addEvent: (key: string, event: { task: string; type: string; agent?: string; message?: string; reason?: string; pr?: string }) =>
    request<TrackEvent>("POST", `/api/projects/${enc(key)}/events`, event),
  setIssueState: (key: string, task: string, issue: { index: number; title: string; state: "resolved" | "ignored" | "open" }) =>
    request<TrackEvent>("POST", `/api/projects/${enc(key)}/tasks/${enc(task)}/issues`, issue),
  /** Several problems of a task at once (a group of refused steps, say), in one event. */
  setIssueStates: (key: string, task: string, issues: Array<{ index: number; title: string }>, state: "resolved" | "ignored" | "open") =>
    request<TrackEvent>("POST", `/api/projects/${enc(key)}/tasks/${enc(task)}/issues`, { issues, state }),
  paste: (key: string, text: string) =>
    request<{ recorded: number; errors: string[] }>("POST", `/api/projects/${enc(key)}/paste`, { text }),
  taskPrompt: (key: string, task: string, agent?: string) =>
    request<{ text: string }>("GET", `/api/projects/${enc(key)}/tasks/${enc(task)}/prompt${agent ? `?agent=${enc(agent)}` : ""}`).then(
      (r) => r.text,
    ),
  bootstrapPrompt: (key: string, agent: string) =>
    request<{ text: string }>("GET", `/api/projects/${enc(key)}/agents/${enc(agent)}/bootstrap`).then((r) => r.text),
  libraryPrompt: (key: string, prompt: string) =>
    request<{ text: string }>("GET", `/api/projects/${enc(key)}/prompts/${enc(prompt)}`).then((r) => r.text),
  exportTo: (key: string, filePath: string, includeState: boolean) =>
    request<{ filePath: string }>("POST", `/api/projects/${enc(key)}/export`, { filePath, includeState }),
  saveAgent: (key: string, agent: AgentPayload, helpsWith: string[]) =>
    request<ProjectSummary>("POST", `/api/projects/${enc(key)}/agents`, { agent, helpsWith }),
  removeAgent: (key: string, agent: string, reassignTo?: string) =>
    request<ProjectSummary>("POST", `/api/projects/${enc(key)}/agents/${enc(agent)}/remove`, { reassignTo }),
  exportUrl: (key: string, includeState: boolean) => `/api/projects/${enc(key)}/export${includeState ? "?state=1" : ""}`,
  // Agent runners
  control: () => request<{ ok: true }>("GET", "/api/control").then(() => true, () => false),
  providers: (refresh = false) =>
    request<{ providers: DetectedProvider[] }>("GET", `/api/providers${refresh ? "?refresh=1" : ""}`).then((r) => r.providers),
  runners: (key: string) => request<RunnerState>("GET", `/api/projects/${enc(key)}/runners`),
  saveRunnerProject: (key: string, patch: { autoDispatch?: boolean; maxConcurrent?: number }) =>
    request<RunnerState["settings"]>("POST", `/api/projects/${enc(key)}/runners`, patch),
  saveRunner: (key: string, agent: string, runner: Partial<ChatRunner>) =>
    request<ChatRunner>("POST", `/api/projects/${enc(key)}/runners/${enc(agent)}`, { runner }),
  runTask: (key: string, task: string, agent?: string, extra?: string) =>
    request<RunSummary>("POST", `/api/projects/${enc(key)}/tasks/${enc(task)}/run`, { agent, extra }),
  reply: (key: string, agent: string, text: string, task?: string) =>
    request<RunSummary>("POST", `/api/projects/${enc(key)}/agents/${enc(agent)}/reply`, { text, task }),
  stopRun: (id: string) => request<RunSummary>("POST", `/api/runs/${enc(id)}/stop`, {}),
  stopAll: (key: string) => request<{ stopped: number }>("POST", `/api/projects/${enc(key)}/runs/stop`, {}),
  activeRuns: () => request<{ count: number }>("GET", "/api/runs/active").then((r) => r.count),
  // The manager: a CLI that answers waiting chats and keeps the plan up to date while the person is away.
  saveManager: (key: string, patch: Partial<ManagerSettings>) => request<ManagerState>("POST", `/api/projects/${enc(key)}/manager`, patch),
  runManager: (key: string) => request<ManagerState>("POST", `/api/projects/${enc(key)}/manager/run`, {}),
  // Work chats left for later.
  addProposal: (key: string, id: string, agent?: string) =>
    request<ApplyResult>("POST", `/api/projects/${enc(key)}/proposals/add`, { id, agent }),
  setProposals: (key: string, ids: string[], state: "ignored" | "open") =>
    request<TrackEvent>("POST", `/api/projects/${enc(key)}/proposals/state`, { ids, state }),
  integrateProposals: (key: string, provider: ManagerProvider, model?: string) =>
    request<GenerateJob>("POST", `/api/projects/${enc(key)}/proposals/integrate`, { provider, model }),
  previewPlan: (key: string, answer: string) =>
    request<{ plan: IntegrationPlan; dropped: string[] }>("POST", `/api/projects/${enc(key)}/proposals/preview`, { answer }),
  applyPlan: (key: string, plan: IntegrationPlan) => request<ApplyResult>("POST", `/api/projects/${enc(key)}/proposals/apply`, { plan }),
  runLog: (id: string, after = 0) =>
    request<{ lines: string[]; next: number; run: RunSummary }>("GET", `/api/runs/${enc(id)}/log?after=${after}`),
};

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall back to a hidden textarea below.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

/** True when the chat is set up to run on its own (not copy and paste). */
export function canRun(runners: RunnerState | null | undefined, agentId: string): boolean {
  const provider = runners?.settings.chats[agentId]?.provider;
  return Boolean(provider && provider !== "manual");
}

/**
 * Gives a task to a chat. A chat with a runner gets it right away (its session starts or
 * continues); otherwise the prompt is copied for pasting and the task is marked as sent.
 */
export async function dispatchTask(
  projectKey: string,
  taskId: string,
  agentId: string,
  runners?: RunnerState | null,
  extra?: string,
): Promise<"run" | "copied"> {
  const note = extra?.trim();
  if (canRun(runners, agentId)) {
    await api.runTask(projectKey, taskId, agentId, note || undefined);
    return "run";
  }
  const prompt = await api.taskPrompt(projectKey, taskId, agentId);
  await copyText(note ? `${prompt.trimEnd()}\n\nADDITIONAL INSTRUCTIONS FROM THE PERSON (they take precedence):\n${note}\n` : prompt);
  await api.addEvent(projectKey, { task: taskId, type: "dispatched", agent: agentId });
  return "copied";
}
