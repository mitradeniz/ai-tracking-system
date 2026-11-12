import type { TaskSnapshot } from "@aitrack/core";
import { useI18n } from "../i18n.ts";
import { agentName, cardNote, type Model } from "../model.ts";

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
  const classes = [
    "card",
    snap.status,
    snap.dispatchable ? "dispatchable" : "",
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
        <span className="spacer" />
        {showAgent && <span className="agent-chip">{agentName(model, who)}</span>}
        <span className={`pill ${snap.dispatchable ? "sendable" : snap.status}`}>
          {snap.dispatchable ? t("sendable") : t(`status_${snap.status}`)}
        </span>
      </div>
      <div className="title">{task.title}</div>
      {note && <div className="note">{note}</div>}
    </button>
  );
}
