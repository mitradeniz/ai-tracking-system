import { createContext, useContext } from "react";

/** Opening the plan editors (tasks, prompts, AI planning) from anywhere in the board. */
export interface PlanEditing {
  addTask(agentId?: string): void;
  editTask(taskId: string): void;
  editPrompts(promptId?: string): void;
  planWithAI(): void;
}

export const PlanEditContext = createContext<PlanEditing | null>(null);
export const usePlanEditing = () => useContext(PlanEditContext);
