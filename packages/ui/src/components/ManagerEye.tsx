import type { TrackEvent } from "@aitrack/core";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n, type Key } from "../i18n.ts";
import { agentName, formatDuration, localMessage, problemsOf, PROVIDER_LABEL, type Model } from "../model.ts";
import { usePref } from "../prefs.ts";
import { useNow } from "./Info.tsx";
import { CLI_NAME } from "./NewProject.tsx";

/** Projects whose eye the person hid; it comes back when the manager is switched on again. */
export function useEyeHidden(key: string): [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = usePref<Record<string, boolean>>("managerEyeHidden", {});
  return [Boolean(hidden[key]), (value) => setHidden((all) => ({ ...all, [key]: value }))];
}

/** Event types worth showing as news. */
const NEWS = new Set<TrackEvent["type"]>(["dispatched", "blocked", "review", "done", "approved", "failed", "reopened", "note"]);

const clip = (text: string, n: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function ago(iso: string, now: number, lang: string): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const tr = lang === "tr";
  if (s < 60) return tr ? `${s} sn` : `${s}s`;
  if (s < 3600) return tr ? `${Math.floor(s / 60)} dk` : `${Math.floor(s / 60)}m`;
  if (s < 86_400) return tr ? `${Math.floor(s / 3600)} sa` : `${Math.floor(s / 3600)}h`;
  return tr ? `${Math.floor(s / 86_400)} g` : `${Math.floor(s / 86_400)}d`;
}

/** The eye itself: looks around, blinks, spins faster while the manager is looking, turns red on errors. */
function EyeArt({ mood }: { mood: "watching" | "busy" | "alert" }) {
  return (
    <svg className={`eye-art ${mood}`} viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <radialGradient id="eye-iris" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="var(--eye-core)" />
          <stop offset=".55" stopColor="var(--eye-main)" />
          <stop offset="1" stopColor="var(--eye-deep)" />
        </radialGradient>
        <clipPath id="eye-lid">
          <path d="M12 60 Q60 18 108 60 Q60 102 12 60 Z" />
        </clipPath>
      </defs>
      <circle className="eye-ring outer" cx="60" cy="60" r="56" />
      <circle className="eye-ring ticks" cx="60" cy="60" r="49" />
      <g className="eye-lids">
        <path className="eye-white" d="M12 60 Q60 18 108 60 Q60 102 12 60 Z" />
        <g clipPath="url(#eye-lid)">
          <g className="eye-look">
            <circle cx="60" cy="60" r="21" fill="url(#eye-iris)" />
            <circle className="eye-iris-ring" cx="60" cy="60" r="15" />
            <circle className="eye-iris-ring" cx="60" cy="60" r="10.5" />
            <circle className="eye-pupil" cx="60" cy="60" r="7" />
            <circle cx="55" cy="55" r="2.6" fill="#fff" opacity=".85" />
          </g>
          <rect className="eye-scan" x="0" y="0" width="120" height="3" />
        </g>
        <path className="eye-outline" d="M12 60 Q60 18 108 60 Q60 102 12 60 Z" />
      </g>
    </svg>
  );
}

/**
 * While a manager runs the project, a small eye floats over the board. Clicking it projects a
 * panel downwards: what each chat is doing, how far the project is, what went wrong, the latest news.
 */
