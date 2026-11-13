import type { TaskSnapshot } from "@aitrack/core";
import { useEffect, useMemo, useState } from "react";
import { desktop, dispatchTask, api, type RunSummary } from "./api.ts";
import { useAppearance, useApplyAppearance } from "./appearance.ts";
import { useTracker } from "./hooks.ts";
import { chosenLang, I18nContext, initialLang, translator, type Lang, type T } from "./i18n.ts";
import {
  localError,
  activeRun,
  agentName,
  buildModel,
  cardNote,
  contextPercent,
  formatDuration,
  lastContextRun,
  localReason,
  problemsOf,
  PROVIDER_LABEL,
  runnerOf,
  type Model,
} from "./model.ts";
import { Bang, useNow } from "./components/Info.tsx";
import { StopButton, stopRun } from "./components/Runners.tsx";
import { readJson, usePref } from "./prefs.ts";

type MiniView = "overview" | "compact" | "lanes";
interface MiniSettings {
  project: string | null;
  view: MiniView;
  sections: { chats: boolean; needsYou: boolean; active: boolean; done: boolean };
  /** Chats to show, per project id; empty means all. */
  agents: Record<string, string[]>;
  pinned: boolean;
  opacity: number;
}

const DEFAULT_MINI: MiniSettings = {
  project: null,
  view: "overview",
  sections: { chats: true, needsYou: true, active: false, done: false },
  agents: {},
  pinned: true,
  opacity: 1,
};

function normalizeMini(v: Partial<MiniSettings> | null): MiniSettings {
  const s = { ...DEFAULT_MINI, ...(v ?? {}) };
  return {
    project: typeof s.project === "string" ? s.project : null,
    view: ["overview", "compact", "lanes"].includes(s.view) ? s.view : "overview",
    sections: { ...DEFAULT_MINI.sections, ...(s.sections ?? {}) },
    agents: s.agents && typeof s.agents === "object" ? s.agents : {},
    pinned: s.pinned !== false,
    opacity: typeof s.opacity === "number" ? Math.min(1, Math.max(0.4, s.opacity)) : 1,
  };
}

type ChatState = "working" | "blocked" | "sent" | "ready" | "review" | "idle";

interface ChatRow {
  id: string;
  name: string;
  state: ChatState;
  text: string;
  /** The task a click should show. */
  focus?: string;
  /** The task one click can send to this chat. */
  next?: TaskSnapshot;
  /** An agent run is going on now. */
  running?: RunSummary;
  /** Short state label shown on the right. */
  label: string;
  startedAt?: string;
  problems: number;
  context: number | null;
}

