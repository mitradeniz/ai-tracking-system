import { useEffect, useState } from "react";
import { api, copyText, type RunSummary } from "../api.ts";
import { useI18n, type Key } from "../i18n.ts";
import {
  agentName,
  contextPercent,
  formatDuration,
  formatTime,
  formatTokens,
  lastRunOf,
  localMessage,
  localReason,
  problemsOf,
  PROVIDER_LABEL,
  reasonText,
  runnerOf,
  type Model,
  type Problem,
} from "../model.ts";
import { usePlanEditing } from "../editing.ts";
import { InfoTip, PromptPicker, useNow } from "./Info.tsx";
import { RunLog } from "./Runners.tsx";

interface Props {
  model: Model;
  taskId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onError: (message: string) => void;
  onInfo?: (message: string) => void;
  /** Opens the run settings of a chat. */
  onRunnerSettings?: (agentId: string) => void;
}

type Pending = { type: "blocked" | "failed" | "note" | "done"; text: string } | null;

export function TaskDrawer({ model, taskId, onClose, onOpen, onError, onInfo, onRunnerSettings }: Props) {
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
  const [reply, setReply] = useState("");
  const [extra, setExtra] = useState("");
  const [showExtra, setShowExtra] = useState(false);

  useEffect(() => {
    setAgent(snap?.candidates[0] ?? snap?.agent ?? owner);
    setPending(null);
    setCopied(false);
    setReply("");
    setExtra("");
    setShowExtra(false);
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

  const planEditing = usePlanEditing();
  useEffect(() => {
    // A dialog opened over the drawer closes first.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".dialog-backdrop") && onClose();
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
    const base = prompt ?? (await api.taskPrompt(key, taskId, agent || undefined));
    const note = extra.trim();
    const text = note ? `${base.trimEnd()}\n\nADDITIONAL INSTRUCTIONS FROM THE PERSON (they take precedence):\n${note}\n` : base;
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

  const sendRun = async () => {
    setBusy(true);
    try {
      await api.runTask(key, taskId, agent || undefined, extra.trim() || undefined);
      setExtra("");
      setShowExtra(false);
      onInfo?.(t("run_sent", { task: taskId, agent: agentName(model, agent) }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Gives text to the chat: continues its session, or starts the task with it, or copies it for pasting. */
  const sendMessage = async (text: string) => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      if (msgAgent && msgRunner && hasSession) {
        await api.reply(key, msgAgent, body, taskId);
        onInfo?.(t("run_replySent", { agent: agentName(model, msgAgent) }));
      } else if (canRunFix) {
        await api.runTask(key, taskId, agent || undefined, body);
        onInfo?.(t("run_sent", { task: taskId, agent: agentName(model, agent) }));
      } else {
        await copyText(body);
        onInfo?.(t("copied"));
      }
      setReply("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stopRun = async (id: string) => {
    try {
      await api.stopRun(id);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const eligible = [task.agent, ...task.alsoAgents.filter((a) => a !== task.agent)];
  const events = [...(model.eventsByTask.get(taskId) ?? [])].reverse();
  const milestone = model.detail.project?.milestones.find((m) => m.id === task.milestone);
  const s = snap.status;
  const holding = s === "dispatched" || s === "in_progress" || s === "blocked";
  const assigned = (holding || s === "done" || s === "review") && Boolean(snap.agent);
  const chosenRunner = runnerOf(model, agent);
  const holderRunner = runnerOf(model, snap.agent);
  const run = lastRunOf(model, taskId);
  const running = run?.state === "running" ? run : undefined;
  const now = useNow(Boolean(running));
  const sendable = s === "ready" || s === "failed" || s === "waiting";
  const msgAgent = snap.agent ?? run?.agent ?? null;
  const msgRunner = runnerOf(model, msgAgent);
  const hasSession = Boolean(run?.sessionId || msgRunner?.sessionId);
  const canMessage = Boolean(msgRunner) && hasSession && !running && !sendable;
  const canRunFix = Boolean(chosenRunner) && (s === "ready" || s === "failed");
  const problems = problemsOf(model, snap, t);

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
            {planEditing && (
              <button className="btn small ghost" onClick={() => planEditing.editTask(task.id)} title={t("te_editHint")}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
                {t("te_editShort")}
              </button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label={t("close")}>
              ✕
            </button>
          </div>
          <h2>{task.title}</h2>
          {task.description && <div className="muted">{task.description}</div>}
        </div>

        <div className="drawer-body">
          <div className={`give-to ${snap.dispatchable ? "go" : ""}`}>
            <span className="label">
              {assigned ? t("sentTo") : t("giveTo")}
              {!assigned && <InfoTip text={t("info_giveTo")} />}
            </span>
            <div className="row">
              <span className="who">{agentName(model, assigned ? snap.agent : agent || owner)}</span>
              {(assigned ? holderRunner : chosenRunner) && (
                <span className="badge">{PROVIDER_LABEL[(assigned ? holderRunner : chosenRunner)!.provider]}</span>
              )}
              {!assigned && eligible.length > 1 && (
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
            {!assigned && eligible.length > 1 && (
              <span className="small muted">
                {t("orAlso")}:{" "}
                {eligible
                  .slice(1)
                  .map((a) => agentName(model, a))
                  .join(", ")}
              </span>
            )}
            {snap.dispatchable && <span className="small">{t("canSendNow")}</span>}

            {sendable && (
              <div className="actions">
                {chosenRunner ? (
                  <button className={`btn ${snap.dispatchable ? "go" : ""}`} disabled={busy || s === "waiting"} onClick={sendRun}>
                    {t("run_send", { agent: agentName(model, agent) })}
                  </button>
                ) : (
                  <button className={`btn ${snap.dispatchable ? "go" : ""}`} disabled={busy} onClick={copyAndSend}>
                    {copied ? `✓ ${t("copied")}` : t("copyAndSend")}
                  </button>
                )}
                <button className="btn" onClick={copy}>
                  {copied && chosenRunner ? `✓ ${t("copied")}` : t("copyPrompt")}
                </button>
                {!showExtra && (
                  <button className="btn ghost" onClick={() => setShowExtra(true)}>
                    + {t("extra_add")}
                  </button>
                )}
                {!chosenRunner && onRunnerSettings && agent && (
                  <button className="btn ghost" title={t("run_setupHint")} onClick={() => onRunnerSettings(agent)}>
                    ⚙ {t("run_setup")}
                  </button>
                )}
              </div>
            )}
            {sendable && showExtra && (
              <div className="field compose">
                <div className="row">
                  <label htmlFor="extra">{t("extra_label")}</label>
                  <InfoTip text={t("extra_hint")} />
                  <span className="spacer" />
                  <PromptPicker value={extra} onInsert={(text) => setExtra((v) => (v.trim() ? `${v.trim()}\n\n${text}` : text))} />
                </div>
                <textarea
                  id="extra"
                  className="input"
                  style={{ minHeight: 70 }}
                  placeholder={t("extra_placeholder")}
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                />
              </div>
            )}

            {running && (
              <div className="run-strip">
                <span className="pulse" aria-hidden="true" />
                <span className="grow ellipsis">
                  <b>{t("run_running", { agent: agentName(model, running.agent) })}</b>
                  {running.lastActivity ? ` · ${running.lastActivity}` : ""}
                </span>
                <span className="mono small">{formatDuration(now - Date.parse(running.startedAt))}</span>
                <button className="btn small danger" onClick={() => void stopRun(running.id)}>
                  ■ {t("run_stop")}
                </button>
              </div>
            )}

            {canMessage && (
              <div className="field compose reply-box">
                {s === "blocked" && snap.lastMessage && (
                  <div className="agent-says">
                    <span className="label">{t("run_agentSays")}</span>
                    <div className="pre-wrap">{localMessage(snap.lastMessage, t)}</div>
                  </div>
                )}
                <div className="row">
                  <label htmlFor="reply">{s === "blocked" ? t("run_reply") : t("msg_title")}</label>
                  <InfoTip text={t("msg_hint")} />
                  <span className="spacer" />
                  <PromptPicker value={reply} onInsert={(text) => setReply((v) => (v.trim() ? `${v.trim()}\n\n${text}` : text))} />
                </div>
                <textarea
                  id="reply"
                  className="input"
                  style={{ minHeight: 64 }}
                  placeholder={s === "blocked" ? t("run_replyPlaceholder") : t("msg_placeholder")}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void sendMessage(reply);
                  }}
                />
                <div className="row">
                  {s === "blocked" && (
                    <button className="btn ghost small" disabled={busy} onClick={() => void sendMessage(t("run_approveText"))}>
                      {t("run_approve")}
                    </button>
                  )}
                  <span className="kbd-hint small muted">⌘↵</span>
                  <span className="spacer" />
                  <button className="btn primary" disabled={busy || !reply.trim()} onClick={() => void sendMessage(reply)}>
                    {s === "blocked" ? t("run_reply") : t("msg_send")}
                  </button>
                </div>
              </div>
            )}

            {(holding || s === "review" || s === "failed" || s === "done") && (
              <div className="actions secondary">
                {s === "review" && (
                  <button className="btn go" disabled={busy} onClick={() => act("approved")}>
                    {t("approve")}
                  </button>
                )}
                {holding && !running && (
                  <button className="btn" disabled={busy} onClick={() => setPending({ type: "done", text: "" })}>
                    {t("markDone")}
                  </button>
                )}
                {s === "dispatched" && !running && (
                  <button className="btn ghost" disabled={busy} onClick={() => act("started")}>
                    {t("markStarted")}
                  </button>
                )}
                {s === "blocked" && !holderRunner && (
                  <button className="btn ghost" disabled={busy} onClick={() => act("started")}>
                    {t("resume")}
                  </button>
                )}
                {holding && s !== "blocked" && !running && (
                  <button className="btn ghost" disabled={busy} onClick={() => setPending({ type: "blocked", text: "" })}>
                    {t("markBlocked")}
                  </button>
                )}
                {holding && !running && (
                  <button className="btn ghost danger" disabled={busy} onClick={() => setPending({ type: "failed", text: "" })}>
                    {t("markFailed")}
                  </button>
                )}
                {holding && (
                  <button className="btn ghost" onClick={copy}>
                    {copied ? `✓ ${t("copied")}` : t("copyPrompt")}
                  </button>
                )}
                {!running && (
                  <button className="btn ghost" disabled={busy} onClick={() => act("reopened")}>
                    {t("reopen")}
                  </button>
                )}
                <button className="btn ghost" onClick={() => setPending({ type: "note", text: "" })}>
                  {t("addNote")}
                </button>
              </div>
            )}
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

          {problems.length > 0 && (
            <section className="section problems">
              <div className="row">
                <h3 style={{ margin: 0 }}>
                  <span className="bang" aria-hidden="true">
                    !
                  </span>{" "}
                  {t("problems")} · {problems.length}
                </h3>
                <InfoTip text={t("problemsHint")} />
              </div>
              {problems.map((p, i) => (
                <ProblemCard
                  key={`${p.title}-${i}`}
                  problem={p}
                  canSend={Boolean(msgRunner) || canRunFix}
                  busy={busy}
                  onSend={(text) => void sendMessage(text)}
                  onSettings={p.settings && onRunnerSettings && msgAgent ? () => onRunnerSettings(msgAgent) : undefined}
                />
              ))}
            </section>
          )}

          {run && (
            <section className="section">
              <div className="row">
                <h3 style={{ margin: 0 }}>{t("run_log")}</h3>
                <InfoTip text={t("info_runLog")} />
                <span className={`pill run-${run.state}`}>{t(`run_state_${run.state}` as Key)}</span>
                <span className="small muted ellipsis">
                  {PROVIDER_LABEL[run.provider]} · {formatTime(run.startedAt, lang)}
                </span>
                <span className="spacer" />
                {onRunnerSettings && (
                  <button className="btn tiny ghost" title={t("run_setup")} onClick={() => onRunnerSettings(run.agent)}>
                    ⚙
                  </button>
                )}
              </div>
              <RunStats run={run} now={now} />
              {run.error && <div className="error small">{run.error}</div>}
              <RunLog run={run} />
            </section>
          )}

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
                    <dd>{localReason(snap.reason, t)}</dd>
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
                    <dd className="pre-wrap">{localMessage(snap.lastMessage, t)}</dd>
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
                    {e.reason && <div>{localReason(e.reason, t)}</div>}
                    {e.message && e.message !== e.reason && <div className="pre-wrap clamp">{localMessage(e.message, t)}</div>}
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

/** One problem: what happened in plain words, and a prompt that would fix it. */
function ProblemCard({
  problem,
  canSend,
  busy,
  onSend,
  onSettings,
}: {
  problem: Problem;
  canSend: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onSettings?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(problem.fix);
  const [copied, setCopied] = useState(false);
  return (
    <div className={`problem ${problem.kind}`}>
      <div className="problem-head">
        <span className="bang" aria-hidden="true">
          !
        </span>
        <div className="grow">
          <div className="problem-title">{problem.title}</div>
          {problem.detail && <div className="small muted pre-wrap">{problem.detail}</div>}
        </div>
        <span className={`pill kind-${problem.kind}`}>{t(`problem_kind_${problem.kind}` as Key)}</span>
      </div>
      <div className="row wrap">
        <button className="btn small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {t("fixPrompt")}
        </button>
        {canSend && (
          <button className="btn small primary" disabled={busy} onClick={() => onSend(text)}>
            {t("fixSend")}
          </button>
        )}
        <button
          className="btn small ghost"
          onClick={async () => {
            await copyText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? `✓ ${t("copied")}` : t("copy")}
        </button>
        {onSettings && (
          <button className="btn small ghost" onClick={onSettings}>
            ⚙ {t("run_setup")}
          </button>
        )}
      </div>
      {open && <textarea className="input mono small" style={{ minHeight: 110 }} value={text} onChange={(e) => setText(e.target.value)} />}
    </div>
  );
}

/** Time, tool calls, context and tokens of a run, as far as the CLI reports them. */
export function RunStats({ run, now }: { run: RunSummary; now: number }) {
  const { t } = useI18n();
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  const pct = contextPercent(run);
  const u = run.usage;
  return (
    <div className="run-stats">
      <div className="stat">
        <span className="label">{t("m_elapsed")}</span>
        <b className="mono">{formatDuration(end - Date.parse(run.startedAt))}</b>
      </div>
      <div className="stat">
        <span className="label">{t("m_tools")}</span>
        <b className="mono">{run.tools ?? 0}</b>
      </div>
      {pct !== null && (
        <div className="stat wide">
          <span className="label">
            {t("m_context")} <InfoTip text={t("m_contextHint")} />
          </span>
          <b className="mono">
            {pct}% · {formatTokens(u?.context)} / {formatTokens(u?.contextWindow)}
          </b>
          <span className={`meter ${pct >= 80 ? "hot" : pct >= 60 ? "warm" : ""}`}>
            <span style={{ width: `${Math.max(2, pct)}%` }} />
          </span>
        </div>
      )}
      {(u?.input !== undefined || u?.output !== undefined) && (
        <div className="stat">
          <span className="label">{t("m_tokens")}</span>
          <b className="mono">
            {formatTokens(u?.input)} / {formatTokens(u?.output)}
          </b>
        </div>
      )}
      {u?.turns !== undefined && (
        <div className="stat">
          <span className="label">{t("m_turns")}</span>
          <b className="mono">{u.turns}</b>
        </div>
      )}
      {u?.costUsd !== undefined && (
        <div className="stat" title={t("m_costHint")}>
          <span className="label">{t("m_cost")}</span>
          <b className="mono">${u.costUsd.toFixed(2)}</b>
        </div>
      )}
    </div>
  );
}
