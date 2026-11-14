#!/usr/bin/env node
// aitrack-report: report the status of a task to AI Tracking System.
// Zero dependencies. Tries the local HTTP API first, then falls back to a report file in the
// repository inbox, and always prints a fenced block that can be pasted into the app.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const HELP = `Usage:
  aitrack-report --task <id> --status <started|progress|blocked|review|done|failed> [options]
  aitrack-report hook [--tool claude|codex|<name>] [--server <url>] [json]

The "hook" form forwards a Claude Code hook (JSON on stdin) or a Codex notify payload (JSON as the
last argument) to the tracker, so sessions opened by hand update their task's status. It never fails
the calling tool: it always exits 0.

Options:
  --project <id>       project id (needed when several open projects share task ids)
  --agent <id>         chat id, e.g. codex-b
  --summary <text>     what changed (done) or what is happening (progress)
  --reason <text>      why it is blocked or failed
  --pr <url|branch>    pull request or branch
  --verify <text>      how to verify the result
  --issues <json>      problems for a person: '[{"title":"…","detail":"…","kind":"needs-you","fix":"<prompt>"}]'
  --follow-ups <json>  work left for later, proposed as tasks: '[{"title":"…","detail":"…","after":["T-02"]}]'
  --waiting-for <ids>  with --status blocked: tasks it waits for, comma-separated (T-01,T-02);
                       the task comes back to this chat when they are done
  --server <url>       default: $AITRACK_SERVER or http://127.0.0.1:4317
  --inbox <dir>        fallback directory, default: <repo root>/.aitrack/inbox
  --no-http            skip the HTTP call and write the inbox file directly
`;

const STATUSES = ["started", "progress", "blocked", "review", "done", "failed"];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--no-http") out.noHttp = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${a}`);
      out[key] = value;
      i += 1;
    } else throw new Error(`Unexpected argument "${a}"`);
  }
  return out;
}

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return process.cwd();
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function hook(argv) {
  let tool;
  let server = process.env.AITRACK_SERVER ?? "http://127.0.0.1:4317";
  let payload;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--tool") tool = argv[++i];
    else if (argv[i] === "--server") server = argv[++i] ?? server;
    else if (argv[i].trim().startsWith("{")) payload = argv[i];
  }
  try {
    payload ??= await readStdin();
    if (!payload.trim()) return;
    const headers = { "content-type": "application/json" };
    if (process.env.AITRACK_CHAT) headers["x-aitrack-chat"] = process.env.AITRACK_CHAT;
    if (process.env.AITRACK_RUN) headers["x-aitrack-run"] = process.env.AITRACK_RUN;
    if (process.env.AITRACK_PROJECT) headers["x-aitrack-project"] = process.env.AITRACK_PROJECT;
    const url = `${server.replace(/\/+$/, "")}/api/hook${tool ? `?tool=${encodeURIComponent(tool)}` : ""}`;
    await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(3000) });
  } catch {
    // The tracker may be closed; a hook must never get in the way of the agent.
  }
}

async function main() {
  if (process.argv[2] === "hook") {
    await hook(process.argv.slice(3));
    return;
  }
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!args.task || !STATUSES.includes(args.status)) {
    process.stderr.write(`--task and a valid --status are required.\n\n${HELP}`);
    process.exit(2);
  }

  const report = {};
  for (const key of ["project", "task", "agent", "status", "summary", "reason", "pr", "verify"]) {
    if (args[key]) report[key] = args[key];
  }
  if (args["waiting-for"]) {
    report.waitingFor = args["waiting-for"].split(",").map((id) => id.trim()).filter(Boolean);
  }
  for (const [flag, field] of [
    ["issues", "issues"],
    ["follow-ups", "followUps"],
  ]) {
    if (!args[flag]) continue;
    try {
      const list = JSON.parse(args[flag]);
      if (!Array.isArray(list)) throw new Error("not a list");
      report[field] = list;
    } catch (e) {
      process.stderr.write(`--${flag} must be a JSON list: ${e.message}\n`);
      process.exit(2);
    }
  }
  const server = (args.server ?? process.env.AITRACK_SERVER ?? "http://127.0.0.1:4317").replace(/\/+$/, "");

  let delivered = false;
  if (!args.noHttp) {
    try {
      const res = await fetch(`${server}/api/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(4000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        delivered = true;
        process.stdout.write(`Reported ${report.task}: ${report.status} -> ${body.status ?? "ok"}\n`);
        if (Array.isArray(body.next) && body.next.length > 0) {
          process.stdout.write(`Ready for this chat next: ${body.next.map((t) => `${t.id} (${t.title})`).join(", ")}\n`);
        }
      } else {
        process.stderr.write(`Tracker refused the report (${res.status}): ${body.error ?? "unknown error"}\n`);
        if (res.status >= 400 && res.status < 500) process.exitCode = 1;
      }
    } catch (e) {
      process.stderr.write(`Tracker not reachable at ${server} (${e.message}); writing an inbox file instead.\n`);
    }
  }

  if (!delivered && process.exitCode !== 1) {
    const dir = path.resolve(args.inbox ?? path.join(repoRoot(), ".aitrack", "inbox"));
    mkdirSync(dir, { recursive: true });
    const safe = (s) => String(s).replace(/[^\w.-]/g, "_");
    const file = path.join(dir, `${safe(report.task)}-${safe(report.status)}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n", "utf8");
    process.stdout.write(`Wrote ${file}\n`);
  }

  process.stdout.write("\n```aitrack-report\n" + JSON.stringify(report) + "\n```\n");
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
