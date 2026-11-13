import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTHORING_INSTRUCTIONS,
  authoringPrompt,
  computeBoard,
  createEmptyProject,
  EditError,
  extractProjectJson,
  nextTaskId,
  parseProjectFile,
  promptUsage,
  readGeneratedProject,
  removePromptFromFile,
  removeTaskFromFile,
  serializeProject,
  slugId,
  updateProjectInfoInFile,
  upsertPromptInFile,
  upsertTaskInFile,
} from "../src/index.ts";

const parse = (text: string) => {
  const { project, issues } = parseProjectFile(text);
  if (!project) throw new Error(issues.map((i) => i.message).join("; "));
  return project;
};

const base = () =>
  serializeProject(
    createEmptyProject("shop", "Shop", {
      language: "tr",
      agents: [
        { id: "claude-a", name: "Claude A", tool: "claude" },
        { id: "codex-a", name: "Codex A", tool: "codex" },
      ],
    }),
  );

describe("empty projects", () => {
  it("start with the chosen chats and nothing else", () => {
    const p = parse(base());
    expect(p.agents.map((a) => a.id)).toEqual(["claude-a", "codex-a"]);
    expect(p.tasks).toEqual([]);
    expect(p.prompts).toEqual({});
    expect(p.settings.language).toBe("tr");
    expect(JSON.stringify(p)).not.toContain("Agent A");
  });

  it("may have no chats at all, and the board is empty", () => {
    const p = parse(serializeProject(createEmptyProject("x", "X")));
    expect(p.agents).toEqual([]);
    const board = computeBoard(p, []);
    expect(board.tasks).toEqual([]);
    expect(board.agents).toEqual([]);
  });
});

describe("editing tasks", () => {
  it("adds tasks with the usual key order and only the fields given", () => {
    let text = base();
    text = upsertTaskInFile(text, { id: "T-01", title: "API contract", agent: "claude-a", instructions: "Write openapi.yaml", allowedPaths: ["contracts/"] }, "create");
    text = upsertTaskInFile(text, { id: "T-02", title: "Page", agent: "codex-a", dependsOn: ["T-01"], acceptance: "npm test passes", estimateDays: 1.5 }, "create");
    const p = parse(text);
    expect(p.tasks.map((t) => t.id)).toEqual(["T-01", "T-02"]);
    expect(p.tasks[1]).toMatchObject({ dependsOn: ["T-01"], estimateDays: 1.5, acceptance: "npm test passes" });
    const raw = JSON.parse(text).tasks[0];
    expect(Object.keys(raw)).toEqual(["id", "title", "agent", "instructions", "allowedPaths"]);
    expect(computeBoard(p, []).byId.get("T-01")?.dispatchable).toBe(true);
  });

  it("updates only the given fields and removes emptied ones", () => {
    let text = upsertTaskInFile(base(), { id: "T-01", title: "One", agent: "claude-a", instructions: "Do it", tags: ["api"] }, "create");
    text = upsertTaskInFile(text, { id: "T-01", title: "One, renamed", agent: "codex-a", instructions: "", alsoAgents: ["claude-a", "codex-a"] }, "update");
    const t = parse(text).tasks[0]!;
    expect(t).toMatchObject({ title: "One, renamed", agent: "codex-a", alsoAgents: ["claude-a"], tags: ["api"] });
    expect(t.instructions).toBeUndefined();
  });

  it("refuses duplicates, unknown references and cycles", () => {
    let text = upsertTaskInFile(base(), { id: "T-01", title: "One", agent: "claude-a", instructions: "x" }, "create");
    text = upsertTaskInFile(text, { id: "T-02", title: "Two", agent: "claude-a", dependsOn: ["T-01"], instructions: "x" }, "create");
    expect(() => upsertTaskInFile(text, { id: "T-01", title: "Again", agent: "claude-a" }, "create")).toThrow(/already exists/);
    expect(() => upsertTaskInFile(text, { id: "T-09", title: "Nope", agent: "claude-a" }, "update")).toThrow(EditError);
    expect(() => upsertTaskInFile(text, { id: "T-03", title: "X", agent: "nobody" }, "create")).toThrow(/Unknown chat/);
    expect(() => upsertTaskInFile(text, { id: "T-03", title: "X", agent: "claude-a", dependsOn: ["T-77"] }, "create")).toThrow(/Unknown task/);
    expect(() => upsertTaskInFile(text, { id: "T-03", title: "X", agent: "claude-a", prompts: ["nope"] }, "create")).toThrow(/Unknown prompt/);
    expect(() => upsertTaskInFile(text, { id: "T-01", title: "One", agent: "claude-a", dependsOn: ["T-02"] }, "update")).toThrow(/cycle/);
    expect(() => upsertTaskInFile(text, { id: "T-01", title: " ", agent: "claude-a" }, "update")).toThrow(/title/);
  });

  it("removes a task and keeps the order of the rest", () => {
    let text = base();
    text = upsertTaskInFile(text, { id: "A", title: "A", agent: "claude-a", instructions: "x" }, "create");
    text = upsertTaskInFile(text, { id: "B", title: "B", agent: "claude-a", dependsOn: ["A"], instructions: "x" }, "create");
    text = upsertTaskInFile(text, { id: "C", title: "C", agent: "codex-a", dependsOn: ["B"], instructions: "x" }, "create");
    text = upsertTaskInFile(text, { id: "D", title: "D", agent: "codex-a", dependsOn: ["B", "A"], instructions: "x" }, "create");
    const out = parse(removeTaskFromFile(text, "B"));
    expect(out.tasks.map((t) => t.id)).toEqual(["A", "C", "D"]);
    expect(out.tasks.find((t) => t.id === "C")?.dependsOn).toEqual(["A"]);
    expect(out.tasks.find((t) => t.id === "D")?.dependsOn).toEqual(["A"]);
    const lone = parse(removeTaskFromFile(removeTaskFromFile(text, "A"), "B"));
    expect(lone.tasks.find((t) => t.id === "C")?.dependsOn).toEqual([]);
    expect(() => removeTaskFromFile(text, "Z")).toThrow(/Unknown task/);
  });

  it("suggests the next task id in the project's style", () => {
    expect(nextTaskId([])).toBe("T-01");
    expect(nextTaskId(["T-01", "T-09"])).toBe("T-10");
    expect(nextTaskId(["API-099", "UI-3"])).toBe("API-100");
    expect(nextTaskId(["setup", "deploy"])).toBe("T-01");
  });
});

