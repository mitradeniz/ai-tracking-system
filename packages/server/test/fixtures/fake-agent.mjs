#!/usr/bin/env node
// A stand-in for the agent CLIs in tests. FAKE_FORMAT picks the output format (codex, claude,
// gemini, text) and FAKE_SCENARIO what the agent does (done, ask, fail, sleep).
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const format = (args.includes("--fake-format") && args[args.indexOf("--fake-format") + 1]) || process.env.FAKE_FORMAT || "codex";
const scenario = process.env.FAKE_SCENARIO || "done";
let stdin = "";
if (!process.stdin.isTTY) for await (const c of process.stdin) stdin += c;
if (process.env.FAKE_LOG) {
  appendFileSync(
    process.env.FAKE_LOG,
    JSON.stringify({ args, stdin, cwd: process.cwd(), run: process.env.AITRACK_RUN, chat: process.env.AITRACK_CHAT }) + "\n",
  );
}
const task = process.env.AITRACK_TASK;
const final =
  scenario === "done" || scenario === "steps"
    ? "All done.\n```aitrack-report\n" + JSON.stringify({ task, status: "done", summary: "fake work", verify: "npm test" }) + "\n```"
    : "Here is my plan. Shall I go ahead?";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (scenario === "sleep") await new Promise((r) => setTimeout(r, 30_000));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
if ((scenario === "slow" || scenario === "steps") && format === "codex") {
  // A longer run, for screenshots: commands and messages arrive over time.
  out({ type: "thread.started", thread_id: "thread-slow" });
  const steps = ["git status --short", "npm ci", "npm run lint", "npx vitest run src/hero", "npm run build"];
  for (const [i, command] of steps.entries()) {
    await pause(Number(process.env.FAKE_PAUSE ?? 1600));
    out({ type: "item.started", item: { id: `c${i}`, type: "command_execution", command } });
    if (i === 1) out({ type: "item.completed", item: { id: `m${i}`, type: "agent_message", text: "Dependencies installed. Writing the hero section and its tests." } });
    if (i === 2) out({ type: "item.completed", item: { id: `f${i}`, type: "file_change", changes: [{ kind: "add", path: "src/sections/Hero.tsx" }, { kind: "update", path: "src/App.tsx" }] } });
  }
  if (scenario === "slow") await pause(60_000);
}
if (scenario === "fail") {
  process.stderr.write("boom: not signed in\n");
  process.exit(1);
}
if (format === "codex") {
  out({ type: "thread.started", thread_id: flag("resume") ?? "thread-123" });
  out({ type: "turn.started" });
  out({ type: "item.started", item: { id: "1", type: "command_execution", command: "npm test" } });
  out({ type: "item.completed", item: { id: "1", type: "command_execution", command: "npm test", exit_code: 0 } });
  out({ type: "item.completed", item: { id: "2", type: "agent_message", text: final } });
  out({ type: "turn.completed", usage: {} });
} else if (format === "claude") {
  const sid = flag("--resume") ?? flag("--session-id");
  out({ type: "system", subtype: "init", session_id: sid });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: final }] } });
  out({ type: "result", subtype: "success", is_error: false, result: final, session_id: sid });
} else if (format === "gemini") {
  out({ type: "init", session_id: flag("--resume") ?? flag("--session-id"), model: "fake" });
  out({ type: "tool_use", tool_name: "run_shell_command", parameters: { command: "npm test" } });
  for (const part of final.match(/[\s\S]{1,20}/g)) out({ type: "message", role: "assistant", content: part, delta: true });
  out({ type: "result", status: "success", stats: {} });
} else {
  process.stdout.write(final + "\n");
}