function chatRows(model: Model, t: T, only: Set<string> | null): ChatRow[] {
  const board = model.detail.board;
  const project = model.detail.project;
  if (!board || !project) return [];
  return project.agents
    .filter((a) => !only || only.has(a.id))
    .map((a) => {
      const av = board.agents.find((x) => x.id === a.id);
      const holding = (av?.holding ?? []).map((id) => model.snap.get(id)).filter((s): s is TaskSnapshot => Boolean(s));
      const sendable = (av?.dispatchable ?? []).map((id) => model.snap.get(id)).filter((s): s is TaskSnapshot => Boolean(s));
      const review = board.tasks.filter((s) => s.status === "review" && (s.agent ?? model.task.get(s.id)?.agent) === a.id);
      const blocked = holding.find((s) => s.status === "blocked");
      const working = holding.find((s) => s.status === "in_progress");
      const sent = holding.find((s) => s.status === "dispatched");
      const mineAll = board.tasks.filter((s) => (s.agent ?? model.task.get(s.id)?.agent) === a.id);
      const withProblems = mineAll.map((s) => ({ s, list: problemsOf(model, s, t) })).filter((x) => x.list.length > 0);
      const problems = withProblems.reduce((n, x) => n + x.list.length, 0);
      const firstProblem = withProblems[0];
      const row: ChatRow = {
        id: a.id,
        name: a.name,
        state: "idle",
        text: firstProblem ? `${firstProblem.s.id} · ${firstProblem.list[0]!.title}` : "",
        focus: firstProblem?.s.id,
        label: t("idle"),
        next: sendable[0],
        problems,
        context: contextPercent(lastContextRun(model, a.id)),
      };
      const run = activeRun(model, a.id);
      if (run) {
        row.state = "working";
        row.running = run;
        row.label = PROVIDER_LABEL[run.provider] ?? t("run_state_running");
        row.startedAt = run.startedAt;
        row.text = `${run.task} · ${run.lastActivity ?? model.task.get(run.task)?.title ?? ""}`;
        row.focus = run.task;
      } else if (blocked) {
        row.state = "blocked";
        const waiting = blocked.reason === "Waiting for your reply.";
        row.label = waiting ? t("run_state_waiting") : t("status_blocked");
        row.text = waiting
          ? `${blocked.id} · ${model.task.get(blocked.id)?.title ?? ""}`
          : `${blocked.id}${blocked.reason ? ` · ${localReason(blocked.reason, t)}` : ""}`;
        row.focus = blocked.id;
      } else if (working) {
        row.state = "working";
        row.label = t("status_in_progress");
        row.text = `${working.id} · ${model.task.get(working.id)?.title ?? ""}`;
        row.focus = working.id;
      } else if (sent) {
        row.state = "sent";
        row.label = t("status_dispatched");
        row.text = `${sent.id} · ${model.task.get(sent.id)?.title ?? ""}`;
        row.focus = sent.id;
      } else if (sendable.length > 0) {
        row.state = "ready";
        row.label = t("sendable");
        row.text = t("chat_idle_ready", { n: sendable.length });
        row.focus = sendable[0]!.id;
      } else if (review.length > 0) {
        row.state = "review";
        row.label = t("status_review");
        row.text = t("chat_review", { n: review.length });
        row.focus = review[0]!.id;
      }
      return row;
    });
}

