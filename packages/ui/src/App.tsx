import { useCallback, useEffect, useMemo, useState } from "react";
import { api, desktop, type Activity } from "./api.ts";
import { useAppearance, useApplyAppearance } from "./appearance.ts";
import { AddProjectDialog, AgentDialog, ExportDialog, PasteDialog } from "./components/Dialogs.tsx";
import { AutoDispatch, RunnerDialog } from "./components/Runners.tsx";
import { SettingsDialog } from "./components/Settings.tsx";
import { TaskDrawer } from "./components/TaskDrawer.tsx";
import { Workspace } from "./components/Workspace.tsx";
import { useTracker } from "./hooks.ts";
import { chosenLang, I18nContext, initialLang, rememberLang, translator, type Key, type Lang } from "./i18n.ts";
import { defaultLayouts, newLayout, useLayouts, type Layout } from "./layouts.ts";
import { buildModel } from "./model.ts";
import { usePref } from "./prefs.ts";

interface Toast {
  id: number;
  text: string;
  kind: string;
}

/** Opens the floating window: a native always-on-top window in the desktop app, a popup in a browser. */
export function openFloating(): void {
  if (desktop?.openMini) {
    void desktop.openMini();
    return;
  }
  window.open("/?mini=1", "aitrack-mini", "popup,width=380,height=620");
}

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = useMemo(() => translator(lang), [lang]);
  const [appearance, setAppearance] = useAppearance();
  useApplyAppearance(appearance);
  const [selected, setSelected] = usePref<string | null>("selectedProject", null);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"add" | "paste" | "export" | "agent" | "settings" | "runner" | null>(null);
  const [agentToEdit, setAgentToEdit] = useState<string | undefined>(undefined);
  const [runnerAgent, setRunnerAgent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((text: string, kind = "info") => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 5000);
  }, []);

  const onActivity = useCallback(
    (a: Activity) => {
      if (!["done", "blocked", "failed", "started", "review"].includes(a.event.type)) return;
      const text = `${a.projectName ? `${a.projectName}: ` : ""}${t(`activity_${a.event.type}` as Key, { task: a.event.task })}`;
      toast(text, a.event.type);
      if (a.event.source !== "ui" && "Notification" in window && Notification.permission === "granted" && document.hidden) {
        new Notification("AI Tracking System", { body: text });
      }
    },
    [t, toast],
  );

  const { projects, loaded, detail, live, refresh, runners } = useTracker(selected, onActivity, (m) => toast(m, "failed"));

  // Keep a valid project selected.
  useEffect(() => {
    if (!loaded) return;
    if (projects.length === 0) {
      if (selected !== null) setSelected(null);
    } else if (!projects.some((p) => p.key === selected)) {
      setSelected(projects[0]!.key);
    }
  }, [loaded, projects, selected, setSelected]);

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // A project may set its language; it applies until the user picks one.
  const projectLang = detail?.project?.settings.language;
  useEffect(() => {
    if (projectLang && !chosenLang()) setLang(projectLang);
  }, [projectLang]);

  const chooseLang = (next: Lang) => {
    rememberLang(next);
    setLang(next);
  };

  // The floating window asks the main window to show a task.
  useEffect(
    () =>
      desktop?.onOpenTask?.((projectKey, taskId) => {
        if (projectKey) setSelected(projectKey);
        if (taskId) setOpenTask(taskId);
      }),
    [setSelected],
  );

  const [layouts, setLayouts] = useLayouts(defaultLayouts);
  const [activeLayout, setActiveLayout] = usePref<string>("activeLayout", "lanes");
  const layout = layouts.find((l) => l.id === activeLayout) ?? layouts[0]!;
  const layoutName = (l: Layout) => l.name || (["lanes", "overview", "flow", "list"].includes(l.id) ? t(`layout_${l.id}` as Key) : l.id);
  const saveLayout = (next: Layout) => setLayouts((all) => all.map((l) => (l.id === next.id ? next : l)));

  const model = useMemo(
    () => (detail ? buildModel(detail, runners && detail.key === selected ? runners : null) : null),
    [detail, runners, selected],
  );
  const counts = detail?.board?.counts;
  const readyCount = detail?.board?.tasks.filter((x) => x.dispatchable).length ?? 0;
  const errors = detail?.issues.filter((i) => i.level === "error") ?? [];
  const warnings = detail?.issues.filter((i) => i.level === "warning") ?? [];
  const editAgent = (agentId?: string) => {
    setAgentToEdit(agentId);
    setDialog("agent");
  };
  const runnerSettings = (agentId?: string) => {
    const first = agentId ?? detail?.project?.agents[0]?.id;
    if (!first) return;
    setRunnerAgent(first);
    setDialog("runner");
  };

  return (
    <I18nContext.Provider value={{ t, lang }}>
      <div className="app">
        <nav className="sidebar" aria-label={t("projects")}>
          <div className="brand">
            <img src="/favicon.svg" alt="" />
            {t("appName")}
          </div>
          <h2>{t("projects")}</h2>
          <ul className="project-list">
            {projects.map((p) => {
              const done = p.counts ? p.counts.done : 0;
              const total = p.counts ? p.counts.total : 0;
              return (
                <li key={p.key}>
                  <button aria-current={p.key === selected} onClick={() => setSelected(p.key)} title={p.filePath}>
                    <span>{p.name}</span>
                    <span className="small muted">
                      {p.ok ? `${done}/${total}` : `⚠ ${p.errors}`}
                      {p.counts && p.counts.ready > 0 ? ` · ${p.counts.ready} ${t("count_ready").toLowerCase()}` : ""}
                    </span>
                    <span className="progress-line">
                      <span style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="sidebar-footer">
            <button className="btn primary" onClick={() => setDialog("add")}>
              + {t("addProject")}
            </button>
            <button className="btn" onClick={openFloating} title={t("floatingHint")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <rect x="12" y="11" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />
              </svg>
              {t("floating")}
            </button>
            <div className="row">
              <button className="btn small ghost" onClick={() => chooseLang(lang === "tr" ? "en" : "tr")}>
                {t("language")}
              </button>
              <span className="spacer" />
              <button
                className="btn small ghost"
                onClick={() => setDialog("settings")}
                aria-label={t("appearance")}
                title={t("appearance")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
                </svg>
              </button>
            </div>
          </div>
        </nav>

        <main className="main">
          {!detail ? (
            <div className="empty">
              <p>{t("noProjects")}</p>
              <button className="btn primary" onClick={() => setDialog("add")}>
                + {t("addProject")}
              </button>
            </div>
          ) : (
            <>
              <header className="header">
                <div className="header-row">
                  <h1>{detail.name}</h1>
                  {counts && (
                    <div className="counts">
                      <span className="count ready">
                        {t("count_ready")} <b>{readyCount}</b>
                      </span>
                      <span className="count active">
                        {t("count_active")} <b>{counts.dispatched + counts.in_progress}</b>
                      </span>
                      <span className="count blocked">
                        {t("count_blocked")} <b>{counts.blocked + counts.failed}</b>
                      </span>
                      {counts.review > 0 && (
                        <span className="count review">
                          {t("count_review")} <b>{counts.review}</b>
                        </span>
                      )}
                      <span className="count">
                        {t("count_waiting")} <b>{counts.waiting + counts.ready - readyCount}</b>
                      </span>
                      <span className="count">
                        {t("count_done")}{" "}
                        <b>
                          {counts.done}/{counts.total}
                        </b>
                      </span>
                    </div>
                  )}
                  <span className="spacer" />
                  <div className="header-actions">
                    {model && <AutoDispatch model={model} onSetup={() => runnerSettings()} onError={(m) => toast(m, "failed")} />}
                    <button className="btn small" onClick={() => setDialog("paste")}>
                      {t("pasteReport")}
                    </button>
                    <button className="btn small" onClick={() => setDialog("export")} disabled={!detail.project}>
                      {t("export")}
                    </button>
                    <button className="btn small ghost" onClick={() => void api.reload(detail.key)}>
                      {t("reload")}
                    </button>
                    <button
                      className="btn small ghost danger"
                      onClick={async () => {
                        if (window.confirm(t("removeConfirm"))) {
                          await api.removeProject(detail.key);
                          setSelected(null);
                          refresh();
                        }
                      }}
                    >
                      {t("remove")}
                    </button>
                  </div>
                </div>
                <div className="header-row">
                  <div className="tabs" role="tablist">
                    {layouts.map((l) =>
                      editing && l.id === layout.id ? (
                        <input
                          key={l.id}
                          className="input tab-name"
                          value={l.name || layoutName(l)}
                          aria-label={t("layoutName")}
                          onChange={(e) => saveLayout({ ...l, name: e.target.value })}
                        />
                      ) : (
                        <button key={l.id} role="tab" aria-selected={l.id === layout.id} onClick={() => setActiveLayout(l.id)}>
                          {layoutName(l)}
                        </button>
                      ),
                    )}
                    {editing && (
                      <button
                        className="tab-add"
                        title={t("newLayout")}
                        aria-label={t("newLayout")}
                        onClick={() => {
                          const l = newLayout(t("newLayoutName"));
                          setLayouts((all) => [...all, l]);
                          setActiveLayout(l.id);
                        }}
                      >
                        +
                      </button>
                    )}
                  </div>
                  {editing && layouts.length > 1 && (
                    <button
                      className="btn small ghost danger"
                      onClick={() => {
                        const rest = layouts.filter((l) => l.id !== layout.id);
                        setLayouts(rest);
                        setActiveLayout(rest[0]!.id);
                      }}
                    >
                      {t("deleteLayout")}
                    </button>
                  )}
                  <button className={`btn small ${editing ? "primary" : ""}`} onClick={() => setEditing(!editing)}>
                    {editing ? (
                      t("doneEditing")
                    ) : (
                      <>
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden="true"
                        >
                          <rect x="3" y="3" width="7" height="9" rx="1.5" />
                          <rect x="14" y="3" width="7" height="5" rx="1.5" />
                          <rect x="14" y="12" width="7" height="9" rx="1.5" />
                          <rect x="3" y="16" width="7" height="5" rx="1.5" />
                        </svg>
                        {t("editScreen")}
                      </>
                    )}
                  </button>
                  <span className="spacer" />
                  <div className="serverline">
                    <span>
                      <span className={`dot ${live ? "" : "off"}`} />
                      {live ? t("live") : t("offline")}
                    </span>
                    <span title={detail.inboxDirs.join("\n")}>
                      {t("reportsTo")} <span className="mono">{detail.serverUrl}/api/report</span> · {detail.inboxDirs.length}{" "}
                      {detail.inboxDirs.length === 1 ? t("inbox") : t("inboxes")}
                    </span>
                    <span className="mono" title={detail.filePath}>
                      {detail.filePath.split(/[\\/]/).slice(-2).join("/")}
                    </span>
                  </div>
                </div>
                {(errors.length > 0 || warnings.length > 0) && (
                  <div className="issues">
                    <strong>{t("issues")}</strong>
                    <ul>
                      {[...errors, ...warnings].slice(0, 8).map((i, n) => (
                        <li key={n}>
                          {i.level === "error" ? "⛔" : "⚠"} {i.message} {i.path && <span className="mono muted">({i.path})</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </header>
              <div className="content">
                {model && (
                  <Workspace
                    model={model}
                    layout={layout}
                    editing={editing}
                    onChange={saveLayout}
                    onOpen={setOpenTask}
                    onError={(m) => toast(m, "failed")}
                    onInfo={(m) => toast(m, "done")}
                    onEditAgent={editAgent}
                    onRunnerSettings={runnerSettings}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {model && openTask && model.task.has(openTask) && (
        <TaskDrawer
          model={model}
          taskId={openTask}
          onClose={() => setOpenTask(null)}
          onOpen={setOpenTask}
          onError={(m) => toast(m, "failed")}
          onInfo={(m) => toast(m, "done")}
          onRunnerSettings={runnerSettings}
        />
      )}
      {dialog === "runner" && model && runnerAgent && model.agent.has(runnerAgent) && (
        <RunnerDialog
          key={runnerAgent}
          model={model}
          agentId={runnerAgent}
          onSwitch={setRunnerAgent}
          onClose={() => setDialog(null)}
          onSaved={(message) => {
            toast(message, "done");
            refresh();
          }}
        />
      )}
      {dialog === "add" && (
        <AddProjectDialog
          onClose={() => setDialog(null)}
          onAdded={(key) => {
            setSelected(key);
            refresh();
          }}
        />
      )}
      {dialog === "agent" && detail?.project && (
        <AgentDialog
          key={agentToEdit ?? "new"}
          projectKey={detail.key}
          project={detail.project}
          agentId={agentToEdit}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            toast(message, "done");
            refresh();
          }}
        />
      )}
      {dialog === "settings" && (
        <SettingsDialog
          appearance={appearance}
          onAppearance={setAppearance}
          lang={lang}
          onLang={chooseLang}
          onResetLayouts={() => {
            setLayouts(defaultLayouts());
            setActiveLayout("lanes");
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "paste" && detail && <PasteDialog projectKey={detail.key} onClose={() => setDialog(null)} />}
      {dialog === "export" && detail?.project && (
        <ExportDialog
          projectKey={detail.key}
          projectId={detail.project.project.id}
          filePath={detail.filePath}
          onClose={() => setDialog(null)}
        />
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind}`}>
            {x.text}
          </div>
        ))}
      </div>
    </I18nContext.Provider>
  );
}
