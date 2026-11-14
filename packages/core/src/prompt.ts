import type { ProjectFile, Task } from "./schema.ts";

export interface RenderContext {
  /** Base URL of the local server, e.g. http://127.0.0.1:4317 */
  serverUrl: string;
  /** Agent the prompt is for; defaults to the task owner. */
  agentId?: string;
}

const SEPARATOR = "\n\n---\n\n";

/** Replaces {{name}} placeholders. Unknown names are left untouched so mistakes stay visible. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? (vars[name] ?? "") : match,
  );
}

export const DEFAULT_REPORT_TEMPLATE = `REPORTING (required)
This task is tracked in AI Tracking System. Report your status at these moments:
- right after you start: status "started"
- when you cannot continue: status "blocked" with a "reason"
- when the work is finished and verified: status "done" with "summary", "pr" (if any) and "verify"
- when you give up: status "failed" with a "reason"

1) Preferred, an HTTP call to the local tracker:
curl -s -X POST {{serverUrl}}/api/report -H "Content-Type: application/json" -d '{"project":"{{project.id}}","task":"{{task.id}}","agent":"{{agent.id}}","status":"done","summary":"<what changed>","pr":"<url or branch>","verify":"<how to verify>"}'

2) If that request fails (no network or sandbox), write the same JSON object to a new file
{{inboxDir}}/{{task.id}}-<status>-<unix-ms>.json at the repository root. Do not commit it.

3) Always end your final message with the same JSON in a fenced block, so it can be pasted into the tracker:
\`\`\`aitrack-report
{"project":"{{project.id}}","task":"{{task.id}}","agent":"{{agent.id}}","status":"done","summary":"...","pr":"...","verify":"..."}
\`\`\`

PROBLEMS: if anything failed, was skipped, is missing or needs a person, also add "issues" to the report, one entry each:
"issues":[{"title":"<one plain line>","detail":"<what happened and what is needed>","kind":"error|missing|needs-you|warning","fix":"<a prompt that would fix it>"}]
For a decision only the person can make, give the options as buttons in that issue, your recommendation first:
"choices":[{"label":"<option in a few plain words>","reply":"<what you will do if it is picked>","recommended":true},{"label":"...","reply":"..."}]
Write "title", "detail", "reason" and the labels in {{language}}, for the project owner, without jargon. Never hide a problem inside "summary".`;

export const DEFAULT_DISPATCH_TEMPLATE = `TASK {{task.id}} — {{task.title}}
Chat: {{agent.name}} ({{agent.id}}){{milestoneLine}}
{{scopeLine}}{{dependenciesLine}}{{allowedPathsLine}}
Before coding: restate the task, list its dependencies and whether they are merged, propose the design and the PR breakdown, and wait for approval.
While working: stay inside the allowed paths; use mocks for anything not merged yet; keep PRs small; ask instead of guessing.
Done when: the acceptance criteria are met, checks are green, and you have reported "done".{{acceptanceLine}}

{{prompts}}{{instructions}}

{{report}}`;

function line(label: string, value: string | undefined, leadingNewline = true): string {
  if (!value || value.trim() === "") return "";
  return `${leadingNewline ? "\n" : ""}${label}: ${value}`;
}

export function taskVariables(project: ProjectFile, task: Task, ctx: RenderContext): Record<string, string> {
  const agentId = ctx.agentId ?? task.agent;
  const agent = project.agents.find((a) => a.id === agentId);
  const milestone = project.milestones.find((m) => m.id === task.milestone);
  const promptBodies = task.prompts
    .map((p) => project.prompts[p])
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => p.body.trim());

  return {
    "project.id": project.project.id,
    "project.name": project.project.name,
    "task.id": task.id,
    "task.title": task.title,
    "task.scope": task.scope ?? "",
    "task.acceptance": task.acceptance ?? "",
    "task.dependsOn": task.dependsOn.join(", "),
    "task.allowedPaths": task.allowedPaths.join(", "),
    "agent.id": agent?.id ?? agentId,
    "agent.name": agent?.name ?? agentId,
    language: project.settings.language === "tr" ? "Turkish" : "English",
    milestone: milestone ? `${milestone.name}${milestone.date ? ` (${milestone.date})` : ""}` : "",
    milestoneLine: milestone ? ` · Milestone: ${milestone.name}${milestone.date ? ` (${milestone.date})` : ""}` : "",
    scopeLine: line("Scope for this chat", task.scope, false),
    dependenciesLine: line("Depends on (done)", task.dependsOn.join(", ")),
    allowedPathsLine: line("Allowed paths for this task", task.allowedPaths.join(", ")),
    acceptanceLine: line("Acceptance", task.acceptance),
    prompts: promptBodies.join(SEPARATOR),
    instructions: task.instructions ? `${promptBodies.length ? SEPARATOR : ""}${task.instructions.trim()}` : "",
    serverUrl: ctx.serverUrl.replace(/\/+$/, ""),
    inboxDir: project.settings.inboxDir,
  };
}

/** The full text to paste into a chat for a task: task header, prompts and reporting instructions. */
export function renderTaskPrompt(project: ProjectFile, taskId: string, ctx: RenderContext): string {
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Unknown task "${taskId}"`);
  const vars = taskVariables(project, task, ctx);
  const report = fillTemplate(project.templates.report ?? DEFAULT_REPORT_TEMPLATE, vars);
  const text = fillTemplate(project.templates.dispatch ?? DEFAULT_DISPATCH_TEMPLATE, { ...vars, report });
  return text.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** The text to paste when a new session of a chat starts. */
export function renderBootstrapPrompt(project: ProjectFile, agentId: string): string {
  const agent = project.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`Unknown agent "${agentId}"`);
  return (
    agent.bootstrapPrompts
      .map((p) => project.prompts[p]?.body.trim())
      .filter(Boolean)
      .join(SEPARATOR) + "\n"
  );
}

export function renderPrompt(project: ProjectFile, promptId: string): string {
  const p = project.prompts[promptId];
  if (!p) throw new Error(`Unknown prompt "${promptId}"`);
  return p.body.trim() + "\n";
}
