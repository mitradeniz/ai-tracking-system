import { api, type ChatRunner } from "./api.ts";
import type { T } from "./i18n.ts";
import type { IssueChoice, IssuePermission, Problem, RefusedStep } from "./model.ts";

/** Entries of a list kept one per line (or comma-separated, for allowed tools). */
function entries(text: string | undefined, commas: boolean): string[] {
  return (text ?? "")
    .split(commas ? /[\n,]+/ : /\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Allows refused steps for a chat from now on: the Claude Code rules that cover them, and the
 * folders outside its working folder that they looked at. Returns the rules and folders added.
 */
export async function allowSteps(key: string, agent: string, runner: ChatRunner, steps: RefusedStep[]): Promise<{ rules: string[]; folders: string[] }> {
  const tools = entries(runner.allowedTools, true);
  const dirs = entries(runner.extraDirs, false);
  const rules = [...new Set(steps.flatMap((s) => s.rules))].filter((r) => !tools.includes(r));
  const folders = [...new Set(steps.map((s) => s.folder).filter((f): f is string => Boolean(f)))].filter((f) => !dirs.includes(f));
  if (rules.length || folders.length) {
    await api.saveRunner(key, agent, {
      ...(rules.length && { allowedTools: [...tools, ...rules].join("\n") }),
      ...(folders.length && { extraDirs: [...dirs, ...folders].join("\n") }),
    });
  }
  return { rules, folders };
}

/** What the chat is told after its refused steps were allowed, in the person's language. */
export function continueAfterAllow(steps: RefusedStep[], t: T): string {
  return [t("allow_reply"), ...steps.map((s) => `- ${s.shown}`), t("allow_replyEnd")].join("\n");
}

/** What the chat is told when the person picks one of its options, in the person's language. */
export function choiceReply(problem: Problem, choice: IssueChoice, t: T): string {
  const answer = choice.reply?.trim();
  return [t("choice_reply", { title: problem.title, label: choice.label }), answer && answer !== choice.label ? answer : "", t("choice_replyEnd")]
    .filter(Boolean)
    .join("\n");
}

/** Marks every problem the card stands for resolved, ignored or open again. */
export async function setProblemState(key: string, task: string, problem: Problem, state: "resolved" | "ignored" | "open"): Promise<void> {
  const issues = problem.issues ?? [];
  if (issues.length === 1) await api.setIssueState(key, task, { ...issues[0]!, state });
  else if (issues.length > 1) await api.setIssueStates(key, task, issues, state);
}

/** How a permission a chat asked for is given to it, from now on, with the CLI it runs on. */
export interface PermissionGrant {
  /** rule: an allowed-tools entry; folder: another folder; network: network in its sandbox;
   * full: only full access covers it (this CLI has no finer setting); none: nothing to change. */
  how: "rule" | "folder" | "network" | "full" | "none";
  /** The change to the chat's run settings. */
  patch: Partial<ChatRunner>;
  /** What is allowed, for the person and the chat. */
  shown: string;
}

/** The commands, in the shape the CLI's allowed-tools list takes. */
const COMMAND_RULE: Partial<Record<string, (command: string) => string>> = {
  claude: (c) => `Bash(${c}:*)`,
  copilot: (c) => `shell(${c}:*)`,
};
/** CLIs that take other folders from the run settings. */
const FOLDERS = new Set(["claude", "deepseek", "codex"]);

export function permissionGrant(runner: ChatRunner, permission: IssuePermission): PermissionGrant {
  const value = (permission.value ?? "").replace(/^\$\s*/, "").trim();
  const p = runner.provider;
  const none = (shown: string): PermissionGrant => ({ how: "none", patch: {}, shown });
  if (runner.access === "full" || p === "manual" || p === "custom") return none(value || permission.kind);
  const full: PermissionGrant = { how: "full", patch: { access: "full" }, shown: value || permission.kind };
  if (permission.kind === "command") {
    const rule = COMMAND_RULE[p];
    if (!value) return full;
    if (!rule) return full;
    const entry = rule(value);
    const tools = entries(runner.allowedTools, true);
    return tools.includes(entry) ? none(entry) : { how: "rule", patch: { allowedTools: [...tools, entry].join("\n") }, shown: entry };
  }
  if (permission.kind === "network") {
    // Codex keeps commands off the network in its sandbox unless it is allowed; Claude Code, Copilot and Gemini do not block it.
    if (p === "codex") return { how: "network", patch: { network: true, ...(runner.access === "readonly" && { access: "edit" as const }) }, shown: "network" };
    if (p === "claude" || p === "copilot" || p === "gemini") return none("network");
    return { ...full, shown: "network" };
  }
  if (!value.startsWith("/") && !/^[A-Za-z]:\\/.test(value)) return full;
  if (!FOLDERS.has(p)) return full;
  const dirs = entries(runner.extraDirs, false);
  return dirs.includes(value) ? none(value) : { how: "folder", patch: { extraDirs: [...dirs, value].join("\n") }, shown: value };
}

/** What the chat is told after the person allowed what it asked for. */
export function continueAfterPermission(grant: PermissionGrant, t: T): string {
  return [t("perm_reply", { what: grant.how === "full" ? t("perm_fullShort") : grant.shown }), t("allow_replyEnd")].join("\n");
}
