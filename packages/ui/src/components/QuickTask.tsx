import { useState } from "react";
import { api, copyText, dispatchTask } from "../api.ts";
import { useI18n } from "../i18n.ts";
import {
  activeRun,
  agentName,
  formatDuration,
  lastRunOf,
  localError,
  localMessage,
  localReason,
  permissionRules,
  problemsOf,
  runnerOf,
  type Model,
  type Problem,
} from "../model.ts";
import { useNow } from "./Info.tsx";
import { Markdown, splitReport } from "./Markdown.tsx";
import { StopButton, stopRun } from "./Runners.tsx";

/**
 * What can be done with a task without the main window: send it, stop it, answer the chat,
 * approve, send a problem's fix, allow a refused step, close a problem, mark it done or reopen it.
 * Used by the floating window.
 */
export function QuickTask({
  model,
  taskId,
  onClose,
  onOpenMain,
  onInfo,
}: {
  model: Model;
  taskId: string;
  onClose: () => void;
  onOpenMain?: () => void;
  /** A short message to show; errors start with ⚠. */
  onInfo: (message: string) => void;
}) {
  const { t } = useI18n();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const snap = model.snap.get(taskId);
  const task = model.task.get(taskId);
  const key = model.detail.key;
  const owner = snap?.agent ?? task?.agent ?? null;
  const running = owner ? activeRun(model, owner) : undefined;
  const runHere = running?.task === taskId ? running : undefined;
  const now = useNow(Boolean(runHere));
  if (!snap || !task) return null;

  const s = snap.status;
  const runner = runnerOf(model, owner);
  const lastRun = lastRunOf(model, taskId);
  const hasSession = Boolean(lastRun?.sessionId || runner?.sessionId);
  const sendable = snap.dispatchable || s === "ready" || s === "failed";
  const canReply = Boolean(runner) && hasSession && !running && !snap.dispatchable && s !== "waiting";
  const problems = problemsOf(model, snap, t);
  const said = s === "blocked" && snap.lastMessage ? splitReport(localMessage(snap.lastMessage, t)) : null;
  const unreadReport = said?.report && snap.reason === "Waiting for your reply." ? said.report : null;
  const target = snap.candidates[0] ?? task.agent;

  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const message = await work();
      if (message) onInfo(message);
    } catch (e) {
      onInfo(`⚠ ${localError((e as Error).message, t)}`);
    } finally {
      setBusy(false);
    }
  };

  /** Continues the chat's session with the text, or starts the task with it. */
  const say = (text: string) =>
    run(async () => {
      const body = text.trim();
      if (!body || !owner) return;
      if (canReply) {
        await api.reply(key, owner, body, taskId);
        setReply("");
        return t("run_replySent", { agent: agentName(model, owner) });
      }
      if (sendable && runnerOf(model, target)) {
        await api.runTask(key, taskId, target, body);
        return t("run_sent", { task: taskId, agent: agentName(model, target) });
      }
      await copyText(body);
      return t("copied");
    });

  const event = (type: string) =>
    run(async () => {
      await api.addEvent(key, { task: taskId, type, agent: snap.agent ?? undefined });
    });

  const allow = (p: Problem) =>
    run(async () => {
      if (!owner || !runner || !p.tool || !p.issue) return;
      const rules = permissionRules(p.tool);
      const have = (runner.allowedTools ?? "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
      await api.saveRunner(key, owner, { allowedTools: [...have, ...rules.filter((r) => !have.includes(r))].join("\n") });
      await api.setIssueState(key, taskId, { ...p.issue, state: "resolved" });
      return t("problem_allowed", { agent: agentName(model, owner), rules: rules.join(", ") });
    });

  const close = (p: Problem, state: "resolved" | "ignored") =>
    run(async () => {
      if (!p.issue) return;
      await api.setIssueState(key, taskId, { ...p.issue, state });
      return t(state === "resolved" ? "problem_resolvedToast" : "problem_ignoredToast", { title: p.issue.title });
    });

  return (
    <div className="mini-quick" onClick={(e) => e.stopPropagation()}>
      <div className="mini-quick-head">
        <span className="mono">{taskId}</span>
        <span className={`pill ${snap.dispatchable ? "sendable" : s}`}>{snap.dispatchable ? t("sendable") : t(`status_${s}`)}</span>
        <span className="grow ellipsis" title={task.title}>
          {task.title}
        </span>
        {onOpenMain && (
          <button className="icon-btn" onClick={onOpenMain} title={t("openMain")} aria-label={t("openMain")}>
            ↗
          </button>
        )}
        <button className="icon-btn" onClick={onClose} aria-label={t("close")}>
          ✕
        </button>
      </div>

      {runHere && (
        <div className="mini-quick-run">
          <span className="pulse" aria-hidden="true" />
          <span className="mono">{formatDuration(now - Date.parse(runHere.startedAt))}</span>
          <span className="grow ellipsis">{runHere.lastActivity ?? t("run_state_running")}</span>
          <StopButton
            label={`■ ${t("run_stop")}`}
            confirmLabel={t("run_stopConfirm")}
            title={t("run_stopHint")}
            onStop={() => void run(() => stopRun(model, runHere, t))}
          />
        </div>
      )}

      {s === "blocked" && snap.reason && snap.reason !== "Waiting for your reply." && (
        <div className="small muted">{localReason(snap.reason, t)}</div>
      )}
      {said && (said.text || unreadReport) && (
        <div className="agent-says mini-says">
          {said.text && <Markdown text={said.text} />}
          {unreadReport && (
            <div className="report-note small">
              <span className="muted">{t("rep_inMessage")}</span>
              <button
                className="btn tiny"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await api.paste(key, unreadReport);
                    if (r.recorded === 0) throw new Error(r.errors.join("; ") || "—");
                    return t("rep_applied");
                  })
                }
              >
                {t("rep_apply")}
              </button>
            </div>
          )}
        </div>
      )}

      {problems.map((p, i) => (
        <div className={`mini-problem ${p.kind}`} key={`${p.title}-${i}`}>
          <div className="mini-problem-title">
            <span className="bang" aria-hidden="true">
              !
            </span>
            <span className="grow">{p.title}</span>
          </div>
          {p.detail && <div className="small muted clamp-2">{p.detail}</div>}
          <div className="row wrap">
            {p.tool && runner?.provider === "claude" && p.issue && (
              <button className="btn tiny primary" disabled={busy} title={t("problem_allowHint")} onClick={() => void allow(p)}>
                {t("problem_allow", { rules: permissionRules(p.tool).map((r) => r.replace(/^Bash\((.*):\*\)$/, "$1")).join(", ") })}
              </button>
            )}
            {p.fix && (canReply || (sendable && runnerOf(model, target))) && (
              <button className="btn tiny" disabled={busy} onClick={() => void say(p.fix)}>
                {t("fixSend")}
              </button>
            )}
            {p.command && (
              <button className="btn tiny" onClick={() => void copyText(p.command!).then(() => onInfo(t("copied")))}>
                {t("problem_copyCommand")}
              </button>
            )}
            {p.issue && (
              <>
                <span className="spacer" />
                <button className="btn tiny ghost" disabled={busy} title={t("problem_resolveHint")} onClick={() => void close(p, "resolved")}>
                  ✓ {t("problem_resolve")}
                </button>
                <button className="btn tiny ghost" disabled={busy} title={t("problem_ignoreHint")} onClick={() => void close(p, "ignored")}>
                  {t("problem_ignore")}
                </button>
              </>
            )}
          </div>
        </div>
      ))}

      {canReply && (
        <div className="mini-reply">
          <textarea
            className="input"
            rows={2}
            placeholder={s === "blocked" ? t("run_replyPlaceholder") : t("msg_placeholder")}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void say(reply);
            }}
          />
          <div className="row">
            {s === "blocked" && (
              <button className="btn tiny ghost" disabled={busy} onClick={() => void say(t("run_approveText"))}>
                {t("run_approve")}
              </button>
            )}
            <span className="spacer" />
            <button className="btn tiny primary" disabled={busy || !reply.trim()} onClick={() => void say(reply)}>
              {s === "blocked" ? t("run_reply") : t("msg_send")}
            </button>
          </div>
        </div>
      )}

      <div className="row wrap mini-quick-actions">
        {snap.dispatchable && target && (
          <button
            className="btn tiny primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const how = await dispatchTask(key, taskId, target, model.runners);
                return how === "run" ? t("run_sent", { task: taskId, agent: agentName(model, target) }) : t("copiedSent", { task: taskId });
              })
            }
          >
            {runnerOf(model, target) ? t("run_send", { agent: agentName(model, target) }) : t("copyAndSendShort")}
          </button>
        )}
        {s === "failed" && runnerOf(model, target) && (
          <button
            className="btn tiny primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.runTask(key, taskId, target);
                return t("run_sent", { task: taskId, agent: agentName(model, target) });
              })
            }
          >
            {t("run_send", { agent: agentName(model, target) })}
          </button>
        )}
        {s === "review" && (
          <button className="btn tiny primary" disabled={busy} onClick={() => void event("approved")}>
            {t("approve")}
          </button>
        )}
        {(s === "dispatched" || s === "in_progress" || s === "blocked") && !runHere && (
          <button className="btn tiny" disabled={busy} onClick={() => void event("done")}>
            {t("markDone")}
          </button>
        )}
        {(s === "blocked" || s === "failed" || s === "review" || s === "done") && !runHere && (
          <button className="btn tiny ghost" disabled={busy} onClick={() => void event("reopened")}>
            {t("reopen")}
          </button>
        )}
      </div>
    </div>
  );
}
