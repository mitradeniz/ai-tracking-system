import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n.ts";
import { newId, usePref } from "../prefs.ts";

/** A small ⓘ that explains the thing next to it, on hover, focus or click. */
export function InfoTip({ text, align = "start" }: { text: string; align?: "start" | "end" | "center" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <span className={`info ${open ? "open" : ""} info-${align}`} ref={ref}>
      <button
        type="button"
        className="info-btn"
        aria-label={text}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        i
      </button>
      <span className="info-pop" role="tooltip">
        {text}
      </span>
    </span>
  );
}

/** Re-renders every `ms` while `active`, for live timers. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [active, ms]);
  return active ? now : Date.now();
}

export interface SavedPrompt {
  id: string;
  title: string;
  body: string;
}

const normalizePrompts = (v: SavedPrompt[]) =>
  Array.isArray(v) ? v.filter((p) => p && typeof p.body === "string" && typeof p.id === "string") : [];

/** The person's own prompts, kept on this computer and shared between windows. */
export function useMyPrompts(): [SavedPrompt[], (body: string) => void, (id: string) => void] {
  const [list, setList] = usePref<SavedPrompt[]>("myPrompts", [], normalizePrompts);
  const add = (body: string) => {
    const text = body.trim();
    if (!text) return;
    const title = text.split("\n")[0]!.slice(0, 60);
    setList((all) => [...all.filter((p) => p.body !== text), { id: newId("p"), title, body: text }]);
  };
  const remove = (id: string) => setList((all) => all.filter((p) => p.id !== id));
  return [list, add, remove];
}

/** "My prompts": insert a saved prompt into a text box, or save the box's text. */
export function PromptPicker({ value, onInsert }: { value: string; onInsert: (text: string) => void }) {
  const { t } = useI18n();
  const [list, add, remove] = useMyPrompts();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="prompt-picker" ref={ref}>
      <button type="button" className="btn tiny ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        ☰ {t("myPrompts")}
        {list.length > 0 && <span className="count-dot">{list.length}</span>}
      </button>
      {open && (
        <div className="prompt-menu" role="menu">
          <div className="small muted">{t("myPrompts_hint")}</div>
          {list.length === 0 && <div className="small muted">{t("myPrompts_empty")}</div>}
          {list.map((p) => (
            <div className="prompt-item" key={p.id}>
              <button
                type="button"
                role="menuitem"
                className="prompt-item-main"
                title={p.body}
                onClick={() => {
                  onInsert(p.body);
                  setOpen(false);
                }}
              >
                {p.title}
              </button>
              <button type="button" className="icon-btn" aria-label={`${t("myPrompts_delete")}: ${p.title}`} onClick={() => remove(p.id)}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="btn tiny" disabled={!value.trim()} onClick={() => add(value)}>
            + {t("myPrompts_save")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The red "!" that marks problems, with their number when there are several. */
export function Bang({ n, title }: { n: number; title?: string }) {
  return (
    <span className="bang" title={title} aria-label={title}>
      <span aria-hidden="true">!</span>
      {n > 1 && <span className="bang-n">{n}</span>}
    </span>
  );
}