describe("editing prompts", () => {
  it("adds, changes and removes prompts with their references", () => {
    let text = upsertPromptInFile(base(), { id: "context", title: "Shared context", body: "We build a shop." }, "create");
    text = upsertTaskInFile(text, { id: "T-01", title: "One", agent: "claude-a", prompts: ["context"] }, "create");
    text = upsertPromptInFile(text, { id: "context", body: "We build a better shop." }, "update");
    let p = parse(text);
    expect(p.prompts.context).toEqual({ body: "We build a better shop." });
    expect(promptUsage(p, "context")).toEqual({ tasks: ["T-01"], agents: [] });
    expect(() => upsertPromptInFile(text, { id: "context", body: "x" }, "create")).toThrow(/already exists/);
    expect(() => upsertPromptInFile(text, { id: "new", body: "  " }, "create")).toThrow(/empty/);
    text = removePromptFromFile(text, "context");
    p = parse(text);
    expect(p.prompts).toEqual({});
    expect(p.tasks[0]!.prompts).toEqual([]);
    expect(slugId("Paylaşılan bağlam", ["context"], "prompt")).toBe("paylasilan-baglam");
  });

  it("changes the project's name and language", () => {
    const p = parse(updateProjectInfoInFile(base(), { name: "Shop 2", language: "en", requireApproval: true }));
    expect(p.project.name).toBe("Shop 2");
    expect(p.settings).toMatchObject({ language: "en", requireApproval: true });
  });
});

describe("authoring with AI", () => {
  it("keeps the instructions in the docs and in the app the same", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(path.join(here, "..", "..", "..", "docs", "authoring-with-ai.md"), "utf8");
    const block = /````text\n([\s\S]*?)\n````/.exec(doc)?.[1] ?? "";
    expect(block.startsWith(AUTHORING_INSTRUCTIONS + "\n\nINPUTS\n")).toBe(true);
  });

  it("builds a prompt with the chats, language and plan", () => {
    const prompt = authoringPrompt({
      projectId: "shop",
      projectName: "Shop",
      language: "tr",
      chats: [{ id: "claude-a", name: "Claude A", tool: "claude", role: "backend" }],
      plan: "Build a shop.",
      canReadRepository: true,
    });
    expect(prompt).toContain("- id: claude-a, name: Claude A, tool: claude, strengths: backend");
    expect(prompt).toContain("Turkish");
    expect(prompt).toContain("Do not change, create or delete any file");
    expect(prompt.endsWith("Build a shop.")).toBe(true);
  });

  it("finds the JSON in an answer and applies the wizard's id, name and language", () => {
    const doc = { format: "aitrack", version: 1, project: { id: "other", name: "Other" }, agents: [{ id: "claude-a", name: "Claude A" }], tasks: [{ id: "T-01", title: "One", agent: "claude-a", instructions: "x" }] };
    const answer = "Here it is:\n```json\n" + JSON.stringify(doc, null, 2) + "\n```\nThe critical path is T-01.";
    expect(extractProjectJson(answer)).toBe(JSON.stringify(doc, null, 2));
    expect(extractProjectJson("no json here")).toBeNull();
    expect(extractProjectJson('text {"a": 1} text')).toBe('{"a": 1}');
    const res = readGeneratedProject(answer, { projectId: "shop", projectName: "Shop", language: "en" });
    expect(res.project?.project).toMatchObject({ id: "shop", name: "Shop" });
    expect(res.project?.settings.language).toBe("en");
    expect(res.issues.filter((i) => i.level === "error")).toEqual([]);
    const bad = readGeneratedProject(JSON.stringify({ ...doc, tasks: [{ id: "T-01", title: "One", agent: "nobody" }] }), { projectId: "shop", projectName: "Shop" });
    expect(bad.issues.some((i) => i.level === "error" && /unknown agent/.test(i.message))).toBe(true);
    expect(readGeneratedProject("sorry", { projectId: "s", projectName: "S" }).issues[0]?.message).toMatch(/JSON/);
  });
});
