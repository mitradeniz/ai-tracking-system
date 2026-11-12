#!/usr/bin/env node
// aitrack-report: report the status of a task to AI Tracking System.
// Zero dependencies. Tries the local HTTP API first, then falls back to a report file in the
// repository inbox, and always prints a fenced block that can be pasted into the app.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const HELP = `Usage:
  aitrack-report --task <id> --status <started|progress|blocked|review|done|failed> [options]

Options:
  --project <id>       project id (needed when several open projects share task ids)
  --agent <id>         chat id, e.g. codex-b
  --summary <text>     what changed (done) or what is happening (progress)
  --reason <text>      why it is blocked or failed
  --pr <url|branch>    pull request or branch
  --verify <text>      how to verify the result
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

async function main() {
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
