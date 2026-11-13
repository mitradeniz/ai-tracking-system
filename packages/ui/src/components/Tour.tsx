import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n, type Key } from "../i18n.ts";

/** One step of the intro: a title, a text, and the part of the screen it points at (data-tour). */
interface Step {
  id: number;
  target?: string;
}

const STEPS: Step[] = [
  { id: 1 },
  { id: 2, target: "projects" },
  { id: 3, target: "new-project" },
  { id: 4, target: "board" },
  { id: 5, target: "runner" },
  { id: 6, target: "autodispatch" },
  { id: 7, target: "plan" },
  { id: 8, target: "counts" },
  { id: 9, target: "floating" },
  { id: 10, target: "settings" },
];

const PAD = 6;

function visibleTarget(name: string | undefined): HTMLElement | null {
  if (!name) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

/** A short, one-time intro that points at the main parts of the screen. */
export function Tour({ onClose, onFinish, finishLabel }: { onClose: () => void; onFinish: () => void; finishLabel: string }) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = STEPS[index]!;
  const last = index === STEPS.length - 1;

  // Measure the element the step points at, and keep up with resizes.
  useLayoutEffect(() => {
    const measure = () => {
      const el = visibleTarget(step.target);
      if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step.target]);

  // Place the card next to the highlighted part: right, below, above, or in the middle.
  useLayoutEffect(() => {
    const w = card.current?.offsetWidth ?? 360;
    const h = card.current?.offsetHeight ?? 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!rect) {
      setCardPos({ top: Math.max(16, (vh - h) / 2), left: Math.max(16, (vw - w) / 2) });
      return;
    }
    const clampX = (x: number) => Math.max(16, Math.min(x, vw - w - 16));
    const clampY = (y: number) => Math.max(16, Math.min(y, vh - h - 16));
    if (rect.right + 16 + w < vw && rect.width < vw * 0.5) setCardPos({ top: clampY(rect.top), left: rect.right + 16 });
    else if (rect.bottom + 16 + h < vh) setCardPos({ top: rect.bottom + 16, left: clampX(rect.left) });
    else if (rect.top - 16 - h > 0) setCardPos({ top: rect.top - 16 - h, left: clampX(rect.left) });
    else setCardPos({ top: clampY(rect.top + 24), left: clampX(rect.left + 24) });
  }, [rect, index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        if (last) onFinish();
        else setIndex((i) => i + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [last, onClose, onFinish]);

  useEffect(() => {
    card.current?.querySelector<HTMLButtonElement>(".btn.primary")?.focus();
  }, [index]);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label={t("tour_title")}>
      {rect ? (
        <div
          className="tour-spot"
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
          aria-hidden="true"
        />
      ) : (
        <div className="tour-shade" aria-hidden="true" />
      )}
      <div ref={card} className="tour-card" style={cardPos ?? { visibility: "hidden" }}>
        <div className="tour-progress" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s.id} className={i === index ? "on" : i < index ? "seen" : ""} />
          ))}
        </div>
        <div className="small muted">{t("tour_step", { n: index + 1, total: STEPS.length })}</div>
        <h3>{t(`tour_${step.id}_title` as Key)}</h3>
        <p>{t(`tour_${step.id}_text` as Key)}</p>
        <div className="row">
          <button className="btn ghost small" onClick={onClose}>
            {t("tour_skip")}
          </button>
          <span className="spacer" />
          {index > 0 && (
            <button className="btn small" onClick={() => setIndex(index - 1)}>
              ← {t("np_back")}
            </button>
          )}
          <button className="btn small primary" onClick={() => (last ? onFinish() : setIndex(index + 1))}>
            {last ? finishLabel : `${t("np_next")} →`}
          </button>
        </div>
      </div>
    </div>
  );
}
