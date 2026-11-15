/// <reference lib="webworker" />
/**
 * The service worker. It makes the app work offline for uploaded GPX courses:
 *
 * - **App shell:** every file of the build is precached at install, under a cache named for the
 *   build's version. Hashed files are answered from it first. Navigations go to the network first
 *   (so an online reload always gets the latest build, and nobody is stranded on a stale one) and
 *   fall back to the cached shell when offline or after `NAVIGATION_TIMEOUT_MS`.
 * - **Updates:** a new version installs, takes over at once, and keeps the previous build's cache,
 *   so a page still running it can load its lazy chunks. The page offers a reload (`register.ts`).
 * - **Elevation tiles:** Terrarium tiles are kept in a bounded LRU cache (`DemCache`).
 * - **Never cached:** `/api/*` (routing and health), non-GET requests, the basemap, and anything
 *   else not listed above.
 *
 * The build (`precachePlugin` in vite.config.ts) replaces the two placeholders below.
 */
import {
  DEM_CACHE,
  DemCache,
  NAVIGATION_TIMEOUT_MS,
  SHELL_CACHE_PREFIX,
  routeFor,
  staleShellCaches,
} from "./policy.ts";

declare const self: ServiceWorkerGlobalScope;

const VERSION: string = "__PP_VERSION__";
const PRECACHE: readonly string[] = JSON.parse("__PP_PRECACHE__") as string[];
const SHELL_CACHE = `${SHELL_CACHE_PREFIX}${VERSION}`;
const SHELL = "/";
const precached = new Set(PRECACHE);
const dem = new DemCache(() => caches.open(DEM_CACHE));

/** Fetch one precache entry, refusing anything that is not what the build listed. */
async function precacheOne(cache: Cache, path: string): Promise<void> {
  const response = await fetch(new Request(path, { cache: "reload" }));
  // A file missing from a newer deploy comes back as the HTML fallback: never keep that.
  const html = (response.headers.get("content-type") ?? "").includes("text/html");
  if (!response.ok || response.redirected || (path !== SHELL && html)) {
    throw new Error(`Precache: ${path} answered ${response.status} ${response.headers.get("content-type")}`);
  }
  await cache.put(path, response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(PRECACHE.map((path) => precacheOne(cache, path)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const stale = staleShellCaches(await caches.keys(), SHELL_CACHE);
      await Promise.all(stale.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/** The network's answer, unless it fails or takes longer than `timeoutMs`; then the cached shell. */
async function navigate(request: Request): Promise<Response> {
  const network = fetch(request);
  network.catch(() => {}); // when the shell answers instead, its failure is expected
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), NAVIGATION_TIMEOUT_MS);
  });
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== "timeout") return first;
  } catch {
    // Offline, or the server could not be reached: fall back to the shell.
  } finally {
    clearTimeout(timer);
  }
  const shell = (await caches.open(SHELL_CACHE).then((c) => c.match(SHELL))) ?? (await caches.match(SHELL));
  // Without a cached shell, keep waiting on the network (and let its error show).
  return shell ?? network;
}

/** A precached file from any shell cache (this build's or the previous one), else the network. */
async function shellFile(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  return (await caches.match(path)) ?? fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  switch (routeFor(request, self.location.origin, precached)) {
    case "navigation":
      event.respondWith(navigate(request));
      return;
    case "shell":
      event.respondWith(shellFile(request));
      return;
    case "dem":
      event.respondWith(dem.respond(request, (work) => event.waitUntil(work)));
      return;
    case "network":
      return;
  }
});
