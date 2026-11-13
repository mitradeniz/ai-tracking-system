import { useMemo, useState } from "react";
import { api, type TaskPayload } from "../api.ts";
import { useI18n } from "../i18n.ts";
import { dependentsOf, nextTaskId, slugId, type Model } from "../model.ts";
import { Dialog } from "./Dialogs.tsx";
import { InfoTip } from "./Info.tsx";

const lines = (text: string) =>
  text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** Adding or changing a task: what it is, which chat takes it, what it waits for and what it is told. */
export function TaskEditorDialog({
  model,
  taskId,
  agentId,
  onClose,
  onDone,
}: {
  model: Model;
  taskId?: string;
  agentId?: string;
  onClose: () => void;
  onDone: (message: string, openTask?: string) => void;
}) {
  const { t } = useI18n();
  const project = model.detail.project!;
  const existing = taskId ? model.task.get(taskId) : undefined;
  const status = taskId ? model.snap.get(taskId)?.status : undefined;
  const [id, setId] = useState(existing?.id ?? nextTaskId(model.tasks.map((x) => x.id)));
  const [title, setTitle] = useState(existing?.title ?? "");
  const [agent, setAgent] = useState(existing?.agent ?? agentId ?? project.agents[0]?.id ?? "");
  const [also, setAlso] = useState<string[]>(existing?.alsoAgents ?? []);
  const [deps, setDeps] = useState<string[]>(existing?.dependsOn ?? []);
  const [prompts, setPrompts] = useState<string[]>(existing?.prompts ?? []);
  const [instructions, setInstructions] = useState(existing?.instructions ?? "");
  const [acceptance, setAcceptance] = useState(existing?.acceptance ?? "");
  const [paths, setPaths] = useState((existing?.allowedPaths ?? []).join("\n"));
  const [description, setDescription] = useState(existing?.description ?? "");
  const [scope, setScope] = useState(existing?.scope ?? "");
  const [milestone, setMilestone] = useState(existing?.milestone ?? "");
  const [estimate, setEstimate] = useState(existing?.estimateDays !== undefined ? String(existing.estimateDays) : "");
  const [tags, setTags] = useState((existing?.tags ?? []).join(", "));
  const [filter, setFilter] = useState("");
  const [newPrompt, setNewPrompt] = useState<{ title: string; body: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A task cannot wait for itself or for tasks that wait for it.
  const blocked = useMemo(() => (existing ? dependentsOf(model.tasks, existing.id) : new Set<string>()), [existing, model.tasks]);
  const candidates = model.tasks.filter((x) => x.id !== existing?.id);
  const q = filter.trim().toLowerCase();
  const shown = candidates.filter((x) => !q || x.id.toLowerCase().includes(q) || x.title.toLowerCase().includes(q));
  const promptIds = Object.keys(project.prompts);
  const unused = promptIds.filter((p) => !prompts.includes(p));
  const dependents = existing ? model.tasks.filter((x) => x.dependsOn.includes(existing.id)) : [];
  const withChat = status === "dispatched" || status === "in_progress" || status === "blocked" || status === "review";
  const estimateNumber = estimate.trim() === "" ? null : Number(estimate.replace(",", "."));
  const estimateOk = estimateNumber === null || (estimateNumber > 0 && estimateNumber <= 365);

  const toggle = (list: string[], value: string, set: (v: string[]) => void) =>
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  const move = (index: number, by: number) => {
    const next = [...prompts];
    const [item] = next.splice(index, 1);
    next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item!);
    setPrompts(next);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const payload: TaskPayload = {
      id: id.trim(),
      title: title.trim(),
      agent,
      alsoAgents: also.filter((a) => a !== agent),
      dependsOn: deps,
      prompts,
      instructions,
      acceptance,
      allowedPaths: lines(paths),
      description,
      scope,
      milestone,
      estimateDays: estimateNumber,
      tags: tags
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    };
    try {
      await api.saveTask(model.detail.key, payload, existing ? "update" : "create");
      onDone(t(existing ? "te_saved" : "te_added", { id: payload.id }), existing ? undefined : payload.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addPrompt = async () => {
    if (!newPrompt?.body.trim()) return;
    setBusy(true);
    setError(null);
    const promptId = slugId(newPrompt.title || newPrompt.body.slice(0, 40), promptIds, "prompt");
    try {
      await api.savePrompt(model.detail.key, { id: promptId, title: newPrompt.title.trim() || undefined, body: newPrompt.body }, "create");
      setPrompts([...prompts, promptId]);
      setNewPrompt(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.removeTask(model.detail.key, existing!.id);
      onDone(t("te_removed", { id: existing!.id }));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (project.agents.length === 0) {
    return (
      <Dialog title={t("te_add")} onClose={onClose}>
        <p className="small muted">{t("te_needChat")}</p>
        <div className="row">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={existing ? t("te_edit", { id: existing.id }) : t("te_add")} onClose={onClose} wide>
      <div className="form-grid">
        <div className="form-col">
          <div className="row wrap">
            <div className="field grow">
              <label htmlFor="te-title">{t("title")}</label>
              <input id="te-title" className="input" value={title} autoFocus placeholder={t("te_titlePlaceholder")} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="te-id">
                {t("te_id")} <InfoTip text={t("te_idHint")} align="end" />
              </label>
              <input id="te-id" className="input mono narrow-id" value={id} disabled={Boolean(existing)} onChange={(e) => setId(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="te-agent">{t("te_agent")}</label>
            <select id="te-agent" className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
              {project.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          {project.agents.length > 1 && (
            <div className="field">
              <label>
                {t("te_also")} <InfoTip text={t("te_alsoHint")} />
              </label>
              <div className="checks">
                {project.agents
                  .filter((a) => a.id !== agent)
                  .map((a) => (
                    <label key={a.id} className="check">
                      <input type="checkbox" checked={also.includes(a.id)} onChange={() => toggle(also, a.id, setAlso)} />
                      {a.name}
                    </label>
                  ))}
              </div>
            </div>
          )}
          <div className="field">
            <label>
              {t("te_deps")} <InfoTip text={t("te_depsHint")} />
            </label>
            {deps.length > 0 && (
              <div className="chips">
                {deps.map((d) => (
                  <button key={d} className="chip-task removable" onClick={() => toggle(deps, d, setDeps)} title={t("te_removeDep")}>
                    <span className="mono">{d}</span> ✕
                  </button>
                ))}
              </div>
            )}
            {candidates.length === 0 ? (
              <span className="small muted">{t("te_noOtherTasks")}</span>
            ) : (
              <>
                {candidates.length > 6 && (
                  <input className="input" value={filter} placeholder={t("te_filterTasks")} onChange={(e) => setFilter(e.target.value)} />
                )}
                <div className="checks scroll">
                  {shown.map((x) => {
                    const cycle = blocked.has(x.id);
                    return (
                      <label key={x.id} className={`check ${cycle ? "disabled" : ""}`} title={cycle ? t("te_wouldCycle") : x.title}>
                        <input type="checkbox" checked={deps.includes(x.id)} disabled={cycle} onChange={() => toggle(deps, x.id, setDeps)} />
                        <span className="mono">{x.id}</span>
                        <span className="ellipsis">{x.title}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          <div className="field">
            <label>
              {t("te_prompts")} <InfoTip text={t("te_promptsHint")} />
            </label>
            {prompts.length > 0 && (
              <ol className="prompt-order">
                {prompts.map((p, i) => (
                  <li key={p}>
                    <span className="mono">{p}</span>
                    <span className="muted ellipsis">{project.prompts[p]?.title ?? ""}</span>
                    <span className="spacer" />
                    <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("moveEarlier")}>
                      ↑
                    </button>
                    <button className="icon-btn" disabled={i === prompts.length - 1} onClick={() => move(i, 1)} aria-label={t("moveLater")}>
                      ↓
                    </button>
                    <button className="icon-btn" onClick={() => setPrompts(prompts.filter((x) => x !== p))} aria-label={t("te_removePrompt")}>
                      ✕
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <div className="row">
              {unused.length > 0 && (
                <select
                  className="input"
                  value=""
                  aria-label={t("te_addPrompt")}
                  onChange={(e) => {
                    if (e.target.value) setPrompts([...prompts, e.target.value]);
                  }}
                >
                  <option value="">{t("te_addPrompt")}</option>
                  {unused.map((p) => (
                    <option key={p} value={p}>
                      {project.prompts[p]?.title ? `${project.prompts[p]!.title} (${p})` : p}
                    </option>
                  ))}
                </select>
              )}
              {!newPrompt && (
                <button className="btn small" onClick={() => setNewPrompt({ title: "", body: "" })}>
                  + {t("te_newPrompt")}
                </button>
              )}
            </div>
            {newPrompt && (
              <div className="sub-form">
                <input
                  className="input"
                  value={newPrompt.title}
                  placeholder={t("pe_titlePlaceholder")}
                  onChange={(e) => setNewPrompt({ ...newPrompt, title: e.target.value })}
                />
                <textarea
                  className="input"
                  rows={5}
                  value={newPrompt.body}
                  placeholder={t("pe_bodyPlaceholder")}
                  onChange={(e) => setNewPrompt({ ...newPrompt, body: e.target.value })}
                />
                <div className="row">
                  <span className="spacer" />
                  <button className="btn ghost small" onClick={() => setNewPrompt(null)}>
                    {t("cancel")}
                  </button>
                  <button className="btn small primary" disabled={busy || !newPrompt.body.trim()} onClick={() => void addPrompt()}>
                    {t("te_savePrompt")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="form-col">
          <div className="field">
            <label htmlFor="te-instructions">
              {t("te_instructions")} <InfoTip text={t("te_instructionsHint")} align="end" />
            </label>
            <textarea
              id="te-instructions"
              className="input"
              rows={7}
              value={instructions}
              placeholder={t("te_instructionsPlaceholder")}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="te-acceptance">{t("te_acceptance")}</label>
            <textarea
              id="te-acceptance"
              className="input"
              rows={3}
              value={acceptance}
              placeholder={t("te_acceptancePlaceholder")}
              onChange={(e) => setAcceptance(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="te-paths">
              {t("te_paths")} <InfoTip text={t("te_pathsHint")} align="end" />
            </label>
            <textarea id="te-paths" className="input mono" rows={3} value={paths} placeholder={"src/api/\ntests/api/"} onChange={(e) => setPaths(e.target.value)} />
          </div>
          <div className="row wrap">
            <div className="field">
              <label htmlFor="te-estimate">{t("te_estimate")}</label>
              <input
                id="te-estimate"
                className="input narrow"
                inputMode="decimal"
                value={estimate}
                placeholder="1"
                onChange={(e) => setEstimate(e.target.value)}
              />
            </div>
            {project.milestones.length > 0 && (
              <div className="field grow">
                <label htmlFor="te-milestone">{t("milestone")}</label>
                <select id="te-milestone" className="input" value={milestone} onChange={(e) => setMilestone(e.target.value)}>
                  <option value="">—</option>
                  {project.milestones.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="field grow">
              <label htmlFor="te-tags">{t("te_tags")}</label>
              <input id="te-tags" className="input" value={tags} placeholder="api, backend" onChange={(e) => setTags(e.target.value)} />
            </div>
          </div>
          <details className="advanced">
            <summary>{t("np_advanced")}</summary>
            <div className="field">
              <label htmlFor="te-description">{t("te_description")}</label>
              <textarea id="te-description" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="te-scope">
                {t("te_scope")} <InfoTip text={t("te_scopeHint")} align="end" />
              </label>
              <input id="te-scope" className="input" value={scope} onChange={(e) => setScope(e.target.value)} />
            </div>
          </details>
        </div>
      </div>

      {existing && removing && (
        <div className="danger-zone">
          <span>{t("te_removeConfirm", { id: existing.id })}</span>
          {dependents.length > 0 && (
            <span className="small">
              {t("te_removeDependents", {
                tasks: dependents.map((x) => x.id).join(", "),
                deps: existing.dependsOn.join(", ") || t("te_nothing"),
              })}
            </span>
          )}
          <div className="row">
            <span className="spacer" />
            <button className="btn ghost" onClick={() => setRemoving(false)}>
              {t("cancel")}
            </button>
            <button className="btn danger-solid" disabled={busy} onClick={() => void remove()}>
              {t("te_remove")}
            </button>
          </div>
        </div>
      )}
      <div className="small muted">{t("te_writesFile")}</div>
      {error && <div className="error">{error}</div>}
      {!estimateOk && <div className="error">{t("te_estimateBad")}</div>}
      <div className="row">
        {existing && !removing && (
          <button className="btn ghost danger" disabled={withChat} title={withChat ? t("te_removeBusy") : undefined} onClick={() => setRemoving(true)}>
            {t("te_remove")}
          </button>
        )}
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t("cancel")}
        </button>
        <button className="btn primary" disabled={busy || !title.trim() || !agent || !id.trim() || !estimateOk} onClick={() => void save()}>
          {existing ? t("save") : t("te_add")}
        </button>
      </div>
    </Dialog>
  );
}

/** The project's prompt library: shared context, session prompts, task prompts. */
export function PromptsDialog({
  model,
  promptId,
  onClose,
  onDone,
}: {
  model: Model;
  promptId?: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useI18n();
  const project = model.detail.project!;
  const ids = Object.keys(project.prompts);
  const [selected, setSelected] = useState<string | null>(promptId ?? ids[0] ?? null);
  const current = selected ? project.prompts[selected] : undefined;
  const [title, setTitle] = useState(current?.title ?? "");
  const [body, setBody] = useState(current?.body ?? "");
  const [newId, setNewId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const creating = selected === null;
  const dirty = creating ? Boolean(title.trim() || body.trim()) : title !== (current?.title ?? "") || body !== (current?.body ?? "");
  const effectiveId = creating ? (idTouched ? newId : slugId(title || "prompt", ids, "prompt")) : selected!;
  const usage = (p: string) => ({
    tasks: project.tasks.filter((x) => x.prompts.includes(p)).map((x) => x.id),
    chats: project.agents.filter((a) => a.bootstrapPrompts.includes(p) || a.quickPrompts.includes(p)).map((a) => a.name),
  });

  const open = (next: string | null) => {
    const p = next ? project.prompts[next] : undefined;
    setSelected(next);
    setTitle(p?.title ?? "");
    setBody(p?.body ?? "");
    setNewId("");
    setIdTouched(false);
    setRemoving(false);
    setPending(undefined);
    setError(null);
  };
  const choose = (next: string | null) => {
    if (dirty) setPending(next);
    else open(next);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.savePrompt(model.detail.key, { id: effectiveId, title, body }, creating ? "create" : "update");
      onDone(t(creating ? "pe_added" : "pe_saved", { id: effectiveId }));
      setSelected(effectiveId);
      setIdTouched(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.removePrompt(model.detail.key, selected!);
      onDone(t("pe_removed", { id: selected! }));
      open(ids.find((x) => x !== selected) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const u = selected ? usage(selected) : { tasks: [], chats: [] };

  return (
    <Dialog title={t("pe_title")} onClose={onClose} wide>
      <div className="prompts-layout">
        <div className="prompt-list" role="listbox" aria-label={t("pe_title")}>
          {ids.map((p) => {
            const n = usage(p);
            return (
              <button key={p} role="option" aria-selected={p === selected} onClick={() => choose(p)}>
                <span className="ellipsis">{project.prompts[p]?.title || p}</span>
                <span className="small muted mono ellipsis">
                  {p} · {t("pe_usedBy", { tasks: n.tasks.length, chats: n.chats.length })}
                </span>
              </button>
            );
          })}
          <button className={`new-prompt ${creating ? "active" : ""}`} onClick={() => choose(null)}>
            + {t("te_newPrompt")}
          </button>
        </div>
        <div className="prompt-edit">
          {pending !== undefined && (
            <div className="danger-zone">
              <span>{t("pe_unsaved")}</span>
              <div className="row">
                <span className="spacer" />
                <button className="btn ghost small" onClick={() => setPending(undefined)}>
                  {t("pe_keepEditing")}
                </button>
                <button className="btn small danger-solid" onClick={() => open(pending)}>
                  {t("pe_discard")}
                </button>
              </div>
            </div>
          )}
          <div className="row wrap">
            <div className="field grow">
              <label htmlFor="pe-title">{t("pe_promptTitle")}</label>
              <input id="pe-title" className="input" value={title} placeholder={t("pe_titlePlaceholder")} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="pe-id">
                {t("te_id")} <InfoTip text={t("pe_idHint")} align="end" />
              </label>
              <input
                id="pe-id"
                className="input mono"
                value={effectiveId}
                disabled={!creating}
                onChange={(e) => {
                  setIdTouched(true);
                  setNewId(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="field grow-v">
            <label htmlFor="pe-body">{t("pe_body")}</label>
            <textarea id="pe-body" className="input prompt-body" value={body} placeholder={t("pe_bodyPlaceholder")} onChange={(e) => setBody(e.target.value)} />
          </div>
          {!creating && (u.tasks.length > 0 || u.chats.length > 0) && (
            <div className="small muted">
              {u.tasks.length > 0 && t("pe_usedTasks", { list: u.tasks.join(", ") })} {u.chats.length > 0 && t("pe_usedChats", { list: u.chats.join(", ") })}
            </div>
          )}
          {removing && selected && (
            <div className="danger-zone">
              <span>{t("pe_removeConfirm", { id: selected })}</span>
              {(u.tasks.length > 0 || u.chats.length > 0) && <span className="small">{t("pe_removeRefs")}</span>}
              <div className="row">
                <span className="spacer" />
                <button className="btn ghost" onClick={() => setRemoving(false)}>
                  {t("cancel")}
                </button>
                <button className="btn danger-solid" disabled={busy} onClick={() => void remove()}>
                  {t("pe_remove")}
                </button>
              </div>
            </div>
          )}
          {error && <div className="error">{error}</div>}
          <div className="row">
            {!creating && !removing && (
              <button className="btn ghost danger" onClick={() => setRemoving(true)}>
                {t("pe_remove")}
              </button>
            )}
            <span className="spacer" />
            <button className="btn ghost" onClick={onClose}>
              {t("close")}
            </button>
            <button className="btn primary" disabled={busy || !body.trim() || !effectiveId || (!creating && !dirty)} onClick={() => void save()}>
              {creating ? t("te_savePrompt") : t("save")}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
