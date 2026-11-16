import type { TrackEvent } from "@aitrack/core";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api, desktop } from "../api.ts";
import { useI18n, type Key } from "../i18n.ts";
import { agentName, formatDuration, formatTime, localMessage, localReason, problemsOf, PROVIDER_LABEL, untilText, type Model } from "../model.ts";
import type { EyeProject } from "../eyeOverview.ts";
import { usePref } from "../prefs.ts";
import { waitingForYou } from "../waiting.ts";
import { useNow } from "./Info.tsx";
import { CLI_NAME } from "./NewProject.tsx";
import { QuickTask } from "./QuickTask.tsx";

/** How the eye looks: the green hologram, the Eye of Ra in black glass, or white liquid glass. */
export const EYE_THEMES = ["holo", "ra", "liquid"] as const;
export type EyeTheme = (typeof EYE_THEMES)[number];
// "dot" was the black-and-white look the Eye of Ra replaced.
const eyeTheme = (v: EyeTheme | "dot"): EyeTheme => (v === "dot" ? "ra" : EYE_THEMES.includes(v) ? v : "holo");

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

type Shift = { x: number; y: number };

/** Keeps the eye on the board: it starts at the top right, so it may move left and down, a little up and right. */
function keepOnScreen(p: Shift): Shift {
  const w = typeof window === "undefined" ? 1200 : window.innerWidth;
  const h = typeof window === "undefined" ? 800 : window.innerHeight;
  return { x: Math.round(Math.min(20, Math.max(-(w - 110), p.x))), y: Math.round(Math.min(h - 220, Math.max(-120, p.y))) };
}

/** A line of the projection: a click opens it in place; only its button goes to the app. */
function Item({
  id,
  open,
  onToggle,
  style,
  className,
  head,
  more,
  action,
}: {
  id: string;
  open: string | null;
  onToggle: (id: string) => void;
  style: CSSProperties;
  className: string;
  head: ReactNode;
  more: ReactNode;
  action: ReactNode;
}) {
  const expanded = open === id;
  return (
    <div className={`holo-item ${expanded ? "expanded" : ""}`} style={style}>
      <button className={className} aria-expanded={expanded} onClick={() => onToggle(id)}>
        {head}
      </button>
      {expanded && (
        <div className="holo-more">
          {more}
          {action}
        </div>
      )}
    </div>
  );
}

function ShowInApp({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="holo-go" onClick={onClick}>
      <span aria-hidden="true">↗</span> {label}
    </button>
  );
}

/** The eye itself: looks around, blinks, spins faster while the manager is looking, turns red on errors. */
/**
 * The Eye of Ra, drawn after the ancient Egyptian sign (the wedjat): the eye with its brow, the line
 * that runs on from its corner, the drop below and the spiral, in white on a black glass bead. Lids,
 * gaze and pupil move like the other eye's; the iris turns red when something is wrong.
 */
function RaArt({ mood }: { mood: "watching" | "busy" | "alert" }) {
  const almond = "M28 60 Q56 41 92 55 Q64 75 28 60 Z";
  return (
    <svg className={`eye-art ra ${mood}`} viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <radialGradient id="ra-disk" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="var(--ra-disk-core)" />
          <stop offset=".8" stopColor="var(--ra-disk-edge)" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <linearGradient id="ra-gloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id="ra-lid">
          <path d={almond} />
        </clipPath>
      </defs>
      <circle className="eye-ring outer ra-disk" cx="60" cy="60" r="56" />
      <ellipse className="ra-gloss" cx="60" cy="30" rx="40" ry="22" fill="url(#ra-gloss)" />
      <circle className="eye-ring ticks" cx="60" cy="60" r="50" />
      <path className="ra-ink" d="M26 44 Q59 25 102 38 L102 43 Q60 32 27 48 Z" />
      <path className="ra-ink" d="M48 67 L50.5 66 L51 92 Q51 98 46 98 Q41 98 42 93 Z" />
      <path className="ra-spiral" d="M64 69 Q67 86 80 90 Q93 93 95 84 Q96 77 89 76 Q83 76 84 82" />
      <g className="eye-lids">
        <path className="ra-white" d={almond} />
        <g clipPath="url(#ra-lid)">
          <g className="eye-look">
            <circle className="ra-iris" cx="59" cy="58" r="11" />
            <circle className="eye-pupil" cx="59" cy="58" r="6" />
            <circle className="eye-glint" cx="56" cy="55" r="1.8" fill="#fff" opacity=".8" />
          </g>
        </g>
        <path className="ra-line" d={almond} />
        <path className="ra-ink" d="M90 54 L108 54 L108 58.5 L90 59.5 Z" />
      </g>
    </svg>
  );
}

