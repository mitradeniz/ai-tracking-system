import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Activity, type ProjectDetail, type ProjectSummary } from "./api.ts";

/**
 * Projects and the selected project's detail, kept live through server-sent events with a slow
 * poll as a safety net. Shared by the main window and the floating window.
 */
export function useTracker(selected: string | null, onActivity?: (a: Activity) => void, onError?: (message: string) => void) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [live, setLive] = useState(false);
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

  const refresh = useCallback(() => {
    void loadProjects();
    void loadDetail(selectedRef.current);
  }, [loadProjects, loadDetail]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void loadDetail(selected);
  }, [selected, loadDetail]);

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
    source.onerror = () => setLive(false);
    const poll = window.setInterval(refresh, 15000);
    return () => {
      source.close();
      window.clearInterval(poll);
      window.clearTimeout(timer);
    };
  }, [refresh]);

  return { projects, loaded, detail, live, refresh };
}
