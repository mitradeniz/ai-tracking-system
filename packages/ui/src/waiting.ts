import type { ManagerRun, ManagerSettings } from "./api.ts";
import type { T } from "./i18n.ts";
import { problemsOf, type Model, type Problem } from "./model.ts";

/**
 * What waits for the person while a manager runs the project: what the manager left for them
 * (one message per task, the newest), and permissions a chat needs that the manager may not give.
 * Shown by the eye with a count, and answered there.
 */
export interface WaitingItem {
  /** Changes when the item says something new: an item the person marked seen comes back then. */
  id: string;
  task?: string;
  /** What the manager wrote to the person about it. */
  message?: string;
  /** The task's problems that need the person: a permission, refused steps, a decision, a question. */
  problems: Problem[];
}

/** Statuses in which a task still waits for something. */
const WAITING = new Set(["blocked", "failed", "review"]);
const FOR_TASK = /^([A-Za-z0-9][\w.-]*): ([\s\S]+)$/;

/** A short, stable fingerprint of a text (FNV-1a). */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const needsPerson = (p: Problem) => Boolean(p.permission || p.steps?.length || p.choices?.length || p.kind === "needs-you");

export function waitingForYou(model: Model, log: ManagerRun[], settings: Pick<ManagerSettings, "fullAuthority"> | undefined, t: T): WaitingItem[] {
  const items = new Map<string, Omit<WaitingItem, "id">>();
  const general: string[] = [];
  // Newest look first: the first message about a task is the one that counts.
  log.slice(0, 10).forEach((run, n) => {
    for (const text of run.forYou) {
      const m = FOR_TASK.exec(text);
      const task = m && model.task.has(m[1]!) ? m[1]! : undefined;
      if (!task) {
        // Notes about no task in particular: from the last look only, they are about now.
        if (n === 0 && !general.includes(text)) general.push(text);
        continue;
      }
      if (items.has(task)) continue;
      const status = model.snap.get(task)?.status;
      if (!status || !WAITING.has(status)) continue;
      items.set(task, { task, message: m![2]!.trim(), problems: [] });
    }
  });
  for (const s of model.snap.values()) {
    if (!WAITING.has(s.status)) continue;
    const item = items.get(s.id);
    const problems = problemsOf(model, s, t).filter(needsPerson);
    // A permission is the person's to give unless the manager has full authority; the rest of a
    // task's problems are shown with what the manager wrote about it.
    const own = settings?.fullAuthority ? [] : problems.filter((p) => p.permission || p.steps?.length);
    if (!item && !own.length) continue;
    items.set(s.id, { task: s.id, message: item?.message, problems: item ? problems : own });
  }
  const sign = (parts: string[]) => fingerprint(parts.join("\u0000"));
  return [
    ...[...items.values()].map((i) => ({ ...i, id: sign([i.task ?? "", i.message ?? "", ...i.problems.map((p) => p.title)]) })),
    ...general.slice(0, 3).map((message) => ({ id: sign(["", message]), message, problems: [] })),
  ];
}
