import { describe, expect, it } from "vitest";
import {
  buildGraph,
  computeBoard,
  parseProjectFile,
  parseReports,
  ProjectFileSchema,
  renderBootstrapPrompt,
  renderTaskPrompt,
  reportToEvent,
  serializeProject,
  type ProjectFile,
  type TrackEvent,
} from "../src/index.ts";

function project(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return ProjectFileSchema.parse({
    format: "aitrack",
    version: 1,
    project: { id: "demo", name: "Demo" },
    agents: [
      { id: "a", name: "Agent A", bootstrapPrompts: ["ctx"] },
      { id: "b", name: "Agent B" },
    ],
    prompts: { ctx: { body: "Shared context." }, p1: { body: "Do step one." } },
    tasks: [
      { id: "T1", title: "One", agent: "a", prompts: ["p1"], estimateDays: 2 },
      { id: "T2", title: "Two", agent: "b", dependsOn: ["T1"], instructions: "Do two." },
      { id: "T3", title: "Three", agent: "b", instructions: "Do three." },
      { id: "T4", title: "Four", agent: "a", dependsOn: ["T2", "T3"], instructions: "Do four." },
    ],
    ...overrides,
  });
}

let seq = 0;
function ev(task: string, type: TrackEvent["type"], extra: Partial<TrackEvent> = {}): TrackEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    task,
    type,
    source: "ui",
    ...extra,
  };
}

describe("graph", () => {
  it("orders, layers and finds the critical chain", () => {
    const g = buildGraph(project().tasks);
    expect(g.cycle).toBeNull();
    expect(g.order.indexOf("T1")).toBeLessThan(g.order.indexOf("T2"));
    expect(g.layer.get("T4")).toBe(2);
    expect(g.chain.get("T1")).toBe(4); // 2 + 1 + 1
    expect([...g.critical]).toEqual(["T1", "T2", "T4"]);
  });

  it("reports cycles and unknown references", () => {
    const p = project();
    p.tasks[0]!.dependsOn = ["T4"];
    p.tasks[1]!.dependsOn.push("NOPE");
    const { issues } = parseProjectFile(serializeProject(p));
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toContain("cycle");
    expect(messages).toContain('unknown task "NOPE"');
  });
});

