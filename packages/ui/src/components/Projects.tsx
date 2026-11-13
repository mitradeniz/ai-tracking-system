import { useState } from "react";
import { api, desktop, type ProjectSummary } from "../api.ts";
import { useI18n } from "../i18n.ts";
import type { Model } from "../model.ts";
import { Dialog } from "./Dialogs.tsx";
import { InfoTip } from "./Info.tsx";
import { Menu, type MenuItem } from "./Menu.tsx";
import { Segmented } from "./Settings.tsx";

/** True when a chat runs itself in the project's code folder (it has no folder of its own). */
function usesCodeFolder(model: Model): boolean {
  return Object.values(model.runners?.settings.chats ?? {}).some((c) => !c.workdir);
}

/**
 * Shown above the board when the plan's code folder (settings.repoPath) is not on this computer:
 * create it, pick another folder, or use the repository the plan is in.
 */
export function CodeFolderBanner({
  model,
  onDone,
  onError,
}: {
  model: Model;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const runners = model.runners;
  if (!runners || runners.defaultWorkdirExists !== false || !usesCodeFolder(model)) return null;
  const key = model.detail.key;
  const act = async (work: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const message = await work();
      if (message) onDone(message);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const planFolder = runners.planFolder;
  return (
    <div className="code-folder" role="status">
      <div>
        <strong>{t("cf_title")}</strong>
        <p className="small">{t("cf_text", { path: runners.defaultWorkdir })}</p>
      </div>
      <div className="row wrap">
        <button
          className="btn small primary"
          disabled={busy}
          title={t("cf_createHint")}
          onClick={() =>
            void act(async () => {
              const res = await api.createCodeFolder(key);
              return t(res.git ? "cf_createdGit" : "cf_created", { path: res.path });
            })
          }
        >
          {t("cf_create")}
        </button>
        {desktop?.chooseFolder && (
          <button
            className="btn small"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const picked = await desktop!.chooseFolder!(planFolder);
                if (!picked) return null;
                await api.saveInfo(key, { repoPath: picked });
                return t("cf_saved", { path: picked });
              })
            }
          >
            {t("cf_choose")}
          </button>
        )}
        {planFolder && planFolder !== runners.defaultWorkdir && (
          <button
            className="btn small ghost"
            disabled={busy}
            title={planFolder}
            onClick={() =>
              void act(async () => {
                await api.saveInfo(key, { repoPath: null });
                return t("cf_saved", { path: planFolder });
              })
            }
          >
            {t("cf_usePlan")}
          </button>
        )}
      </div>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /\w/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** The sidebar's project list: pinned first, drag to reorder, a ⋯ menu per project. */
export function ProjectList({
  projects,
  selected,
  collapsed,
  onSelect,
  onChanged,
  onRemove,
  onSettings,
  onError,
}: {
  projects: ProjectSummary[];
  selected: string | null;
  collapsed: boolean;
  onSelect: (key: string) => void;
  onChanged: () => void;
  onRemove: (project: ProjectSummary) => void;
  onSettings: (key: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const order = async (keys: string[]) => {
    try {
      await api.orderProjects(keys);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const keys = projects.map((p) => p.key);
  /** Moves a project by one place within its group (pinned or not). */
  const shift = (key: string, by: -1 | 1) => {
    const i = keys.indexOf(key);
    const j = i + by;
    if (j < 0 || j >= keys.length || projects[j]!.pinned !== projects[i]!.pinned) return;
    const next = [...keys];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void order(next);
  };
  const dropOn = (target: string) => {
    if (!dragging || dragging === target) return;
    const from = projects.find((p) => p.key === dragging)!;
    const to = projects.find((p) => p.key === target)!;
    const next = keys.filter((k) => k !== dragging);
    next.splice(next.indexOf(target) + (keys.indexOf(dragging) < keys.indexOf(target) ? 1 : 0), 0, dragging);
    // Dropping into the other group pins or unpins it.
    if (from.pinned !== to.pinned) {
      void api
        .pinProject(dragging, to.pinned)
        .then(() => order(next))
        .catch((e) => onError((e as Error).message));
    } else void order(next);
  };

  return (
    <ul className="project-list">
      {projects.map((p, i) => {
        const done = p.counts ? p.counts.done : 0;
        const total = p.counts ? p.counts.total : 0;
        const pct = total ? (done / total) * 100 : 0;
        const firstUnpinned = !p.pinned && i > 0 && projects[i - 1]!.pinned;
        const items: MenuItem[] = [
          { label: p.pinned ? t("pm_unpin") : t("pm_pin"), onClick: () => void api.pinProject(p.key, !p.pinned).then(onChanged, (e) => onError((e as Error).message)) },
          { label: t("pm_up"), disabled: i === 0 || projects[i - 1]!.pinned !== p.pinned, onClick: () => shift(p.key, -1) },
          { label: t("pm_down"), disabled: i === projects.length - 1 || projects[i + 1]!.pinned !== p.pinned, onClick: () => shift(p.key, 1) },
          "separator",
          { label: t("pm_settings"), disabled: !p.ok, onClick: () => onSettings(p.key) },
          ...(desktop ? [{ label: t("pm_showFile"), onClick: () => void desktop!.showInFolder(p.filePath) }] : []),
          "separator",
          { label: t("pm_remove"), danger: true, onClick: () => onRemove(p) },
        ];
        return (
          <li
            key={p.key}
            className={`${dragging === p.key ? "dragging" : ""} ${over === p.key && dragging && dragging !== p.key ? "drop-target" : ""} ${firstUnpinned ? "group-start" : ""}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              setDragging(p.key);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              setOver(p.key);
            }}
            onDrop={(e) => {
              e.preventDefault();
              dropOn(p.key);
              setDragging(null);
              setOver(null);
            }}
          >
            <button
              className="project-item"
              aria-current={p.key === selected}
              onClick={() => onSelect(p.key)}
              title={collapsed ? `${p.name} · ${done}/${total}` : p.filePath}
              aria-label={collapsed ? p.name : undefined}
            >
              {collapsed ? (
                <span className="avatar" style={{ ["--pct" as string]: `${pct}%` }}>
                  {initials(p.name)}
                  {p.counts && p.counts.ready > 0 && <span className="avatar-dot" aria-hidden="true" />}
                  {p.pinned && <span className="avatar-pin" aria-hidden="true" />}
                </span>
              ) : (
                <>
                  <span className="project-name">
                    {p.pinned && (
                      <svg className="pin-icon" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-label={t("pm_pinned")}>
                        <path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z" />
                      </svg>
                    )}
                    <span className="ellipsis">{p.name}</span>
                  </span>
                  <span className="small muted">
                    {p.ok ? (total ? `${done}/${total}` : t("pm_noTasks")) : `⚠ ${p.errors}`}
                    {p.counts && p.counts.ready > 0 ? ` · ${p.counts.ready} ${t("count_ready").toLowerCase()}` : ""}
                  </span>
                  <span className="progress-line">
                    <span style={{ width: `${pct}%` }} />
                  </span>
                </>
              )}
            </button>
            {!collapsed && (
              <span className="project-menu">
                <Menu label={t("pm_menu", { name: p.name })} items={items} className="icon-btn">
                  ⋯
                </Menu>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Removing a project: from the list only, or with its file moved to the Trash. */
export function RemoveProjectDialog({
  project,
  onClose,
  onRemoved,
}: {
  project: ProjectSummary;
  onClose: () => void;
  onRemoved: (message: string) => void;
}) {
  const { t } = useI18n();
  const canTrash = Boolean(desktop?.trashProject) && project.filePath.endsWith(".aitrack");
  const [trash, setTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (trash && canTrash) {
        const res = await desktop!.trashProject!(project.key);
        if (!res.ok) throw new Error(res.error ?? "failed");
      } else {
        await api.removeProject(project.key);
      }
      onRemoved(t(trash ? "pm_trashed" : "pm_removed", { name: project.name }));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("pm_removeTitle", { name: project.name })} onClose={onClose}>
      <div className="radio-list" role="radiogroup">
        <label className={`radio-card ${!trash ? "on" : ""}`}>
          <input type="radio" checked={!trash} onChange={() => setTrash(false)} />
          <span>
            <strong>{t("pm_removeList")}</strong>
            <span className="small muted">{t("pm_removeListHint")}</span>
          </span>
        </label>
        {canTrash && (
          <label className={`radio-card ${trash ? "on danger" : ""}`}>
            <input type="radio" checked={trash} onChange={() => setTrash(true)} />
            <span>
              <strong>{t("pm_trash")}</strong>
              <span className="small muted">{t("pm_trashHint")}</span>
            </span>
          </label>
        )}
      </div>
      <div className="small muted mono ellipsis" title={project.filePath}>
        {project.filePath}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t("cancel")}
        </button>
        <button className={`btn ${trash ? "danger-solid" : "primary"}`} disabled={busy} onClick={() => void run()}>
          {trash ? t("pm_trash") : t("pm_removeList")}
        </button>
      </div>
    </Dialog>
  );
}

/** Name, description, prompt language and approval of a project. */
export function ProjectSettingsDialog({ model, onClose, onDone }: { model: Model; onClose: () => void; onDone: (message: string) => void }) {
  const { t } = useI18n();
  const project = model.detail.project!;
  const [name, setName] = useState(project.project.name);
  const [description, setDescription] = useState(project.project.description ?? "");
  const [language, setLanguage] = useState<"en" | "tr" | "none">(project.settings.language ?? "none");
  const [approval, setApproval] = useState(project.settings.requireApproval);
  const savedRepoPath = project.settings.repoPath ?? "";
  const [repoPath, setRepoPath] = useState(savedRepoPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveInfo(model.detail.key, {
        name,
        description,
        language: language === "none" ? null : language,
        requireApproval: approval,
        ...(repoPath.trim() !== savedRepoPath ? { repoPath: repoPath.trim() || null } : {}),
      });
      onDone(t("ps_saved"));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("pm_settings")} onClose={onClose}>
      <div className="field">
        <label htmlFor="ps-name">{t("projectName")}</label>
        <input id="ps-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ps-desc">{t("te_description")}</label>
        <textarea id="ps-desc" className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label>
          {t("np_language")} <InfoTip text={t("np_languageHint")} />
        </label>
        <Segmented
          value={language}
          label={t("np_language")}
          options={[
            { value: "none", label: t("ps_langAny") },
            { value: "en", label: "English" },
            { value: "tr", label: "Türkçe" },
          ]}
          onChange={setLanguage}
        />
      </div>
      <div className="field">
        <label htmlFor="ps-code">
          {t("ps_code")} <InfoTip text={t("ps_codeHint")} />
        </label>
        <div className="row">
          <input
            id="ps-code"
            className="input mono"
            value={repoPath}
            placeholder={model.runners?.planFolder ?? ""}
            onChange={(e) => setRepoPath(e.target.value)}
          />
          {desktop?.chooseFolder && (
            <button
              className="btn"
              onClick={async () => {
                const picked = await desktop!.chooseFolder!(model.runners?.defaultWorkdir || model.runners?.planFolder || undefined);
                if (picked) setRepoPath(picked);
              }}
            >
              {t("browse")}
            </button>
          )}
        </div>
        {model.runners && repoPath.trim() === savedRepoPath && (
          <span className={`small ${model.runners.defaultWorkdirExists === false ? "warn-text" : "muted"}`}>
            {model.runners.defaultWorkdirExists === false ? `${t("ps_codeMissing")} ` : ""}
            {t("ps_codeNow", { path: model.runners.defaultWorkdir })}
          </span>
        )}
      </div>
      <label className="check wide-check">
        <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
        {t("ps_approval")}
        <InfoTip text={t("ps_approvalHint")} />
      </label>
      <div className="small muted">
        {t("ps_file")} <span className="mono">{model.detail.filePath}</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t("cancel")}
        </button>
        <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>
          {t("save")}
        </button>
      </div>
    </Dialog>
  );
}

