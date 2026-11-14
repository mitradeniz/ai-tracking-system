import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, desktop, type Activity, type ProjectSummary } from "./api.ts";
import { useAppearance, useApplyAppearance } from "./appearance.ts";
import { AddProjectDialog, AgentDialog, ExportDialog, PasteDialog } from "./components/Dialogs.tsx";
import { Menu, type MenuItem } from "./components/Menu.tsx";
import { NewProjectWizard, PlanWithAIDialog } from "./components/NewProject.tsx";
import { CodeFolderBanner, ProjectList, ProjectSettingsDialog, RemoveProjectDialog } from "./components/Projects.tsx";
import { AutoDispatch, RunnerDialog } from "./components/Runners.tsx";
import { SettingsDialog } from "./components/Settings.tsx";
import { TaskDrawer } from "./components/TaskDrawer.tsx";
import { PromptsDialog, TaskEditorDialog } from "./components/TaskEditor.tsx";
import { Tour } from "./components/Tour.tsx";
import { PlanEditContext, type PlanEditing } from "./editing.ts";
import { Workspace } from "./components/Workspace.tsx";
import { useTracker } from "./hooks.ts";
import { chosenLang, I18nContext, initialLang, rememberLang, translator, type Key, type Lang } from "./i18n.ts";
import { defaultLayouts, newLayout, useLayouts, type Layout } from "./layouts.ts";
import { buildModel, localError } from "./model.ts";
import { usePref } from "./prefs.ts";
import { useUpdates } from "./updates.ts";

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
  const [dialog, setDialog] = useState<
    | "add"
    | "wizard"
    | "paste"
    | "export"
    | "agent"
    | "settings"
    | "runner"
    | "task"
    | "prompts"
    | "planAI"
    | "projectSettings"
    | "removeProject"
    | null
  >(null);
  const [taskEdit, setTaskEdit] = useState<{ taskId?: string; agentId?: string }>({});
  const [promptFocus, setPromptFocus] = useState<string | undefined>(undefined);
  const [removeTarget, setRemoveTarget] = useState<ProjectSummary | null>(null);
  const [tourDone, setTourDone] = usePref<boolean>("tourDone", false);
  const [touring, setTouring] = useState(false);
  const [agentToEdit, setAgentToEdit] = useState<string | undefined>(undefined);
  const [runnerAgent, setRunnerAgent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = usePref<boolean>("sidebarCollapsed", false);

  // ⌘B / Ctrl+B hides or shows the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCollapsed]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((text: string, kind = "info") => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 5000);
  }, []);

  const onActivity = useCallback(
    (a: Activity) => {
      if (!["done", "blocked", "failed", "started", "review"].includes(a.event.type)) return;
      const what = a.event.type === "blocked" && a.event.waitingFor?.length
        ? t("activity_waiting", { task: a.event.task, tasks: a.event.waitingFor.join(", ") })
        : t(`activity_${a.event.type}` as Key, { task: a.event.task });
      const text = `${a.projectName ? `${a.projectName}: ` : ""}${what}`;
      toast(text, a.event.type);
      if (a.event.source !== "ui" && "Notification" in window && Notification.permission === "granted" && document.hidden) {
        new Notification("AI Tracking System", { body: text });
      }
    },
    [t, toast],
  );

  const { projects, loaded, detail, live, refresh, runners } = useTracker(selected, onActivity, (m) => toast(localError(m, t), "failed"));

  const updates = useUpdates((kind, p) =>
    toast(kind === "done" ? t("upd_done", { to: p.to ?? "" }) : t("upd_failed", { message: p.message ?? "" }), kind === "done" ? "done" : "failed"),
  );
  const [focusUpdates, setFocusUpdates] = useState(false);
  const openSettings = (atUpdates = false) => {
    setFocusUpdates(atUpdates);
    setDialog("settings");
  };
  useEffect(() => desktop?.updates?.onOpen(() => openSettings(true)), []);
  const updateReady = updates.info?.state === "available" || updates.progress?.state === "running";

  // The intro runs once, the first time the app opens.
  useEffect(() => {
    if (loaded && !tourDone) setTouring(true);
  }, [loaded, tourDone]);
  const endTour = (openWizard: boolean) => {
    setTouring(false);
    setTourDone(true);
    if (openWizard) setDialog("wizard");
  };

  // Keep a valid project selected. A project that was just added may not be in the list yet.
  const justAdded = useRef<{ key: string; at: number } | null>(null);
  const selectNew = (key: string) => {
    justAdded.current = { key, at: Date.now() };
    setSelected(key);
    refresh();
  };
  useEffect(() => {
    if (!loaded) return;
    const pending = justAdded.current;
    if (pending && projects.some((p) => p.key === pending.key)) justAdded.current = null;
    else if (pending && pending.key === selected && Date.now() - pending.at < 10_000) return;
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
  const planEditing: PlanEditing = useMemo(
    () => ({
      addTask: (agentId?: string) => {
        setTaskEdit({ agentId });
        setDialog("task");
      },
      editTask: (taskId: string) => {
        setTaskEdit({ taskId });
        setDialog("task");
      },
      editPrompts: (promptId?: string) => {
        setPromptFocus(promptId);
        setDialog("prompts");
      },
      planWithAI: () => setDialog("planAI"),
    }),
    [],
  );
  const current = projects.find((p) => p.key === detail?.key);
  const noTasks = Boolean(detail?.project && detail.project.tasks.length === 0);
  const projectMenu: MenuItem[] = detail
    ? [
        { label: t("pm_settings"), disabled: !detail.project, onClick: () => setDialog("projectSettings") },
        { label: t("pe_title"), disabled: !detail.project, onClick: () => planEditing.editPrompts() },
        ...(noTasks ? [{ label: t("np_planWithAi"), onClick: () => setDialog("planAI") }] : []),
        "separator",
        { label: current?.pinned ? t("pm_unpin") : t("pm_pin"), onClick: () => void api.pinProject(detail.key, !current?.pinned).then(refresh) },
        { label: t("reload"), onClick: () => void api.reload(detail.key) },
        ...(desktop ? [{ label: t("pm_showFile"), onClick: () => void desktop!.showInFolder(detail.filePath) }] : []),
        "separator",
        {
          label: t("pm_remove"),
          danger: true,
          onClick: () => {
            if (current) {
              setRemoveTarget(current);
              setDialog("removeProject");
            }
          },
        },
      ]
    : [];
  const runnerSettings = (agentId?: string) => {
    const first = agentId ?? detail?.project?.agents[0]?.id;
    if (!first) return;
    setRunnerAgent(first);
    setDialog("runner");
  };

  return (
    <I18nContext.Provider value={{ t, lang }}>
      <PlanEditContext.Provider value={detail?.project ? planEditing : null}>
      <div className={`app ${collapsed ? "collapsed" : ""}`}>
        <nav className="sidebar" aria-label={t("projects")}>
          <div className="brand">
            <img src="/favicon.svg" alt="" />
            {!collapsed && <span className="brand-name">{t("appName")}</span>}
            <button
              className="icon-btn side-toggle"
              onClick={() => setCollapsed(!collapsed)}
              aria-label={collapsed ? t("sidebar_show") : t("sidebar_hide")}
              title={`${collapsed ? t("sidebar_show") : t("sidebar_hide")} (⌘B)`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2.5" />
                <path d="M9 4v16" />
                {collapsed ? <path d="M13 10l2 2-2 2" /> : <path d="M15 10l-2 2 2 2" />}
              </svg>
            </button>
          </div>
          {!collapsed && <h2>{t("projects")}</h2>}
          <div data-tour="projects" className="project-list-wrap">
            <ProjectList
              projects={projects}
              selected={selected}
              collapsed={collapsed}
              onSelect={setSelected}
              onChanged={refresh}
              onRemove={(p) => {
                setRemoveTarget(p);
                setDialog("removeProject");
              }}
              onSettings={(key) => {
                setSelected(key);
                setDialog("projectSettings");
              }}
              onError={(m) => toast(localError(m, t), "failed")}
            />
          </div>
          <div className="sidebar-footer">
            {updateReady && (
              <button
                className="btn update-pill"
                onClick={() => openSettings(true)}
                title={updates.progress?.state === "running" ? t("upd_running") : t("upd_available", { n: updates.info?.behind ?? 0 })}
              >
                <span aria-hidden="true">↑</span>
                {!collapsed && (updates.progress?.state === "running" ? t("upd_running") : t("upd_availableShort"))}
              </button>
            )}
            <div className={collapsed ? "stack-tight" : "row new-row"} data-tour="new-project">
              <button className="btn primary grow-btn" onClick={() => setDialog("wizard")} title={t("newProject")} aria-label={t("newProject")}>
                +{collapsed ? "" : ` ${t("newProject")}`}
              </button>
              <button className="btn" onClick={() => setDialog("add")} title={t("openFile")} aria-label={t("openFile")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
              </button>
            </div>
            <button className="btn" onClick={openFloating} title={t("floatingHint")} aria-label={t("floating")} data-tour="floating">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <rect x="12" y="11" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />
              </svg>
              {!collapsed && t("floating")}
            </button>
            <div className={collapsed ? "stack-tight" : "row"}>
              <button className="btn small ghost" onClick={() => chooseLang(lang === "tr" ? "en" : "tr")} title={t("language")}>
                {collapsed ? (lang === "tr" ? "EN" : "TR") : t("language")}
              </button>
              {!collapsed && <span className="spacer" />}
              <button
                className="btn small ghost"
                onClick={() => openSettings(false)}
                aria-label={t("settings")}
                title={t("settings")}
                data-tour="settings"
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
            <div className="empty welcome">
              <img src="/favicon.svg" alt="" width={44} height={44} />
              <h2>{t("welcome_title")}</h2>
              <p>{t("welcome_text")}</p>
              <div className="row wrap center">
                <button className="btn primary" onClick={() => setDialog("wizard")}>
                  + {t("newProject")}
                </button>
                <button className="btn" onClick={() => setDialog("add")}>
                  {t("openFile")}
                </button>
              </div>
              <button className="btn ghost small" onClick={() => setTouring(true)}>
                {t("tour_replay")}
              </button>
            </div>
          ) : (
            <>
              <header className="header">
                <div className="header-row">
                  <h1>{detail.name}</h1>
                  {counts && (
                    <div className="counts" data-tour="counts">
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
                    {model && (
                      <AutoDispatch
                        model={model}
                        onSetup={() => runnerSettings()}
                        onError={(m) => toast(localError(m, t), "failed")}
                        onInfo={(m) => toast(m, "done")}
                      />
                    )}
                    <button className="btn small" onClick={() => setDialog("paste")}>
                      {t("pasteReport")}
                    </button>
                    <button className="btn small" onClick={() => setDialog("export")} disabled={!detail.project}>
                      {t("export")}
                    </button>
                    <Menu label={t("pm_menu", { name: detail.name })} items={projectMenu} className="btn small ghost">
                      ⋯
                    </Menu>
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
                  {detail.project && !editing && (
                    <div className="row plan-actions" data-tour="plan">
                      <button className="btn small" onClick={() => planEditing.addTask()}>
                        + {t("te_addShort")}
                      </button>
                      <button className="btn small ghost" onClick={() => planEditing.editPrompts()}>
                        {t("pe_short")}
                      </button>
                    </div>
                  )}
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
              <div className="content" data-tour="board">
                {model && (
                  <CodeFolderBanner
                    model={model}
                    onDone={(m) => {
                      toast(m, "done");
                      refresh();
                    }}
                    onError={(m) => toast(localError(m, t), "failed")}
                  />
                )}
                {model && noTasks && (
                  <div className="empty-plan">
                    <div>
                      <h3>{t("ep_title")}</h3>
                      <p className="small muted">{model.detail.project!.agents.length ? t("ep_text") : t("ep_textNoChats")}</p>
                    </div>
                    <div className="row wrap">
                      <button className="btn primary" onClick={() => setDialog("planAI")}>
                        ✦ {t("np_planWithAi")}
                      </button>
                      {model.detail.project!.agents.length > 0 ? (
                        <button className="btn" onClick={() => planEditing.addTask()}>
                          + {t("te_add")}
                        </button>
                      ) : (
                        <button className="btn" onClick={() => editAgent()}>
                          + {t("addAgent")}
                        </button>
                      )}
                      <button className="btn ghost" onClick={() => planEditing.editPrompts()}>
                        {t("pe_title")}
                      </button>
                    </div>
                  </div>
                )}
                {model && (
                  <Workspace
                    model={model}
                    layout={layout}
                    editing={editing}
                    onChange={saveLayout}
                    onOpen={setOpenTask}
                    onError={(m) => toast(localError(m, t), "failed")}
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
          onError={(m) => toast(localError(m, t), "failed")}
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
          onAdded={selectNew}
          onNew={() => setDialog("wizard")}
        />
      )}
      {dialog === "wizard" && (
        <NewProjectWizard
          onClose={() => setDialog(null)}
          onOpenFile={() => setDialog("add")}
          onCreated={(key, message) => {
            selectNew(key);
            toast(message, "done");
          }}
        />
      )}
      {dialog === "task" && model && (
        <TaskEditorDialog
          key={taskEdit.taskId ?? `new-${taskEdit.agentId ?? ""}`}
          model={model}
          taskId={taskEdit.taskId}
          agentId={taskEdit.agentId}
          onClose={() => setDialog(null)}
          onDone={(message, open) => {
            toast(message, "done");
            refresh();
            if (open) setOpenTask(open);
          }}
        />
      )}
      {dialog === "prompts" && model && (
        <PromptsDialog
          model={model}
          promptId={promptFocus}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            toast(message, "done");
            refresh();
          }}
        />
      )}
      {dialog === "planAI" && model && (
        <PlanWithAIDialog
          model={model}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            toast(message, "done");
            refresh();
          }}
        />
      )}
      {dialog === "projectSettings" && model && (
        <ProjectSettingsDialog
          model={model}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            toast(message, "done");
            refresh();
          }}
        />
      )}
      {dialog === "removeProject" && removeTarget && (
        <RemoveProjectDialog
          project={removeTarget}
          onClose={() => setDialog(null)}
          onRemoved={(message) => {
            toast(message, "done");
            if (removeTarget.key === selected) setSelected(null);
            setRemoveTarget(null);
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
          updates={updates.supported ? updates : undefined}
          focusUpdates={focusUpdates}
          onTour={() => {
            setDialog(null);
            setTouring(true);
          }}
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
      {touring && (
        <Tour
          onClose={() => endTour(false)}
          onFinish={() => endTour(projects.length === 0)}
          finishLabel={projects.length === 0 ? t("tour_finishNew") : t("tour_finish")}
        />
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind}`}>
            {x.text}
          </div>
        ))}
      </div>
      </PlanEditContext.Provider>
    </I18nContext.Provider>
  );
}