export function ManagerEye({ model, onOpenTask, onOpenManager }: { model: Model; onOpenTask: (id: string) => void; onOpenManager: () => void }) {
  const { t, lang } = useI18n();
  const key = model.detail.key;
  const state = model.runners?.manager;
  const on = Boolean(state?.settings.enabled);
  const [hidden, setHidden] = useEyeHidden(key);
  const [open, setOpen] = useState(false);
  const now = useNow(on && !hidden && open, 1000);

  // Switching the manager on brings the eye back.
  const last = useRef<{ key: string; on: boolean }>({ key, on });
  useEffect(() => {
    if (last.current.key === key && on && !last.current.on) {
      setHidden(false);
      setOpen(false);
    }
    last.current = { key, on };
  }, [key, on, setHidden]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!on || hidden || !state) return null;

  const counts = model.detail.board?.counts;
  const total = counts?.total ?? 0;
  const done = counts?.done ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const running = (model.runners?.runs ?? []).filter((r) => r.state === "running");
  const errors = [...model.snap.values()]
    .map((s) => ({ s, list: problemsOf(model, s, t) }))
    .filter((x) => x.s.status === "failed" || x.list.length > 0)
    .slice(0, 5);
  const news = [...model.detail.events]
    .filter((e) => NEWS.has(e.type) && (e.type !== "note" || e.source === "manager"))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, 7);
  const lastRun = state.log[0];
  const forYou = lastRun?.forYou.length ?? 0;
  const mood = errors.length ? "alert" : state.running || running.length ? "busy" : "watching";
  const status = state.running ? t("eye_looking") : errors.length ? t("eye_alert", { n: errors.length }) : t("eye_watching");
  let i = 0;
  const line = (): CSSProperties => ({ ["--i" as string]: i++ });

  return (
    <div className={`eye-dock ${open ? "open" : ""}`}>
      <div className="eye-wrap">
        <button
          className={`eye-btn ${mood}`}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? t("eye_close") : t("eye_open")}
          title={`${t("mgr_title")} · ${status}`}
        >
          <EyeArt mood={mood} />
        </button>
        <button
          className="eye-hide"
          onClick={() => {
            setOpen(false);
            setHidden(true);
          }}
          aria-label={t("eye_hide")}
          title={t("eye_hide")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
            <path d="M3 21 21 3" />
          </svg>
        </button>
      </div>

      {open && (
        <>
          <div className="eye-beam" aria-hidden="true" />
          <section className={`eye-holo ${mood}`} aria-label={t("mgr_title")}>
            <header className="holo-head" style={line()}>
              <span className="holo-title">{t("eye_title")}</span>
              <span className={`holo-status ${mood}`}>
                <span className="dot" />
                {status}
              </span>
              <span className="spacer" />
              <span className="holo-cli">{CLI_NAME[state.settings.provider] ?? state.settings.provider}</span>
            </header>

            <div className="holo-progress" style={line()}>
              <div className="holo-pct">
                {pct}
                <small>%</small>
              </div>
              <div className="grow">
                <div className="holo-bar">
                  <span style={{ width: `${pct}%` }} />
                </div>
                <div className="holo-counts">
                  <span>{t("eye_done", { done, total })}</span>
                  <span>{t("eye_active", { n: (counts?.dispatched ?? 0) + (counts?.in_progress ?? 0) })}</span>
                  <span>{t("eye_ready", { n: counts?.ready ?? 0 })}</span>
                  {(counts?.review ?? 0) > 0 && <span>{t("eye_review", { n: counts!.review })}</span>}
                </div>
              </div>
            </div>

            <h4 style={line()}>{t("eye_models")}</h4>
            {running.length === 0 ? (
              <div className="holo-empty" style={line()}>
                {t("eye_idle")}
              </div>
            ) : (
              running.map((r) => (
                <button key={r.id} className="holo-row" style={line()} onClick={() => onOpenTask(r.task)}>
                  <span className="pulse" aria-hidden="true" />
                  <span className="holo-who">
                    {agentName(model, r.agent)}
                    <small>
                      {PROVIDER_LABEL[r.provider] ?? r.provider}
                      {r.usage?.model ? ` · ${r.usage.model}` : ""}
                    </small>
                  </span>
                  <span className="holo-what">
                    <b>{r.task}</b> {clip(r.lastActivity ?? model.task.get(r.task)?.title ?? "", 70)}
                  </span>
                  <span className="holo-time">{formatDuration(now - Date.parse(r.startedAt))}</span>
                </button>
              ))
            )}

            {errors.length > 0 && (
              <>
                <h4 className="alert" style={line()}>
                  {t("eye_errors", { n: errors.length })}
                </h4>
                {errors.map(({ s, list }) => (
                  <button key={s.id} className="holo-row alert" style={line()} onClick={() => onOpenTask(s.id)}>
                    <span className="holo-bang">!</span>
                    <span className="holo-what">
                      <b>{s.id}</b> {clip(list[0]?.title ?? s.reason ?? t(`status_${s.status}` as Key), 90)}
                    </span>
                  </button>
                ))}
              </>
            )}

            <h4 style={line()}>{t("eye_news")}</h4>
            {news.length === 0 ? (
              <div className="holo-empty" style={line()}>
                {t("eye_noNews")}
              </div>
            ) : (
              news.map((e) => (
                <button key={e.id} className={`holo-news ${e.type}`} style={line()} onClick={() => onOpenTask(e.task)}>
                  <span className="holo-ago">{ago(e.ts, now, lang)}</span>
                  <b>{e.task}</b>
                  <span className="holo-type">{t(`type_${e.type}` as Key)}</span>
                  {(e.message || e.reason) && <span className="holo-msg">{clip(localMessage(e.message ?? e.reason ?? "", t), 80)}</span>}
                </button>
              ))
            )}

            {lastRun && (
              <button className="holo-foot" style={line()} onClick={onOpenManager}>
                <span>
                  {t("eye_lastRun", { ago: ago(lastRun.startedAt, now, lang) })}
                  {lastRun.summary ? ` — ${clip(lastRun.summary, 110)}` : ""}
                </span>
                {forYou > 0 && <span className="holo-foryou">{t("eye_forYou", { n: forYou })}</span>}
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
