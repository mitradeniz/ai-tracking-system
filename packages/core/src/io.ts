import { validateProject, type Issue } from "./graph.ts";
import {
  EventSchema,
  ProjectFileSchema,
  ReportSchema,
  type EventSource,
  type ProjectFile,
  type Report,
  type TrackEvent,
} from "./schema.ts";

export const FILE_EXTENSION = ".aitrack";
export const SCHEMA_URL =
  "https://raw.githubusercontent.com/mitradeniz/ai-tracking-system/main/schema/aitrack.schema.json";

export interface ParseResult {
  project: ProjectFile | null;
  issues: Issue[];
}

/** Parses and validates the text of a project file. Never throws. */
export function parseProjectFile(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { project: null, issues: [{ level: "error", path: "", message: `Not valid JSON: ${(e as Error).message}` }] };
  }
  const parsed = ProjectFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      project: null,
      issues: parsed.error.issues.map((i) => ({
        level: "error" as const,
        path: i.path.map(String).join("."),
        message: i.message,
      })),
    };
  }
  const issues = validateProject(parsed.data);
  return { project: parsed.data, issues };
}

export interface SerializeOptions {
  /** Events to embed as a state snapshot. Omit to write the definition only. */
  events?: TrackEvent[];
  now?: Date;
}

/** Serializes a project to the file format, with a stable key order and a trailing newline. */
export function serializeProject(project: ProjectFile, options: SerializeOptions = {}): string {
  const { state: _ignored, ...definition } = project;
  // Header fields first for readability; prompts last because they are long.
  const ordered: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    format: "aitrack",
    version: 1,
    project: definition.project,
    settings: definition.settings,
    agents: definition.agents,
    milestones: definition.milestones,
    tasks: definition.tasks,
    prompts: definition.prompts,
    templates: definition.templates,
  };
  if (options.events) {
    ordered.state = {
      exportedAt: (options.now ?? new Date()).toISOString(),
      events: [...options.events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)),
    };
  }
  return JSON.stringify(ordered, null, 2) + "\n";
}

/** A new project with the given chats (possibly none), no tasks and no prompts. */
export function createEmptyProject(
  id: string,
  name: string,
  options: { language?: "en" | "tr"; description?: string; agents?: Array<{ id: string; name: string; tool?: string; role?: string }> } = {},
): ProjectFile {
  return ProjectFileSchema.parse({
    format: "aitrack",
    version: 1,
    project: { id, name, ...(options.description ? { description: options.description } : {}) },
    settings: options.language ? { language: options.language } : undefined,
    agents: (options.agents ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.tool ? { tool: a.tool } : {}),
      ...(a.role ? { role: a.role } : {}),
    })),
    tasks: [],
    prompts: {},
  });
}

let counter = 0;
export function newEventId(now: Date = new Date()): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${now.getTime().toString(36)}-${counter.toString(36)}-${rand}`;
}

const REPORT_TO_EVENT: Record<Report["status"], TrackEvent["type"]> = {
  started: "started",
  progress: "progress",
  blocked: "blocked",
  review: "review",
  done: "done",
  failed: "failed",
};

export function reportToEvent(report: Report, source: EventSource, now: Date = new Date()): TrackEvent {
  return EventSchema.parse({
    id: newEventId(now),
    ts: now.toISOString(),
    task: report.task,
    agent: report.agent,
    type: REPORT_TO_EVENT[report.status],
    message: report.summary ?? report.message,
    reason: report.reason,
    pr: report.pr,
    verify: report.verify,
    issues: report.issues,
    waitingFor: report.status === "blocked" ? report.waitingFor : undefined,
    source,
  });
}

export interface ParsedReports {
  reports: Report[];
  errors: string[];
}

/**
 * The JSON objects written inline in a text, outermost only, in order. Strings are respected, so
 * braces inside them do not count.
 */
export function jsonObjectsIn(text: string): Array<{ start: number; end: number; value: Record<string, unknown> }> {
  const out: Array<{ start: number; end: number; value: Record<string, unknown> }> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (c === "\\") j++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = j + 1;
        break;
      }
    }
    if (end < 0) break;
    try {
      const value = JSON.parse(text.slice(i, end)) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out.push({ start: i, end, value: value as Record<string, unknown> });
        i = end - 1;
      }
    } catch {
      // Not JSON; look further.
    }
  }
  return out;
}

const looksLikeReport = (o: Record<string, unknown>) => typeof o.task === "string" && typeof o.status === "string";

/**
 * Extracts reports from free text: fenced ```aitrack-report blocks, else the whole text when it is
 * JSON, else ```json blocks and JSON objects written inline that have a task and a status (an AI
 * that forgot the fence). A block may hold one report object or an array of them.
 */
export function parseReports(text: string): ParsedReports {
  const reports: Report[] = [];
  const errors: string[] = [];
  const blocks: string[] = [];
  const fence = /```aitrack-report\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) blocks.push(m[1] ?? "");
  if (blocks.length === 0 && text.trim().length > 0) {
    let whole = true;
    try {
      JSON.parse(text.trim());
    } catch {
      whole = false;
    }
    const inline = whole ? [] : jsonObjectsIn(text).filter((o) => looksLikeReport(o.value));
    if (inline.length > 0) for (const o of inline) blocks.push(JSON.stringify(o.value));
    else blocks.push(text.trim());
  }

  for (const block of blocks) {
    let raw: unknown;
    try {
      raw = JSON.parse(block);
    } catch (e) {
      errors.push(`Not valid JSON: ${(e as Error).message}`);
      continue;
    }
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const r = ReportSchema.safeParse(item);
      if (r.success) reports.push(r.data);
      else errors.push(r.error.issues.map((i) => `${i.path.join(".") || "report"}: ${i.message}`).join("; "));
    }
  }
  return { reports, errors };
}
