import { spawn } from "node:child_process";

/**
 * Runs that open in a Terminal window (Claude Code, for computer use).
 *
 * The tracker writes a small launcher (a `.command` file, which macOS opens in a terminal app) and
 * opens it with `open -a <app>`. The session then belongs to the terminal: the person sees it,
 * answers its questions there, and macOS asks for the screen and accessibility permissions on the
 * terminal app's behalf. The tracker follows the session through hooks, not through its output.
 */

/** A value quoted for bash: nothing in it is expanded. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Names of terminal apps: letters, digits, spaces and a few signs, no paths. */
export function terminalAppName(value: string | undefined): string {
  const name = (value ?? "").trim();
  return name && /^[\w .+-]{1,80}$/.test(name) ? name : "Terminal";
}

/**
 * A prompt is the first argument of the command line; one that starts with "-" would be read as an
 * option, so it gets a space in front.
 */
export function promptArgument(prompt: string): string {
  return prompt.startsWith("-") ? ` ${prompt}` : prompt;
}

export interface TerminalScript {
  /** Folder the session works in. */
  cwd: string;
  /** The CLI's program. */
  binary: string;
  /** Its options (the prompt is not among them). */
  args: string[];
  /** File the prompt is read from; the launcher deletes it once read. */
  promptFile: string;
  /** PATH for the session. */
  path: string;
  /** Variables the session gets (AITRACK_*). */
  env: Record<string, string>;
  /** Window title and first line, e.g. "claude-gui · task T3". */
  title: string;
}

/** The launcher: goes to the folder, reads and deletes the prompt, then starts the CLI in its place. */
export function terminalScript(s: TerminalScript): string {
  const exports = Object.entries(s.env)
    .filter(([name]) => /^[A-Z_][A-Z0-9_]*$/.test(name))
    .map(([name, value]) => `export ${name}=${shq(value)}`);
  return [
    "#!/bin/bash",
    `# Opened by AI Tracking System (${s.title.replace(/[\r\n]/g, " ")}). It deletes itself; safe to delete.`,
    `cd -- ${shq(s.cwd)} || { echo "The working folder was not found: "${shq(s.cwd)}; exit 1; }`,
    `export PATH=${shq(s.path)}`,
    ...exports,
    // A run started by the tracker in the background carries AITRACK_RUN; this one is followed by hooks.
    "unset AITRACK_RUN",
    `PROMPT="$(cat -- ${shq(s.promptFile)})"`,
    `rm -f -- ${shq(s.promptFile)} "$0"`,
    `printf '\\033]0;%s\\007' ${shq(`AI Tracking System · ${s.title}`)}`,
    `echo ${shq(`AI Tracking System · ${s.title}`)}`,
    `echo ${shq("An interactive Claude Code session: answer it here; the board follows it.")}`,
    `echo ${shq("Computer use: the first time in this folder, type /mcp, pick computer-use and choose Enable.")}`,
    `echo ${shq("If an earlier window of this chat is still open, close it: one session can use the computer at a time.")}`,
    `[ -n "$ANTHROPIC_API_KEY" ] && echo ${shq("Note: ANTHROPIC_API_KEY is set. Computer use needs a Pro or Max login through claude.ai, not an API key.")}`,
    "echo",
    `exec ${shq(s.binary)} "$PROMPT" ${s.args.map(shq).join(" ")}`,
    "",
  ].join("\n");
}

/** Opens a launcher in a terminal app (macOS). Fails with the reason `open` gives. */
export function openInTerminal(app: string, file: string, opener = "open"): Promise<void> {
  return new Promise((resolve, reject) => {
    let err = "";
    let child;
    try {
      child = spawn(opener, ["-a", app, file], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      reject(e as Error);
      return;
    }
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `Could not open ${app} (exit code ${code}).`));
    });
  });
}
