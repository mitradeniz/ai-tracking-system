import { z } from "zod";
import { jsonObjectsIn } from "./io.ts";

/**
 * Work chats left for later becomes proposed tasks; an AI CLI (or the app) folds them into the plan
 * with an integration plan: new tasks, proposals linked to tasks that already cover them, and
 * proposals not worth a task.
 */

/** A task the plan should get, as an AI CLI (or the app) proposes it. */
export interface PlannedTask {
  /** Left out: the app picks one. */
  id?: string;
  title: string;
  agent: string;
  dependsOn?: string[];
  instructions?: string;
  acceptance?: string;
  prompts?: string[];
  allowedPaths?: string[];
  milestone?: string;
  estimateDays?: number;
  /** The proposals and notes this task takes care of. */
  covers?: { proposals?: string[]; notes?: Array<{ task: string; index: number }> };
}

export interface IntegrationPlan {
  tasks: PlannedTask[];
  /** Proposals an existing task already covers. */
  links: Array<{ task: string; proposals: string[] }>;
  /** Proposals not worth a task. */
  ignore: string[];
  summary?: string;
}

const NoteRef = z.object({ task: z.string().min(1).max(80), index: z.number().int().min(0).max(100) });
const PlannedTaskSchema = z.object({
  id: z.string().max(80).optional(),
  title: z.string().min(1).max(300),
  agent: z.string().min(1).max(80),
  dependsOn: z.array(z.string().max(80)).max(30).optional(),
  instructions: z.string().max(8000).optional(),
  acceptance: z.string().max(4000).optional(),
  prompts: z.array(z.string().max(80)).max(20).optional(),
  allowedPaths: z.array(z.string().max(300)).max(30).optional(),
  milestone: z.string().max(80).optional(),
  estimateDays: z.number().positive().max(365).optional(),
  covers: z
    .object({ proposals: z.array(z.string().max(160)).max(30).optional(), notes: z.array(NoteRef).max(30).optional() })
    .optional(),
});
const PlanSchema = z.object({
  tasks: z.array(PlannedTaskSchema).max(40).default([]),
  links: z.array(z.object({ task: z.string().min(1).max(80), proposals: z.array(z.string().max(160)).max(30) })).max(40).default([]),
  ignore: z.array(z.string().max(160)).max(60).default([]),
  summary: z.string().max(2000).optional(),
});

/** Drops nulls the way chats write "none", recursively. */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== null).map(dropNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)]));
  }
  return value;
}

/** Reads an integration plan from an AI's answer: the last JSON object with "tasks", "links" or "ignore". */
export function parsePlan(text: string): IntegrationPlan {
  const found = jsonObjectsIn(text)
    .map((o) => o.value)
    .filter((v) => "tasks" in v || "links" in v || "ignore" in v);
  const last = found[found.length - 1];
  if (!last) throw new Error("The answer has no plan (a JSON object with \"tasks\").");
  const parsed = PlanSchema.safeParse(dropNulls(last));
  if (!parsed.success) {
    throw new Error(`The plan in the answer is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "plan"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

