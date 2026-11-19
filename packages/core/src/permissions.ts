import type { TaskIssue } from "./schema.ts";

/**
 * Permissions a chat needs to go on: the one it asked for in its report, or, when it did not name
 * it, the one its problem plainly shows (a sandbox that kept a command off the network, say). And
 * how each CLI is given it for good. Shared by the app (the person's button) and the tracker (a
 * manager that may grant them).
 */

export type IssuePermission = NonNullable<TaskIssue["permission"]>;

/** A permission, and whether the tracker read it from the problem instead of the chat naming it. */
export type NeededPermission = IssuePermission & { inferred?: boolean };

/** The part of a chat's run settings a permission changes. */
export interface GrantRunner {
  provider: string;
  access?: "readonly" | "edit" | "full";
  allowedTools?: string;
  extraDirs?: string;
  network?: boolean;
  /** Claude Code: its runs open in a Terminal window, where computer use works. */
  terminal?: boolean;
}

/** How a permission a chat asked for is given to it, from now on, with the CLI it runs on. */
export interface PermissionGrant {
  /** rule: an allowed-tools entry; folder: another folder; network: network in its sandbox;
   * terminal: its runs open in a Terminal window (Claude Code's computer use);
   * full: only full access covers it (this CLI has no finer setting); none: nothing to change;
   * elsewhere: no setting of this CLI gives it (computer use outside Claude Code): another chat must do it. */
  how: "rule" | "folder" | "network" | "terminal" | "full" | "none" | "elsewhere";
  /** The change to the chat's run settings. */
  patch: { access?: "edit" | "full"; allowedTools?: string; extraDirs?: string; network?: boolean; terminal?: boolean };
  /** What is allowed, for the person and the chat. */
  shown: string;
}

/** CLIs that run commands in a sandbox of their own: what they report as refused may be the sandbox. */
const SANDBOXED = new Set(["codex", "deepseek"]);

/** The network was out of reach: a name that did not resolve, a refused or unreachable host. */
const NETWORK =
  /\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo)\b|could not resolve host|name resolution|ad çözümle|network (?:access|is (?:off|disabled|blocked|unavailable))|no network|without network|ağ erişimi|ağa erişe/i;
/** Listening on, or connecting to, this computer was refused (the sandbox keeps loopback closed). */
const LOOPBACK =
  /(?:127\.0\.0\.1|localhost|loopback|::1)[^\n]{0,100}(?:EPERM|EACCES|not permitted|denied|engelli|reddedil|izin)|(?:EPERM|EACCES|listen)[^\n]{0,100}(?:127\.0\.0\.1|localhost|loopback)/i;
/**
 * The sandbox stopped a command: a write it does not allow, a process list, or a browser that could
 * not register its Mach services on macOS (Chromium: bootstrap_check_in … Permission denied (1100)).
 */
const SANDBOX =
  /bootstrap_check_in|mach[- ](?:bootstrap|port|register)|MachPortRendezvous|permission denied \(1100\)|\bsandbox\b[^\n]{0,40}(?:denied|blocked|refus|prevent|not allow|not permitted|engel)|(?:blocked|denied|refused|prevented|stopped|engellen)[^\n]{0,40}\bsandbox\b|sandbox-exec|seatbelt|operation not permitted|\bEPERM\b|read-only file system|\bEROFS\b|korumalı alan/i;
