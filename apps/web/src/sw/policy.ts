/**
 * What the service worker (`sw.ts`) does with each request, as plain functions with no service
 * worker globals, so the web unit tests can check them. Kept apart from `sw.ts` so the app could
 * share them without pulling in the worker.
 */

/** Precache names start with this, then the build's version. */
export const SHELL_CACHE_PREFIX = "pp-shell-";
/** Terrarium elevation tiles, kept least recently used first (see `DemCache`). */
export const DEM_CACHE = "pp-dem-v1";
/**
 * The most DEM tiles kept. A zoom 12 Terrarium tile is about 100 KB and covers about 10 km by
 * 10 km at mid latitudes, so this is room for a few dozen courses (about 25 MB).
 */
export const DEM_CACHE_MAX_TILES = 256;
/** How long a navigation waits for the network before it falls back to the cached app shell. */
export const NAVIGATION_TIMEOUT_MS = 4000;
/** Shell caches kept: the current build's, and the one before, for pages still running it. */
export const SHELL_CACHES_KEPT = 2;

const TERRARIUM = /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\/\d+\/\d+\/\d+\.png$/;

export type Route = "navigation" | "shell" | "dem" | "network";

export interface RequestInfo {
  method: string;
  url: string;
  mode: string;
}

/**
 * How to answer a request. Only GETs are ever answered from a cache. `/api/*` always goes to the
 * network (routing answers and health checks are live), as does anything not in the precache: a
 * missing `/assets/` file gets the app's HTML from the server (its single-page fallback), which
 * must never be cached as a script. Share links live in the URL's hash, which never reaches here,
 * so they are just navigations to `/`.
 */
export function routeFor(request: RequestInfo, origin: string, precached: ReadonlySet<string>): Route {
  if (request.method !== "GET") return "network";
  const url = new URL(request.url);
  if (url.origin === origin) {
    if (url.pathname.startsWith("/api/")) return "network";
    if (request.mode === "navigate") return "navigation";
    return precached.has(url.pathname) && url.search === "" ? "shell" : "network";
  }
  return TERRARIUM.test(`${url.origin}${url.pathname}`) && url.search === "" ? "dem" : "network";
}

/** The shell caches to delete once `current` is active: all but the newest `SHELL_CACHES_KEPT`. */
export function staleShellCaches(names: readonly string[], current: string): string[] {
  const shells = names.filter((n) => n.startsWith(SHELL_CACHE_PREFIX) && n !== current);
  // `caches.keys()` lists caches in creation order, so the newest are last.
  return shells.slice(0, Math.max(0, shells.length - (SHELL_CACHES_KEPT - 1)));
}

/** The parts of the Cache API that `DemCache` uses. */
export interface CacheLike {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
  delete(request: Request | string): Promise<boolean>;
  keys(): Promise<readonly Request[]>;
}

/**
 * A bounded, least recently used cache of DEM tiles on the Cache API. The Cache API keeps entries
 * in insertion order, so a hit is deleted and put back at the end, and once there are more than
 * `maxTiles` the oldest go. Failed and opaque responses are never kept.
 */
export class DemCache {
  constructor(
    private readonly open: () => Promise<CacheLike>,
    private readonly maxTiles: number = DEM_CACHE_MAX_TILES,
    private readonly fetchFn: (request: Request) => Promise<Response> = (r) => fetch(r),
  ) {}

  /**
   * Answer a tile request: from the cache when it has it, else from the network (keeping a good
   * answer). `waitUntil` receives the bookkeeping that may finish after the answer.
   */
  async respond(request: Request, waitUntil: (work: Promise<unknown>) => void = () => {}): Promise<Response> {
    const cache = await this.open();
    const hit = await cache.match(request);
    if (hit) {
      waitUntil(this.touch(cache, request, hit.clone()));
      return hit;
    }
    const response = await this.fetchFn(request);
    if (response.ok && response.type !== "opaque") {
      waitUntil(this.keep(cache, request, response.clone()));
    }
    return response;
  }

  /**
   * Move a hit to the most recently used end. A `put` alone appends it in Chromium and Firefox,
   * but WebKit replaces the entry where it is, so delete it first.
   */
  private async touch(cache: CacheLike, request: Request, response: Response): Promise<void> {
    await cache.delete(request);
    await cache.put(request, response);
  }

  private async keep(cache: CacheLike, request: Request, response: Response): Promise<void> {
    await cache.put(request, response);
    const keys = await cache.keys();
    const excess = keys.length - this.maxTiles;
    for (const key of keys.slice(0, Math.max(0, excess))) await cache.delete(key);
  }
}
