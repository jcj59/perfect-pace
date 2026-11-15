import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export interface InfoPopoverProps {
  /** The button's accessible name and the popover's title, such as "How the plan works". */
  label: string;
  /** The explanation: text, or several `<p>` blocks for longer ones. */
  children: ReactNode;
  /** `data-testid` of the popover; the button gets `<testId>-button`. */
  testId: string;
}

/** Room kept between the open popover and the bottom edge of the panel that scrolls it into view. */
const SCROLL_MARGIN_PX = 12;

/**
 * A small (i) button that opens an explanation under it: a non-modal disclosure. Opening moves
 * focus into the popover; Esc, the button again or the close button shut it and give focus back
 * to the button; a click or tap anywhere else, or tabbing out of it, shuts it too.
 *
 * The popover spans the nearest positioned ancestor, so render this inside a `relative` row as
 * wide as the panel content (it then fits the phone sheet with no sideways scroll), and a caret
 * points up at the button.
 */
export function InfoPopover({ label, children, testId }: InfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const [caretX, setCaretX] = useState<number | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  // Point the caret at the button, then move focus in and bring the popover into view.
  useLayoutEffect(() => {
    const b = button.current;
    const p = panel.current;
    if (!open || !b || !p) return;
    const br = b.getBoundingClientRect();
    setCaretX(br.left + br.width / 2 - p.getBoundingClientRect().left);
    p.focus({ preventScroll: true });
    revealInScroller(p);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    // Capture, so a press that a map or a drag handler keeps to itself still closes it.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (panel.current?.contains(target) || button.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  const closeAndRefocus = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
        className="relative -my-1.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-subtle transition-colors after:absolute after:-inset-2 after:content-[''] hover:bg-line/60 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-expanded:bg-accent-soft aria-expanded:text-accent"
        data-testid={`${testId}-button`}
      >
        <svg
          viewBox="0 0 24 24"
          className="size-[18px]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" strokeWidth="2.2" />
        </svg>
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next && !panel.current?.contains(next) && next !== button.current) setOpen(false);
          }}
          className="absolute inset-x-0 top-full z-20 mt-2.5 rounded-2xl bg-surface py-3.5 pr-2.5 pl-4 shadow-panel ring-1 ring-line outline-none transition-[opacity,translate] duration-150 ease-out starting:-translate-y-1 starting:opacity-0 motion-reduce:transition-none"
          data-testid={testId}
        >
          {caretX !== null && (
            <span
              className="absolute -top-[6.5px] size-3 rotate-45 rounded-tl-[3px] border-t border-l border-line bg-surface"
              style={{ left: caretX - 6 }}
              aria-hidden="true"
            />
          )}
          <div className="flex items-start justify-between gap-2">
            <p id={titleId} className="pt-1 text-sm font-semibold text-ink">
              {label}
            </p>
            <button
              type="button"
              aria-label="Close"
              onClick={closeAndRefocus}
              className="relative inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-subtle transition-colors after:absolute after:-inset-2 after:content-[''] hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              data-testid={`${testId}-close`}
            >
              <svg
                viewBox="0 0 24 24"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div className="mt-1 space-y-2 pr-1.5 text-[13px] leading-relaxed text-ink-muted">{children}</div>
        </div>
      )}
    </>
  );
}

/** Scroll the nearest scrolling ancestor just enough to show `element`, keeping its top in view. */
function revealInScroller(element: HTMLElement): void {
  let scroller = element.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  if (!scroller) return;
  const view = scroller.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  const below = box.bottom + SCROLL_MARGIN_PX - view.bottom;
  const room = box.top - view.top - SCROLL_MARGIN_PX;
  if (below > 0) scroller.scrollTop += Math.min(below, Math.max(room, 0));
}
