import { useEffect } from "react";
import { usePref } from "./prefs.ts";

export type ThemeChoice = "dark" | "light" | "system";
export type Accent = "mono" | "clay" | "sand" | "sage" | "sky" | "lavender";
export type Density = "compact" | "comfortable";
export type FontSize = "s" | "m" | "l";
export type Glass = "low" | "medium" | "high";

export interface Appearance {
  theme: ThemeChoice;
  accent: Accent;
  density: Density;
  fontSize: FontSize;
  glass: Glass;
}

export const ACCENTS: Accent[] = ["mono", "clay", "sand", "sage", "sky", "lavender"];

/** Swatch colours for the settings dialog (dark theme value, light theme value). */
export const ACCENT_SWATCH: Record<Accent, [string, string]> = {
  mono: ["#f4f4f2", "#0a0a0a"],
  clay: ["#d97757", "#b5583a"],
  sand: ["#d8c08c", "#8a6a2a"],
  sage: ["#9cc2a6", "#3f6e50"],
  sky: ["#9fb9e0", "#3c5a8a"],
  lavender: ["#c2b6e3", "#5d4f8c"],
};

function legacyTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem("aitrack.theme");
    return t === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "dark",
  accent: "mono",
  density: "comfortable",
  fontSize: "m",
  glass: "medium",
};

function normalize(a: Partial<Appearance> | null): Appearance {
  const base = { ...DEFAULT_APPEARANCE, theme: legacyTheme() };
  const v = { ...base, ...(a ?? {}) };
  return {
    theme: ["dark", "light", "system"].includes(v.theme) ? v.theme : "dark",
    accent: ACCENTS.includes(v.accent) ? v.accent : "mono",
    density: v.density === "compact" ? "compact" : "comfortable",
    fontSize: ["s", "m", "l"].includes(v.fontSize) ? v.fontSize : "m",
    glass: ["low", "medium", "high"].includes(v.glass) ? v.glass : "medium",
  };
}

export function useAppearance(): [Appearance, (next: Appearance) => void] {
  const [raw, setRaw] = usePref<Partial<Appearance> | null>("appearance", null);
  const appearance = normalize(raw);
  return [appearance, (next) => setRaw(next)];
}

function systemTheme(): "dark" | "light" {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Applies the appearance to the document as data attributes that the stylesheet reads. */
export function useApplyAppearance(appearance: Appearance): void {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      root.dataset.theme = appearance.theme === "system" ? systemTheme() : appearance.theme;
      root.dataset.accent = appearance.accent;
      root.dataset.density = appearance.density;
      root.dataset.font = appearance.fontSize;
      root.dataset.glass = appearance.glass;
    };
    apply();
    if (appearance.theme !== "system") return;
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    query?.addEventListener("change", apply);
    return () => query?.removeEventListener("change", apply);
  }, [appearance.theme, appearance.accent, appearance.density, appearance.fontSize, appearance.glass]);
}
