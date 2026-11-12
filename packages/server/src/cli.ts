import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, VERSION } from "./index.ts";

const HELP = `AI Tracking System ${VERSION}

Usage:
  aitrack serve [project.aitrack ...] [--port 4317] [--data-dir ~/.aitrack] [--ui-dir path]

Starts the local tracker on http://127.0.0.1:<port>. Agents report to POST /api/report.
`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function defaultUiDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../../ui/dist"), path.resolve(here, "../ui"), path.resolve(process.cwd(), "packages/ui/dist")];
  return candidates.find((c) => existsSync(path.join(c, "index.html")));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command !== "serve") {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  const flags = new Set(["--port", "--data-dir", "--ui-dir"]);
  const projects = rest.filter((a, i) => !a.startsWith("--") && !flags.has(rest[i - 1] ?? ""));
  const running = await startServer({
    port: Number(arg(rest, "--port") ?? 4317),
    dataDir: arg(rest, "--data-dir"),
    uiDir: arg(rest, "--ui-dir") ?? defaultUiDir(),
    projects,
  });
  running.manager.on("warning", (e: unknown) => process.stderr.write(`warning: ${(e as Error)?.message ?? e}\n`));
  running.manager.on("activity", ({ event, projectName }: { event: { task: string; type: string }; projectName?: string }) =>
    process.stdout.write(`[${new Date().toLocaleTimeString()}] ${projectName ?? ""} ${event.task}: ${event.type}\n`),
  );
  process.stdout.write(`AI Tracking System is running at ${running.url}\n`);
  process.stdout.write(`Open this link to use the agent runners from a browser: ${running.controlUrl}\n`);
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: unknown) => {
  process.stderr.write(`${(e as Error)?.stack ?? e}\n`);
  process.exit(1);
});
