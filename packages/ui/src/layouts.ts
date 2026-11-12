import { newId, usePref } from "./prefs.ts";

/** Building blocks of a screen. */
export type PanelKind = "ready" | "lanes" | "flow" | "list" | "inbox" | "activity" | "progress";
export type PanelWidth = 3 | 4 | 6 | 8 | 9 | 12;
export type PanelHeight = "auto" | "s" | "m" | "l" | "fill";

export interface Panel {
  id: string;
  kind: PanelKind;
  width: PanelWidth;
  height: PanelHeight;
  /** Chats to show, per project id. Missing or empty means every chat. */
  agents?: Record<string, string[]>;
}

export interface Layout {
  id: string;
  name: string;
  panels: Panel[];
}

export const PANEL_KINDS: PanelKind[] = ["inbox", "ready", "lanes", "flow", "list", "activity", "progress"];
export const PANEL_WIDTHS: PanelWidth[] = [3, 4, 6, 8, 9, 12];
export const PANEL_HEIGHTS: PanelHeight[] = ["auto", "s", "m", "l", "fill"];

/** Panels that draw their own glass surfaces and sit on the page without a frame. */
export const BARE_PANELS = new Set<PanelKind>(["ready", "lanes", "flow"]);
/** Panels that can be limited to some chats. */
export const FILTERABLE = new Set<PanelKind>(["lanes", "flow", "list", "inbox", "activity", "ready"]);

const panel = (kind: PanelKind, width: PanelWidth = 12, height: PanelHeight = "auto", id: string = newId("p")): Panel => ({
  id,
  kind,
  width,
  height,
});

/** Built-in layouts. Their name is empty so the UI shows it in the current language until renamed. */
export function defaultLayouts(): Layout[] {
  return [
    { id: "lanes", name: "", panels: [panel("ready", 12, "auto", "lanes-ready"), panel("lanes", 12, "auto", "lanes-lanes")] },
    {
      id: "overview",
      name: "",
      panels: [
        panel("inbox", 6, "m", "overview-inbox"),
        panel("progress", 6, "m", "overview-progress"),
        panel("activity", 12, "m", "overview-activity"),
      ],
    },
    { id: "flow", name: "", panels: [panel("ready", 12, "auto", "flow-ready"), panel("flow", 12, "auto", "flow-flow")] },
    { id: "list", name: "", panels: [panel("list", 12, "auto", "list-list")] },
  ];
}

function validPanel(p: Partial<Panel>): p is Panel {
  return (
    typeof p?.id === "string" &&
    PANEL_KINDS.includes(p.kind as PanelKind) &&
    PANEL_WIDTHS.includes(p.width as PanelWidth) &&
    PANEL_HEIGHTS.includes(p.height as PanelHeight)
  );
}

export function useLayouts(defaults: () => Layout[]): [Layout[], (next: Layout[] | ((prev: Layout[]) => Layout[])) => void] {
  const [stored, setStored] = usePref<Layout[] | null>("layouts", null);
  const layouts =
    Array.isArray(stored) && stored.length > 0
      ? stored
          .filter((l) => l && typeof l.id === "string" && typeof l.name === "string" && Array.isArray(l.panels))
          .map((l) => ({ ...l, panels: l.panels.filter(validPanel) }))
      : defaults();
  const update = (next: Layout[] | ((prev: Layout[]) => Layout[])) =>
    setStored((prev) => {
      const current = Array.isArray(prev) && prev.length > 0 ? prev : defaults();
      return typeof next === "function" ? next(current) : next;
    });
  return [layouts.length > 0 ? layouts : defaults(), update];
}

export function newPanel(kind: PanelKind): Panel {
  const wide = kind === "lanes" || kind === "flow" || kind === "list" || kind === "ready";
  return panel(kind, wide ? 12 : 6, wide ? "auto" : "m");
}

export function newLayout(name: string): Layout {
  return { id: newId("l"), name, panels: [panel("ready"), panel("lanes")] };
}

export function movePanel(panels: Panel[], from: number, to: number): Panel[] {
  if (from === to || from < 0 || to < 0 || from >= panels.length || to >= panels.length) return panels;
  const next = [...panels];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** Chats a panel shows for the given project; null means all. */
export function panelAgents(p: { agents?: Record<string, string[]> }, projectId: string, known: string[]): Set<string> | null {
  const list = (p.agents?.[projectId] ?? []).filter((a) => known.includes(a));
  return list.length > 0 ? new Set(list) : null;
}
