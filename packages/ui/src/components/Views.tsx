import { useMemo, useState } from "react";
import type { TaskSnapshot } from "@aitrack/core";
import { api, copyText } from "../api.ts";
import { useI18n } from "../i18n.ts";
import { activeRun, agentName, cardNote, formatTime, helpedChats, type Model } from "../model.ts";
import { RunnerBadge } from "./Runners.tsx";
import { TaskCard } from "./TaskCard.tsx";

interface ViewProps {
  model: Model;
  onOpen: (id: string) => void;
  onError: (message: string) => void;
  /** Only these chats; null or undefined means every chat. */
  agents?: Set<string> | null;
}

/** True when a task belongs to one of the chats (as owner or as the chat holding it now). */
export function inChats(model: Model, s: TaskSnapshot, agents: Set<string> | null | undefined): boolean {
  if (!agents) return true;
  const owner = model.task.get(s.id)?.agent;
  return (owner !== undefined && agents.has(owner)) || (s.agent !== null && s.agent !== undefined && agents.has(s.agent));
}

function byUrgency(model: Model) {
  const order = model.detail.board?.order ?? [];
  return (a: TaskSnapshot, b: TaskSnapshot) => b.chain - a.chain || order.indexOf(a.id) - order.indexOf(b.id);
}

/** Waiting work reads best in the order it can start: dependency step first, then urgency. */
function byStep(model: Model) {
  const urgency = byUrgency(model);
  return (a: TaskSnapshot, b: TaskSnapshot) => a.layer - b.layer || urgency(a, b);
}

