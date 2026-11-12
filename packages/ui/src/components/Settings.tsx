import { ACCENT_SWATCH, ACCENTS, type Appearance } from "../appearance.ts";
import { useI18n, type Lang } from "../i18n.ts";

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsDialog({
  appearance,
  onAppearance,
  lang,
  onLang,
  onResetLayouts,
  onClose,
}: {
  appearance: Appearance;
  onAppearance: (a: Appearance) => void;
  lang: Lang;
  onLang: (l: Lang) => void;
  onResetLayouts: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const set = <K extends keyof Appearance>(key: K, value: Appearance[K]) => onAppearance({ ...appearance, [key]: value });
  const light = document.documentElement.dataset.theme === "light";

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t("appearance")} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2>{t("appearance")}</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label={t("close")}>
            ✕
          </button>
        </div>
        <div className="settings-grid">
          <span className="setting-label">{t("theme")}</span>
          <Segmented
            label={t("theme")}
            value={appearance.theme}
            onChange={(v) => set("theme", v)}
            options={[
              { value: "dark", label: t("theme_dark") },
              { value: "light", label: t("theme_light") },
              { value: "system", label: t("theme_system") },
            ]}
          />
          <span className="setting-label">{t("accent")}</span>
          <div className="swatches" role="radiogroup" aria-label={t("accent")}>
            {ACCENTS.map((a) => (
              <button
                key={a}
                role="radio"
                aria-checked={appearance.accent === a}
                className="swatch"
                title={t(`accent_${a}`)}
                aria-label={t(`accent_${a}`)}
                onClick={() => set("accent", a)}
              >
                <span style={{ background: ACCENT_SWATCH[a][light ? 1 : 0] }} />
              </button>
            ))}
          </div>
          <span className="setting-label">{t("density")}</span>
          <Segmented
            label={t("density")}
            value={appearance.density}
            onChange={(v) => set("density", v)}
            options={[
              { value: "compact", label: t("density_compact") },
              { value: "comfortable", label: t("density_comfortable") },
            ]}
          />
          <span className="setting-label">{t("fontSize")}</span>
          <Segmented
            label={t("fontSize")}
            value={appearance.fontSize}
            onChange={(v) => set("fontSize", v)}
            options={[
              { value: "s", label: t("font_s") },
              { value: "m", label: t("font_m") },
              { value: "l", label: t("font_l") },
            ]}
          />
          <span className="setting-label">{t("glass")}</span>
          <Segmented
            label={t("glass")}
            value={appearance.glass}
            onChange={(v) => set("glass", v)}
            options={[
              { value: "low", label: t("glass_low") },
              { value: "medium", label: t("glass_medium") },
              { value: "high", label: t("glass_high") },
            ]}
          />
          <span className="setting-label">{lang === "tr" ? "Dil" : "Language"}</span>
          <Segmented
            label="Language"
            value={lang}
            onChange={onLang}
            options={[
              { value: "tr", label: "Türkçe" },
              { value: "en", label: "English" },
            ]}
          />
        </div>
        <div className="row">
          <button
            className="btn ghost danger small"
            onClick={() => {
              if (window.confirm(t("resetLayoutsConfirm"))) onResetLayouts();
            }}
          >
            {t("resetLayouts")}
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}
