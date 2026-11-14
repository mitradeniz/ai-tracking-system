import type { Agent, BoardStatus, Reason, Task, TaskIssue, TaskSnapshot, TrackEvent } from "@aitrack/core";
import type { ChatRunner, ProjectDetail, RunnerState, RunSummary } from "./api.ts";
import type { T } from "./i18n.ts";

export interface Model {
  detail: ProjectDetail;
  tasks: Task[];
  task: Map<string, Task>;
  snap: Map<string, TaskSnapshot>;
  agent: Map<string, Agent>;
  eventsByTask: Map<string, TrackEvent[]>;
  /** How chats run on this computer and their recent runs; null when unknown. */
  runners: RunnerState | null;
}

export function buildModel(detail: ProjectDetail, runners: RunnerState | null = null): Model | null {
  if (!detail.project || !detail.board) return null;
  const eventsByTask = new Map<string, TrackEvent[]>();
  for (const e of detail.events) {
    const list = eventsByTask.get(e.task) ?? [];
    list.push(e);
    eventsByTask.set(e.task, list);
  }
  return {
    detail,
    tasks: detail.project.tasks,
    task: new Map(detail.project.tasks.map((t) => [t.id, t])),
    snap: new Map(detail.board.tasks.map((t) => [t.id, t])),
    agent: new Map(detail.project.agents.map((a) => [a.id, a])),
    eventsByTask,
    runners: runners && detail.key ? runners : null,
  };
}

/** The chat's runner, or null when it is run by hand. */
export function runnerOf(model: Model, agentId: string | null | undefined): ChatRunner | null {
  if (!agentId) return null;
  const r = model.runners?.settings.chats[agentId];
  return r && r.provider !== "manual" ? r : null;
}

/** The chat's run in progress, if any. */
export function activeRun(model: Model, agentId: string | null | undefined): RunSummary | undefined {
  return model.runners?.runs.find((r) => r.agent === agentId && r.state === "running");
}

/** The latest run of a task. */
export function lastRunOf(model: Model, taskId: string): RunSummary | undefined {
  return model.runners?.runs.find((r) => r.task === taskId);
}

export const PROVIDER_LABEL: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  copilot: "Copilot",
  gemini: "Gemini",
  custom: "CLI",
  manual: "",
};

export function agentName(model: Model, id: string | null | undefined): string {
  if (!id) return "—";
  return model.agent.get(id)?.name ?? id;
}

/** Reasons the tracker writes itself, shown in the UI language. */
export function localReason(reason: string, t: T): string {
  if (reason === "Waiting for your reply.") return t("run_state_waiting");
  if (reason.startsWith("Stopped from the tracker.")) return t("run_reason_stopped");
  if (reason.startsWith("The run stopped when the app closed.")) return t("run_reason_closed");
  if (reason.startsWith("Needs you: ")) return t("run_reason_needs", { message: reason.slice(11) });
  return reason;
}

/** How to install each CLI (macOS and Linux), and the command that signs in the first time. */
export const INSTALL: Record<string, { install: string; login: string }> = {
  claude: { install: "curl -fsSL https://claude.ai/install.sh | bash", login: "claude" },
  codex: { install: "npm install -g @openai/codex", login: "codex login" },
  copilot: { install: "npm install -g @github/copilot", login: "copilot" },
  gemini: { install: "npm install -g @google/gemini-cli", login: "gemini" },
};

/** Errors the tracker explains in English, shown in the UI language. */
export function localError(message: string, t: T): string {
  let m = /^The project's code folder does not exist yet: (.+) \(settings\.repoPath in the project file\)\./.exec(message);
  if (m) return t("err_codeFolderMissing", { path: m[1]! });
  m = /^This chat's working folder was not found: (.+)\. Choose another one/.exec(message);
  if (m) return t("err_workdirMissing", { path: m[1]! });
  m = /^(.+) was not found \(([^)]+)\)\. Install it/.exec(message);
  if (m) {
    const how = INSTALL[m[2]!];
    return how ? t("err_cliMissingHow", { name: m[1]!, install: how.install, login: how.login }) : t("err_cliMissing", { name: m[1]! });
  }
  return message;
}

