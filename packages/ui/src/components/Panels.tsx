import type { TaskSnapshot } from "@aitrack/core";
import { useState } from "react";
import { api, dispatchTask } from "../api.ts";
import { useI18n } from "../i18n.ts";
import { agentName, cardNote, formatTime, problemsOf, runnerOf, type Model } from "../model.ts";
import { inChats } from "./Views.tsx";

interface PanelProps {
  model: Model;
  onOpen: (id: string) => void;
  onError: (message: string) => void;
  onInfo?: (message: string) => void;
  agents?: Set<string> | null;
}

function TaskRow({
  model,
  snap,
  onOpen,
  children,
}: {
  model: Model;
  snap: TaskSnapshot;
  onOpen: (id: string) => void;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const task = model.task.get(snap.id);
  const note = cardNote(model, snap, t);
  return (
    <div className={`task-row ${snap.dispatchable ? "sendable" : snap.status}`}>
      <button type="button" className="task-row-main" onClick={() => onOpen(snap.id)} title={task?.title}>
        <span className="mono id">{snap.id}</span>
        {problemsOf(model, snap, t).length > 0 && <span className="bang">!</span>}
        <span className="ellipsis">{task?.title}</span>
        <span className="small muted ellipsis">
          {agentName(model, snap.agent ?? task?.agent)}
          {note ? ` · ${note}` : ""}
        </span>
      </button>
      {children}
    </div>
  );
}

/** Everything that waits for the user: tasks to send, approvals, blocks and failures. */
export function InboxPanel({ model, onOpen, onError, onInfo, agents }: PanelProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const board = model.detail.board;
  if (!board) return null;
  const mine = board.tasks.filter((s) => inChats(model, s, agents));
  const groups: { key: string; title: string; items: TaskSnapshot[] }[] = [
    { key: "sendable", title: t("inbox_sendable"), items: mine.filter((s) => s.dispatchable).sort((a, b) => b.chain - a.chain) },
    { key: "review", title: t("inbox_review"), items: mine.filter((s) => s.status === "review") },
    { key: "blocked", title: t("inbox_blocked"), items: mine.filter((s) => s.status === "blocked") },
    { key: "failed", title: t("inbox_failed"), items: mine.filter((s) => s.status === "failed") },
    {
      key: "problems",
      title: t("problems"),
      items: mine.filter((s) => !["blocked", "failed"].includes(s.status) && problemsOf(model, s, t).length > 0),
    },
  ].filter((g) => g.items.length > 0);

  const run = async (id: string, fn: () => Promise<unknown>, message?: string) => {
    setBusy(id);
    try {
      await fn();
      if (message) onInfo?.(message);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (groups.length === 0) return <div className="panel-empty muted small">{t("inbox_empty")}</div>;
  return (
    <div className="stack">
      {groups.map((g) => (
        <section key={g.key} className="group">
          <h3>
            {g.title} · {g.items.length}
          </h3>
          {g.items.map((s) => (
            <TaskRow key={s.id} model={model} snap={s} onOpen={onOpen}>
              {g.key === "sendable" && s.candidates[0] && (
                <button
                  className="btn small primary"
                  disabled={busy === s.id}
                  onClick={() =>
                    run(s.id, async () => {
                      const agent = s.candidates[0]!;
                      const how = await dispatchTask(model.detail.key, s.id, agent, model.runners);
                      onInfo?.(how === "run" ? t("run_sent", { task: s.id, agent: agentName(model, agent) }) : t("copiedSent", { task: s.id }));
                    })
                  }
                >
                  {runnerOf(model, s.candidates[0]) ? `▶ ${t("sendable")}` : t("copyAndSendShort")}
                </button>
              )}
              {g.key === "review" && (
                <button
                  className="btn small"
                  disabled={busy === s.id}
                  onClick={() =>
                    run(s.id, () => api.addEvent(model.detail.key, { task: s.id, type: "approved", agent: s.agent ?? undefined }))
                  }
                >
                  {t("approve")}
                </button>
              )}
            </TaskRow>
          ))}
        </section>
      ))}
    </div>
  );
}

/** The latest events across all tasks. */
export function ActivityPanel({ model, onOpen, agents }: PanelProps) {
  const { t, lang } = useI18n();
  const events = [...model.detail.events]
    .filter((e) => {
      if (!agents) return true;
      const owner = model.task.get(e.task)?.agent;
      return (e.agent !== undefined && agents.has(e.agent)) || (owner !== undefined && agents.has(owner));
    })
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, 50);
  if (events.length === 0) return <div className="panel-empty muted small">{t("activity_empty")}</div>;
  return (
    <ul className="feed">
      {events.map((e) => (
        <li key={e.id}>
          <button type="button" onClick={() => onOpen(e.task)}>
            <span
              className={`status-dot ${e.type === "approved" || e.type === "done" ? "done" : e.type === "started" || e.type === "dispatched" ? "in_progress" : e.type}`}
            />
            <span className="mono">{e.task}</span>
            <span>{t(`type_${e.type}`)}</span>
            {e.agent && <span className="muted">{agentName(model, e.agent)}</span>}
            <span className="spacer" />
            <span className="small muted">{formatTime(e.ts, lang)}</span>
          </button>
          {(e.reason || e.message) && <div className="small muted feed-text">{e.reason ?? e.message}</div>}
        </li>
      ))}
    </ul>
  );
}

function Bar({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Done per milestone and per chat. */
export function ProgressPanel({ model }: PanelProps) {
  const { t } = useI18n();
  const project = model.detail.project;
  const board = model.detail.board;
  if (!project || !board) return null;
  const isDone = (id: string) => model.snap.get(id)?.status === "done";
  const all = project.tasks;
  const doneAll = all.filter((x) => isDone(x.id)).length;

  return (
    <div className="stack">
      <section className="group">
        <h3>{t("progress_overall")}</h3>
        <div className="progress-row">
          <span>{t("doneOf", { done: doneAll, total: all.length })}</span>
          <Bar done={doneAll} total={all.length} />
        </div>
      </section>
      {project.milestones.length > 0 && (
        <section className="group">
          <h3>{t("progress_milestones")}</h3>
          {project.milestones.map((m) => {
            const tasks = all.filter((x) => x.milestone === m.id);
            const done = tasks.filter((x) => isDone(x.id)).length;
            return (
              <div className="progress-row" key={m.id}>
                <span className="ellipsis" title={m.name}>
                  {m.name}
                  {m.date && <span className="muted small"> · {m.date}</span>}
                </span>
                <span className="small muted nowrap">
                  {done}/{tasks.length}
                </span>
                <Bar done={done} total={tasks.length} />
              </div>
            );
          })}
        </section>
      )}
      <section className="group">
        <h3>{t("progress_chats")}</h3>
        {project.agents.map((a) => {
          const tasks = all.filter((x) => x.agent === a.id);
          const done = tasks.filter((x) => isDone(x.id)).length;
          const av = board.agents.find((x) => x.id === a.id);
          return (
            <div className="progress-row" key={a.id}>
              <span className="ellipsis">
                {a.name}
                {av && av.holding.length > 0 && <span className="muted small"> · {av.holding.join(", ")}</span>}
              </span>
              <span className="small muted nowrap">
                {done}/{tasks.length}
              </span>
              <Bar done={done} total={tasks.length} />
            </div>
          );
        })}
      </section>
    </div>
  );
}
