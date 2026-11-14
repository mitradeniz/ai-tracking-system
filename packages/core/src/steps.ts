/**
 * Steps an agent CLI refused (from its permission denials): what each one does in plain words, how
 * much it can change, and the Claude Code rules that would allow it. Used by the app to explain a
 * refused step and by the manager to allow only the safe ones.
 */

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
