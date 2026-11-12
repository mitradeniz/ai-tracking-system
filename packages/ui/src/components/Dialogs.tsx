import type { ProjectFile } from "@aitrack/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, desktop } from "../api.ts";
import { useI18n } from "../i18n.ts";
import { agentIdFromName, helpedChats, sharedBootstrapPrompts } from "../model.ts";

/** Closes a dialog with Escape. */
export function useEscape(onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2>{title}</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function AddProjectDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (key: string) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"open" | "new">("open");
  const [path, setPath] = useState("");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<{ key: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      onAdded(res.key);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const picked = mode === "open" ? await desktop?.openProjectDialog() : await desktop?.newProjectDialog();
    if (picked) setPath(picked);
  };

  return (
    <Dialog title={t("addProject")} onClose={onClose}>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === "open"} onClick={() => setMode("open")}>
          {t("openFile")}
        </button>
        <button role="tab" aria-selected={mode === "new"} onClick={() => setMode("new")}>
          {t("newProject")}
        </button>
      </div>
      <div className="field">
        <label htmlFor="path">{t("filePath")}</label>
        <div className="row">
          <input
            id="path"
            className="input mono"
            value={path}
            placeholder="/Users/me/projects/app/app.aitrack"
            onChange={(e) => setPath(e.target.value)}
          />
          {desktop && (
            <button className="btn" onClick={browse}>
              {t("browse")}
            </button>
          )}
        </div>
      </div>
      {mode === "new" && (
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="pid">{t("projectId")}</label>
            <input id="pid" className="input mono" value={id} placeholder="my-app" onChange={(e) => setId(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label htmlFor="pname">{t("projectName")}</label>
            <input id="pname" className="input" value={name} placeholder="My App" onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
      )}
      <div className="small muted">{t("howToAuthor")}</div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t("cancel")}
        </button>
        {mode === "open" ? (
          <button className="btn primary" disabled={busy || !path.trim()} onClick={() => run(() => api.addProject(path.trim()))}>
            {t("add")}
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={busy || !path.trim() || !id.trim() || !name.trim()}
            onClick={() => run(() => api.createProject(path.trim(), id.trim(), name.trim()))}
          >
            {t("create")}
          </button>
        )}
      </div>
    </Dialog>
  );
}

