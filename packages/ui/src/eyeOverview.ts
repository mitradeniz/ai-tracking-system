import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ProjectSummary, type RunSummary } from "./api.ts";
import type { T } from "./i18n.ts";
import { agentName, buildModel, problemsOf } from "./model.ts";

/** One project a manager runs, as the eye's tabs show it. */
export interface EyeProject {
  key: string;
  name: string;
  /** Share of the tasks that are done. */
  pct: number;
  /** Tasks that failed or have problems that need someone. */
  problems: number;
  /** Runs going on now, with the chat's name and the task's title. */
  running: Array<{ run: RunSummary; agent: string; title: string }>;
}

/**
 * Every project a manager runs, kept up to date for the eye: its progress, its problems and what
 * runs there. A project's numbers are read again when the tracker says it changed, and now and then.
 */
export function useEyeOverview(projects: ProjectSummary[], t: T, enabled = true): EyeProject[] {
  const [byKey, setByKey] = useState<Map<string, EyeProject>>(new Map());
  const tRef = useRef(t);
  tRef.current = t;
  const keys = useMemo(() => projects.map((p) => p.key).join("\u0000"), [projects]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const list = keys ? keys.split("\u0000") : [];
    const load = async (key: string) => {
      try {
        const runners = await api.runners(key);
        if (!runners.manager?.settings.enabled) {
          if (alive) setByKey((m) => (m.has(key) ? withoutKey(m, key) : m));
          return;
        }
        const detail = await api.project(key);
        const model = buildModel(detail, runners);
        if (!model || !alive) return;
        const counts = model.detail.board?.counts;
        const total = counts?.total ?? 0;
        const problems = [...model.snap.values()].filter((s) => s.status === "failed" || problemsOf(model, s, tRef.current).length > 0).length;
        const running = runners.runs
          .filter((r) => r.state === "running")
          .map((run) => ({ run, agent: agentName(model, run.agent), title: model.task.get(run.task)?.title ?? "" }));
        const entry: EyeProject = {
          key,
          name: detail.project?.project.name ?? key,
          pct: total ? Math.round(((counts?.done ?? 0) / total) * 100) : 0,
          problems,
          running,
        };
        setByKey((m) => new Map(m).set(key, entry));
      } catch {
        // A project that cannot be read now keeps what was shown.
      }
    };
    for (const key of list) void load(key);
    setByKey((m) => {
      const gone = [...m.keys()].filter((k) => !list.includes(k));
      if (!gone.length) return m;
      const next = new Map(m);
      for (const k of gone) next.delete(k);
      return next;
    });

    // What changed where: read that project again, a moment later so a burst is read once.
    const due = new Set<string>();
    let timer: number | undefined;
    const soon = (key?: string) => {
      if (key && list.includes(key)) due.add(key);
      else for (const k of list) due.add(k);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const now = [...due];
        due.clear();
        for (const k of now) void load(k);
      }, 1200);
    };
    const keyOf = (msg: Event): string | undefined => {
      try {
        const data = JSON.parse((msg as MessageEvent<string>).data) as { key?: unknown };
        return typeof data.key === "string" ? data.key : undefined;
      } catch {
        return undefined;
      }
    };
    const source = new EventSource("/api/stream");
    for (const name of ["changed", "run", "runners"]) source.addEventListener(name, (msg) => soon(keyOf(msg)));
    const poll = window.setInterval(() => soon(), 30_000);
    return () => {
      alive = false;
      source.close();
      window.clearInterval(poll);
      window.clearTimeout(timer);
    };
  }, [keys, enabled]);

  return useMemo(() => projects.map((p) => byKey.get(p.key)).filter((x): x is EyeProject => Boolean(x)), [projects, byKey]);
}

function withoutKey<V>(m: Map<string, V>, key: string): Map<string, V> {
  const next = new Map(m);
  next.delete(key);
  return next;
}