describe("board", () => {
  it("marks tasks without pending dependencies as dispatchable when the chat is free", () => {
    const b = computeBoard(project(), []);
    expect(b.byId.get("T1")!.dispatchable).toBe(true);
    expect(b.byId.get("T3")!.dispatchable).toBe(true);
    expect(b.byId.get("T2")!.status).toBe("waiting");
    expect(b.byId.get("T2")!.reasons).toEqual([{ kind: "dependency", task: "T1", status: "waiting" }]);
  });

  it("explains that a chat is busy", () => {
    const b = computeBoard(project(), [ev("T3", "dispatched", { agent: "b" })]);
    const t1 = b.byId.get("T1")!;
    expect(t1.dispatchable).toBe(true);
    const done = computeBoard(project(), [
      ev("T3", "dispatched", { agent: "b" }),
      ev("T1", "dispatched", { agent: "a" }),
      ev("T1", "done", { agent: "a" }),
    ]);
    const t2 = done.byId.get("T2")!;
    expect(t2.status).toBe("ready");
    expect(t2.dispatchable).toBe(false);
    expect(t2.reasons).toEqual([{ kind: "agent_busy", agent: "b", tasks: ["T3"] }]);
  });

  it("lets another allowed chat take a task", () => {
    const p = project();
    p.tasks[2]!.alsoAgents = ["a"];
    const b = computeBoard(p, [ev("T2", "dispatched", { agent: "b" })]);
    // T2 is held by b although it is waiting: holding is about the chat, not readiness.
    expect(b.byId.get("T3")!.candidates).toEqual(["a"]);
  });

  it("follows the event lifecycle", () => {
    const events = [ev("T1", "dispatched", { agent: "a" }), ev("T1", "started"), ev("T1", "blocked", { reason: "No key" })];
    let b = computeBoard(project(), events);
    expect(b.byId.get("T1")!.status).toBe("blocked");
    expect(b.byId.get("T1")!.reasons).toEqual([{ kind: "blocked", reason: "No key" }]);
    expect(b.agents.find((a) => a.agent.id === "a")!.hasRoom).toBe(false);

    events.push(ev("T1", "done", { message: "Shipped", pr: "#1" }));
    b = computeBoard(project(), events);
    expect(b.byId.get("T1")!.status).toBe("done");
    expect(b.byId.get("T1")!.runtime.summary).toBe("Shipped");
    expect(b.byId.get("T2")!.dispatchable).toBe(true);

    events.push(ev("T1", "reopened"));
    b = computeBoard(project(), events);
    expect(b.byId.get("T1")!.status).toBe("ready");
    expect(b.byId.get("T2")!.status).toBe("waiting");
  });

  it("holds done tasks for approval when required", () => {
    const p = project({ settings: { requireApproval: true, inboxDir: ".aitrack/inbox" } });
    let b = computeBoard(p, [ev("T1", "done")]);
    expect(b.byId.get("T1")!.status).toBe("review");
    expect(b.byId.get("T2")!.status).toBe("waiting");
    b = computeBoard(p, [ev("T1", "done"), ev("T1", "approved")]);
    expect(b.byId.get("T1")!.status).toBe("done");
  });

  it("does not offer failed tasks as dispatchable but explains why", () => {
    const b = computeBoard(project(), [ev("T1", "failed", { reason: "Tests fail" })]);
    expect(b.byId.get("T1")!.status).toBe("failed");
    expect(b.byId.get("T1")!.reasons[0]).toEqual({ kind: "failed", reason: "Tests fail" });
  });

  it("sorts a chat's dispatchable tasks by urgency", () => {
    const b = computeBoard(project(), []);
    expect(b.agents.find((a) => a.agent.id === "b")!.dispatchable).toEqual(["T3"]);
    expect(b.counts.ready).toBe(2);
    expect(b.counts.waiting).toBe(2);
  });
});