export function ReadyStrip({ model, onOpen, agents }: Omit<ViewProps, "onError">) {
  const { t } = useI18n();
  const groups = (model.detail.board?.agents ?? []).filter((a) => a.dispatchable.length > 0 && (!agents || agents.has(a.id)));
  return (
    <div className="ready-strip" aria-live="polite">
      <span className="label">{t("readyNow")}</span>
      {groups.length === 0 && <span className="muted small">{t("nothingReady")}</span>}
      {groups.map((g) => (
        <div className="ready-group" key={g.id}>
          <span className="who">{agentName(model, g.id)} →</span>
          {g.dispatchable.map((id) => (
            <button key={id} className="chip-task" onClick={() => onOpen(id)} title={model.task.get(id)?.title}>
              {id}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export function LanesView({
  model,
  onOpen,
  onError,
  onEditAgent,
  onRunnerSettings,
  agents,
}: ViewProps & { onEditAgent: (agentId?: string) => void; onRunnerSettings?: (agentId: string) => void }) {
  const { t } = useI18n();
  const [showDone, setShowDone] = useState<Record<string, boolean>>({});
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const project = model.detail.project;
  const board = model.detail.board;
  if (!project || !board) return null;
  const urgency = byUrgency(model);
  const step = byStep(model);
  const shown = project.agents.filter((a) => !agents || agents.has(a.id));

  const copyPrompt = async (label: string, load: () => Promise<string>) => {
    try {
      await copyText(await load());
      setCopiedFor(label);
      window.setTimeout(() => setCopiedFor(null), 1500);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="lanes" style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(276px, 1fr)) 150px` }}>
      {shown.map((agent) => {
        const av = board.agents.find((a) => a.id === agent.id);
        const holding = (av?.holding ?? []).map((id) => model.snap.get(id)).filter((s): s is TaskSnapshot => Boolean(s));
        const sendable = (av?.dispatchable ?? []).map((id) => model.snap.get(id)).filter((s): s is TaskSnapshot => Boolean(s));
        const own = board.tasks.filter((s) => model.task.get(s.id)?.agent === agent.id);
        const readyBusy = own.filter((s) => s.status === "ready" && !s.dispatchable).sort(urgency);
        const waiting = own.filter((s) => s.status === "waiting").sort(step);
        const review = own.filter((s) => s.status === "review");
        const failed = own.filter((s) => s.status === "failed");
        const done = own.filter((s) => s.status === "done");
        const isIdle = av?.hasRoom ?? true;
        const helped = helpedChats(model.tasks, agent.id);
        const empty =
          holding.length + sendable.length + failed.length + review.length + readyBusy.length + waiting.length + done.length === 0;

        const section = (title: string, items: TaskSnapshot[], extra?: React.ReactNode) =>
          items.length > 0 && (
            <div className="lane-section">
              <h3>
                <span>
                  {title} · {items.length}
                </span>
                {extra}
              </h3>
              {items.map((s) => (
                <TaskCard key={s.id} model={model} snap={s} onOpen={onOpen} />
              ))}
            </div>
          );

        return (
          <section className="lane" key={agent.id} aria-label={agent.name}>
            <div className="lane-head">
              <div className="lane-title">
                {agent.color && <span className="agent-dot" style={{ background: agent.color }} aria-hidden="true" />}
                <strong>{agent.name}</strong>
                {agent.tool && !model.runners && <span className="badge">{agent.tool}</span>}
                {onRunnerSettings && <RunnerBadge model={model} agentId={agent.id} onClick={() => onRunnerSettings(agent.id)} />}
                <span className="spacer" />
                <span className={`badge ${isIdle ? "idle" : "busy"}`}>{isIdle ? t("idle") : t("busy")}</span>
                <button
                  className="icon-btn"
                  title={t("editAgent")}
                  aria-label={`${t("editAgent")}: ${agent.name}`}
                  onClick={() => onEditAgent(agent.id)}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              </div>
              {agent.role && <div className="small muted">{agent.role}</div>}
              {(() => {
                const run = activeRun(model, agent.id);
                return run ? (
                  <button className="run-line" onClick={() => onOpen(run.task)} title={run.lastActivity}>
                    <span className="pulse" aria-hidden="true" />
                    <span className="mono">{run.task}</span>
                    <span className="ellipsis">{run.lastActivity ?? t("run_state_running")}</span>
                  </button>
                ) : null;
              })()}
              {helped.length > 0 && (
                <div className="small muted">{t("helpsWith", { names: helped.map((h) => agentName(model, h)).join(", ") })}</div>
              )}
              <div className="lane-actions">
                {agent.bootstrapPrompts.length > 0 && (
                  <button
                    className="btn small"
                    title={t("bootstrapHint")}
                    onClick={() => copyPrompt(`boot-${agent.id}`, () => api.bootstrapPrompt(model.detail.key, agent.id))}
                  >
                    {copiedFor === `boot-${agent.id}` ? `✓ ${t("copied")}` : t("bootstrap")}
                  </button>
                )}
                {agent.quickPrompts.map((p) => (
                  <button
                    key={p}
                    className="btn small"
                    title={project.prompts[p]?.title ?? p}
                    onClick={() => copyPrompt(`${agent.id}-${p}`, () => api.libraryPrompt(model.detail.key, p))}
                  >
                    {copiedFor === `${agent.id}-${p}` ? `✓ ${t("copied")}` : p}
                  </button>
                ))}
              </div>
            </div>
            {section(t("now"), holding)}
            {section(t("sendable"), sendable)}
            {section(t("failed"), failed)}
            {section(t("inReview"), review)}
            {section(t("readyBusy"), readyBusy)}
            {section(t("upcoming"), waiting)}
            {done.length > 0 && (
              <div className="lane-section">
                <h3>
                  <span>
                    {t("doneN")} · {done.length}
                  </span>
                  <button onClick={() => setShowDone({ ...showDone, [agent.id]: !showDone[agent.id] })}>
                    {showDone[agent.id] ? t("hide") : t("showAll")}
                  </button>
                </h3>
                {showDone[agent.id] && done.map((s) => <TaskCard key={s.id} model={model} snap={s} onOpen={onOpen} />)}
              </div>
            )}
            {empty && <div className="lane-empty small muted">{helped.length > 0 ? t("laneEmptyHelper") : t("laneEmpty")}</div>}
            <div style={{ height: 8 }} />
          </section>
        );
      })}
      <button className="lane add-lane" onClick={() => onEditAgent()}>
        <span className="plus" aria-hidden="true">
          +
        </span>
        {t("addAgent")}
      </button>
    </div>
  );
}

export function FlowView({ model, onOpen, agents }: Omit<ViewProps, "onError">) {
  const { t } = useI18n();
  const [hover, setHover] = useState<string | null>(null);
  const board = model.detail.board;
  const related = useMemo(() => {
    if (!hover) return new Set<string>();
    const task = model.task.get(hover);
    return new Set([...(task?.dependsOn ?? []), ...(model.snap.get(hover)?.dependents ?? [])]);
  }, [hover, model]);
  if (!board) return null;
  const columns: TaskSnapshot[][] = Array.from({ length: board.layers }, () => []);
  const order = board.order;
  for (const s of [...board.tasks].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))) {
    if (inChats(model, s, agents)) columns[s.layer]?.push(s);
  }

  return (
    <div className="flow">
      {columns.map(
        (col, i) =>
          col.length > 0 && (
            <div className="flow-col" key={i}>
              <h3>
                {t("layer")} {i + 1}
              </h3>
              {col.map((s) => (
                <TaskCard
                  key={s.id}
                  model={model}
                  snap={s}
                  onOpen={onOpen}
                  showAgent
                  onHover={setHover}
                  highlight={hover === s.id ? "self" : related.has(s.id) ? "related" : null}
                />
              ))}
            </div>
          ),
      )}
    </div>
  );
}

export function ListView({ model, onOpen, agents }: Omit<ViewProps, "onError">) {
  const { t, lang } = useI18n();
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState("");
  const [status, setStatus] = useState("");
  const board = model.detail.board;
  const project = model.detail.project;
  if (!board || !project) return null;
  const statuses = ["ready", "waiting", "dispatched", "in_progress", "blocked", "review", "failed", "done"] as const;
  const rows = board.tasks.filter((s) => {
    const task = model.task.get(s.id);
    if (!task) return false;
    if (!inChats(model, s, agents)) return false;
    if (agent && task.agent !== agent && s.agent !== agent) return false;
    if (status && s.status !== status) return false;
    if (q && !`${task.id} ${task.title}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <div>
      <div className="filters">
        <input className="input" placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("search")} />
        <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label={t("chat")}>
          <option value="">{t("allChats")}</option>
          {project.agents
            .filter((a) => !agents || agents.has(a.id))
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("status")}>
          <option value="">{t("allStatuses")}</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {t(`status_${s}`)}
            </option>
          ))}
        </select>
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>{t("task")}</th>
            <th>{t("title")}</th>
            <th>{t("chat")}</th>
            <th>{t("status")}</th>
            <th>{t("dependsOn")}</th>
            <th>{t("milestone")}</th>
            <th>{t("updated")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const task = model.task.get(s.id)!;
            return (
              <tr key={s.id} className={s.dispatchable ? "dispatchable" : ""} onClick={() => onOpen(s.id)}>
                <td className="mono">{s.id}</td>
                <td>
                  {task.title}
                  <div className="small muted">{cardNote(model, s, t)}</div>
                </td>
                <td>{agentName(model, s.agent ?? task.agent)}</td>
                <td>
                  <span className={`pill ${s.dispatchable ? "sendable" : s.status}`}>
                    {s.dispatchable ? t("sendable") : t(`status_${s.status}`)}
                  </span>
                </td>
                <td className="mono small">{task.dependsOn.join(", ")}</td>
                <td className="small">{task.milestone ?? ""}</td>
                <td className="small muted">{formatTime(s.updatedAt, lang)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
