import { useEffect, useRef } from "react";
import { api } from "../api.ts";
import { ACCENT_SWATCH, ACCENTS, type Appearance } from "../appearance.ts";
import { useI18n, type Key, type Lang } from "../i18n.ts";
import type { Updates } from "../updates.ts";
import { useEscape } from "./Dialogs.tsx";
import { InfoTip } from "./Info.tsx";

export function Segmented<T extends string>({
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
  updates,
  focusUpdates,
  onTour,
}: {
  appearance: Appearance;
  onAppearance: (a: Appearance) => void;
  lang: Lang;
  onLang: (l: Lang) => void;
  onResetLayouts: () => void;
  onClose: () => void;
  updates?: Updates;
  /** Opened from "Check for updates": scroll to that section. */
  focusUpdates?: boolean;
  /** Shows the intro again. */
  onTour?: () => void;
}) {
  const { t } = useI18n();
  const set = <K extends keyof Appearance>(key: K, value: Appearance[K]) => onAppearance({ ...appearance, [key]: value });
  const light = document.documentElement.dataset.theme === "light";
  const updatesRef = useRef<HTMLElement>(null);
  useEscape(onClose);
  useEffect(() => {
    if (focusUpdates) updatesRef.current?.scrollIntoView({ block: "start" });
  }, [focusUpdates]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t("settings")} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2>{t("settings")}</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label={t("close")}>
            ✕
          </button>
        </div>
        <h3 className="settings-h">{t("appearance")}</h3>
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
        <section className="updates" ref={updatesRef}>
          <h3 className="settings-h">
            {t("updates")} <InfoTip text={t("upd_howItWorks")} />
          </h3>
          {updates ? <UpdatesSection updates={updates} /> : <div className="small muted">{t("upd_browserOnly")}</div>}
        </section>
        <div className="row">
          <button
            className="btn ghost danger small"
            onClick={() => {
              if (window.confirm(t("resetLayoutsConfirm"))) onResetLayouts();
            }}
          >
            {t("resetLayouts")}
          </button>
          {onTour && (
            <button className="btn ghost small" onClick={onTour}>
              {t("tour_replay")}
            </button>
          )}
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Settings → Updates: this version, what is new on GitHub, and the button that installs it. */
function UpdatesSection({ updates }: { updates: Updates }) {
  const { t, lang } = useI18n();
  const { info, checking, progress, error, check, run, autoCheck, setAutoCheck, autoInstall, setAutoInstall } = updates;
  const running = progress?.state === "running";
  const date = (iso?: string) => (iso ? new Date(iso).toLocaleString(lang === "tr" ? "tr-TR" : "en-US", { dateStyle: "medium", timeStyle: "short" }) : "");
  const reason = info?.reason ? t(`upd_reason_${info.reason}` as Key) : "";
  return (
    <div className="updates-body">
      {info?.current && (
        <div className="update-version">
          <span className="setting-label">{t("upd_version")}</span>
          <span>
            <span className="mono">{info.current.sha}</span> · {info.current.subject}
            <span className="small muted"> · {date(info.current.date)}</span>
          </span>
        </div>
      )}
      <div className={`update-status ${info?.state ?? ""}`}>
        {running ? (
          <>
            <span className="pulse" aria-hidden="true" />
            <b>{t("upd_running")}</b>
            <span className="small muted">{progress?.message}</span>
          </>
        ) : checking ? (
          <span className="muted">{t("upd_checking")}</span>
        ) : info?.state === "available" ? (
          <b>↑ {t("upd_available", { n: info.behind })}</b>
        ) : info?.state === "current" ? (
          <span>✓ {t("upd_current")}</span>
        ) : info ? (
          <span className="warn-text">{reason || info.detail}</span>
        ) : (
          <span className="muted">—</span>
        )}
        <span className="spacer" />
        {!running && (
          <button className="btn small" disabled={checking} onClick={() => void check()}>
            {t("upd_check")}
          </button>
        )}
        {info?.state === "available" && !running && (
          <button
            className="btn small primary"
            onClick={async () => {
              const active = await api.activeRuns().catch(() => 0);
              if (active > 0 && !window.confirm(t("upd_confirmRuns", { n: active }))) return;
              void run();
            }}
          >
            {t("upd_run")}
          </button>
        )}
      </div>
      {info?.state === "current" && info.ahead > 0 && <div className="small muted">{t("upd_aheadNote", { n: info.ahead })}</div>}
      {info?.detail && info.state !== "available" && <pre className="prompt small-pre">{info.detail}</pre>}
      {error && <div className="error small">{t(`upd_reason_${error}` as Key) || error}</div>}
      {info?.state === "available" && info.commits.length > 0 && !running && (
        <ul className="update-commits">
          {info.commits.slice(0, 8).map((c) => (
            <li key={c.sha}>
              <span className="mono muted">{c.sha}</span> {c.subject}
            </li>
          ))}
          {info.commits.length > 8 && <li className="muted">…</li>}
        </ul>
      )}
      {running && (
        <>
          <div className="small muted">{t("upd_runningHint")}</div>
          {progress && progress.log.length > 0 && <pre className="runlog">{progress.log.join("\n")}</pre>}
        </>
      )}
      {progress?.state === "failed" && !running && (
        <div className="error small">{t("upd_failed", { message: progress.message ?? "" })}</div>
      )}
      <label className="check plain">
        <input type="checkbox" checked={autoCheck} onChange={(e) => setAutoCheck(e.target.checked)} />
        {t("upd_autoCheck")}
      </label>
      <label className="check plain">
        <input type="checkbox" checked={autoInstall} onChange={(e) => setAutoInstall(e.target.checked)} />
        {t("upd_autoInstall")}
      </label>
    </div>
  );
}
