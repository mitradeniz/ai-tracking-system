import { describe, expect, it } from "vitest";
import {
  agentIdFromName,
  computeBoard,
  EditError,
  helpedChats,
  parseProjectFile,
  removeAgentFromFile,
  upsertAgentInFile,
} from "../src/index.ts";

// A hand-written file: defaults left out on purpose, so edits must not add them.
const FILE = `{
  "format": "aitrack",
  "version": 1,
  "project": {
    "id": "demo",
    "name": "Demo"
  },
  "agents": [
    {
      "id": "a",
      "name": "Agent A",
      "bootstrapPrompts": [
        "ctx"
      ]
    },
    {
      "id": "b",
      "name": "Agent B"
    }
  ],
  "tasks": [
    {
      "id": "T1",
      "title": "One",
      "agent": "a",
      "prompts": [
        "ctx"
      ]
    },
    {
      "id": "T2",
      "title": "Two",
      "agent": "b",
      "instructions": "Do two."
    },
    {
      "id": "T3",
      "title": "Three",
      "agent": "b",
      "dependsOn": [
        "T1"
      ],
      "instructions": "Do three."
    }
  ],
  "prompts": {
    "ctx": {
      "body": "Shared context."
    }
  }
}
`;

const parse = (text: string) => {
  const { project } = parseProjectFile(text);
  if (!project) throw new Error("invalid");
  return project;
};

describe("editing chats", () => {
  it("adds a chat without touching the rest of the file", () => {
    const out = upsertAgentInFile(FILE, { agent: { id: "c", name: "Agent C", tool: "codex", bootstrapPrompts: ["ctx"] } });
    expect(out.slice(out.indexOf('"tasks"'))).toBe(FILE.slice(FILE.indexOf('"tasks"')));
    const p = parse(out);
    expect(p.agents.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(p.agents[2]).toMatchObject({ name: "Agent C", tool: "codex", maxParallel: 1 });
    expect(out).not.toContain('"alsoAgents"');
    expect(out).not.toContain('"capabilities"');
  });

  it("lets a new chat take another chat's tasks, and the board offers them", () => {
    const out = upsertAgentInFile(FILE, { agent: { id: "c", name: "Agent C" }, helpsWith: ["b"] });
    const p = parse(out);
    expect(p.tasks.find((t) => t.id === "T2")?.alsoAgents).toEqual(["c"]);
    expect(p.tasks.find((t) => t.id === "T1")?.alsoAgents).toEqual([]);
    expect(helpedChats(p.tasks, "c")).toEqual(["b"]);
    // While b is busy with T2, the new chat c is offered nothing of b's that is not ready yet,
    // but T2 itself lists both chats as candidates.
    const t2 = computeBoard(p, []).byId.get("T2");
    expect(t2?.candidates).toEqual(expect.arrayContaining(["b", "c"]));
  });

  it("updates a chat and its helped chats", () => {
    const once = upsertAgentInFile(FILE, { agent: { id: "c", name: "Agent C" }, helpsWith: ["a", "b"] });
    const twice = upsertAgentInFile(once, { agent: { id: "c", name: "Agent C2", role: "Helper" }, helpsWith: ["a"] });
    const p = parse(twice);
    expect(p.agents.find((a) => a.id === "c")).toMatchObject({ name: "Agent C2", role: "Helper" });
    expect(helpedChats(p.tasks, "c")).toEqual(["a"]);
    expect(p.tasks.find((t) => t.id === "T2")?.alsoAgents).toEqual([]);
    expect(twice).not.toMatch(/"alsoAgents": \[\]/);
  });

  it("rejects bad input", () => {
    expect(() => upsertAgentInFile(FILE, { agent: { id: "bad id", name: "X" } })).toThrow(EditError);
    expect(() => upsertAgentInFile(FILE, { agent: { id: "c", name: "" } })).toThrow(EditError);
    expect(() => upsertAgentInFile(FILE, { agent: { id: "c", name: "C", bootstrapPrompts: ["nope"] } })).toThrow(/Unknown prompt/);
    expect(() => upsertAgentInFile(FILE, { agent: { id: "c", name: "C" }, helpsWith: ["zz"] })).toThrow(/Unknown chat/);
    expect(() => upsertAgentInFile("{}", { agent: { id: "c", name: "C" } })).toThrow(/has errors/);
  });

  it("removes a chat, moving its tasks", () => {
    const withC = upsertAgentInFile(FILE, { agent: { id: "c", name: "Agent C" }, helpsWith: ["b"] });
    expect(() => removeAgentFromFile(withC, "b")).toThrow(/choose a chat/);
    const out = removeAgentFromFile(withC, "b", "c");
    const p = parse(out);
    expect(p.agents.map((a) => a.id)).toEqual(["a", "c"]);
    expect(p.tasks.filter((t) => t.agent === "c").map((t) => t.id)).toEqual(["T2", "T3"]);
    expect(out).not.toContain('"alsoAgents"');
    const noC = removeAgentFromFile(withC, "c");
    expect(noC).toBe(FILE);
  });

  it("keeps at least one chat", () => {
    const onlyA = removeAgentFromFile(FILE, "b", "a");
    expect(() => removeAgentFromFile(onlyA, "a")).toThrow(/at least one chat/);
  });

  it("derives free ids from names", () => {
    expect(agentIdFromName("Codex D", ["codex-a"])).toBe("codex-d");
    expect(agentIdFromName("Claude Çalışan", [])).toBe("claude-calisan");
    expect(agentIdFromName("Codex A", ["codex-a"])).toBe("codex-a-2");
    expect(agentIdFromName("!!!", [])).toBe("chat");
  });
});