export function PasteDialog({ projectKey, onClose }: { projectKey: string; onClose: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ recorded: number; errors: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.paste(projectKey, text);
      setResult(res);
      if (res.errors.length === 0) window.setTimeout(onClose, 700);
    } catch (e) {
      setResult({ recorded: 0, errors: [(e as Error).message] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("pasteReport")} onClose={onClose}>
      <div className="small muted">{t("pasteHint")}</div>
      <textarea className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label={t("pasteReport")} />
      {result && (
        <div className={result.errors.length ? "error" : "small"}>
          {t("recordedN", { n: result.recorded })}
          {result.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}
      <div className="row">
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t("cancel")}
        </button>
        <button className="btn primary" disabled={busy || !text.trim()} onClick={submit}>
          {t("record")}
        </button>
      </div>
    </Dialog>
  );
}

export function ExportDialog({
  projectKey,
  projectId,
  filePath,
  onClose,
}: {
  projectKey: string;
  projectId: string;
  filePath: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState(filePath);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (includeState: boolean) => {
    setError(null);
    try {
      let path = target.trim();
      if (desktop) {
        const picked = await desktop.saveProjectDialog(path || `${projectId}.aitrack`);
        if (!picked) return;
        path = picked;
      }
      const res = await api.exportTo(projectKey, path, includeState);
      setDone(res.filePath);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog title={t("export")} onClose={onClose}>
      {!desktop && (
        <div className="field">
          <label htmlFor="exp">{t("filePath")}</label>
          <input id="exp" className="input mono" value={target} onChange={(e) => setTarget(e.target.value)} />
        </div>
      )}
      <div className="actions">
        <button className="btn primary" onClick={() => save(true)}>
          {t("exportWithState")}
        </button>
        <button className="btn" onClick={() => save(false)}>
          {t("exportDefinition")}
        </button>
        {!desktop && (
          <a className="btn ghost" href={api.exportUrl(projectKey, true)} download>
            ⤓ .aitrack
          </a>
        )}
      </div>
      {done && (
        <div className="small">
          {t("exported")} <span className="mono">{done}</span>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}

const TOOLS = ["claude", "codex", "cursor"];

/** A prompt's title without a leading copy of its id ("P00 — Shared context" -> "Shared context"). */
function promptLabel(id: string, title: string | undefined): string {
  if (!title) return "";
  return title.startsWith(id) ? title.slice(id.length).replace(/^[\s—–:-]+/, "") : title;
}

export function AgentDialog({
  projectKey,
  project,
  agentId,
  onClose,
  onDone,
}: {
  projectKey: string;
  project: Omit<ProjectFile, "state">;
  agentId?: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useI18n();
  const existing = agentId ? project.agents.find((a) => a.id === agentId) : undefined;
  const others = project.agents.filter((a) => a.id !== agentId);
  const [name, setName] = useState(existing?.name ?? "");
  const [id, setId] = useState(existing?.id ?? "");
  const [idTouched, setIdTouched] = useState(Boolean(existing));
  const initialTool = existing?.tool ?? "codex";
  const [toolChoice, setToolChoice] = useState(TOOLS.includes(initialTool) ? initialTool : "other");
  const [toolOther, setToolOther] = useState(TOOLS.includes(initialTool) ? "" : initialTool);
  const [role, setRole] = useState(existing?.role ?? "");
  const [maxParallel, setMaxParallel] = useState(existing?.maxParallel ?? 1);
  const [helps, setHelps] = useState<Set<string>>(() => new Set(existing ? helpedChats(project.tasks, existing.id) : []));
  const [prompts, setPrompts] = useState<Set<string>>(
    () => new Set(existing ? existing.bootstrapPrompts : sharedBootstrapPrompts(project.agents)),
  );
  const [removing, setRemoving] = useState(false);
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveId = idTouched
    ? id
    : agentIdFromName(
        name,
        others.map((a) => a.id),
      );
  const ownedTasks = existing ? project.tasks.filter((x) => x.agent === existing.id).length : 0;
  const promptIds = Object.keys(project.prompts);

  const toggle = (set: Set<string>, value: string, update: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone(message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(
      () =>
        api.saveAgent(
          projectKey,
          {
            id: effectiveId,
            name: name.trim(),
            tool: toolChoice === "other" ? toolOther.trim() : toolChoice,
            role: role.trim(),
            maxParallel,
            bootstrapPrompts: promptIds.filter((p) => prompts.has(p)),
          },
          [...helps],
        ),
      t(existing ? "agentSaved" : "agentAdded", { name: name.trim() }),
    );

  return (
    <Dialog title={existing ? t("editAgent") : t("addAgent")} onClose={onClose}>
      <div className="row wrap">
        <div className="field grow">
          <label htmlFor="agent-name">{t("agentName")}</label>
          <input id="agent-name" className="input" value={name} placeholder="Codex D" autoFocus onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field grow">
          <label htmlFor="agent-id">{t("agentId")}</label>
          <input
            id="agent-id"
            className="input mono"
            value={effectiveId}
            disabled={Boolean(existing)}
            title={t("agentIdHint")}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.target.value);
            }}
          />
        </div>
      </div>
      <div className="row wrap">
        <div className="field">
          <label htmlFor="agent-tool">{t("agentTool")}</label>
          <div className="row">
            <select id="agent-tool" className="input" value={toolChoice} onChange={(e) => setToolChoice(e.target.value)}>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="cursor">Cursor</option>
              <option value="other">{t("agentToolOther")}</option>
            </select>
            {toolChoice === "other" && (
              <input className="input" value={toolOther} aria-label={t("agentToolOther")} onChange={(e) => setToolOther(e.target.value)} />
            )}
          </div>
        </div>
        <div className="field">
          <label htmlFor="agent-parallel">{t("agentParallel")}</label>
          <input
            id="agent-parallel"
            className="input narrow"
            type="number"
            min={1}
            max={10}
            value={maxParallel}
            onChange={(e) => setMaxParallel(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="agent-role">{t("agentRole")}</label>
        <input
          id="agent-role"
          className="input"
          value={role}
          placeholder={t("agentRolePlaceholder")}
          onChange={(e) => setRole(e.target.value)}
        />
      </div>
      {others.length > 0 && (
        <div className="field">
          <label>{t("agentHelps")}</label>
          <div className="checks">
            {others.map((a) => (
              <label key={a.id} className="check">
                <input type="checkbox" checked={helps.has(a.id)} onChange={() => toggle(helps, a.id, setHelps)} />
                {a.name}
              </label>
            ))}
          </div>
          <span className="small muted">{t("agentHelpsHint")}</span>
        </div>
      )}
      {promptIds.length > 0 && (
        <div className="field">
          <label>{t("agentPrompts")}</label>
          <div className="checks scroll">
            {promptIds.map((p) => (
              <label key={p} className="check" title={project.prompts[p]?.title ?? p}>
                <input type="checkbox" checked={prompts.has(p)} onChange={() => toggle(prompts, p, setPrompts)} />
                <span className="mono">{p}</span>
                {promptLabel(p, project.prompts[p]?.title) && (
                  <span className="muted ellipsis">{promptLabel(p, project.prompts[p]?.title)}</span>
                )}
              </label>
            ))}
          </div>
          <span className="small muted">{t("agentPromptsHint")}</span>
        </div>
      )}
      {existing && removing && (
        <div className="danger-zone">
          <span>{t("removeAgentConfirm")}</span>
          {ownedTasks > 0 && (
            <div className="row">
              <label htmlFor="move-to" className="small muted">
                {t("removeAgentMoveTo")} ({ownedTasks})
              </label>
              <select id="move-to" className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                {others.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="row">
            <span className="spacer" />
            <button className="btn ghost" onClick={() => setRemoving(false)}>
              {t("cancel")}
            </button>
            <button
              className="btn danger-solid"
              disabled={busy}
              onClick={() =>
                run(
                  () => api.removeAgent(projectKey, existing.id, ownedTasks > 0 ? moveTo : undefined),
                  t("agentRemoved", { name: existing.name }),
                )
              }
            >
              {t("removeAgent")}
            </button>
          </div>
        </div>
      )}
      <div className="small muted">{t("agentWritesFile")}</div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        {existing && !removing && others.length > 0 && (
          <button className="btn ghost danger" onClick={() => setRemoving(true)}>
            {t("removeAgent")}
          </button>
        )}
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t("cancel")}
        </button>
        <button className="btn primary" disabled={busy || !name.trim() || !effectiveId} onClick={save}>
          {existing ? t("save") : t("addAgent")}
        </button>
      </div>
    </Dialog>
  );
}
