import { useCallback, useEffect, useState } from "react";

/**
 * Per-user preferences in localStorage. Every window of the app (main window, floating window)
 * shares them, and a change in one window reaches the others through the `storage` event.
 */

const PREFIX = "aitrack.";
const SAME_WINDOW_EVENT = "aitrack:pref";

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage unavailable: preferences are a convenience.
  }
  window.dispatchEvent(new CustomEvent(SAME_WINDOW_EVENT, { detail: key }));
}

/** A preference as React state, kept in sync across components and windows. */
export function usePref<T>(key: string, fallback: T, normalize: (v: T) => T = (v) => v): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => normalize(readJson(key, fallback)));

  useEffect(() => {
    const reload = () => setValue(normalize(readJson(key, fallback)));
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFIX + key) reload();
    };
    const onLocal = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) reload();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(SAME_WINDOW_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SAME_WINDOW_EVENT, onLocal);
    };
    // fallback and normalize are stable for a given key in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      const current = normalize(readJson(key, fallback));
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(current) : next;
      writeJson(key, resolved);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return [value, update];
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