/** Messages the tracker writes itself when it runs a chat, shown in the UI language. */
export function localMessage(message: string, t: T): string {
  let m = /^(Auto-sent|Sent) to (.+) \((r-[\w-]+)\)\.$/.exec(message);
  if (m) return t(m[1] === "Auto-sent" ? "run_msg_autoSent" : "run_msg_sent", { provider: m[2]! });
  m = /^(.+) is working( on it)?\.$/.exec(message);
  if (m) return t("run_msg_working", { provider: m[1]! });
  m = /^Reply sent: ([\s\S]*)$/.exec(message);
  if (m) return t("run_msg_reply", { text: m[1]! });
  m = /^Problem (resolved|ignored|reopened): ([\s\S]*)$/.exec(message);
  if (m) return t(m[1] === "resolved" ? "msg_problemResolved" : m[1] === "ignored" ? "msg_problemIgnored" : "msg_problemReopened", { title: m[2]! });
  return message;
}

export function reasonText(model: Model, reason: Reason, t: T): string {
  switch (reason.kind) {
    case "dependency":
      return t("why_dependency", { task: reason.task, status: t(`status_${reason.status}`) });
    case "waiting_for":
      return t("why_waiting_for", { tasks: reason.tasks.join(", ") });
    case "agent_busy":
      return reason.tasks.length > 0
        ? t("why_agent_busy", { agent: agentName(model, reason.agent), tasks: reason.tasks.join(", ") })
        : t("why_agent_busy_free", { agent: agentName(model, reason.agent) });
    case "blocked":
      return t("why_blocked", { reason: localReason(reason.reason, t) || "—" });
    case "failed":
      return t("why_failed", { reason: reason.reason || "—" });
    case "awaiting_approval":
      return t("why_awaiting_approval");
    case "cycle":
      return t("why_cycle", { cycle: reason.cycle.join(" → ") });
  }
}

/** The tasks a blocked task waits for: the chat stopped it until they are done. Null otherwise. */
export function waitingFor(s: TaskSnapshot): string[] | null {
  const r = s.reasons.find((x) => x.kind === "waiting_for");
  return r?.kind === "waiting_for" ? r.tasks : null;
}

/** The status a pill shows: a task waiting for other tasks needs nothing from the person, so it is not shown as blocked. */
export function shownStatus(s: TaskSnapshot): BoardStatus {
  return waitingFor(s) ? "waiting" : s.status;
}

/** One short line under a card title. */
export function cardNote(model: Model, s: TaskSnapshot, t: T): string {
  const wait = waitingFor(s);
  if (wait) return t("card_waitingFor", { tasks: wait.join(", ") });
  if (s.resumes?.length) return t("card_resumes", { tasks: s.resumes.join(", ") });
  if (s.status === "blocked" || s.status === "failed") return s.reason ? localReason(s.reason, t) : "";
  if (s.status === "waiting") {
    const open = s.reasons.filter((r) => r.kind === "dependency").map((r) => (r.kind === "dependency" ? r.task : ""));
    return open.length ? `⏳ ${open.slice(0, 3).join(", ")}${open.length > 3 ? "…" : ""}` : "";
  }
  if (s.status === "ready" && !s.dispatchable) {
    const busy = s.reasons.find((r) => r.kind === "agent_busy");
    return busy ? reasonText(model, busy, t) : "";
  }
  if (s.status === "in_progress" || s.status === "dispatched") {
    const run = model.runners?.runs.find((r) => r.task === s.id && r.state === "running");
    if (run?.lastActivity) return run.lastActivity;
    return s.lastMessage ? localMessage(s.lastMessage, t) : "";
  }
  if (s.status === "done" || s.status === "review") return s.summary ?? "";
  return "";
}

export function formatTime(iso: string | null | undefined, lang: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(lang === "tr" ? "tr-TR" : "en-US", { dateStyle: "short", timeStyle: "short" });
}

/** Chats whose tasks the given chat may also take (it is in their tasks' `alsoAgents`). */
export function helpedChats(tasks: Task[], agentId: string): string[] {
  const out = new Set<string>();
  for (const t of tasks) if (t.agent !== agentId && t.alsoAgents.includes(agentId)) out.add(t.agent);
  return [...out];
}

/** A free chat id derived from a display name, e.g. "Codex D" -> "codex-d". */
export function agentIdFromName(name: string, taken: Iterable<string>): string {
  return slugId(name, taken, "chat");
}

