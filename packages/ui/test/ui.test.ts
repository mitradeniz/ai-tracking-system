import { describe, expect, it } from "vitest";
import { splitReport } from "../src/components/Markdown.tsx";
import type { TaskSnapshot } from "@aitrack/core";
import type { RunSummary } from "../src/api.ts";
import { translator } from "../src/i18n.ts";
import { cardNote, explainStep, localMessage, notesOf, permissionRules, problemsOf, shownStatus, type Model } from "../src/model.ts";
import { choiceReply, continueAfterAllow, continueAfterPermission, permissionGrant, settledBy } from "../src/problemActions.ts";
import { waitingForYou } from "../src/waiting.ts";
import type { ChatRunner } from "../src/api.ts";

describe("permission rules", () => {
  it("allows each command of a refused command line", () => {
    expect(permissionRules('Bash cd "/a b/c" && find . -type f | sort | sed \'s#x##\' && wc -l contracts/…')).toEqual([
      "Bash(cd:*)",
      "Bash(find:*)",
      "Bash(sort:*)",
      "Bash(sed:*)",
      "Bash(wc:*)",
    ]);
    expect(permissionRules("Bash git push origin main")).toEqual(["Bash(git push:*)"]);
    expect(permissionRules("Bash NODE_ENV=test /usr/local/bin/node x.mjs")).toEqual(["Bash(node:*)"]);
    expect(permissionRules("WebFetch https://example.com")).toEqual(["WebFetch"]);
  });
});

describe("chat messages", () => {
  it("takes the report off the end of a message", () => {
    const fenced = splitReport('Done.\n\n```aitrack-report\n{"task":"T1","status":"done"}\n```');
    expect(fenced).toEqual({ text: "Done.", report: '{"task":"T1","status":"done"}' });
    const bare = splitReport('All set.\n```json\n{"task":"T1","status":"blocked","pr":null}\n```\n');
    expect(bare.text).toBe("All set.");
    expect(JSON.parse(bare.report!)).toMatchObject({ task: "T1", status: "blocked" });
    expect(splitReport("Just text with {braces}.")).toEqual({ text: "Just text with {braces}.", report: null });
  });
});

