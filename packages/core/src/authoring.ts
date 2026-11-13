/**
 * Turning a plan into a project file with an AI. The same instructions are in
 * docs/authoring-with-ai.md for people who use another AI by hand; a test keeps both in sync.
 */
import { parseProjectFile, type ParseResult } from "./io.ts";

export const AUTHORING_INSTRUCTIONS = `You are converting a software plan into an AI Tracking System project file (.aitrack, format version 1).
The file is used to run several AI chats in parallel: a task can be sent as soon as all tasks it
depends on are done and its chat is free. Your goal is the shortest total time with safe parallel work.

OUTPUT
- Output exactly one JSON document and nothing else. No comments, no trailing commas.
- Start with: "$schema": "https://raw.githubusercontent.com/mitradeniz/ai-tracking-system/main/schema/aitrack.schema.json",
  "format": "aitrack", "version": 1.
- Top-level keys in this order: $schema, format, version, project, settings, agents, milestones, tasks, prompts.
- Ids: letters, digits, ".", "_", "-"; start with a letter or digit; max 80 chars. Never reuse an id.

SCHEMA (fields you may use)
- project: { id, name, description?, links?: [{label, url}] }
- settings: { requireApproval?: boolean, inboxDir?: ".aitrack/inbox", repoPath?: "<path of the code repo relative to this file>" }
- agents[]: { id, name, tool?, role?, capabilities?: string[], maxParallel?: 1, bootstrapPrompts?: promptId[], quickPrompts?: promptId[] }
- milestones[]: { id, name, date?: "YYYY-MM-DD", description? }
- tasks[]: { id, title, description?, agent, alsoAgents?: agentId[], dependsOn?: taskId[], prompts?: promptId[],
             instructions?, scope?, allowedPaths?: string[], acceptance?, milestone?, estimateDays?, tags?: string[] }
- prompts: { "<promptId>": { title?, body } }

HOW TO SPLIT THE WORK
1. One task = one reviewable unit of work for one chat, ideally 0.5–3 days and one pull request.
   Split anything bigger. Do not create tasks smaller than about two hours.
2. dependsOn lists only REAL prerequisites: the task cannot be done correctly without the other task's
   merged output (a contract, a schema, a shared library, infrastructure it runs on). Do not add a
   dependency just because tasks are in the same phase or "it feels later". Prefer contract-first:
   when B only needs A's interface, make a small contract task that both A and B depend on, so A and B
   run in parallel against a mock.
3. Parallel tasks must not edit the same files. Give every task allowedPaths, and make tasks that can
   run at the same time touch disjoint paths. If two tasks must touch the same file, make one depend on
   the other or extract the shared change into its own task.
4. Add integration tasks where parallel streams meet (wire the real service in place of the mock,
   end-to-end test) and review/QA tasks where risk is high.
5. Every task has acceptance criteria that can be checked: commands that pass, behaviour to observe,
   files that exist.
6. Give estimateDays to every task; it is used for the critical path.
7. No cycles. Every dependsOn id must exist.

HOW TO ASSIGN CHATS
- Use exactly the chats listed in the inputs; copy their names and strengths into agents[].role and
  capabilities. Assign each task to the chat whose strengths fit best. Respect hard constraints from
  the inputs (for example: only some chats can use a browser or generate images).
- Balance the load: look at the tasks that can run at the same time and spread them across chats.
- When another chat could also do a task well, list it in alsoAgents so work moves when the owner is busy.
- maxParallel is 1 unless the inputs say a chat can handle more.

PROMPTS
- Make one shared context prompt (product, stack, repository layout, conventions, rules for parallel
  work: stay inside allowed paths, small PRs, never commit secrets, ask instead of guessing).
- Make one session prompt per chat (its role, what it owns, what it must not touch).
  bootstrapPrompts of each chat = [shared context id, its session prompt id].
- Reuse the prompts from the inputs verbatim when they exist; reference them by id from tasks.
  When one prompt covers several tasks, reference it from each and set task.scope to the part each
  task covers.
- Put task-specific details in task.instructions. Do not repeat the shared context in every task.
- Recurring duties (code review, QA round, integration check) are prompts referenced from
  agents[].quickPrompts.
- Do not write reporting instructions; the app appends them to every task prompt.
- Never put secrets, credentials, personal data or customer data in the file.

MILESTONES
- Map the plan's phases or sprints to milestones with dates when the plan has them, and set
  task.milestone.

Before answering, check: every id referenced exists; no cycles; tasks that can run in parallel have
disjoint allowedPaths; every task has prompts or instructions, acceptance and estimateDays.`;