/** A free id derived from a title: lower case, ASCII, words joined with "-". */
export function slugId(name: string, taken: Iterable<string>, fallback: string): string {
  const map: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" };
  const base =
    name
      .toLowerCase()
      .replace(/[çğıöşü]/g, (c) => map[c] ?? c)
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || fallback;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The next task id in the style the project already uses: T-07 after T-06; T-01 at first. */
export function nextTaskId(ids: string[]): string {
  const used = new Set(ids);
  let best: { prefix: string; n: number; width: number } | null = null;
  for (const id of ids) {
    const m = /^(.*?)(\d+)$/.exec(id);
    if (!m) continue;
    const n = Number(m[2]);
    if (!best || n > best.n) best = { prefix: m[1]!, n, width: m[2]!.length };
  }
  const style = best ?? { prefix: "T-", n: 0, width: 2 };
  for (let n = style.n + 1; ; n += 1) {
    const id = `${style.prefix}${String(n).padStart(style.width, "0")}`;
    if (!used.has(id)) return id;
  }
}

/** Every task that waits, directly or through others, for the given task. */
export function dependentsOf(tasks: Task[], taskId: string): Set<string> {
  const out = new Set<string>();
  const stack = [taskId];
  while (stack.length) {
    const current = stack.pop()!;
    for (const t of tasks) {
      if (t.dependsOn.includes(current) && !out.has(t.id)) {
        out.add(t.id);
        stack.push(t.id);
      }
    }
  }
  return out;
}

/** Session prompts every chat shares (for example the shared context), in the first chat's order. */
export function sharedBootstrapPrompts(agents: Agent[]): string[] {
  const [first, ...rest] = agents;
  if (!first) return [];
  return first.bootstrapPrompts.filter((p) => rest.every((a) => a.bootstrapPrompts.includes(p)));
}

/** Something the person should look at, with a prompt that would fix it. */
export interface Problem {
  kind: "error" | "missing" | "needs-you" | "warning";
  title: string;
  detail?: string;
  /** Prompt to give the chat, ready to send; empty when the chat cannot fix it (a sign-in, say). */
  fix: string;
  /** A command for the person to run in Terminal. */
  command?: string;
  /** The problem is in how the chat runs (permissions, CLI), not in the work. */
  settings?: boolean;
  /** The problems the chat reported that this card stands for; they are closed together. */
  issues?: Array<{ index: number; title: string }>;
  /** Steps the CLI refused, each explained in plain words. */
  steps?: RefusedStep[];
  /** A decision: the options the chat offered, as buttons. */
  choices?: IssueChoice[];
}

export type IssueChoice = NonNullable<TaskIssue["choices"]>[number];

/** How much a step can change: it only reads, it changes the project, or it is hard to undo. */
export type StepRisk = "read" | "change" | "risky";

export type StepWhat =
  | "list" | "read" | "search" | "text" | "system" | "processes" | "disk" | "where"
  | "gitRead" | "gitWrite" | "gitPush" | "gitRewrite" | "files" | "delete" | "perms" | "admin" | "stop" | "open"
  | "network" | "build" | "install" | "publish" | "dockerRead" | "docker" | "edit" | "readFile" | "web" | "other";

/** A step the CLI refused, explained. */
export interface RefusedStep {
  /** As the CLI reported it, e.g. "Bash sysctl -n hw.model". */
  tool: string;
  /** What to show: the command line, or the tool and its target. */
  shown: string;
  /** What it does (the i18n key is `step_${what}`). */
  what: StepWhat;
  risk: StepRisk;
  /** Claude Code rules that allow it. */
  rules: string[];
  /** A folder outside the chat's working folder that the step looked at. */
  folder?: string;
}

/** The title the tracker gives a step the CLI refused. */
export const REFUSED = "Permission denied: ";

const STEPS = new Map<string, [StepWhat, StepRisk]>();
function steps(what: StepWhat, risk: StepRisk, names: string) {
  for (const n of names.split(/\s+/)) STEPS.set(n, [what, risk]);
}
steps("list", "read", "ls tree");
steps("read", "read", "cat head tail less more wc file stat strings xxd hexdump od md5 md5sum shasum sha256sum plutil");
steps("search", "read", "find grep egrep rg ag fd locate mdfind");
steps("text", "read", "echo printf sort uniq cut tr jq yq sed awk column diff cmp comm basename dirname realpath readlink date pwd cd test true false seq");
steps("system", "read", "sysctl system_profiler sw_vers uname hostname whoami id uptime arch nproc lscpu ioreg");
steps("processes", "read", "ps top pgrep lsof");
steps("disk", "read", "du df");
steps("where", "read", "which type whereis");
steps("files", "change", "mkdir touch cp mv ln tar zip unzip gzip gunzip");
steps("delete", "risky", "rm rmdir unlink shred trash srm");
steps("perms", "risky", "chmod chown chgrp xattr chflags");
steps("admin", "risky", "sudo su doas");
steps("stop", "risky", "kill killall pkill launchctl shutdown reboot");
steps("open", "change", "open xdg-open");
steps("network", "risky", "curl wget ssh scp sftp rsync nc ncat telnet ftp");
steps("build", "change", "node python python3 ruby perl go cargo make cmake tsc npx bunx deno java javac mvn gradle swift swiftc xcodebuild pytest vitest jest tsx php dotnet");
steps("install", "change", "pip pip3 pipx gem apt apt-get yum dnf port");

const GIT_READ = new Set("status diff log show rev-parse ls-files blame grep remote describe shortlog reflog cat-file ls-tree config".split(" "));
const GIT_REWRITE = new Set("reset rebase clean filter-branch filter-repo".split(" "));
const PKG_INSTALL = new Set("install i add ci update upgrade up remove uninstall rm".split(" "));
const DOCKER_READ = new Set("ps info version images inspect logs stats top port history".split(" "));
const RISK_ORDER: Record<StepRisk, number> = { read: 0, change: 1, risky: 2 };

/** What one command of a command line does. */
function commandStep(words: string[]): [StepWhat, StepRisk] {
  const name = (words[0] ?? "").split("/").pop()!;
  const sub = words.slice(1).find((w) => !w.startsWith("-")) ?? "";
  if (name === "git") {
    if (sub === "push") return words.some((w) => /^(-f|--force)/.test(w)) ? ["gitRewrite", "risky"] : ["gitPush", "risky"];
    if (GIT_REWRITE.has(sub)) return ["gitRewrite", "risky"];
    if (GIT_READ.has(sub) && !(sub === "config" && !words.includes("--get"))) return ["gitRead", "read"];
    return ["gitWrite", "change"];
  }
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    if (sub === "publish") return ["publish", "risky"];
    return PKG_INSTALL.has(sub) ? ["install", "change"] : ["build", "change"];
  }
  if (name === "brew") return ["list", "info", "search", "outdated", "doctor", "config"].includes(sub) || sub === "" ? ["system", "read"] : ["install", "change"];
  if (name === "docker" || name === "docker-compose") {
    const what = sub === "compose" ? (words.slice(2).find((w) => !w.startsWith("-")) ?? "") : sub;
    if (DOCKER_READ.has(what) || what === "ls" || what === "config") return ["dockerRead", "read"];
    if (what === "rm" || what === "rmi" || what === "prune" || words.includes("prune")) return ["delete", "risky"];
    return ["docker", "change"];
  }
  if (name === "defaults") return sub === "read" ? ["system", "read"] : ["other", "change"];
  return STEPS.get(name) ?? ["other", "change"];
}

