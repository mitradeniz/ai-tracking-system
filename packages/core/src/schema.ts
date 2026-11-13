import { z } from "zod";

/**
 * The `.aitrack` project file format, version 1.
 *
 * A project file describes the chats (agents) that work on a project, the tasks they take,
 * the dependencies between tasks and the prompts to paste into each chat. It can also carry a
 * snapshot of the status events, so a project can be exported, shared and re-opened.
 */

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const id = (what: string) =>
  z
    .string()
    .min(1)
    .max(80)
    .regex(ID_PATTERN, `${what} id may contain letters, digits, ".", "_" and "-" and must start with a letter or digit`);

export const AgentSchema = z.object({
  id: id("Agent").describe("Stable identifier used in tasks and reports, e.g. \"codex-b\"."),
  name: z.string().min(1).describe("Display name of the chat, e.g. \"Codex B\"."),
  tool: z.string().optional().describe("The AI tool behind the chat, e.g. \"claude\", \"codex\"."),
  role: z.string().optional().describe("One line describing what this chat is responsible for."),
  capabilities: z.array(z.string()).default([]).describe("Free-form capability tags, e.g. \"computer-use\"."),
  color: z.string().optional().describe("Optional CSS color used for this chat in the UI."),
  maxParallel: z.number().int().min(1).max(10).default(1).describe("How many tasks this chat may hold at once."),
  bootstrapPrompts: z
    .array(z.string())
    .default([])
    .describe("Prompt ids pasted, in order, when a new session of this chat starts."),
  quickPrompts: z
    .array(z.string())
    .default([])
    .describe("Prompt ids for recurring duties (reviews, QA rounds) shown as quick-copy buttons."),
});

export const PromptSchema = z.object({
  title: z.string().optional(),
  body: z.string().min(1),
});

export const TaskSchema = z.object({
  id: id("Task"),
  title: z.string().min(1),
  description: z.string().optional(),
  agent: z.string().min(1).describe("Id of the chat that owns this task."),
  alsoAgents: z
    .array(z.string())
    .default([])
    .describe("Other chats allowed to take this task when the owner is busy."),
  dependsOn: z.array(z.string()).default([]).describe("Task ids that must be done before this task can start."),
  prompts: z.array(z.string()).default([]).describe("Prompt ids whose bodies are pasted for this task, in order."),
  instructions: z.string().optional().describe("Extra instructions appended after the prompts."),
  scope: z.string().optional().describe("Which part of the prompts this task covers, for split tasks."),
  allowedPaths: z.array(z.string()).default([]).describe("Paths the chat may change for this task."),
  acceptance: z.string().optional().describe("How to tell the task is done."),
  milestone: z.string().optional(),
  estimateDays: z.number().positive().max(365).optional(),
  tags: z.array(z.string()).default([]),
});

export const MilestoneSchema = z.object({
  id: id("Milestone"),
  name: z.string().min(1),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),
  description: z.string().optional(),
});

export const SettingsSchema = z.object({
  requireApproval: z
    .boolean()
    .default(false)
    .describe("When true, a task reported done goes to review until a human approves it."),
  inboxDir: z
    .string()
    .default(".aitrack/inbox")
    .describe("Directory, relative to a repository root, where agents drop report files."),
  repoPath: z
    .string()
    .optional()
    .describe("Path of the main git repository, relative to this file. Its worktrees are scanned for report files."),
  language: z.enum(["en", "tr"]).optional(),
});

export const TemplatesSchema = z.object({
  dispatch: z.string().optional().describe("Template of the prompt copied for a task. See docs/file-format.md."),
  report: z.string().optional().describe("Template of the reporting instructions appended to every task prompt."),
});

export const EVENT_TYPES = [
  "dispatched",
  "started",
  "progress",
  "blocked",
  "review",
  "done",
  "approved",
  "failed",
  "reopened",
  "note",
] as const;

/**
 * Something that failed, was skipped, is missing or needs a person, written so the project owner
 * understands it, with a prompt that would fix it.
 */
export const ISSUE_KINDS = ["error", "missing", "needs-you", "warning"] as const;

export const TaskIssueSchema = z.object({
  title: z.string().min(1).max(300).describe("One line in plain language."),
  detail: z.string().max(4000).optional().describe("What happened and what is needed."),
  kind: z.enum(ISSUE_KINDS).optional().describe("error (default), missing, needs-you or warning."),
  fix: z.string().max(8000).optional().describe("A prompt that would fix it, ready to send to a chat."),
});

export const EVENT_SOURCES = ["ui", "http", "file", "paste", "import", "runner", "hook"] as const;

export const EventSchema = z.object({
  id: z.string().min(1),
  ts: z.string().min(1).describe("ISO 8601 timestamp."),
  task: z.string().min(1),
  agent: z.string().optional(),
  type: z.enum(EVENT_TYPES),
  message: z.string().max(20000).optional(),
  reason: z.string().max(20000).optional(),
  pr: z.string().max(2000).optional(),
  verify: z.string().max(20000).optional(),
  issues: z.array(TaskIssueSchema).max(30).optional().describe("Problems the chat reported; an empty list clears them."),
  source: z.enum(EVENT_SOURCES).default("ui"),
});

export const ProjectFileSchema = z.object({
  $schema: z.string().optional(),
  format: z.literal("aitrack"),
  version: z.literal(1),
  project: z.object({
    id: id("Project"),
    name: z.string().min(1),
    description: z.string().optional(),
    links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
  }),
  settings: SettingsSchema.default({ requireApproval: false, inboxDir: ".aitrack/inbox" }),
  agents: z.array(AgentSchema).default([]),
  prompts: z.record(z.string(), PromptSchema).default({}),
  templates: TemplatesSchema.default({}),
  milestones: z.array(MilestoneSchema).default([]),
  tasks: z.array(TaskSchema).default([]),
  state: z
    .object({
      exportedAt: z.string(),
      events: z.array(EventSchema).default([]),
    })
    .optional(),
});

/** What an agent sends when it reports progress. */
export const REPORT_STATUSES = ["started", "progress", "blocked", "review", "done", "failed"] as const;

export const ReportSchema = z.object({
  project: z.string().optional(),
  task: z.string().min(1),
  agent: z.string().optional(),
  status: z.enum(REPORT_STATUSES),
  summary: z.string().max(20000).optional(),
  message: z.string().max(20000).optional(),
  reason: z.string().max(20000).optional(),
  pr: z.string().max(2000).optional(),
  verify: z.string().max(20000).optional(),
  issues: z.array(TaskIssueSchema).max(30).optional(),
});

export type Agent = z.infer<typeof AgentSchema>;
export type Prompt = z.infer<typeof PromptSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Templates = z.infer<typeof TemplatesSchema>;
export type TrackEvent = z.infer<typeof EventSchema>;
export type TaskIssue = z.infer<typeof TaskIssueSchema>;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type EventSource = (typeof EVENT_SOURCES)[number];
export type ProjectFile = z.infer<typeof ProjectFileSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
