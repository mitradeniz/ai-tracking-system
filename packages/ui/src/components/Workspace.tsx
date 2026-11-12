import { useState } from "react";
import { useI18n } from "../i18n.ts";
import {
  BARE_PANELS,
  FILTERABLE,
  movePanel,
  newPanel,
  PANEL_HEIGHTS,
  PANEL_KINDS,
  PANEL_WIDTHS,
  panelAgents,
  type Layout,
  type Panel,
  type PanelKind,
} from "../layouts.ts";
import type { Model } from "../model.ts";
import { ActivityPanel, InboxPanel, ProgressPanel } from "./Panels.tsx";
import { FlowView, LanesView, ListView, ReadyStrip } from "./Views.tsx";

interface Props {
  model: Model;
  layout: Layout;
  editing: boolean;
  onChange: (layout: Layout) => void;
  onOpen: (id: string) => void;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
  onEditAgent: (agentId?: string) => void;
}

/** A screen built from panels. In edit mode panels can be added, moved, resized, filtered and removed. */
export function Workspace({ model, layout, editing, onChange, onOpen, onError, onInfo, onEditAgent }: Props) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const project = model.detail.project;
  if (!project) return null;
  const projectId = project.project.id;
  const known = project.agents.map((a) => a.id);

  const update = (index: number, patch: Partial<Panel>) =>
    onChange({ ...layout, panels: layout.panels.map((p, i) => (i === index ? { ...p, ...patch } : p)) });

  const setAgents = (index: number, panel: Panel, ids: string[]) =>
    update(index, { agents: { ...(panel.agents ?? {}), [projectId]: ids } });

  const content = (p: Panel) => {
    const agents = panelAgents(p, projectId, known);
    const common = { model, onOpen, onError, agents };
    switch (p.kind) {
      case "ready":
        return <ReadyStrip {...common} />;
      case "lanes":
        return <LanesView {...common} onEditAgent={onEditAgent} />;
      case "flow":
        return <FlowView {...common} />;
      case "list":
        return <ListView {...common} />;
      case "inbox":
        return <InboxPanel {...common} onInfo={onInfo} />;
      case "activity":
        return <ActivityPanel {...common} />;
      case "progress":
        return <ProgressPanel {...common} />;
    }
  };

  return (
    <div className={`workspace ${editing ? "editing" : ""}`}>
      {layout.panels.map((p, i) => {
        const bare = BARE_PANELS.has(p.kind);
        const agents = panelAgents(p, projectId, known);
        const filterLabel = agents
          ? project.agents
              .filter((a) => agents.has(a.id))
              .map((a) => a.name)
              .join(", ")
          : t("allChats");
        return (
          <section
            key={p.id}
            className={`panel w-${p.width} h-${p.height} ${bare ? "bare" : "framed"} ${dragging === i ? "dragging" : ""}`}
            aria-label={t(`panel_${p.kind}`)}
            onDragOver={(e) => {
              if (dragging !== null) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging !== null) onChange({ ...layout, panels: movePanel(layout.panels, dragging, i) });
              setDragging(null);
            }}
          >
            {(!bare || editing) && (
              <header
                className="panel-head"
                draggable={editing}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  setDragging(i);
                }}
                onDragEnd={() => setDragging(null)}
                title={editing ? t("dragToMove") : undefined}
              >
                {editing && (
                  <span className="grip" aria-hidden="true">
                    ⋮⋮
                  </span>
                )}
                <span className="panel-title">{t(`panel_${p.kind}`)}</span>
                {agents && !editing && <span className="small muted ellipsis">{filterLabel}</span>}
                <span className="spacer" />
                {editing && (
                  <div className="panel-tools">
                    <button
                      className="icon-btn"
                      disabled={i === 0}
                      onClick={() => onChange({ ...layout, panels: movePanel(layout.panels, i, i - 1) })}
                      aria-label={t("moveEarlier")}
                      title={t("moveEarlier")}
                    >
                      ←
                    </button>
                    <button
                      className="icon-btn"
                      disabled={i === layout.panels.length - 1}
                      onClick={() => onChange({ ...layout, panels: movePanel(layout.panels, i, i + 1) })}
                      aria-label={t("moveLater")}
                      title={t("moveLater")}
                    >
                      →
                    </button>
                    <select
                      className="input tiny"
                      value={p.width}
                      onChange={(e) => update(i, { width: Number(e.target.value) as Panel["width"] })}
                      aria-label={t("width")}
                      title={t("width")}
                    >
                      {PANEL_WIDTHS.map((w) => (
                        <option key={w} value={w}>
                          ↔ {t(`w_${w}`)}
                        </option>
                      ))}
                    </select>
                    <select
                      className="input tiny"
                      value={p.height}
                      onChange={(e) => update(i, { height: e.target.value as Panel["height"] })}
                      aria-label={t("height")}
                      title={t("height")}
                    >
                      {PANEL_HEIGHTS.map((h) => (
                        <option key={h} value={h}>
                          ↕ {t(`h_${h}`)}
                        </option>
                      ))}
                    </select>
                    {FILTERABLE.has(p.kind) && (
                      <details className="menu">
                        <summary className="btn small" title={t("chatsFilter")}>
                          <span className="ellipsis">{filterLabel}</span>
                        </summary>
                        <div className="menu-pop">
                          {project.agents.map((a) => (
                            <label key={a.id} className="check plain">
                              <input
                                type="checkbox"
                                checked={agents?.has(a.id) ?? false}
                                onChange={(e) => {
                                  const current = new Set(agents ?? []);
                                  if (e.target.checked) current.add(a.id);
                                  else current.delete(a.id);
                                  setAgents(i, p, [...current]);
                                }}
                              />
                              {a.name}
                            </label>
                          ))}
                          <button className="btn small ghost" onClick={() => setAgents(i, p, [])}>
                            {t("allChats")}
                          </button>
                        </div>
                      </details>
                    )}
                    <button
                      className="icon-btn danger"
                      onClick={() => onChange({ ...layout, panels: layout.panels.filter((_, j) => j !== i) })}
                      aria-label={t("removePanel")}
                      title={t("removePanel")}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </header>
            )}
            <div className="panel-body">{content(p)}</div>
          </section>
        );
      })}
      {editing && (
        <div className="panel w-12 add-panel">
          {!adding ? (
            <button className="add-panel-btn" onClick={() => setAdding(true)}>
              <span className="plus">+</span> {t("addPanel")}
            </button>
          ) : (
            <div className="panel-picker">
              {PANEL_KINDS.map((kind: PanelKind) => (
                <button
                  key={kind}
                  className="picker-item"
                  onClick={() => {
                    onChange({ ...layout, panels: [...layout.panels, newPanel(kind)] });
                    setAdding(false);
                  }}
                >
                  <strong>{t(`panel_${kind}`)}</strong>
                  <span className="small muted">{t(`panelDesc_${kind}`)}</span>
                </button>
              ))}
              <button className="btn ghost small" onClick={() => setAdding(false)}>
                {t("cancel")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