describe("refused steps and decisions", () => {
  const t = translator("en");
  const model = (runs: Partial<RunSummary>[] = []) =>
    ({ task: new Map([["T1", { id: "T1", title: "One" }]]), runners: { runs } }) as unknown as Model;
  const snap = (extra: Partial<TaskSnapshot>) => ({ id: "T1", status: "blocked", reasons: [], ...extra }) as TaskSnapshot;

  it("says what each refused step does and how risky it is", () => {
    expect(explainStep("Bash sysctl -n hw.model")).toMatchObject({ what: "system", risk: "read", rules: ["Bash(sysctl:*)"] });
    expect(explainStep("Bash system_profiler SPHardwareDataType")).toMatchObject({ what: "system", risk: "read" });
    expect(explainStep("Bash git push origin main")).toMatchObject({ what: "gitPush", risk: "risky" });
    expect(explainStep("Bash git reset --hard HEAD~1")).toMatchObject({ what: "gitRewrite", risk: "risky" });
    expect(explainStep("Bash git status --short")).toMatchObject({ what: "gitRead", risk: "read" });
    expect(explainStep("Bash cd web && rm -rf dist")).toMatchObject({ what: "delete", risk: "risky" });
    expect(explainStep("Bash cd web && npm install")).toMatchObject({ what: "install", risk: "change" });
    expect(explainStep("Bash docker ps -a")).toMatchObject({ what: "dockerRead", risk: "read" });
    expect(explainStep("Bash docker compose up -d")).toMatchObject({ what: "docker", risk: "change" });
    expect(explainStep("Bash brew list")).toMatchObject({ what: "system", risk: "read" });
    expect(explainStep("WebFetch https://example.com")).toMatchObject({ what: "web", risk: "read" });
    expect(explainStep("Edit /w/src/a.ts")).toMatchObject({ what: "edit", risk: "change" });
    // A folder outside the chat's own is offered to add; a top-level folder never is.
    expect(explainStep("Bash ls -la /Users/me/.claude/projects/-w/memory/", "/w").folder).toBe("/Users/me/.claude/projects/-w/memory");
    expect(explainStep("Bash cat /Users/me/other/README.md", "/w").folder).toBe("/Users/me/other");
    expect(explainStep("Bash ls /w/src", "/w").folder).toBeUndefined();
    expect(explainStep("Bash cat /etc/hosts", "/w").folder).toBeUndefined();
  });

  it("puts every refused step on one card and keeps decisions as options", () => {
    const issues = [
      { title: "Which repository should the code live in?", kind: "needs-you" as const, choices: [{ label: "Separate repo", recommended: true }, { label: "Same repo" }] },
      { title: "Permission denied: Bash sysctl -n hw.model", kind: "needs-you" as const },
      { title: "Permission denied: Bash git push origin main", kind: "needs-you" as const },
      { title: "Permission denied: Bash ls /x", kind: "needs-you" as const, state: "resolved" as const },
    ];
    const list = problemsOf(model([{ task: "T1", workdir: "/w", provider: "claude" }]), snap({ reason: "Which repository?", issues }), t);
    expect(list).toHaveLength(2);
    expect(list[0]!.choices).toHaveLength(2);
    expect(list[0]!.issues).toEqual([{ index: 0, title: issues[0]!.title }]);
    const card = list[1]!;
    expect(card.title).toBe(t("issue_refusedMany", { n: 2 }));
    expect(card.detail).toBe(t("issue_refusedDetailRisky"));
    expect(card.steps!.map((s) => s.risk)).toEqual(["read", "risky"]);
    expect(card.issues!.map((i) => i.index)).toEqual([1, 2]);
  });

  it("does not repeat the chat's question when it already wrote down what it needs", () => {
    const asked = problemsOf(model(), snap({ reason: "Docker is not running.", issues: [{ title: "Start Docker?", kind: "needs-you" }] }), t);
    expect(asked.map((p) => p.title)).toEqual(["Start Docker?"]);
    const onlyQuestion = problemsOf(model(), snap({ reason: "Docker is not running." }), t);
    expect(onlyQuestion.map((p) => p.title)).toEqual([t("issue_blocked")]);
    const onlyRefused = problemsOf(model(), snap({ reason: "Docker is not running.", issues: [{ title: "Permission denied: Bash docker info" }] }), t);
    expect(onlyRefused.map((p) => p.title)).toEqual([t("issue_blocked"), t("issue_refusedOne")]);
  });

  it("shows a task that waits for another one as waiting, without a problem", () => {
    const parked = snap({ reason: "Needs CLD-01 merged", reasons: [{ kind: "waiting_for", tasks: ["CLD-01"] }] });
    expect(shownStatus(parked)).toBe("waiting");
    expect(problemsOf(model(), parked, t)).toEqual([]);
    expect(cardNote(model(), parked, t)).toBe(t("card_waitingFor", { tasks: "CLD-01" }));
    const back = snap({ status: "ready", reasons: [], resumes: ["CLD-01"] });
    expect(cardNote(model(), back, t)).toBe(t("card_resumes", { tasks: "CLD-01" }));
    expect(shownStatus(snap({ reason: "Which repo?", reasons: [{ kind: "blocked", reason: "Which repo?" }] }))).toBe("blocked");
  });

  it("shows a task parked by a usage limit as waiting, with the time it goes on", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const parked = snap({ reason: `Usage limit: Claude Code · until ${until}` });
    expect(shownStatus(parked)).toBe("waiting");
    expect(problemsOf(model(), parked, t)).toEqual([]);
    expect(cardNote(model(), parked, t)).toMatch(/^Claude Code reached its usage limit; it goes on by itself at /);
  });

  it("keeps notes apart from problems: they need no answer", () => {
    const done = snap({
      status: "done",
      issues: [
        { title: "Placeholders in web/img", kind: "warning" },
        { title: "Buy the domain", kind: "needs-you" },
        { title: "Old note", kind: "warning", state: "resolved" },
      ],
    });
    expect(problemsOf(model(), done, t).map((p) => p.title)).toEqual(["Buy the domain"]);
    expect(notesOf(done).map((n) => [n.index, n.title])).toEqual([[0, "Placeholders in web/img"]]);
  });

  it("shows what the manager did in the person's language", () => {
    const tr = translator("tr");
    expect(localMessage("Manager: replied — Evet, devam et.", tr)).toBe("Yönetici yanıtladı: Evet, devam et.");
    expect(localMessage('Manager: chose "Separate repo" for "Where does the code go?"', tr)).toBe("Yönetici “Where does the code go?” için “Separate repo” seçti");
    expect(localMessage("Manager: left for you — Buy the domain.", tr)).toBe("Yönetici sana bıraktı: Buy the domain.");
    expect(localMessage("Manager: approved — Tests pass.", tr)).toBe("Yönetici onayladı. Tests pass.");
    expect(localMessage("Proposed tasks: Add CI → ignored", tr)).toBe("Önerilen görevler: Add CI → yoksayıldı");
  });

  it("tells the chat what was allowed and what the person picked", () => {
    const steps = [explainStep("Bash sysctl -n hw.model")];
    expect(continueAfterAllow(steps, t)).toContain("- sysctl -n hw.model");
    const problem = { kind: "needs-you" as const, title: "Where does the code go?", fix: "" };
    const reply = choiceReply(problem, { label: "Separate repo", reply: "I move the commits there." }, t);
    expect(reply).toContain('I choose: "Separate repo"');
    expect(reply).toContain("I move the commits there.");
    const tr = choiceReply(problem, { label: "Ayrı repo" }, translator("tr"));
    expect(tr.split("\n")).toEqual(['"Where does the code go?" konusunda seçimim: "Ayrı repo".', "Bununla devam et ve yeniden raporla."]);
  });

  it("gives a permission a chat asked for in the way its CLI takes it, for good", () => {
    const base: ChatRunner = { provider: "claude", access: "edit", session: "keep", unattended: false, network: false, allowedTools: "Bash(npm test:*)" };
    // Claude Code and Copilot: an entry in the allowed tools.
    expect(permissionGrant(base, { kind: "command", value: "$ open" })).toEqual({ how: "rule", patch: { allowedTools: "Bash(npm test:*)\nBash(open:*)" }, shown: "Bash(open:*)" });
    expect(permissionGrant(base, { kind: "command", value: "npm test" }).how).toBe("none");
    expect(permissionGrant({ ...base, provider: "copilot", allowedTools: "" }, { kind: "command", value: "npm ci" }).patch).toEqual({ allowedTools: "shell(npm ci:*)" });
    // Codex: network in its sandbox, other folders; a single command only with full access.
    const codex: ChatRunner = { ...base, provider: "codex", allowedTools: undefined };
    expect(permissionGrant(codex, { kind: "network" })).toEqual({ how: "network", patch: { network: true }, shown: "network" });
    expect(permissionGrant(codex, { kind: "folder", value: "/Users/me/other" })).toEqual({ how: "folder", patch: { extraDirs: "/Users/me/other" }, shown: "/Users/me/other" });
    expect(permissionGrant(codex, { kind: "command", value: "open" })).toMatchObject({ how: "full", patch: { access: "full" } });
    expect(permissionGrant(codex, { kind: "folder", value: "relative/path" }).how).toBe("full");
    // Claude Code does not block the network; full access needs nothing more.
    expect(permissionGrant(base, { kind: "network" }).how).toBe("none");
    expect(permissionGrant({ ...codex, access: "full" }, { kind: "command", value: "open" }).how).toBe("none");
    const grant = permissionGrant(codex, { kind: "network" });
    expect(continueAfterPermission(grant, translator("tr")).split("\n")[0]).toBe("Bundan sonra sana kalıcı olarak izin verildi: network.");
  });

  it("offers the permission a Codex chat's sandbox kept out, and settles every card it covers at once", () => {
    const snap = {
      id: "T1",
      agent: "codex-c",
      status: "blocked",
      reasons: [],
      issues: [
        { title: "Registry erişimi başarısız", detail: "Npm metadata isteği ENOTFOUND verdi.", kind: "error" },
        { title: "Localhost bağlantısı engelli", detail: "127.0.0.1 üzerinde dinleme EPERM ile reddedildi.", kind: "error" },
        { title: "Testler kırmızı", detail: "2 test başarısız", kind: "error" },
      ],
    } as unknown as TaskSnapshot;
    const codex: ChatRunner = { provider: "codex", access: "edit", session: "keep", unattended: true, network: false };
    const model = { task: new Map([["T1", { id: "T1", title: "One", agent: "codex-c" }]]), runners: { runs: [], settings: { chats: { "codex-c": codex } } } } as unknown as Model;
    const problems = problemsOf(model, snap, t);
    expect(problems.map((p) => p.permission)).toEqual([{ kind: "network", inferred: true }, { kind: "network", inferred: true }, undefined]);
    const grant = permissionGrant(codex, problems[0]!.permission!);
    expect(grant).toMatchObject({ how: "network", patch: { network: true } });
    expect(settledBy(problems, problems[0]!, codex, grant).issues!.map((i) => i.index)).toEqual([0, 1]);
    // The same problems with a Claude Code chat: nothing to grant.
    const claude = { ...model, runners: { runs: [], settings: { chats: { "codex-c": { ...codex, provider: "claude" } } } } } as unknown as Model;
    expect(problemsOf(claude, snap, t).some((p) => p.permission)).toBe(false);
  });

  it("lists what waits for the person while a manager runs the project, one item per task", () => {
    const codex: ChatRunner = { provider: "codex", access: "edit", session: "keep", unattended: true, network: true };
    const snaps = [
      { id: "T1", agent: "c", status: "blocked", reasons: [], issues: [{ title: "Chromium açılamıyor", detail: "Mach bootstrap Permission denied (1100)", kind: "error" }] },
      { id: "T2", agent: "c", status: "blocked", reasons: [], issues: [{ title: "Bölge?", kind: "needs-you" }] },
      { id: "T3", agent: "c", status: "done", reasons: [], issues: [] },
    ] as unknown as TaskSnapshot[];
    const model = {
      task: new Map(["T1", "T2", "T3"].map((id) => [id, { id, title: id, agent: "c" }])),
      snap: new Map(snaps.map((s) => [s.id, s])),
      runners: { runs: [], settings: { chats: { c: codex } } },
    } as unknown as Model;
    const log = [
      { forYou: ["T2: Bölge kararı senin.", "Alan adını satın al."] },
      { forYou: ["T2: older message", "T3: done already", "General from an older look"] },
    ] as never;
    const items = waitingForYou(model, log, { fullAuthority: false }, t);
    expect(items.map((i) => [i.task ?? null, i.message ?? null, i.problems.length])).toEqual([
      ["T2", "Bölge kararı senin.", 1],
      ["T1", null, 1],
      [null, "Alan adını satın al.", 0],
    ]);
    // With full authority the manager gives permissions itself: they do not wait for the person.
    expect(waitingForYou(model, log, { fullAuthority: true }, t).map((i) => i.task ?? null)).toEqual(["T2", null]);
    // An item keeps its id while it says the same thing.
    expect(waitingForYou(model, log, { fullAuthority: false }, t)[0]!.id).toBe(items[0]!.id);
  });

  it("shows the permission a chat asked for on its problem", () => {
    const snap = { id: "T1", status: "blocked", issues: [{ title: "Finder açılamadı", kind: "needs-you", permission: { kind: "command", value: "open" } }] } as unknown as TaskSnapshot;
    const model = { task: new Map([["T1", { id: "T1", title: "One" }]]), runners: null } as unknown as Model;
    expect(problemsOf(model, snap, t)[0]!.permission).toEqual({ kind: "command", value: "open" });
  });
});
