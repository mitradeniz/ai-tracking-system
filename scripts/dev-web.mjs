// Development: the tracker API (with reload on change) plus the Vite dev server for the UI.
import { spawn } from "node:child_process";

const run = (cmd, args, opts = {}) => spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
const server = run("npx", ["tsx", "watch", "packages/server/src/cli.ts", "serve", ...process.argv.slice(2)]);
const ui = run("npx", ["vite"], { cwd: "packages/ui" });
const stop = () => {
  server.kill();
  ui.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
