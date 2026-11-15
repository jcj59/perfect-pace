import { createStore, useStore } from "../state/store.ts";

/** Connection and service worker state, for the panel header's status line. */
export interface PwaState {
  /** The browser's own idea of the connection (`navigator.onLine`). */
  online: boolean;
  /** A newer build took over this page; a reload shows it. */
  updateReady: boolean;
}

export const pwaStore = createStore<PwaState>({
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  updateReady: false,
});

export function usePwaState<T>(selector: (state: PwaState) => T): T {
  return useStore(pwaStore, selector);
}

/** How often a long-open page asks for a newer service worker, at most, when it comes back into view. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

/**
 * Track the connection, and in production builds register the service worker (`src/sw/sw.ts`,
 * built to `/sw.js`) once the page has loaded, so it never competes with the first load. Returns
 * the cleanup for the listeners.
 */
export function startPwa(): () => void {
  const sync = () => pwaStore.set({ online: navigator.onLine });
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
  sync();
  const cleanups = [
    () => window.removeEventListener("online", sync),
    () => window.removeEventListener("offline", sync),
  ];
  if (import.meta.env.PROD && "serviceWorker" in navigator) cleanups.push(registerServiceWorker());
  return () => cleanups.forEach((cleanup) => cleanup());
}

function registerServiceWorker(): () => void {
  const container = navigator.serviceWorker;
  // Once a service worker controls the page, another taking over means a newer build installed.
  // The first one claiming a page that loaded without one is not an update.
  let controlled = container.controller !== null;
  const onControllerChange = () => {
    if (controlled) pwaStore.set({ updateReady: true });
    controlled = true;
  };
  container.addEventListener("controllerchange", onControllerChange);

  let registration: ServiceWorkerRegistration | undefined;
  let lastCheck = Date.now();
  const onVisible = () => {
    if (document.visibilityState !== "visible" || !registration || Date.now() - lastCheck < UPDATE_CHECK_MS) return;
    lastCheck = Date.now();
    registration.update().catch(() => {}); // offline: try again next time
  };
  document.addEventListener("visibilitychange", onVisible);

  const register = () => {
    container
      .register("/sw.js", { scope: "/" })
      .then((r) => {
        registration = r;
      })
      .catch((error: unknown) => console.warn("The service worker did not register", error));
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });

  return () => {
    container.removeEventListener("controllerchange", onControllerChange);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("load", register);
  };
}
