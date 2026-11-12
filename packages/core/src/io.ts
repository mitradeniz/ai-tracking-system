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

/** A new, minimal project definition. */
export function createProjectTemplate(id: string, name: string): ProjectFile {
  return ProjectFileSchema.parse({
    format: "aitrack",
    version: 1,
    project: { id, name, description: "" },
    agents: [
      { id: "agent-a", name: "Agent A", tool: "claude", role: "Complex technical work" },
      { id: "agent-b", name: "Agent B", tool: "codex", role: "Simple technical work" },
    ],
    prompts: {
      context: { title: "Shared context", body: "Describe the project, its stack and its rules here." },
      "first-task": { title: "First task", body: "Describe the first task here." },
    },
    tasks: [
      { id: "T-01", title: "First task", agent: "agent-a", prompts: ["context", "first-task"] },
      { id: "T-02", title: "Second task", agent: "agent-b", dependsOn: ["T-01"], instructions: "Describe it." },
    ],
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
    source,
  });
}

export interface ParsedReports {
  reports: Report[];
  errors: string[];
}

/**
 * Extracts reports from free text: fenced ```aitrack-report blocks, or the whole text when it is JSON.
 * A block may hold one report object or an array of them.
 */
export function parseReports(text: string): ParsedReports {
  const reports: Report[] = [];
  const errors: string[] = [];
  const blocks: string[] = [];
  const fence = /```aitrack-report\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) blocks.push(m[1] ?? "");
  if (blocks.length === 0 && text.trim().length > 0) blocks.push(text.trim());

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
