#!/usr/bin/env node
// A stand-in for the agent CLIs in tests. FAKE_FORMAT picks the output format (codex, claude,
// gemini, text) and FAKE_SCENARIO what the agent does (done, ask, fail, sleep).
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
// `claude --help`: lists auto mode among the permission modes when FAKE_AUTO is set.
if (args.includes("--help")) {
  const modes = ['"acceptEdits"', ...(process.env.FAKE_AUTO ? ['"auto"'] : []), '"bypassPermissions"', '"plan"'];
  process.stdout.write(`Usage: claude [options]\n  --permission-mode <mode>  Permission mode to use for the session\n                            (choices: ${modes.join(", ")})\n`);
  process.exit(0);
}
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
const english = process.env.FAKE_LANG === "en";
const issues = english
  ? [
      { title: "Stripe test key missing, payment step not tried", kind: "needs-you", detail: "STRIPE_SECRET_KEY is not set. The flow is written but not tested end to end.", fix: "STRIPE_SECRET_KEY is now set in .env.local. Run the payment flow end to end, fix what fails and report again." },
      { title: "Mobile screenshot tests skipped", kind: "missing", detail: "The emulator could not start here." },
    ]
  : [
  { title: "Stripe test anahtarı yok, ödeme adımı denenmedi", kind: "needs-you", detail: "STRIPE_SECRET_KEY tanımlı değil. Ödeme akışı yazıldı ama uçtan uca test edilemedi.", fix: "STRIPE_SECRET_KEY is now set in .env.local. Run the payment flow end to end, fix what fails and report again." },
  { title: "Mobil ekran görüntüsü testleri atlandı", kind: "missing", detail: "Emülatör bu ortamda açılamadı." },
];
// A project plan, as the new-project wizard asks for (scenario "project").
const plan = {
  format: "aitrack",
  version: 1,
  project: { id: "draft", name: "Draft" },
  agents: [
    { id: "claude-a", name: "Claude A", tool: "claude", role: "API design, backend, reviews", bootstrapPrompts: ["context"] },
    { id: "codex-a", name: "Codex A", tool: "codex", role: "Web pages and components", bootstrapPrompts: ["context"] },
  ],
  milestones: [{ id: "m1", name: "Launch" }],
  tasks: [
    { id: "T-01", title: "Signup API contract", agent: "claude-a", prompts: ["context"], instructions: "Write contracts/signup.yaml.", allowedPaths: ["contracts/"], acceptance: "The contract validates.", estimateDays: 0.5, milestone: "m1" },
    { id: "T-02", title: "Landing page against the mock", agent: "codex-a", dependsOn: ["T-01"], instructions: "Build the page with the mock server.", allowedPaths: ["web/"], acceptance: "npm test passes.", estimateDays: 1, milestone: "m1" },
    { id: "T-03", title: "Signup backend", agent: "claude-a", dependsOn: ["T-01"], instructions: "Implement the endpoint.", allowedPaths: ["api/"], acceptance: "API tests pass.", estimateDays: 1.5, milestone: "m1" },
    { id: "T-04", title: "Connect the form to the real API", agent: "codex-a", dependsOn: ["T-02", "T-03"], instructions: "Replace the mock.", allowedPaths: ["web/"], acceptance: "End-to-end test passes.", estimateDays: 0.5, milestone: "m1" },
  ],
  prompts: { context: { title: "Shared context", body: "We build a landing page with a signup form." } },
};
const final =
  scenario === "project"
    ? "Here is the project file.\n```json\n" + JSON.stringify(plan, null, 2) + "\n```\nT-01 can start right away."
    : scenario === "issues"
    ? "Done, with two open points.\n```aitrack-report\n" + JSON.stringify({ task, status: "done", summary: english ? "Payment form and API added" : "Ödeme formu ve API eklendi", issues }) + "\n```"
    : scenario === "done" || scenario === "steps"
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
if (scenario === "noauth" && format === "claude") {
  // Claude Code without a sign-in: an error result, no conversation.
  out({ type: "assistant", message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
  out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", usage: { input_tokens: 0, output_tokens: 0 } });
  process.exit(1);
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
  // FAKE_MODE: the mode the CLI really runs in (auto mode may be unavailable for the account).
  out({ type: "system", subtype: "init", session_id: sid, permissionMode: process.env.FAKE_MODE ?? flag("--permission-mode") ?? "default" });
  if (scenario === "project") {
    for (const file of ["README.md", "package.json", "src/"]) {
      await pause(Number(process.env.FAKE_PAUSE ?? 0));
      out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: file } }] } });
    }
  } else out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
  out({ type: "assistant", message: { model: "claude-fake", content: [{ type: "text", text: final }], usage: { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30000, output_tokens: 90 } } });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: final,
    session_id: sid,
    num_turns: 2,
    total_cost_usd: 0.05,
    usage: { input_tokens: 20, cache_creation_input_tokens: 2000, cache_read_input_tokens: 60000, output_tokens: 150 },
    modelUsage: { "claude-fake": { contextWindow: 1000000 } },
    permission_denials: process.env.FAKE_DENY ? [{ tool_name: "Bash", tool_input: { command: "npm test" } }] : [],
  });
} else if (format === "gemini") {
  out({ type: "init", session_id: flag("--resume") ?? flag("--session-id"), model: "fake" });
  out({ type: "tool_use", tool_name: "run_shell_command", parameters: { command: "npm test" } });
  for (const part of final.match(/[\s\S]{1,20}/g)) out({ type: "message", role: "assistant", content: part, delta: true });
  out({ type: "result", status: "success", stats: {} });
} else {
  process.stdout.write(final + "\n");
}