describe("prompts", () => {
  it("renders task prompts with reporting instructions", () => {
    const text = renderTaskPrompt(project(), "T1", { serverUrl: "http://127.0.0.1:4317/" });
    expect(text).toContain("TASK T1 — One");
    expect(text).toContain("Chat: Agent A (a)");
    expect(text).toContain("Do step one.");
    expect(text).toContain('curl -s -X POST http://127.0.0.1:4317/api/report');
    expect(text).toContain('"task":"T1"');
    expect(text).toContain(".aitrack/inbox/T1-<status>-<unix-ms>.json");
    expect(text).not.toMatch(/\{\{/);
  });

  it("renders bootstrap prompts", () => {
    expect(renderBootstrapPrompt(project(), "a")).toBe("Shared context.\n");
  });

  it("supports custom templates", () => {
    const p = project({ templates: { dispatch: "{{task.id}} for {{agent.name}}\n{{prompts}}\n{{report}}", report: "R {{task.id}}" } });
    expect(renderTaskPrompt(p, "T1", { serverUrl: "http://x" })).toBe("T1 for Agent A\nDo step one.\nR T1\n");
  });
});

describe("reports", () => {
  it("parses fenced report blocks and plain JSON", () => {
    const text = 'Done.\n```aitrack-report\n{"task":"T1","status":"done","summary":"ok"}\n```\n';
    expect(parseReports(text).reports).toEqual([{ task: "T1", status: "done", summary: "ok" }]);
    expect(parseReports('[{"task":"T1","status":"started"},{"task":"T2","status":"x"}]').errors).toHaveLength(1);
  });

  it("keeps the problems of the latest report until the task is sent again, done or reopened", () => {
    const issue = { title: "Secret missing", kind: "needs-you" as const, fix: "Ask for the key." };
    const parsed = parseReports('```aitrack-report\n{"task":"T1","status":"blocked","reason":"no key","issues":[{"title":"Secret missing","kind":"needs-you","fix":"Ask for the key."}]}\n```');
    expect(parsed.reports[0]!.issues).toEqual([issue]);
    const p = project();
    const withIssue = [ev("T1", "dispatched", { agent: "a" }), ev("T1", "blocked", { reason: "no key", issues: [issue] }), ev("T1", "started")];
    expect(computeBoard(p, withIssue).byId.get("T1")!.runtime.issues).toEqual([issue]);
    expect(computeBoard(p, [...withIssue, ev("T1", "done")]).byId.get("T1")!.runtime.issues).toEqual([]);
    const doneWithGap = [...withIssue, ev("T1", "done", { issues: [{ title: "Tests skipped", kind: "missing" }] })];
    expect(computeBoard(p, doneWithGap).byId.get("T1")!.runtime.issues).toEqual([{ title: "Tests skipped", kind: "missing" }]);
  });

  it("reads reports the way chats write them: nulls, unknown kinds, no fence", () => {
    const loose = '```aitrack-report\n{"task":"T1","status":"Blocked","pr":null,"verify":null,"issues":[{"title":"No folder","kind":"blocker","fix":null}]}\n```';
    expect(parseReports(loose).reports).toEqual([{ task: "T1", status: "blocked", issues: [{ title: "No folder" }] }]);
    const bare = 'Done, see below.\n```json\n{"task":"T1","status":"done","summary":"a {brace} in a \\"string\\""}\n```\nThanks.';
    expect(parseReports(bare).reports).toEqual([{ task: "T1", status: "done", summary: 'a {brace} in a "string"' }]);
    const inline = 'Summary first. {"task":"T1","status":"review","summary":"ok"} and {"other":1}';
    expect(parseReports(inline).reports).toEqual([{ task: "T1", status: "review", summary: "ok" }]);
    expect(parseReports("Not a report at all.").reports).toEqual([]);
  });

  it("closes problems with a note that keeps the chat's last message", () => {
    const p = project();
    const issues = [{ title: "A" }, { title: "B", kind: "warning" as const }];
    const events = [
      ev("T1", "dispatched", { agent: "a" }),
      ev("T1", "blocked", { reason: "Waiting for your reply.", message: "What now?", issues }),
      ev("T1", "note", { message: "Problem resolved: A", issues: [{ title: "A", state: "resolved" }, issues[1]!] }),
    ];
    const r = computeBoard(p, events).byId.get("T1")!.runtime;
    expect(r.issues.map((i) => i.state)).toEqual(["resolved", undefined]);
    expect(r.lastMessage).toBe("What now?");
    expect(r.status).toBe("blocked");
  });

  it("asks for problems in the project's language", () => {
    const tr = renderTaskPrompt(project({ settings: { requireApproval: false, inboxDir: ".aitrack/inbox", language: "tr" } }), "T1", { serverUrl: "http://x" });
    expect(tr).toContain('"issues":[{"title"');
    expect(tr).toContain("in Turkish");
  });

  it("turns reports into events", () => {
    const e = reportToEvent({ task: "T1", status: "blocked", reason: "why" }, "http", new Date("2026-01-01T00:00:00Z"));
    expect(e).toMatchObject({ task: "T1", type: "blocked", reason: "why", source: "http", ts: "2026-01-01T00:00:00.000Z" });
  });
});

describe("file io", () => {
  it("round-trips with a state snapshot", () => {
    const events = [ev("T1", "done")];
    const text = serializeProject(project(), { events, now: new Date("2026-02-01T00:00:00Z") });
    const parsed = parseProjectFile(text);
    expect(parsed.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(parsed.project!.state!.events).toHaveLength(1);
    expect(text.startsWith('{\n  "$schema"')).toBe(true);
  });

  it("rejects files that are not aitrack projects", () => {
    expect(parseProjectFile("{}").project).toBeNull();
    expect(parseProjectFile("nope").issues[0]!.message).toMatch(/Not valid JSON/);
  });
});
