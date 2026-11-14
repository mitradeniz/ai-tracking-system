import { api, type ChatRunner } from "./api.ts";
import type { T } from "./i18n.ts";
import type { IssueChoice, Problem, RefusedStep } from "./model.ts";

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