/** Splits a command line into its commands, each as words (quotes kept out, assignments dropped). */
function commandsOf(line: string): string[][] {
  return line
    .replace(/…$/, "")
    .split(/&&|\|\||[;|]/)
    .map((part) =>
      (part.trim().replace(/^(\w+=\S*\s+)+/, "").match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, "")),
    )
    .filter((w) => w.length > 0 && /^[\w./+-]+$/.test(w[0]!));
}

function inside(child: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, "");
  return child === p || child.startsWith(`${p}/`);
}

/** Explains a step the CLI refused: what it does, how risky it is, and the rules that allow it. */
export function explainStep(tool: string, workdir?: string): RefusedStep {
  const bash = /^Bash\s+([\s\S]*)$/.exec(tool);
  const rules = permissionRules(tool);
  if (!bash) {
    const [name = tool, ...rest] = tool.split(/\s+/);
    const target = rest.join(" ");
    const [what, risk]: [StepWhat, StepRisk] = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)
      ? ["edit", "change"]
      : /^(Read|Glob|Grep|LS|NotebookRead)$/.test(name)
        ? ["readFile", "read"]
        : /^(WebFetch|WebSearch)$/.test(name)
          ? ["web", "read"]
          : ["other", "change"];
    const folder = what === "readFile" || what === "edit" ? outsideFolder(target, workdir, false) : undefined;
    return { tool, shown: tool, what, risk, rules, ...(folder && { folder }) };
  }
  const line = bash[1]!.trim();
  const commands = commandsOf(line);
  let best: [StepWhat, StepRisk] = ["other", "change"];
  let first = true;
  for (const words of commands) {
    const step = commandStep(words);
    // The riskiest command decides; among equals the first one that is not plain text work.
    if (first || RISK_ORDER[step[1]] > RISK_ORDER[best[1]] || (RISK_ORDER[step[1]] === RISK_ORDER[best[1]] && best[0] === "text" && step[0] !== "text")) {
      best = step;
      first = false;
    }
  }
  const dirCommand = commands.some((w) => ["ls", "find", "tree", "du", "cd"].includes(w[0]!.split("/").pop()!));
  const folder = outsideFolder(line, workdir, dirCommand);
  return { tool, shown: line, what: best[0], risk: best[1], rules, ...(folder && { folder }) };
}

