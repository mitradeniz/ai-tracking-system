import { useCallback, useEffect, useRef, useState } from "react";
import { api, desktop, type UpdateInfo, type UpdateProgress } from "./api.ts";
import { usePref } from "./prefs.ts";

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * In-app updates: checks the clone the app was installed from, on start and every six hours, and
 * runs the updater on request (or by itself when automatic install is on and no chat is running).
 */
export function useUpdates(onResult?: (kind: "done" | "failed", progress: UpdateProgress) => void) {
  const bridge = desktop?.updates;
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoCheck, setAutoCheck] = usePref<boolean>("updateAutoCheck", true);
  const [autoInstall, setAutoInstall] = usePref<boolean>("updateAutoInstall", false);
  const [seenAt, setSeenAt] = usePref<string>("updateSeenAt", "");
  const resultRef = useRef(onResult);
  resultRef.current = onResult;

  const check = useCallback(async () => {
    if (!bridge) return null;
    setChecking(true);
    setError(null);
    try {
      const next = await bridge.check();
      setInfo(next);
      return next;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setChecking(false);
    }
  }, [bridge]);

  const refreshProgress = useCallback(async () => {
    if (!bridge) return null;
    try {
      const p = await bridge.progress();
      setProgress(p);
      return p;
    } catch {
      return null;
    }
  }, [bridge]);

  const run = useCallback(async () => {
    if (!bridge) return false;
    setError(null);
    const res = await bridge.run();
    if (!res.ok) {
      setError(res.error ?? "error");
      return false;
    }
    setProgress({ state: "running", message: "", log: [] });
    return true;
  }, [bridge]);

  // The result of the last update, once: shown after the app reopened (or when it failed).
  useEffect(() => {
    void refreshProgress().then((p) => {
      if (!p?.at || (p.state !== "done" && p.state !== "failed") || p.at <= seenAt) return;
      setSeenAt(p.at);
      resultRef.current?.(p.state, p);
    });
    // Only on start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow a running update.
  useEffect(() => {
    if (progress?.state !== "running") return;
    const id = window.setInterval(() => {
      void refreshProgress().then((p) => {
        if (p && p.state === "failed" && p.at && p.at > seenAt) {
          setSeenAt(p.at);
          resultRef.current?.("failed", p);
        }
      });
    }, 1500);
    return () => window.clearInterval(id);
  }, [progress?.state, refreshProgress, seenAt, setSeenAt]);

  // Check on start and every six hours.
  useEffect(() => {
    if (!bridge || !autoCheck) return;
    void check();
    const id = window.setInterval(() => void check(), SIX_HOURS);
    return () => window.clearInterval(id);
  }, [bridge, autoCheck, check]);

  // Install by itself when allowed and nothing is running.
  useEffect(() => {
    if (!autoInstall || info?.state !== "available" || progress?.state === "running") return;
    let cancelled = false;
    void api.activeRuns().then((n) => {
      if (!cancelled && n === 0) void run();
    });
    return () => {
      cancelled = true;
    };
  }, [autoInstall, info?.state, progress?.state, run]);

  return {
    supported: Boolean(bridge),
    info,
    checking,
    progress,
    error,
    check,
    run,
    autoCheck,
    setAutoCheck,
    autoInstall,
    setAutoInstall,
  };
}

export type Updates = ReturnType<typeof useUpdates>;
