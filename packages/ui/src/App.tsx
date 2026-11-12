import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Activity, type ProjectDetail, type ProjectSummary } from "./api.ts";
import { AddProjectDialog, AgentDialog, ExportDialog, PasteDialog } from "./components/Dialogs.tsx";
import { TaskDrawer } from "./components/TaskDrawer.tsx";
import { FlowView, LanesView, ListView, ReadyStrip } from "./components/Views.tsx";
import { chosenLang, I18nContext, initialLang, rememberLang, translator, type Key, type Lang } from "./i18n.ts";
import { buildModel } from "./model.ts";

type View = "lanes" | "flow" | "list";
interface Toast {
  id: number;
  text: string;
  kind: string;
}

function readPref(name: string, fallback: string): string {
  try {
    return localStorage.getItem(name) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(name: string, value: string): void {
  try {
    localStorage.setItem(name, value);
  } catch {
    // Ignore: preferences are a convenience.
  }
}

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [theme, setTheme] = useState(() => readPref("aitrack.theme", "dark"));
  const t = useMemo(() => translator(lang), [lang]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => readPref("aitrack.project", "") || null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [view, setView] = useState<View>(() => (readPref("aitrack.view", "lanes") as View) ?? "lanes");
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"add" | "paste" | "export" | "agent" | null>(null);
  const [agentToEdit, setAgentToEdit] = useState<string | undefined>(undefined);
  const [live, setLive] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = lang;
    writePref("aitrack.theme", theme);
  }, [theme, lang]);

  // A project may set its language; it applies until the user picks one with the toggle.
  const projectLang = detail?.project?.settings.language;
  useEffect(() => {
    if (projectLang && !chosenLang()) setLang(projectLang);
  }, [projectLang]);

  useEffect(() => writePref("aitrack.view", view), [view]);
  useEffect(() => writePref("aitrack.project", selected ?? ""), [selected]);

  const toast = useCallback((text: string, kind = "info") => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 5000);
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.projects();
      setProjects(list);
      if (list.length > 0 && !list.some((p) => p.key === selectedRef.current)) setSelected(list[0]!.key);
      if (list.length === 0) setSelected(null);
    } catch (e) {
      toast((e as Error).message, "failed");
    }
  }, [toast]);

  const loadDetail = useCallback(async (key: string | null) => {
    if (!key) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await api.project(key));
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void loadDetail(selected);
  }, [selected, loadDetail]);

  // Live updates: server-sent events, with a slow poll as a safety net.
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void loadProjects();
        void loadDetail(selectedRef.current);
      }, 120);
    };
    const source = new EventSource("/api/stream");
    source.addEventListener("hello", () => setLive(true));
    source.addEventListener("changed", refresh);
    source.addEventListener("activity", (msg) => {
      try {
        const a = JSON.parse((msg as MessageEvent<string>).data) as Activity;
        const key = `activity_${a.event.type}` as Key;
        if (["done", "blocked", "failed", "started", "review"].includes(a.event.type)) {
          const text = `${a.projectName ? `${a.projectName}: ` : ""}${t(key, { task: a.event.task })}`;
          toast(text, a.event.type);
          if (a.event.source !== "ui" && "Notification" in window && Notification.permission === "granted" && document.hidden) {
            new Notification("AI Tracking System", { body: text });
          }
        }
      } catch {
        // Ignore malformed activity.
      }
    });
    source.onerror = () => setLive(false);
    const poll = window.setInterval(refresh, 15000);
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
    return () => {
      source.close();
      window.clearInterval(poll);
      window.clearTimeout(timer);
    };
  }, [loadProjects, loadDetail, toast, t]);

  const model = useMemo(() => (detail ? buildModel(detail) : null), [detail]);
  const counts = detail?.board?.counts;
  const readyCount = detail?.board?.tasks.filter((x) => x.dispatchable).length ?? 0;
  const errors = detail?.issues.filter((i) => i.level === "error") ?? [];
  const warnings = detail?.issues.filter((i) => i.level === "warning") ?? [];

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
            <div className="row">
              <button
                className="btn small ghost"
                onClick={() => {
                  const next = lang === "tr" ? "en" : "tr";
                  rememberLang(next);
                  setLang(next);
                }}
              >
                {t("language")}
              </button>
              <button className="btn small ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={t("theme")}>
                {theme === "dark" ? "☀" : "☾"}
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
                          void loadProjects();
                        }
                      }}
                    >
                      {t("remove")}
                    </button>
                  </div>
                </div>
                <div className="header-row">
                  <div className="tabs" role="tablist">
                    {(["lanes", "flow", "list"] as View[]).map((v) => (
                      <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}>
                        {t(`views_${v}`)}
                      </button>
                    ))}
                  </div>
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
              {model && <ReadyStrip model={model} onOpen={setOpenTask} />}
              <div className="content">
                {model && view === "lanes" && (
                  <LanesView
                    model={model}
                    onOpen={setOpenTask}
                    onError={(m) => toast(m, "failed")}
                    onEditAgent={(agentId) => {
                      setAgentToEdit(agentId);
                      setDialog("agent");
                    }}
                  />
                )}
                {model && view === "flow" && <FlowView model={model} onOpen={setOpenTask} />}
                {model && view === "list" && <ListView model={model} onOpen={setOpenTask} />}
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
        />
      )}
      {dialog === "add" && (
        <AddProjectDialog
          onClose={() => setDialog(null)}
          onAdded={(key) => {
            setSelected(key);
            void loadProjects();
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
            void loadDetail(detail.key);
            void loadProjects();
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
