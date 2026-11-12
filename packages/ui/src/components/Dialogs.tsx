import { useState, type ReactNode } from "react";
import { api, desktop } from "../api.ts";
import { useI18n } from "../i18n.ts";

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
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
