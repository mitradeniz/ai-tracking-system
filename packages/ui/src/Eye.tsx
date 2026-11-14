import { useEffect, useMemo, useState } from "react";
import { api, desktop } from "./api.ts";
import { ManagerEye } from "./components/ManagerEye.tsx";
import { useTracker } from "./hooks.ts";
import { chosenLang, I18nContext, initialLang, translator, type Lang } from "./i18n.ts";
import { buildModel } from "./model.ts";
import { usePref } from "./prefs.ts";

/**
 * The desktop app's eye window: a transparent, always-on-top window with only the manager's eye.
 * It watches the project open in the main window when a manager runs it, otherwise the first
 * project a manager runs.
 */
export function EyeApp() {
  const [selected] = usePref<string | null>("selectedProject", null);
  const [key, setKey] = useState<string | null>(null);
  const { projects, detail, runners } = useTracker(key);
  const managed = Boolean(runners?.manager?.settings.enabled);

  useEffect(() => {
    document.documentElement.dataset.eye = "1";
  }, []);

  // Which project to watch; looked up again when the list or the manager changes, and now and then.
  useEffect(() => {
    let alive = true;
    const pick = async () => {
      const list = projects.length ? projects : await api.projects().catch(() => []);
      const order = [...list].sort((a, b) => (a.key === selected ? -1 : b.key === selected ? 1 : 0));
      for (const p of order) {
        try {
          const r = await api.runners(p.key);
          if (r.manager?.settings.enabled) {
            if (alive) setKey(p.key);
            return;
          }
        } catch {
          // A project that cannot be read now is skipped.
        }
      }
      if (alive) setKey(null);
    };
    void pick();
    const id = window.setInterval(() => void pick(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [projects, selected, managed]);

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
          onOpenTask={(id) => void desktop?.focusMain?.(model.detail.key, id)}
          onOpenManager={() => void desktop?.focusMain?.(model.detail.key)}
        />
      )}
    </I18nContext.Provider>
  );
}
