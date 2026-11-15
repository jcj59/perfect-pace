import { describe, expect, it } from "vitest";
import { type CacheLike, DemCache, SHELL_CACHE_PREFIX, routeFor, staleShellCaches } from "../src/sw/policy.ts";

const ORIGIN = "https://perfect-pace.example";
const PRECACHED = new Set(["/", "/assets/index-abc.js", "/icons/icon-192.png"]);
const TILE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1234/1500.png";

const get = (url: string, mode = "cors") => ({ method: "GET", url, mode });

describe("service worker routing", () => {
  it("sends navigations, share links included, to the network-first shell", () => {
    expect(routeFor(get(`${ORIGIN}/`, "navigate"), ORIGIN, PRECACHED)).toBe("navigation");
    // The hash never reaches the service worker, but a URL with one still navigates.
    expect(routeFor(get(`${ORIGIN}/#v=2&c=t.AAAA`, "navigate"), ORIGIN, PRECACHED)).toBe("navigation");
  });

  it("answers precached files from the shell cache, and nothing else of the origin", () => {
    expect(routeFor(get(`${ORIGIN}/assets/index-abc.js`), ORIGIN, PRECACHED)).toBe("shell");
    expect(routeFor(get(`${ORIGIN}/icons/icon-192.png`), ORIGIN, PRECACHED)).toBe("shell");
    // A file of another build: the server would answer it with the HTML fallback.
    expect(routeFor(get(`${ORIGIN}/assets/index-old.js`), ORIGIN, PRECACHED)).toBe("network");
    expect(routeFor(get(`${ORIGIN}/assets/index-abc.js?x=1`), ORIGIN, PRECACHED)).toBe("network");
  });

  it("never caches the API, other methods, or the basemap", () => {
    expect(routeFor(get(`${ORIGIN}/api/health`), ORIGIN, PRECACHED)).toBe("network");
    expect(routeFor(get(`${ORIGIN}/api/route`, "navigate"), ORIGIN, PRECACHED)).toBe("network");
    expect(routeFor({ method: "POST", url: `${ORIGIN}/api/route`, mode: "cors" }, ORIGIN, PRECACHED)).toBe("network");
    expect(routeFor({ method: "POST", url: TILE, mode: "cors" }, ORIGIN, PRECACHED)).toBe("network");
    expect(routeFor(get("https://tiles.openfreemap.org/planet"), ORIGIN, PRECACHED)).toBe("network");
  });

  it("caches Terrarium tiles only", () => {
    expect(routeFor(get(TILE), ORIGIN, PRECACHED)).toBe("dem");
    expect(routeFor(get(`${TILE}?v=2`), ORIGIN, PRECACHED)).toBe("network");
    expect(routeFor(get("https://s3.amazonaws.com/elevation-tiles-prod/normal/12/1/1.png"), ORIGIN, PRECACHED)).toBe(
      "network",
    );
  });
});

describe("shell cache cleanup", () => {
  const name = (v: string) => `${SHELL_CACHE_PREFIX}${v}`;

  it("keeps the current build and the one before it", () => {
    const names = [name("a"), "pp-dem-v1", name("b"), name("c"), name("d")];
    expect(staleShellCaches(names, name("d"))).toEqual([name("a"), name("b")]);
  });

  it("deletes nothing on a first install or a single upgrade", () => {
    expect(staleShellCaches([name("a")], name("a"))).toEqual([]);
    expect(staleShellCaches([name("a"), name("b")], name("b"))).toEqual([]);
  });
});

/** An in-memory Cache with the Cache API's ordering: `put` replaces an entry and appends it. */
class MemoryCache implements CacheLike {
  readonly entries = new Map<string, Response>();
  private static key(r: Request | string): string {
    return typeof r === "string" ? r : r.url;
  }
  match(r: Request | string) {
    return Promise.resolve(this.entries.get(MemoryCache.key(r))?.clone());
  }
  put(r: Request | string, response: Response) {
    this.entries.delete(MemoryCache.key(r));
    this.entries.set(MemoryCache.key(r), response);
    return Promise.resolve();
  }
  delete(r: Request | string) {
    return Promise.resolve(this.entries.delete(MemoryCache.key(r)));
  }
  keys() {
    return Promise.resolve([...this.entries.keys()].map((url) => new Request(url)));
  }
}

const tile = (i: number) => new Request(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/${i}/1.png`);

function setup(maxTiles: number, respond: (r: Request) => Response = () => new Response("png")) {
  const cache = new MemoryCache();
  const fetched: string[] = [];
  const work: Promise<unknown>[] = [];
  const dem = new DemCache(
    () => Promise.resolve(cache),
    maxTiles,
    (r) => {
      fetched.push(r.url);
      return Promise.resolve(respond(r));
    },
  );
  const get = async (i: number) => {
    const response = await dem.respond(tile(i), (w) => work.push(w));
    await Promise.all(work.splice(0));
    return response;
  };
  return { cache, fetched, get, urls: () => [...cache.entries.keys()].map((u) => Number(u.split("/").at(-2))) };
}

describe("DEM tile cache", () => {
  it("answers a repeat request from the cache", async () => {
    const { fetched, get } = setup(4);
    expect(await (await get(1)).text()).toBe("png");
    expect(await (await get(1)).text()).toBe("png");
    expect(fetched).toHaveLength(1);
  });

  it("keeps at most maxTiles, evicting the least recently used", async () => {
    const { get, urls, fetched } = setup(3);
    for (const i of [1, 2, 3]) await get(i);
    await get(1); // 1 is now the most recent
    await get(4); // evicts 2, the least recently used
    expect(urls()).toEqual([3, 1, 4]);
    await get(2);
    expect(urls()).toEqual([1, 4, 2]);
    expect(fetched).toHaveLength(5);
  });

  it("never keeps a failed or opaque answer", async () => {
    const { cache, get } = setup(3, (r) =>
      r.url.includes("/1/") ? new Response("missing", { status: 404 }) : Response.error(),
    );
    expect((await get(1)).status).toBe(404);
    expect((await get(2)).type).toBe("error");
    expect(cache.entries.size).toBe(0);
  });

  it("passes a network failure through, so the app reports it", async () => {
    const dem = new DemCache(
      () => Promise.resolve(new MemoryCache()),
      3,
      () => Promise.reject(new TypeError("offline")),
    );
    await expect(dem.respond(tile(1))).rejects.toThrow("offline");
  });
});
