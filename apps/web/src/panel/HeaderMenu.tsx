import { type KeyboardEvent, Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const ReportDialog = lazy(() => import("../report/ReportDialog.tsx"));

const MENU_WIDTH_PX = 216;
const GAP_PX = 6;

/** The app's `<main>` (so the menu is inside a landmark), outside the panel and the sheet. */
const portalTarget = (): HTMLElement => document.querySelector("main") ?? document.body;

const stopPointer = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * The panel header's menu (its button shows three dots): for now, "Report a problem", which
 * opens the report dialog. The menu and the dialog render into `<main>`, outside the panel, so
 * the phone sheet (which drags from its header and clips what overflows it) neither clips them
 * nor treats a press in them as a drag.
 */
export function HeaderMenu({ corner = false }: { corner?: boolean }) {
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Forget the position too, so the next open measures again before it shows.
  const dismiss = () => {
    setOpen(false);
    setPosition(null);
  };

  // Below the button, right-aligned with it; above it when there is no room below (the sheet at peek).
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? 48;
    const below = rect.bottom + GAP_PX;
    const top = below + height <= window.innerHeight - 8 ? below : rect.top - GAP_PX - height;
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH_PX, window.innerWidth - MENU_WIDTH_PX - 8));
    setPosition({ top, left });
  }, [open]);

  // Once placed (it is hidden, so not focusable, until then), focus the first item.
  useEffect(() => {
    if (open && position) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, position]);

  // Close on a press outside, on resize (the button moves), or when focus leaves.
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) dismiss();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  function closeMenu() {
    dismiss();
    button.current?.focus();
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => items[(to + items.length) % items.length]?.focus();
    if (event.key === "Escape") closeMenu();
    else if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Tab") dismiss();
    else return;
    if (event.key !== "Tab") event.preventDefault();
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "header-menu" : undefined}
        data-testid="header-menu-button"
        onClick={() => (open ? dismiss() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`${corner ? "size-8" : "-mr-2 size-9"} grid shrink-0 cursor-pointer place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none aria-expanded:bg-surface-raised aria-expanded:text-ink`}
      >
        <svg
          viewBox="0 0 24 24"
          className="size-5"
          fill="currentColor"
          aria-hidden="true"
          transform={corner ? "rotate(90)" : undefined}
        >
          <circle cx="12" cy="5.5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="18.5" r="1.75" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id="header-menu"
            role="menu"
            aria-label="More"
            data-testid="header-menu"
            onKeyDown={onMenuKeyDown}
            onPointerDown={stopPointer}
            className="fixed z-30 rounded-xl border border-line bg-surface p-1.5 text-ink shadow-panel"
            style={{
              width: MENU_WIDTH_PX,
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-testid="report-problem"
              onClick={() => {
                dismiss();
                setReporting(true);
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
            >
              <svg
                viewBox="0 0 24 24"
                className="size-[18px] shrink-0 text-ink-muted"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 21V4.5a.5.5 0 0 1 .5-.5H18l-2.5 4.5L18 13H5" />
              </svg>
              Report a problem
            </button>
          </div>,
          portalTarget(),
        )}
      {reporting &&
        createPortal(
          <Suspense fallback={null}>
            <ReportDialog
              onClose={() => {
                setReporting(false);
                button.current?.focus();
              }}
            />
          </Suspense>,
          portalTarget(),
        )}
    </>
  );
}
