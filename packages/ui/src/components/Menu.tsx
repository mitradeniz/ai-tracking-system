import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | "separator";

/** A small popup menu next to a button. Closes on a click outside, Escape or a choice. */
export function Menu({
  label,
  items,
  children,
  className = "icon-btn",
  align = "end",
}: {
  label: string;
  items: MenuItem[];
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = popup.current?.offsetWidth ?? 220;
    const height = popup.current?.offsetHeight ?? 200;
    let left = align === "end" ? r.right - width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = r.bottom + 4;
    if (top + height > window.innerHeight - 8) top = Math.max(8, r.top - height - 4);
    setPos({ top, left });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popup.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {children}
      </button>
      {open && (
        <div
          ref={popup}
          className="menu"
          role="menu"
          style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }}
        >
          {items.map((item, i) =>
            item === "separator" ? (
              <div key={i} className="menu-sep" role="separator" />
            ) : (
              <button
                key={i}
                role="menuitem"
                className={item.danger ? "danger" : undefined}
                disabled={item.disabled}
                title={item.hint}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </>
  );
}