function EyeArt({ mood, theme }: { mood: "watching" | "busy" | "alert"; theme: EyeTheme }) {
  if (theme === "ra") return <RaArt mood={mood} />;
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
            <circle className="eye-iris" cx="60" cy="60" r="21" fill="url(#eye-iris)" />
            <circle className="eye-iris-ring" cx="60" cy="60" r="15" />
            <circle className="eye-iris-ring" cx="60" cy="60" r="10.5" />
            <circle className="eye-pupil" cx="60" cy="60" r="7" />
            <circle className="eye-glint" cx="55" cy="55" r="2.6" fill="#fff" opacity=".85" />
          </g>
          <rect className="eye-scan" x="0" y="0" width="120" height="3" />
        </g>
        <path className="eye-outline" d="M12 60 Q60 18 108 60 Q60 102 12 60 Z" />
      </g>
    </svg>
  );
}

/**
 * While a manager runs the project, a small eye floats over the board — or, in the desktop app, in
 * its own window above other apps (windowed). Clicking it projects a panel downwards: what each
 * chat is doing, how far the project is, what went wrong, the latest news. It can be dragged there.
 */
export function ManagerEye({
  model,
  onOpenTask,
  onOpenManager,
  windowed = false,
  projects = [],
  onSwitch,
  onOpenElsewhere,
}: {
  model: Model;
  onOpenTask: (id: string) => void;
  onOpenManager: () => void;
  windowed?: boolean;
  /** Every project a manager runs (this one included): their tabs, problems and runs. */
  projects?: EyeProject[];
  /** Show another of those projects in the eye. */
  onSwitch?: (key: string) => void;
  /** Open a task of another project in the app. */
  onOpenElsewhere?: (key: string, task: string) => void;
}) {
  const { t, lang } = useI18n();
  const key = model.detail.key;
  const state = model.runners?.manager;
  const on = Boolean(state?.settings.enabled);
  const [hidden, setHidden] = useEyeHidden(key);
  const [open, setOpen] = useState(false);
  const [apex, setApex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [talkError, setTalkError] = useState<string | null>(null);
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setTalkError(null);
    try {
      await api.messageManager(key, text);
      setDraft("");
    } catch (e) {
      setTalkError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));
  const dock = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean; base: Shift } | null>(null);
  // On the board, where the person dragged the eye to (from its place at the top right).
  const [shift, setShift] = usePref<Shift>("managerEyeShift", { x: 0, y: 0 });
  const [moving, setMoving] = useState<Shift | null>(null);
  const [theme, setTheme] = usePref<EyeTheme>("eyeTheme", "holo", eyeTheme);
  // What waits for the person that they marked seen: it comes back when it says something new.
  const [seenWaiting, setSeenWaiting] = usePref<string[]>(`eyeSeen:${key}`, []);
  const [flash, setFlash] = useState<string | null>(null);
  const now = useNow(on && !hidden && open, 1000);
  const visible = on && !hidden && Boolean(state);

  // In its own window, the window follows: shown or hidden, small or tall enough for the projection.
  useEffect(() => {
    if (!windowed) return;
    void desktop?.eyeSet?.({ open, height: open ? 560 : undefined }).then((r) => r && setApex(r.offset));
  }, [windowed, open]);
  useEffect(() => {
    if (!windowed) return;
    void desktop?.eyeSet?.({ visible }).then((r) => r && setApex(r.offset));
  }, [windowed, visible]);
  useEffect(() => {
    if (!windowed || !open || !dock.current) return;
    const el = dock.current;
    const report = () => void desktop?.eyeSet?.({ open: true, height: Math.ceil(el.scrollHeight) + 8 }).then((r) => r && setApex(r.offset));
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [windowed, open]);

  // Dragging the eye moves it, closed or open: its window in the desktop app, the eye on the board
  // in a browser. A press without moving opens or closes the projection.
  const finish = (toggleOpen: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (windowed) void desktop?.eyeMove?.("end");
    if (d.moved) {
      if (!windowed && moving) setShift(keepOnScreen(moving));
      setMoving(null);
      return;
    }
    if (toggleOpen) setOpen((o) => !o);
  };
  const pointer = {
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.screenX, y: e.screenY, moved: false, base: shift };
      if (windowed) void desktop?.eyeMove?.("start");
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.screenX - d.x;
      const dy = e.screenY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      if (windowed) void desktop?.eyeMove?.("move", dx, dy).then((r) => r && setApex(r.offset));
      else setMoving(keepOnScreen({ x: d.base.x + dx, y: d.base.y + dy }));
    },
    onPointerUp: () => finish(true),
    onPointerCancel: () => finish(false),
    // The keyboard still opens and closes it.
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => {
      if (e.detail === 0) setOpen((o) => !o);
    },
  };

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

  if (!visible || !state) return null;

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
  // What it approved, newest first: the ones the person has not looked at come first.
  const approvals = [...(state.approvals ?? [])].sort((a, b) => Number(Boolean(a.seen)) - Number(Boolean(b.seen))).slice(0, 5);
  const unseen = state.unseen ?? 0;
  const markSeen = (tasks?: string[]) => void api.approvalsSeen(key, tasks).catch(() => undefined);
  // The last few things the person wrote to the manager, oldest first, with its answers.
  const talks = state.log.filter((r) => r.message).slice(0, 3).reverse();
  const limits = [...new Map((model.runners?.limits ?? []).map((l) => [l.cli, l])).values()];
  const forYou = lastRun?.forYou.length ?? 0;
  // The other projects a manager runs: a problem in any of them turns the eye red too.
  const others = projects.filter((p) => p.key !== key);
  const othersProblems = others.reduce((n, p) => n + p.problems, 0);
  const elsewhere = others.flatMap((p) => p.running.map((r) => ({ ...r, project: p })));
  const mood = errors.length || othersProblems ? "alert" : state.running || running.length || elsewhere.length ? "busy" : "watching";
  const status = state.running
    ? t("eye_looking")
    : errors.length
      ? t("eye_alert", { n: errors.length })
      : othersProblems
        ? t("eye_alertOther", { n: othersProblems })
        : t("eye_watching");
  const tabs = projects.length > 1 ? projects : [];
  const waiting = waitingForYou(model, state.log, state.settings, t).filter((w) => !seenWaiting.includes(w.id));
  const markWaiting = (id: string) => setSeenWaiting((list) => [...list.filter((x) => x !== id), id].slice(-100));
  let i = 0;
  const line = (): CSSProperties => ({ ["--i" as string]: i++ });

  return (
    <div
      ref={dock}
      className={`eye-dock theme-${theme} ${open ? "open" : ""} ${windowed ? "windowed" : ""} ${moving ? "moving" : ""}`}
      style={
        windowed
          ? apex !== null
            ? ({ ["--apex" as string]: `${apex}px` } as CSSProperties)
            : undefined
          : (moving ?? shift).x || (moving ?? shift).y
            ? // `translate`, not `transform`: the eye's own pop-in animation uses transform.
              { translate: `${(moving ?? shift).x}px ${(moving ?? shift).y}px` }
            : undefined
      }
    >
      <div className="eye-wrap">
        <button
          className={`eye-btn ${mood}`}
          {...pointer}
          aria-expanded={open}
          aria-label={open ? t("eye_close") : t("eye_open")}
          title={`${t("mgr_title")} · ${status}${waiting.length ? ` · ${t("eye_waitingN", { n: waiting.length })}` : ""}`}
        >
          <EyeArt mood={mood} theme={theme} />
        </button>
        {waiting.length > 0 && (
          <span className="eye-count" aria-label={t("eye_waitingN", { n: waiting.length })}>
            {waiting.length}
          </span>
        )}
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
              <span className="holo-themes" role="radiogroup" aria-label={t("eye_theme")}>
                {EYE_THEMES.map((th) => (
                  <button
                    key={th}
                    role="radio"
                    aria-checked={theme === th}
                    className={`holo-swatch ${th}`}
                    title={t(`eye_theme_${th}` as Key)}
                    aria-label={t(`eye_theme_${th}` as Key)}
                    onClick={() => setTheme(th)}
                  />
                ))}
              </span>
            </header>

            {tabs.length > 0 && (
              <div className="holo-tabs" role="tablist" aria-label={t("eye_projects")} style={line()}>
                {tabs.map((p) => {
                  const here = p.key === key;
                  const n = here ? errors.length : p.problems;
                  return (
                    <button
                      key={p.key}
                      role="tab"
                      aria-selected={here}
                      className={`holo-tab ${here ? "active" : ""} ${n ? "alert" : ""}`}
                      title={`${p.name} · ${p.pct}%${n ? ` · ${t("eye_tabProblems", { n })}` : ""}`}
                      onClick={() => !here && onSwitch?.(p.key)}
                    >
                      {n > 0 && <span className="holo-tab-bang">!</span>}
                      <span className="holo-tab-name">{clip(p.name, 22)}</span>
                      <span className="holo-tab-pct">{here ? pct : p.pct}%</span>
                      {p.running.length > 0 && <span className="holo-pulse" aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            )}

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

            {waiting.length > 0 && (
              <>
                <h4 className="holo-waiting-head" style={line()}>
                  {t("eye_waiting", { n: waiting.length })}
                </h4>
                {waiting.map((w) => (
                  <Item
                    key={w.id}
                    id={`wait:${w.id}`}
                    open={expanded}
                    onToggle={toggle}
                    style={line()}
                    className="holo-row waiting"
                    head={
                      <>
                        <span className="holo-ask">?</span>
                        <span className="holo-what">
                          {w.task && <b>{w.task}</b>} {clip(w.message ?? w.problems[0]?.title ?? "", 90)}
                        </span>
                      </>
                    }
                    more={
                      <>
                        {w.message && (
                          <p className="holo-quote">
                            <strong>{t("eye_managerSays")}:</strong> {w.message}
                          </p>
                        )}
                        {w.task && (
                          <div className="holo-answer-box">
                            <QuickTask
                              model={model}
                              taskId={w.task}
                              onClose={() => toggle(`wait:${w.id}`)}
                              onInfo={(m) => {
                                setFlash(m);
                                window.setTimeout(() => setFlash((cur) => (cur === m ? null : cur)), 6000);
                              }}
                            />
                          </div>
                        )}
                      </>
                    }
                    action={
                      <div className="holo-actions">
                        <button className="holo-go" title={t("eye_waitingSeenHint")} onClick={() => markWaiting(w.id)}>
                          ✓ {t("appr_seen")}
                        </button>
                        {w.task && <ShowInApp label={t("eye_showInApp")} onClick={() => onOpenTask(w.task!)} />}
                      </div>
                    }
                  />
                ))}
                {flash && <p className={flash.startsWith("⚠") ? "holo-err" : "holo-flash"}>{flash}</p>}
              </>
            )}

            {limits.map((l) => (
              <div key={l.cli} className="holo-limit" style={line()} title={`${t(`limit_basis_${l.basis}` as Key)}\n${l.message}`}>
                ⏳ {t("eye_limit", { cli: l.cli, time: untilText(Date.parse(l.until)) })}
              </div>
            ))}

            <h4 style={line()}>{t("eye_models")}</h4>
            {running.length === 0 && elsewhere.length === 0 ? (
              <div className="holo-empty" style={line()}>
                {t("eye_idle")}
              </div>
            ) : (
              running.map((r) => (
                <Item
                  key={r.id}
                  id={`run:${r.id}`}
                  open={expanded}
                  onToggle={toggle}
                  style={line()}
                  className="holo-row"
                  head={
                    <>
                      <span className="holo-pulse" aria-hidden="true" />
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
                    </>
                  }
                  more={
                    <>
                      <p>
                        <b>{r.task}</b> {model.task.get(r.task)?.title}
                      </p>
                      {r.lastActivity && <p className="holo-quote">{r.lastActivity}</p>}
                      {r.lastMessage && <p className="holo-quote">{clip(r.lastMessage, 600)}</p>}
                    </>
                  }
                  action={<ShowInApp label={t("eye_showInApp")} onClick={() => onOpenTask(r.task)} />}
                />
              ))
            )}
            {elsewhere.map(({ run: r, agent, title, project }) => (
              <Item
                key={`${project.key}:${r.id}`}
                id={`run:${project.key}:${r.id}`}
                open={expanded}
                onToggle={toggle}
                style={line()}
                className="holo-row elsewhere"
                head={
                  <>
                    <span className="holo-pulse" aria-hidden="true" />
                    <span className="holo-who">
                      {agent}
                      <small>{clip(project.name, 18)}</small>
                    </span>
                    <span className="holo-what">
                      <b>{r.task}</b> {clip(r.lastActivity ?? title, 70)}
                    </span>
                    <span className="holo-time">{formatDuration(now - Date.parse(r.startedAt))}</span>
                  </>
                }
                more={
                  <>
                    <p>
                      <b>{r.task}</b> {title}
                      <span className="holo-when"> · {project.name}</span>
                    </p>
                    {r.lastActivity && <p className="holo-quote">{r.lastActivity}</p>}
                  </>
                }
                action={
                  <div className="holo-actions">
                    {onSwitch && (
                      <button className="holo-go" onClick={() => onSwitch(project.key)}>
                        {t("eye_switchTo", { name: clip(project.name, 24) })}
                      </button>
                    )}
                    {onOpenElsewhere && <ShowInApp label={t("eye_showInApp")} onClick={() => onOpenElsewhere(project.key, r.task)} />}
                  </div>
                }
              />
            ))}

            {errors.length > 0 && (
              <>
                <h4 className="alert" style={line()}>
                  {t("eye_errors", { n: errors.length })}
                </h4>
                {errors.map(({ s: snap, list }) => (
                  <Item
                    key={snap.id}
                    id={`err:${snap.id}`}
                    open={expanded}
                    onToggle={toggle}
                    style={line()}
                    className="holo-row alert"
                    head={
                      <>
                        <span className="holo-bang">!</span>
                        <span className="holo-what">
                          <b>{snap.id}</b> {clip(list[0]?.title ?? (snap.reason ? localReason(snap.reason, t) : t(`status_${snap.status}` as Key)), 90)}
                        </span>
                      </>
                    }
                    more={
                      <>
                        <p>
                          <b>{snap.id}</b> {model.task.get(snap.id)?.title}
                        </p>
                        {list.length > 0
                          ? list.slice(0, 5).map((p, n) => (
                              <p key={n} className="holo-quote">
                                <strong>{p.title}</strong>
                                {p.detail ? ` — ${clip(p.detail, 400)}` : ""}
                              </p>
                            ))
                          : snap.reason && <p className="holo-quote">{localReason(snap.reason, t)}</p>}
                      </>
                    }
                    action={<ShowInApp label={t("eye_showInApp")} onClick={() => onOpenTask(snap.id)} />}
                  />
                ))}
              </>
            )}

            {approvals.length > 0 && (
              <>
                <h4 className="holo-approved-head" style={line()}>
                  <span>
                    {t("eye_approved")}
                    {unseen > 0 && <span className="holo-new"> · {t("appr_new", { n: unseen })}</span>}
                  </span>
                  {unseen > 0 && (
                    <button className="holo-mini" onClick={() => markSeen()}>
                      {t("appr_allSeen")}
                    </button>
                  )}
                </h4>
                {approvals.map((a) => (
                  <Item
                    key={`${a.task}-${a.at}`}
                    id={`appr:${a.task}:${a.at}`}
                    open={expanded}
                    onToggle={toggle}
                    style={line()}
                    className={`holo-row approved ${a.seen ? "seen" : "unseen"}`}
                    head={
                      <>
                        <span className="holo-ok">✓</span>
                        <span className="holo-what">
                          <b>{a.task}</b> {clip(a.title, 60)}
                        </span>
                        {a.check && <span className="holo-look">{t("appr_check")}</span>}
                        <span className="holo-time">{ago(a.at, now, lang)}</span>
                      </>
                    }
                    more={
                      <>
                        <p>
                          <b>{a.task}</b> {a.title}
                          <span className="holo-when"> · {formatTime(a.at, lang)}</span>
                        </p>
                        {a.check && (
                          <p className="holo-quote holo-checkline">
                            <strong>{t("appr_check")}:</strong> {a.check}
                          </p>
                        )}
                        {a.note && (
                          <p className="holo-quote">
                            {t("appr_why")}: {a.note}
                          </p>
                        )}
                        {a.pr && <p className="holo-quote">PR: {a.pr}</p>}
                      </>
                    }
                    action={
                      <div className="holo-actions">
                        <ShowInApp label={t("eye_showInApp")} onClick={() => onOpenTask(a.task)} />
                        {!a.seen && (
                          <button className="holo-go" onClick={() => markSeen([a.task])}>
                            ✓ {t("appr_seen")}
                          </button>
                        )}
                      </div>
                    }
                  />
                ))}
              </>
            )}

            <h4 style={line()}>{t("eye_news")}</h4>
            {news.length === 0 ? (
              <div className="holo-empty" style={line()}>
                {t("eye_noNews")}
              </div>
            ) : (
              news.map((e) => {
                const text = e.message ? localMessage(e.message, t) : e.reason ? localReason(e.reason, t) : "";
                return (
                  <Item
                    key={e.id}
                    id={`news:${e.id}`}
                    open={expanded}
                    onToggle={toggle}
                    style={line()}
                    className={`holo-news ${e.type}`}
                    head={
                      <>
                        <span className="holo-ago">{ago(e.ts, now, lang)}</span>
                        <b>{e.task}</b>
                        <span className="holo-type">{t(`type_${e.type}` as Key)}</span>
                        {text && <span className="holo-msg">{clip(text, 80)}</span>}
                      </>
                    }
                    more={
                      <>
                        <p>
                          <b>{e.task}</b> {model.task.get(e.task)?.title}
                          <span className="holo-when"> · {formatTime(e.ts, lang)}</span>
                        </p>
                        {text && <p className="holo-quote">{text}</p>}
                        {e.reason && e.message && <p className="holo-quote">{localReason(e.reason, t)}</p>}
                        {e.pr && <p className="holo-quote">PR: {e.pr}</p>}
                      </>
                    }
                    action={<ShowInApp label={t("eye_showInApp")} onClick={() => onOpenTask(e.task)} />}
                  />
                );
              })
            )}

            {lastRun && (
              <Item
                id="foot"
                open={expanded}
                onToggle={toggle}
                style={line()}
                className="holo-foot"
                head={
                  <>
                    <span className="holo-what">
                      {t("eye_lastRun", { ago: ago(lastRun.startedAt, now, lang) })}
                      {lastRun.summary ? ` — ${clip(lastRun.summary, 60)}` : ""}
                    </span>
                    {forYou > 0 && <span className="holo-foryou">{t("eye_forYou", { n: forYou })}</span>}
                  </>
                }
                more={
                  <>
                    {lastRun.summary && <p className="holo-quote">{lastRun.summary}</p>}
                    {lastRun.forYou.length > 0 && (
                      <>
                        <p className="holo-foryou">{t("mgr_forYou")}</p>
                        <ul className="holo-list">
                          {lastRun.forYou.map((item, n) => (
                            <li key={n}>{item}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                }
                action={<ShowInApp label={t("eye_openManager")} onClick={onOpenManager} />}
              />
            )}
            <h4 style={line()}>{t("eye_talk")}</h4>
            {talks.map((run) => (
              <div key={run.id} className="holo-talk" style={line()}>
                <p className="holo-you">
                  <b>{t("eye_you")}:</b> {run.message}
                </p>
                <p className="holo-answer">
                  <b>{t("eye_managerSays")}:</b>{" "}
                  {run.state === "running" ? <span className="holo-thinking">{t("eye_thinking")}</span> : run.state === "failed" ? <span className="holo-err">{run.error}</span> : run.reply ?? run.summary ?? "—"}
                </p>
              </div>
            ))}
            <div className="holo-input" style={line()}>
              <textarea
                value={draft}
                rows={2}
                maxLength={4000}
                placeholder={t("eye_talkPlaceholder")}
                title={t("eye_sendHint")}
                aria-label={t("eye_talk")}
                disabled={sending}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                  if (e.key === "Escape") e.stopPropagation();
                }}
              />
              <button className="holo-go" disabled={sending || !draft.trim()} onClick={() => void send()}>
                {sending ? "…" : t("eye_send")}
              </button>
            </div>
            {talkError && <p className="holo-err">{talkError}</p>}
          </section>
        </>
      )}
    </div>
  );
}
