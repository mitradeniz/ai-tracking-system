import type { TaskSnapshot } from "@aitrack/core";
import { useI18n } from "../i18n.ts";
import {
  agentName,
  cardNote,
  formatDuration,
  problemsOf,
  shownStatus,
  type Model,
} from "../model.ts";
import { Bang, useNow } from "./Info.tsx";

interface Props {
  model: Model;
  snap: TaskSnapshot;
  onOpen: (id: string) => void;
  showAgent?: boolean;
  highlight?: "self" | "related" | null;
  onHover?: (id: string | null) => void;
}

export function TaskCard({ model, snap, onOpen, showAgent, highlight, onHover }: Props) {
  const { t } = useI18n();
  const task = model.task.get(snap.id);
  if (!task) return null;
  const note = cardNote(model, snap, t);
  const problems = problemsOf(model, snap, t);
  const run = model.runners?.runs.find((r) => r.task === snap.id && r.state === "running");
  const now = useNow(Boolean(run));
  const classes = [
    "card",
    shownStatus(snap),
    snap.dispatchable ? "dispatchable" : "",
    problems.length > 0 ? "has-problems" : "",
    highlight === "self" ? "highlight" : highlight === "related" ? "related" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const who = snap.agent ?? task.agent;

  return (
    <button
      type="button"
      className={classes}
      onClick={() => onOpen(snap.id)}
      onMouseEnter={() => onHover?.(snap.id)}
      onMouseLeave={() => onHover?.(null)}
      title={task.title}
    >
      <div className="top">
        <span className="id">{task.id}</span>
        {snap.critical && (
          <span className="crit" title={t("critical")}>
            ●
          </span>
        )}
        {problems.length > 0 && <Bang n={problems.length} title={problems.map((p) => p.title).join("\n")} />}
        <span className="spacer" />
        {run && (
          <span className="run-time mono" title={run.lastActivity}>
            <span className="pulse" aria-hidden="true" />
            {formatDuration(now - Date.parse(run.startedAt))}
          </span>
        )}
        {showAgent && <span className="agent-chip">{agentName(model, who)}</span>}
        <span className={`pill ${snap.dispatchable ? "sendable" : shownStatus(snap)}`}>
          {snap.dispatchable ? t("sendable") : t(`status_${shownStatus(snap)}`)}
        </span>
      </div>
      <div className="title">{task.title}</div>
      {note && <div className="note">{note}</div>}
    </button>
  );
}