/**
 * The first absolute path in a step when it is outside the chat's working folder: the folder to
 * add so the step can run. A file's folder when the path looks like a file. Top-level folders and
 * the home folder itself are never offered.
 */
function outsideFolder(text: string, workdir: string | undefined, pathIsFolder: boolean): string | undefined {
  if (!workdir) return undefined;
  const m = /(?:^|[\s"'=])(\/[^\s"'|;&<>()]+)/.exec(text);
  if (!m) return undefined;
  let p = m[1]!.replace(/…$/, "");
  const endsWithSlash = p.endsWith("/");
  p = p.replace(/\/+$/, "");
  if (!endsWithSlash && !pathIsFolder) p = p.slice(0, p.lastIndexOf("/"));
  if (!p || inside(p, workdir)) return undefined;
  if (p.split("/").filter(Boolean).length < 3) return undefined;
  return p;
}

/**
 * The Claude Code permission rules that would have allowed a refused step: one Bash rule per
 * command in a command line ("cd x && find . | wc -l" → cd, find, wc), the tool name otherwise.
 */
export function permissionRules(tool: string): string[] {
  const m = /^Bash\s+([\s\S]*)$/.exec(tool);
  if (!m) return [tool.split(/\s/)[0]!];
  const rules = new Set<string>();
  for (const part of m[1]!.replace(/…$/, "").split(/&&|\|\||[;|]/)) {
    const words = part.trim().replace(/^(\w+=\S*\s+)+/, "").split(/\s+/).filter(Boolean);
    const cmd = words[0]?.replace(/^["']|["']$/g, "");
    if (!cmd || !/^[\w./+-]+$/.test(cmd)) continue;
    const name = cmd.split("/").pop()!;
    rules.add(name === "git" && words[1] && /^[a-z-]+$/.test(words[1]) ? `Bash(git ${words[1]}:*)` : `Bash(${name}:*)`);
  }
  return [...rules];
}

function issueFix(taskId: string, title: string, issue: TaskIssue): string {
  if (issue.fix?.trim()) return issue.fix.trim();
  return [
    `Task ${taskId} (${title}) has an open problem: ${issue.title}.`,
    issue.detail ? `Details: ${issue.detail}` : "",
    "Resolve it within the task's allowed paths, verify the result, and report again with the aitrack-report block. If you cannot resolve it, explain in plain words what is needed from me.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A CLI that is installed but not signed in. */
const SIGN_IN = /not logged in|please run \/login|not authenticated|unauthori[sz]ed|authentication (?:failed|required|error)|invalid (?:x-)?api[- ]key|codex login|please log ?in/i;
/** A CLI that was asked to continue a session it no longer has. */
const SESSION_GONE = /no conversation found|unknown session|could not (?:find|resume) (?:the )?session/i;
/** Claude Code refused auto mode (an older version, or turned off for the account). */
const AUTO_MODE = /auto mode|invalid[^\n]{0,80}permission-mode|permission-mode[^\n]{0,80}(?:invalid|choices)/i;

/** Problems of a task: what the chat reported, plus failures and blocks the tracker knows about. */
export function problemsOf(model: Model, s: TaskSnapshot, t: T): Problem[] {
  const task = model.task.get(s.id);
  const title = task?.title ?? s.id;
  const out: Problem[] = [];
  const lastRun = lastRunOf(model, s.id);
  const refused: Array<{ index: number; title: string }> = [];
  (s.issues ?? []).forEach((i, index) => {
    if (i.state) return;
    if (i.title.startsWith(REFUSED)) {
      refused.push({ index, title: i.title });
      return;
    }
    out.push({
      kind: i.kind ?? "error",
      title: i.title,
      detail: i.detail,
      fix: issueFix(s.id, title, i),
      issues: [{ index, title: i.title }],
      ...(i.choices?.length && { choices: i.choices }),
    });
  });
  // Every step the CLI refused, on one card.
  if (refused.length) {
    const list = refused.map((r) => explainStep(r.title.slice(REFUSED.length), lastRun?.workdir));
    out.push({
      kind: "needs-you",
      title: list.length === 1 ? t("issue_refusedOne") : t("issue_refusedMany", { n: list.length }),
      detail: t(list.some((x) => x.risk === "risky") ? "issue_refusedDetailRisky" : "issue_refusedDetail"),
      fix: `Task ${s.id} (${title}): your permissions refused these steps: ${list.map((x) => x.tool).join("; ")}. Finish the task without them if you can; otherwise tell me in plain words which one you need and why.`,
      settings: true,
      issues: refused,
      steps: list,
    });
  }
  const runFailedNow = s.status === "failed" && s.reason && lastRun?.state === "failed" && lastRun.error === s.reason;
  if (runFailedNow && SIGN_IN.test(s.reason!)) {
    const how = INSTALL[lastRun!.provider];
    out.unshift({
      kind: "needs-you",
      title: t("issue_signIn", { cli: PROVIDER_LABEL[lastRun!.provider] || lastRun!.provider }),
      detail: t("issue_signInDetail", { login: how?.login ?? lastRun!.provider }),
      fix: "",
      command: how?.login,
    });
  } else if (runFailedNow && SESSION_GONE.test(s.reason!)) {
    out.unshift({ kind: "warning", title: t("issue_sessionGone"), detail: t("issue_sessionGoneDetail"), fix: "" });
  } else if (runFailedNow && lastRun!.provider === "claude" && AUTO_MODE.test(s.reason!)) {
    out.unshift({ kind: "warning", title: t("issue_autoMode"), detail: t("issue_autoModeDetail"), fix: "", settings: true, command: "claude update" });
  } else if (s.status === "failed" && s.reason && !out.some((p) => p.detail === s.reason)) {
    const runFailed = lastRun?.state === "failed" && lastRun.error === s.reason;
    out.unshift({
      kind: "error",
      title: runFailed ? t("issue_runFailed") : t("issue_failed"),
      detail: s.reason,
      fix: `Task ${s.id} (${title}) failed: ${s.reason}\nFind the cause, fix it, verify the result, and report again with the aitrack-report block. If you need something from me, say exactly what.`,
      settings: runFailed,
    });
  }
  // The chat's own question, unless it already wrote down what it needs as problems of its own.
  const askedAlready = out.some((p) => p.kind === "needs-you" && p.issues && !p.steps);
  if (
    s.status === "blocked" &&
    s.reason &&
    !askedAlready &&
    !waitingFor(s) &&
    s.reason !== "Waiting for your reply." &&
    !s.reason.startsWith("Stopped from") &&
    !s.reason.startsWith("The run stopped")
  ) {
    out.unshift({
      kind: "needs-you",
      title: t("issue_blocked"),
      detail: localReason(s.reason, t),
      fix: `About task ${s.id} (${title}), which is blocked: ${s.reason}\n<your answer or decision>\nContinue with this, verify, and report again.`,
    });
  }
  return out;
}

/** The problems a chat reported that the person resolved or ignored. */
export function closedIssuesOf(s: TaskSnapshot): Array<TaskIssue & { index: number }> {
  return (s.issues ?? []).map((i, index) => ({ ...i, index })).filter((i) => Boolean(i.state));
}

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** How full the session's context is, 0–100, when the CLI tells. */
export function contextPercent(run: RunSummary | undefined): number | null {
  const u = run?.usage;
  if (!u?.context || !u.contextWindow) return null;
  return Math.min(100, Math.round((u.context / u.contextWindow) * 100));
}

/** The chat's latest run that reported context usage. */
export function lastContextRun(model: Model, agentId: string): RunSummary | undefined {
  return model.runners?.runs.find((r) => r.agent === agentId && r.usage?.context);
}
