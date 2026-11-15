/**
 * A pathname router for the app's two pages: the planner at `/` and the race library at `/races`.
 * The Worker answers any path with the app (its single-page fallback), and offline the service
 * worker answers every navigation with the cached shell, so both pages work as direct links.
 */
import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** The current pathname, re-rendering on `navigate` and on the browser's back and forward. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

/** Go to `to` (a path with any query) without reloading, as a new history entry. */
export function navigate(to: string): void {
  history.pushState(null, "", to);
  for (const listener of [...listeners]) listener();
  window.scrollTo(0, 0);
}

/** A link within the app: a real `<a>` (so it opens in a new tab too), followed without a reload. */
export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(to);
      }}
    />
  );
}
