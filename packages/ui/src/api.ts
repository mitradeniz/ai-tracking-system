import type { BoardSnapshot, Issue, ProjectFile, TrackEvent } from "@aitrack/core";

export interface ProjectSummary {
  key: string;
  filePath: string;
  addedAt: string;
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
  showInFolder(filePath: string): Promise<void>;
}

declare global {
  interface Window {
    aitrackDesktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined = typeof window !== "undefined" ? window.aitrackDesktop : undefined;

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
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
    throw new Error(message);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  projects: () => request<{ projects: ProjectSummary[] }>("GET", "/api/projects").then((r) => r.projects),
  project: (key: string) => request<ProjectDetail>("GET", `/api/projects/${enc(key)}`),
  addProject: (filePath: string) => request<ProjectSummary>("POST", "/api/projects", { filePath }),
  createProject: (filePath: string, id: string, name: string) =>
    request<ProjectSummary>("POST", "/api/projects/create", { filePath, id, name }),
  removeProject: (key: string) => request<{ ok: true }>("DELETE", `/api/projects/${enc(key)}`),
  reload: (key: string) => request<{ ok: true }>("POST", `/api/projects/${enc(key)}/reload`),
  addEvent: (key: string, event: { task: string; type: string; agent?: string; message?: string; reason?: string; pr?: string }) =>
    request<TrackEvent>("POST", `/api/projects/${enc(key)}/events`, event),
  paste: (key: string, text: string) =>
    request<{ recorded: number; errors: string[] }>("POST", `/api/projects/${enc(key)}/paste`, { text }),
  taskPrompt: (key: string, task: string, agent?: string) =>
    request<{ text: string }>(
      "GET",
      `/api/projects/${enc(key)}/tasks/${enc(task)}/prompt${agent ? `?agent=${enc(agent)}` : ""}`,
    ).then((r) => r.text),
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
