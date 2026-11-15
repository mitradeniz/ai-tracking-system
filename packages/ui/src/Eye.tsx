import { useEffect, useMemo, useState } from "react";
import { desktop } from "./api.ts";
import { ManagerEye } from "./components/ManagerEye.tsx";
import { useEyeOverview } from "./eyeOverview.ts";
import { useTracker } from "./hooks.ts";
import { chosenLang, I18nContext, initialLang, translator, type Lang } from "./i18n.ts";
import { buildModel } from "./model.ts";
import { usePref } from "./prefs.ts";

/**
 * The desktop app's eye window: a transparent, always-on-top window with only the manager's eye.
 * It watches the project open in the main window when a manager runs it, otherwise the first
 * project a manager runs; with several, its tabs switch between them.
 */
export function EyeApp() {
  const [selected] = usePref<string | null>("selectedProject", null);
  // A project picked from the eye's tabs, until the main window opens another one.
  const [picked, setPicked] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const { projects, detail, runners } = useTracker(key);
  const lang0: Lang = chosenLang() ?? initialLang();
  const t0 = useMemo(() => translator(lang0), [lang0]);
  const overview = useEyeOverview(projects, t0);

  useEffect(() => {
    document.documentElement.dataset.eye = "1";
  }, []);
  useEffect(() => setPicked(null), [selected]);

  // Which project to watch: the one picked in the eye, else the one open in the main window when a
  // manager runs it, else the first project a manager runs.
  const managed = overview.map((p) => p.key);
  const want = picked && managed.includes(picked) ? picked : selected && managed.includes(selected) ? selected : (managed[0] ?? null);
  useEffect(() => {
    if (want !== key) setKey(want);
  }, [want, key]);

  const projectLang = detail?.project?.settings.language;
  const lang: Lang = chosenLang() ?? projectLang ?? initialLang();
  const t = useMemo(() => translator(lang), [lang]);
  const model = useMemo(() => (detail && runners && detail.key === key ? buildModel(detail, runners) : null), [detail, runners, key]);

  // Nothing to watch: the window stays hidden.
  useEffect(() => {
    if (!model) void desktop?.eyeSet?.({ visible: false });
  }, [model]);

  return (
    <I18nContext.Provider value={{ t, lang }}>
      {model && (
        <ManagerEye
          model={model}
          windowed
          projects={overview}
          onSwitch={setPicked}
          onOpenElsewhere={(k, id) => void desktop?.focusMain?.(k, id)}
          onOpenTask={(id) => void desktop?.focusMain?.(model.detail.key, id)}
          onOpenManager={() => void desktop?.focusMain?.(model.detail.key)}
        />
      )}
    </I18nContext.Provider>
  );
}