/** An absolute folder named in the problem, with words that say it is outside what the chat may use. */
const OUTSIDE = /(?:outside|not (?:allowed|writable)|read-only|dışında|yazılamıyor)/i;
const FOLDER = /(?:^|[\s"'`(])((?:\/(?:Users|home|private|tmp|var|opt|Volumes|mnt)\/)[^\s"'`,;:)]+)/;
/** Computer use was not there: the screen, clicks and typing in apps (Claude Code has it only in an interactive session). */
const COMPUTER_USE = /computer[- ]use|bilgisayar(?:ı)? kullan|ekran(?:ı)? (?:kontrol|göremi)|screen (?:control|recording)|\bcomputer-use\b/i;

/**
 * The permission a problem stands for: the one the chat named, or one read from its words when the
 * chat runs in a sandbox (Codex, DeepSeek) that keeps commands off the network or away from other
 * folders. Problems about the work itself (a failing test, a database role) give nothing.
 */
export function neededPermission(issue: Pick<TaskIssue, "title" | "detail" | "fix" | "permission">, provider?: string): NeededPermission | undefined {
  if (issue.permission) return issue.permission;
  if (!provider) return undefined;
  const text = [issue.title, issue.detail, issue.fix].filter(Boolean).join("\n");
  // Whatever the CLI: a problem about computer use needs computer use, not more access.
  if (COMPUTER_USE.test(text)) return { kind: "computer-use", inferred: true };
  if (!SANDBOXED.has(provider)) return undefined;
  if (NETWORK.test(text) || LOOPBACK.test(text)) return { kind: "network", inferred: true };
  if (!SANDBOX.test(text)) return undefined;
  const folder = OUTSIDE.test(text) ? FOLDER.exec(text)?.[1]?.replace(/[.]+$/, "") : undefined;
  if (folder) return { kind: "folder", value: folder, inferred: true };
  return { kind: "command", inferred: true };
}

/** Entries of a list kept one per line (or comma-separated, for allowed tools). */
function entries(text: string | undefined, commas: boolean): string[] {
  return (text ?? "")
    .split(commas ? /[\n,]+/ : /\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** The commands, in the shape the CLI's allowed-tools list takes. */
const COMMAND_RULE: Partial<Record<string, (command: string) => string>> = {
  claude: (c) => `Bash(${c}:*)`,
  copilot: (c) => `shell(${c}:*)`,
};
/** CLIs that take other folders from the run settings. */
const FOLDERS = new Set(["claude", "deepseek", "codex", "copilot", "antigravity", "gemini"]);

/**
 * The change to a chat's run settings that gives it a permission for good. A CLI with no finer
 * setting for it gets full access (which the person confirms; a manager only with full authority).
 */
export function permissionGrant(runner: GrantRunner, permission: IssuePermission): PermissionGrant {
  const value = (permission.value ?? "").replace(/^\$\s*/, "").trim();
  const p = runner.provider;
  const none = (shown: string): PermissionGrant => ({ how: "none", patch: {}, shown });
  if (permission.kind === "computer-use") {
    // Full access does not bring it: Claude Code offers computer use only in an interactive session.
    if (p !== "claude") return { how: "elsewhere", patch: {}, shown: "computer use" };
    if (runner.terminal) return none("computer use (Terminal window)");
    return { how: "terminal", patch: { terminal: true }, shown: "computer use (runs open in a Terminal window)" };
  }
  if (runner.access === "full" || p === "manual" || p === "custom") return none(value || permission.kind);
  const full: PermissionGrant = { how: "full", patch: { access: "full" }, shown: value || permission.kind };
  if (permission.kind === "command") {
    const rule = COMMAND_RULE[p];
    if (!value || !rule) return full;
    const entry = rule(value);
    const tools = entries(runner.allowedTools, true);
    return tools.includes(entry) ? none(entry) : { how: "rule", patch: { allowedTools: [...tools, entry].join("\n") }, shown: entry };
  }
  if (permission.kind === "network") {
    // Codex keeps commands off the network in its sandbox unless it is allowed; once it is and the
    // problem stays (a browser that cannot start in the sandbox, say), only full access is left.
    // Claude Code, Copilot and Gemini do not block it.
    if (p === "codex") {
      if (runner.network) return { ...full, shown: "network" };
      return { how: "network", patch: { network: true, ...(runner.access === "readonly" && { access: "edit" as const }) }, shown: "network" };
    }
    if (p === "claude" || p === "copilot" || p === "antigravity" || p === "gemini") return none("network");
    return { ...full, shown: "network" };
  }
  if (!value.startsWith("/") && !/^[A-Za-z]:\\/.test(value)) return full;
  if (!FOLDERS.has(p)) return full;
  const dirs = entries(runner.extraDirs, false);
  return dirs.includes(value) ? none(value) : { how: "folder", patch: { extraDirs: [...dirs, value].join("\n") }, shown: value };
}