export interface AuthoringChat {
  id: string;
  name: string;
  tool?: string;
  role?: string;
}

export interface AuthoringInput {
  projectId: string;
  projectName: string;
  /** Language of titles, prompts and instructions. */
  language?: "en" | "tr";
  chats: AuthoringChat[];
  plan: string;
  /** The AI can read the repository in its working folder. */
  canReadRepository?: boolean;
  /** Errors of an earlier answer, to be fixed. */
  previous?: { text: string; errors: string[] };
}

/** The full prompt: the instructions followed by this project's inputs. */
export function authoringPrompt(input: AuthoringInput): string {
  const lines: string[] = [AUTHORING_INSTRUCTIONS, "", "INPUTS"];
  lines.push(`Project id: ${input.projectId}`);
  lines.push(`Project name: ${input.projectName}`);
  if (input.language) {
    lines.push(
      `Language: write titles, descriptions, prompts, instructions and acceptance criteria in ${input.language === "tr" ? "Turkish" : "English"}; keep ids, paths and code in English. Set settings.language to "${input.language}".`,
    );
  }
  if (input.chats.length > 0) {
    lines.push("Chats (use exactly these ids and names; do not add or remove chats):");
    for (const c of input.chats) {
      const extra = [c.tool ? `tool: ${c.tool}` : "", c.role ? `strengths: ${c.role}` : ""].filter(Boolean).join(", ");
      lines.push(`- id: ${c.id}, name: ${c.name}${extra ? `, ${extra}` : ""}`);
    }
  } else {
    lines.push("Chats: none given. Propose 2 to 4 chats that fit the plan (for example Claude A for complex work, Codex A for focused coding).");
  }
  if (input.canReadRepository) {
    lines.push(
      "Repository: your working folder is the project's repository. Read it (structure, README, package files) to choose allowedPaths and realistic tasks. Do not change, create or delete any file; only answer with the JSON.",
    );
  }
  lines.push("", "Plan:", input.plan.trim() || "(no plan given: create a sensible first milestone from the repository)");
  if (input.previous) {
    lines.push(
      "",
      "Your previous answer had these errors. Answer again with the complete corrected JSON document:",
      ...input.previous.errors.map((e) => `- ${e}`),
      "",
      "Previous answer:",
      input.previous.text,
    );
  }
  return lines.join("\n");
}

/** The JSON document in an AI's answer: inside a ```json block if there is one, else from the first "{" to the last "}". */
export function extractProjectJson(answer: string): string | null {
  const fenced = [...answer.matchAll(/```(?:json|aitrack)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]!.trim());
  const candidates = [...fenced.filter((f) => f.startsWith("{")), answer];
  for (const c of candidates) {
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    const text = c.slice(start, end + 1);
    try {
      JSON.parse(text);
      return text;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export interface GeneratedProject extends ParseResult {
  /** The file text to save, with the project id, name and language from the wizard. */
  text: string | null;
}

/** Reads an AI's answer as a project file and applies the id, name and language chosen in the app. */
export function readGeneratedProject(
  answer: string,
  fixed: { projectId: string; projectName: string; language?: "en" | "tr" },
): GeneratedProject {
  const json = extractProjectJson(answer);
  if (!json) {
    return { project: null, text: null, issues: [{ level: "error", path: "", message: "The answer does not contain a JSON document." }] };
  }
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { project: null, text: null, issues: [{ level: "error", path: "", message: "The answer is not a JSON object." }] };
  }
  raw.format ??= "aitrack";
  raw.version ??= 1;
  const project = (raw.project && typeof raw.project === "object" ? raw.project : {}) as Record<string, unknown>;
  project.id = fixed.projectId;
  project.name = fixed.projectName;
  raw.project = project;
  if (fixed.language) {
    const settings = (raw.settings && typeof raw.settings === "object" ? raw.settings : {}) as Record<string, unknown>;
    settings.language = fixed.language;
    raw.settings = settings;
  }
  delete raw.state;
  const text = JSON.stringify(raw, null, 2) + "\n";
  const parsed = parseProjectFile(text);
  return { ...parsed, text };
}
