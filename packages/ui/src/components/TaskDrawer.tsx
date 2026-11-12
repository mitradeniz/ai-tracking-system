import { useEffect, useState } from "react";
import { api, copyText } from "../api.ts";
import { useI18n } from "../i18n.ts";
import { agentName, formatTime, reasonText, type Model } from "../model.ts";

interface Props {
  model: Model;
  taskId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onError: (message: string) => void;
}

type Pending = { type: "blocked" | "failed" | "note" | "done"; text: string } | null;

export function TaskDrawer({ model, taskId, onClose, onOpen, onError }: Props) {
  const { t, lang } = useI18n();
  const task = model.task.get(taskId);
  const snap = model.snap.get(taskId);
  const key = model.detail.key;
  const [prompt, setPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const owner = task?.agent ?? "";
  const [agent, setAgent] = useState<string>(owner);

  useEffect(() => {
    setAgent(snap?.candidates[0] ?? snap?.agent ?? owner);
    setPending(null);
    setCopied(false);
    // Only when the task changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    let alive = true;
    setPrompt(null);
    api
      .taskPrompt(key, taskId, agent || undefined)
      .then((text) => alive && setPrompt(text))
      .catch((e: Error) => alive && setPrompt(`⚠ ${e.message}`));
    return () => {
      alive = false;
    };
  }, [key, taskId, agent, model.detail.project]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!task || !snap) return null;

  const act = async (type: string, extra: Record<string, string> = {}) => {
    setBusy(true);
    try {
      await api.addEvent(key, { task: taskId, type, agent: snap.agent ?? agent, ...extra });
      setPending(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    const text = prompt ?? (await api.taskPrompt(key, taskId, agent || undefined));
    await copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const copyAndSend = async () => {
    try {
      await copy();
      await act("dispatched", { agent });
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const eligible = [task.agent, ...task.alsoAgents.filter((a) => a !== task.agent)];
  const events = [...(model.eventsByTask.get(taskId) ?? [])].reverse();
  const milestone = model.detail.project?.milestones.find((m) => m.id === task.milestone);
  const s = snap.status;
  const holding = s === "dispatched" || s === "in_progress" || s === "blocked";

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`${task.id} ${task.title}`}>
        <div className="drawer-head">
          <div className="row">
            <span className="mono muted">{task.id}</span>
            <span className={`pill ${snap.dispatchable ? "sendable" : s}`}>{snap.dispatchable ? t("sendable") : t(`status_${s}`)}</span>
            {snap.critical && <span className="crit">● {t("critical")}</span>}
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label={t("close")}>
              ✕
            </button>
          </div>
          <h2>{task.title}</h2>
          {task.description && <div className="muted">{task.description}</div>}
        </div>

        <div className="drawer-body">
          <div className={`give-to ${snap.dispatchable ? "go" : ""}`}>
            <span className="label">{holding ? t("sentTo") : t("giveTo")}</span>
            <div className="row">
              <span className="who">{agentName(model, holding ? snap.agent : agent || owner)}</span>
              {!holding && eligible.length > 1 && (
                <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label={t("chat")}>
                  {eligible.map((a) => (
                    <option key={a} value={a}>
                      {agentName(model, a)}
                      {snap.candidates.includes(a) ? " ✓" : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {!holding && eligible.length > 1 && (
              <span className="small muted">
                {t("orAlso")}:{" "}
                {eligible
                  .slice(1)
                  .map((a) => agentName(model, a))
                  .join(", ")}
              </span>
            )}
            {snap.dispatchable && <span className="small">{t("canSendNow")}</span>}
            <div className="actions">
              {(s === "ready" || s === "failed" || s === "waiting") && (
                <>
                  <button className={`btn ${snap.dispatchable ? "go" : ""}`} disabled={busy} onClick={copyAndSend}>
                    {copied ? `✓ ${t("copied")}` : t("copyAndSend")}
                  </button>
                  <button className="btn" onClick={copy}>
                    {t("copyPrompt")}
                  </button>
                </>
              )}
              {holding && (
                <>
                  {s === "dispatched" && (
                    <button className="btn" disabled={busy} onClick={() => act("started")}>
                      {t("markStarted")}
                    </button>
                  )}
                  {s === "blocked" && (
                    <button className="btn" disabled={busy} onClick={() => act("started")}>
                      {t("resume")}
                    </button>
                  )}
                  <button className="btn go" disabled={busy} onClick={() => setPending({ type: "done", text: "" })}>
                    {t("markDone")}
                  </button>
                  {s !== "blocked" && (
                    <button className="btn" disabled={busy} onClick={() => setPending({ type: "blocked", text: "" })}>
                      {t("markBlocked")}
                    </button>
                  )}
                  <button className="btn danger" disabled={busy} onClick={() => setPending({ type: "failed", text: "" })}>
                    {t("markFailed")}
                  </button>
                  <button className="btn" onClick={copy}>
                    {copied ? `✓ ${t("copied")}` : t("copyPrompt")}
                  </button>
                </>
              )}
              {s === "review" && (
                <button className="btn go" disabled={busy} onClick={() => act("approved")}>
                  {t("approve")}
                </button>
              )}
              {s !== "ready" && s !== "waiting" && (
                <button className="btn ghost" disabled={busy} onClick={() => act("reopened")}>
                  {t("reopen")}
                </button>
              )}
              <button className="btn ghost" onClick={() => setPending({ type: "note", text: "" })}>
                {t("addNote")}
              </button>
            </div>
            {pending && (
              <div className="field">
                <textarea
                  className="input"
                  style={{ minHeight: 70 }}
                  autoFocus
                  placeholder={pending.type === "note" || pending.type === "done" ? t("notePlaceholder") : t("reasonPlaceholder")}
                  value={pending.text}
                  onChange={(e) => setPending({ ...pending, text: e.target.value })}
                />
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={busy || ((pending.type === "blocked" || pending.type === "failed") && !pending.text.trim())}
                    onClick={() =>
                      act(
                        pending.type,
                        pending.type === "blocked" || pending.type === "failed"
                          ? { reason: pending.text.trim() }
                          : pending.text.trim()
                            ? { message: pending.text.trim() }
                            : {},
                      )
                    }
                  >
                    {t("save")}
                  </button>
                  <button className="btn ghost" onClick={() => setPending(null)}>
                    {t("cancel")}
                  </button>
                </div>
              </div>
            )}
          </div>

          {snap.reasons.length > 0 && (
            <section className="section">
              <h3>{t("whyNot")}</h3>
              <ul className="reasons">
                {snap.reasons.map((r, i) => (
                  <li key={i}>
                    {r.kind === "dependency" ? (
                      <>
                        <button className="linklike" onClick={() => onOpen(r.task)}>
                          {r.task}
                        </button>{" "}
                        {reasonText(model, r, t).replace(r.task, "").trim()}
                      </>
                    ) : (
                      reasonText(model, r, t)
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(snap.summary || snap.reason || snap.pr || snap.verify || snap.lastMessage) && (
            <section className="section">
              <h3>{t("lastReport")}</h3>
              <dl className="kv">
                {snap.summary && (
                  <>
                    <dt>{t("summary")}</dt>
                    <dd>{snap.summary}</dd>
                  </>
                )}
                {snap.reason && (
                  <>
                    <dt>{t("reason")}</dt>
                    <dd>{snap.reason}</dd>
                  </>
                )}
                {snap.pr && (
                  <>
                    <dt>{t("pr")}</dt>
                    <dd>
                      {/^https?:\/\//.test(snap.pr) ? (
                        <a href={snap.pr} target="_blank" rel="noreferrer">
                          {snap.pr}
                        </a>
                      ) : (
                        snap.pr
                      )}
                    </dd>
                  </>
                )}
                {snap.verify && (
                  <>
                    <dt>{t("verify")}</dt>
                    <dd>{snap.verify}</dd>
                  </>
                )}
                {snap.lastMessage && snap.lastMessage !== snap.summary && (
                  <>
                    <dt>{t("message")}</dt>
                    <dd>{snap.lastMessage}</dd>
                  </>
                )}
                <dt>{t("updated")}</dt>
                <dd>{formatTime(snap.updatedAt, lang)}</dd>
              </dl>
            </section>
          )}

          <section className="section">
            <h3>{t("details")}</h3>
            <dl className="kv">
              {task.dependsOn.length > 0 && (
                <>
                  <dt>{t("dependsOn")}</dt>
                  <dd>
                    <div className="chips">
                      {task.dependsOn.map((d) => {
                        const ds = model.snap.get(d);
                        return (
                          <button key={d} className="dep-chip" onClick={() => onOpen(d)} title={ds ? t(`status_${ds.status}`) : ""}>
                            <span className={`status-dot ${ds?.status ?? ""}`} />
                            {d}
                          </button>
                        );
                      })}
                    </div>
                  </dd>
                </>
              )}
              {snap.dependents.length > 0 && (
                <>
                  <dt>{t("dependents")}</dt>
                  <dd>
                    <div className="chips">
                      {snap.dependents.map((d) => (
                        <button key={d} className="dep-chip" onClick={() => onOpen(d)}>
                          <span className={`status-dot ${model.snap.get(d)?.status ?? ""}`} />
                          {d}
                        </button>
                      ))}
                    </div>
                  </dd>
                </>
              )}
              {milestone && (
                <>
                  <dt>{t("milestone")}</dt>
                  <dd>
                    {milestone.name}
                    {milestone.date ? ` (${milestone.date})` : ""}
                  </dd>
                </>
              )}
              {task.estimateDays !== undefined && (
                <>
                  <dt>{t("estimate")}</dt>
                  <dd>
                    {task.estimateDays} {task.estimateDays === 1 ? t("day") : t("days")}
                  </dd>
                </>
              )}
              {task.scope && (
                <>
                  <dt>{t("scope")}</dt>
                  <dd>{task.scope}</dd>
                </>
              )}
              {task.allowedPaths.length > 0 && (
                <>
                  <dt>{t("allowedPaths")}</dt>
                  <dd className="mono small">{task.allowedPaths.join("\n")}</dd>
                </>
              )}
              {task.acceptance && (
                <>
                  <dt>{t("acceptance")}</dt>
                  <dd>{task.acceptance}</dd>
                </>
              )}
            </dl>
          </section>

          <section className="section">
            <div className="row">
              <h3 style={{ margin: 0 }}>{t("prompt")}</h3>
              <span className="spacer" />
              <button className="btn small" onClick={copy}>
                {copied ? `✓ ${t("copied")}` : t("copyPrompt")}
              </button>
            </div>
            <pre className="prompt" style={{ marginTop: 8 }}>
              {prompt ?? t("loading")}
            </pre>
          </section>

          <section className="section">
            <h3>{t("history")}</h3>
            {events.length === 0 ? (
              <div className="muted small">{t("noHistory")}</div>
            ) : (
              <ul className="timeline">
                {events.map((e) => (
                  <li key={e.id}>
                    <div className="when">
                      {formatTime(e.ts, lang)} · {t(`type_${e.type}`)} · {e.source}
                      {e.agent ? ` · ${agentName(model, e.agent)}` : ""}
                    </div>
                    {(e.message || e.reason) && <div>{e.reason ?? e.message}</div>}
                    {e.pr && <div className="small muted">PR: {e.pr}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}