export function MiniApp() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = useMemo(() => translator(lang), [lang]);
  const [appearance] = useAppearance();
  useApplyAppearance(appearance);
  const [raw, setRaw] = usePref<Partial<MiniSettings> | null>("mini", null);
  const settings = normalizeMini(raw);
  const save = (patch: Partial<MiniSettings>) => setRaw({ ...settings, ...patch });
  const [mainSelected] = usePref<string | null>("selectedProject", null);
  const [showSettings, setShowSettings] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const selected = settings.project ?? mainSelected;
  const { projects, loaded, detail, live, runners } = useTracker(selected, undefined, (m) => setFlash(`⚠ ${m}`));
  const project = projects.find((p) => p.key === selected) ? selected : (projects[0]?.key ?? null);
  // Follow the first project when the stored one is gone.
  useEffect(() => {
    if (loaded && project !== selected && project) save({ project });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, project, selected]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.mini = "1";
    root.lang = lang;
  }, [lang]);

  const projectLang = detail?.project?.settings.language;
  useEffect(() => {
    if (projectLang && !chosenLang()) setLang(projectLang);
  }, [projectLang]);

  // Pinning and opacity live in the desktop shell.
  useEffect(() => {
    void desktop?.setMini?.({ pinned: settings.pinned, opacity: settings.opacity });
  }, [settings.pinned, settings.opacity]);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 2500);
    return () => window.clearTimeout(id);
  }, [flash]);

  const model = useMemo(
    () => (detail && detail.key === project ? buildModel(detail, runners && selected === project ? runners : null) : null),
    [detail, project, runners, selected],
  );
  const projectId = model?.detail.project?.project.id ?? "";
  const known = model?.detail.project?.agents.map((a) => a.id) ?? [];
  const chosen = (settings.agents[projectId] ?? []).filter((a) => known.includes(a));
  const only = chosen.length > 0 ? new Set(chosen) : null;
  const rows = model ? chatRows(model, t, only) : [];
  const now = useNow(rows.some((r) => Boolean(r.running)));
  const inScope = (s: TaskSnapshot) => {
    if (!only || !model) return true;
    const owner = model.task.get(s.id)?.agent;
    return (owner !== undefined && only.has(owner)) || (s.agent != null && only.has(s.agent));
  };
  const tasks = model?.detail.board?.tasks.filter(inScope) ?? [];
  const counts = {
    ready: tasks.filter((s) => s.dispatchable).length,
    active: tasks.filter((s) => s.status === "in_progress" || s.status === "dispatched").length,
    blocked: tasks.filter((s) => s.status === "blocked" || s.status === "failed").length,
    review: tasks.filter((s) => s.status === "review").length,
  };

  const open = (taskId?: string) => {
    if (desktop?.focusMain) void desktop.focusMain(project ?? undefined, taskId);
  };

  const send = async (s: TaskSnapshot, agentId: string) => {
    if (!model) return;
    setBusy(s.id);
    try {
      const how = await dispatchTask(model.detail.key, s.id, agentId, model.runners);
      setFlash(how === "run" ? t("run_sent", { task: s.id, agent: agentName(model, agentId) }) : t("copiedSent", { task: s.id }));
    } catch (e) {
      setFlash(`⚠ ${localError((e as Error).message, t)}`);
    } finally {
      setBusy(null);
    }
  };

  const approve = async (s: TaskSnapshot) => {
    if (!model) return;
    setBusy(s.id);
    try {
      await api.addEvent(model.detail.key, { task: s.id, type: "approved", agent: s.agent ?? undefined });
    } catch (e) {
      setFlash(`⚠ ${localError((e as Error).message, t)}`);
    } finally {
      setBusy(null);
    }
  };

  const taskLine = (s: TaskSnapshot, action?: React.ReactNode) => (
    <div className={`mini-task ${s.dispatchable ? "sendable" : s.status}`} key={s.id}>
      <button type="button" className="mini-task-main" onClick={() => open(s.id)} title={model?.task.get(s.id)?.title}>
        <span className="mono">{s.id}</span>
        <span className="ellipsis">{model?.task.get(s.id)?.title}</span>
      </button>
      {action}
    </div>
  );

  const chatList = (compact: boolean) => (
    <div className={`mini-chats ${compact ? "compact" : ""}`}>
      {rows.map((r) => (
        <div className={`mini-chat ${r.state}`} key={r.id}>
          <button type="button" className="mini-chat-main" onClick={() => open(r.focus)}>
            <span className={`state-dot ${r.state} ${r.running ? "pulse" : ""}`} aria-hidden="true" />
            <span className="mini-chat-name ellipsis">{r.name}</span>
            <span className="mini-chat-state">
              {r.problems > 0 && <Bang n={r.problems} title={t("problemsN", { n: r.problems })} />}
              {r.startedAt && <span className="mono">{formatDuration(now - Date.parse(r.startedAt))}</span>}
              <span>{r.label}</span>
            </span>
            {!compact && r.text && (
              <span className="mini-chat-text ellipsis" title={r.text}>
                {r.text}
              </span>
            )}
            {!compact && r.context !== null && (
              <span className="mini-ctx" title={t("m_contextHint")}>
                <span className={`meter ${r.context >= 80 ? "hot" : r.context >= 60 ? "warm" : ""}`}>
                  <span style={{ width: `${Math.max(3, r.context)}%` }} />
                </span>
                {t("m_context")} {r.context}%
              </span>
            )}
          </button>
          {r.running && model && (
            <StopButton
              tiny
              label="■"
              confirmLabel={t("run_stopConfirm")}
              title={t("run_stopHint")}
              onStop={() =>
                void stopRun(model, r.running!, t)
                  .then((m) => setFlash(m))
                  .catch((e: Error) => setFlash(`⚠ ${localError(e.message, t)}`))
              }
            />
          )}
          {r.next && r.state !== "working" && r.state !== "blocked" && r.state !== "sent" && (
            <button className="btn tiny primary" disabled={busy === r.next.id} onClick={() => send(r.next!, r.id)} title={r.next.id}>
              {compact ? r.next.id : `${runnerOf(model!, r.id) ? "▶" : t("copyAndSendShort")} ${r.next.id}`}
            </button>
          )}
        </div>
      ))}
    </div>
  );

  const section = (title: string, items: TaskSnapshot[], render: (s: TaskSnapshot) => React.ReactNode) =>
    items.length > 0 && (
      <section className="mini-section">
        <h3>
          {title} · {items.length}
        </h3>
        {items.map(render)}
      </section>
    );

  const needsYou = tasks
    .filter(
      (s) =>
        s.dispatchable || s.status === "review" || s.status === "blocked" || s.status === "failed" || (model ? problemsOf(model, s, t).length > 0 : false),
    )
    .sort((a, b) => Number(b.dispatchable) - Number(a.dispatchable) || b.chain - a.chain);
  const active = tasks.filter((s) => s.status === "in_progress" || s.status === "dispatched");
  const done = tasks
    .filter((s) => s.status === "done")
    .sort((a, b) => ((a.finishedAt ?? a.updatedAt ?? "") < (b.finishedAt ?? b.updatedAt ?? "") ? 1 : -1))
    .slice(0, 6);

  const allChats = model?.detail.project?.agents ?? [];

  return (
    <I18nContext.Provider value={{ t, lang }}>
      <div className="mini" style={desktop ? undefined : { opacity: settings.opacity }}>
        <header className="mini-head">
          <img src="/favicon.svg" alt="" />
          <select
            className="input tiny no-drag"
            value={project ?? ""}
            onChange={(e) => save({ project: e.target.value || null })}
            aria-label={t("project")}
          >
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="spacer" />
          <span className={`dot ${live ? "" : "off"}`} title={live ? t("live") : t("offline")} />
          <button
            className={`icon-btn no-drag ${showSettings ? "on" : ""}`}
            onClick={() => setShowSettings(!showSettings)}
            aria-label={t("settings")}
            title={t("settings")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
              <circle cx="9" cy="6" r="2" fill="currentColor" />
              <circle cx="15" cy="12" r="2" fill="currentColor" />
              <circle cx="7" cy="18" r="2" fill="currentColor" />
            </svg>
          </button>
          {desktop?.focusMain && (
            <button className="icon-btn no-drag" onClick={() => open()} aria-label={t("openMain")} title={t("openMain")}>
              ↗
            </button>
          )}
          {desktop?.closeMini && (
            <button className="icon-btn no-drag" onClick={() => void desktop?.closeMini?.()} aria-label={t("close")} title={t("close")}>
              ✕
            </button>
          )}
        </header>

        {showSettings && (
          <div className="mini-settings">
            <div className="segmented" role="radiogroup" aria-label="view">
              {(["overview", "compact", "lanes"] as MiniView[]).map((v) => (
                <button key={v} role="radio" aria-checked={settings.view === v} onClick={() => save({ view: v })}>
                  {t(`mini_${v}`)}
                </button>
              ))}
            </div>
            {settings.view === "overview" && (
              <div className="mini-checks">
                <span className="small muted">{t("mini_show")}</span>
                {(["chats", "needsYou", "active", "done"] as const).map((k) => (
                  <label key={k} className="check plain">
                    <input
                      type="checkbox"
                      checked={settings.sections[k]}
                      onChange={(e) => save({ sections: { ...settings.sections, [k]: e.target.checked } })}
                    />
                    {t(`sec_${k}`)}
                  </label>
                ))}
              </div>
            )}
            {allChats.length > 0 && (
              <div className="mini-checks">
                <span className="small muted">{t("chatsFilter")}</span>
                {allChats.map((a) => (
                  <label key={a.id} className="check plain">
                    <input
                      type="checkbox"
                      checked={only?.has(a.id) ?? false}
                      onChange={(e) => {
                        const next = new Set(only ?? []);
                        if (e.target.checked) next.add(a.id);
                        else next.delete(a.id);
                        save({ agents: { ...settings.agents, [projectId]: [...next] } });
                      }}
                    />
                    {a.name}
                  </label>
                ))}
              </div>
            )}
            <div className="mini-checks">
              {desktop?.setMini && (
                <label className="check plain">
                  <input type="checkbox" checked={settings.pinned} onChange={(e) => save({ pinned: e.target.checked })} />
                  {t("pin")}
                </label>
              )}
              <label className="check plain grow">
                {t("opacity")}
                <input
                  type="range"
                  min={40}
                  max={100}
                  value={Math.round(settings.opacity * 100)}
                  onChange={(e) => save({ opacity: Number(e.target.value) / 100 })}
                />
              </label>
            </div>
          </div>
        )}

        {!model ? (
          <div className="mini-body muted small">{loaded && projects.length === 0 ? t("noProject") : t("loading")}</div>
        ) : (
          <div className="mini-body">
            <div className="mini-summary">
              <span className="count ready">
                {t("count_ready")} <b>{counts.ready}</b>
              </span>
              <span className="count">
                {t("count_active")} <b>{counts.active}</b>
              </span>
              <span className="count blocked">
                {t("count_blocked")} <b>{counts.blocked}</b>
              </span>
              {counts.review > 0 && (
                <span className="count review">
                  {t("count_review")} <b>{counts.review}</b>
                </span>
              )}
            </div>

            {settings.view === "compact" && chatList(true)}

            {settings.view === "overview" && (
              <>
                {settings.sections.chats && chatList(false)}
                {settings.sections.needsYou &&
                  section(t("sec_needsYou"), needsYou, (s) =>
                    taskLine(
                      s,
                      problemsOf(model, s, t).length > 0 && !s.dispatchable && s.status !== "review" ? (
                        <span className="bang" title={problemsOf(model, s, t).map((p) => p.title).join("\n")}>
                          !
                        </span>
                      ) : s.dispatchable && s.candidates[0] ? (
                        <button className="btn tiny primary" disabled={busy === s.id} onClick={() => send(s, s.candidates[0]!)}>
                          {runnerOf(model, s.candidates[0]) ? `▶ ${agentName(model, s.candidates[0])}` : t("copyAndSendShort")}
                        </button>
                      ) : s.status === "review" ? (
                        <button className="btn tiny" disabled={busy === s.id} onClick={() => approve(s)}>
                          {t("approve")}
                        </button>
                      ) : (
                        <span className={`pill ${s.status}`}>{t(`status_${s.status}`)}</span>
                      ),
                    ),
                  )}
                {settings.sections.active &&
                  section(t("sec_active"), active, (s) =>
                    taskLine(s, <span className={`pill ${s.status}`}>{t(`status_${s.status}`)}</span>),
                  )}
                {settings.sections.done && section(t("sec_done"), done, (s) => taskLine(s))}
              </>
            )}

            {settings.view === "lanes" && (
              <div className="mini-lanes">
                {rows.map((r) => {
                  const av = model.detail.board?.agents.find((x) => x.id === r.id);
                  const items = [
                    ...(av?.holding ?? []),
                    ...(av?.dispatchable ?? []),
                    ...tasks.filter((s) => s.status === "review" && (s.agent ?? model.task.get(s.id)?.agent) === r.id).map((s) => s.id),
                  ]
                    .filter((id, i, all) => all.indexOf(id) === i)
                    .map((id) => model.snap.get(id))
                    .filter((s): s is TaskSnapshot => Boolean(s));
                  return (
                    <div className="mini-lane" key={r.id}>
                      <div className="mini-lane-head">
                        <span className={`state-dot ${r.state}`} />
                        <strong>{r.name}</strong>
                      </div>
                      {items.length === 0 && <div className="small muted">{t("idle")}</div>}
                      {items.map((s) => (
                        <button key={s.id} className={`mini-card ${s.dispatchable ? "sendable" : s.status}`} onClick={() => open(s.id)}>
                          <span className="mono small">{s.id}</span>
                          <span className="mini-card-title">{model.task.get(s.id)?.title}</span>
                          {cardNote(model, s, t) && <span className="small muted ellipsis">{cardNote(model, s, t)}</span>}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {flash && <div className="mini-flash">{flash}</div>}
      </div>
    </I18nContext.Provider>
  );
}

/** For tests and the main window: the floating window's stored settings. */
export function miniSettings(): MiniSettings {
  return normalizeMini(readJson<Partial<MiniSettings> | null>("mini", null));
}
