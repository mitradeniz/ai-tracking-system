import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Activity, type ProjectDetail, type ProjectSummary, type RunLogEvent, type RunnerState } from "./api.ts";

/** Live run output, for components that show a run's log. */
export const RUNLOG_EVENT = "aitrack:runlog";

/**
 * Projects and the selected project's detail, kept live through server-sent events with a slow
 * poll as a safety net. Shared by the main window and the floating window.
 */
export function useTracker(selected: string | null, onActivity?: (a: Activity) => void, onError?: (message: string) => void) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [live, setLive] = useState(false);
  const [runners, setRunners] = useState<RunnerState | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await api.projects());
      setLoaded(true);
    } catch (e) {
      errorRef.current?.((e as Error).message);
    }
  }, []);

  const loadDetail = useCallback(async (key: string | null) => {
    if (!key) {
      setDetail(null);
      return;
    }
    try {
      const d = await api.project(key);
      if (selectedRef.current === key) setDetail(d);
    } catch {
      if (selectedRef.current === key) setDetail(null);
    }
  }, []);

  const loadRunners = useCallback(async (key: string | null) => {
    if (!key) {
      setRunners(null);
      return;
    }
    try {
      const r = await api.runners(key);
      if (selectedRef.current === key) setRunners(r);
    } catch {
      if (selectedRef.current === key) setRunners(null);
    }
  }, []);

  const refresh = useCallback(() => {
    void loadProjects();
    void loadDetail(selectedRef.current);
    void loadRunners(selectedRef.current);
  }, [loadProjects, loadDetail, loadRunners]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void loadDetail(selected);
    void loadRunners(selected);
  }, [selected, loadDetail, loadRunners]);

  useEffect(() => {
    let timer: number | undefined;
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 120);
    };
    const source = new EventSource("/api/stream");
    source.addEventListener("hello", () => setLive(true));
    source.addEventListener("changed", soon);
    source.addEventListener("activity", (msg) => {
      try {
        activityRef.current?.(JSON.parse((msg as MessageEvent<string>).data) as Activity);
      } catch {
        // Ignore malformed activity.
      }
    });
    let runnersTimer: number | undefined;
    const runnersSoon = () => {
      window.clearTimeout(runnersTimer);
      runnersTimer = window.setTimeout(() => void loadRunners(selectedRef.current), 120);
    };
    source.addEventListener("run", runnersSoon);
    source.addEventListener("runners", runnersSoon);
    source.addEventListener("runlog", (msg) => {
      try {
        const data = JSON.parse((msg as MessageEvent<string>).data) as RunLogEvent;
        window.dispatchEvent(new CustomEvent<RunLogEvent>(RUNLOG_EVENT, { detail: data }));
        if (data.lastActivity && data.key === selectedRef.current) {
          setRunners((r) =>
            r ? { ...r, runs: r.runs.map((x) => (x.id === data.runId ? { ...x, lastActivity: data.lastActivity } : x)) } : r,
          );
        }
      } catch {
        // Ignore malformed output.
      }
    });
    source.onerror = () => setLive(false);
    const poll = window.setInterval(refresh, 15000);
    return () => {
      source.close();
      window.clearInterval(poll);
      window.clearTimeout(timer);
      window.clearTimeout(runnersTimer);
    };
  }, [refresh, loadRunners]);

  return { projects, loaded, detail, live, refresh, runners };
}
