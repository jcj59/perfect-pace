import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERRARIUM_ZOOM,
  ElevationError,
  type LatLon,
  TERRARIUM_URL_TEMPLATE,
  canvasTileDecoder,
  decodeTerrariumPixel,
  terrariumProvider,
  urlTileFetcher,
} from "../src/index.ts";
import { LruCache } from "../src/lru.ts";
import { decodePng, encodePng, fixtureDemProvider, pngDecoder, terrariumRgb } from "./support/dem.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The position of global pixel `(gx, gy)` (fractional, centers at integers) at `zoom` with `size`-pixel tiles. */
function atPixel(gx: number, gy: number, zoom: number, size: number): LatLon {
  const world = size * 2 ** zoom;
  const lon = ((gx + 0.5) / world) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (gy + 0.5)) / world))) * 180) / Math.PI;
  return { lat, lon };
}

/**
 * A synthetic world at zoom 1 (2x2 tiles of 4x4 pixels, 8x8 pixels in all) whose elevation at
 * global pixel `(gx, gy)` is `10 gx + 3 gy`. Bilinear interpolation reproduces a linear function
 * exactly, so any sample, including across tile seams, has a known answer.
 */
const SIZE = 4;
const ZOOM = 1;
const plane = (gx: number, gy: number): number => 10 * gx + 3 * gy;

function syntheticTiles(): { fetchTile: (z: number, x: number, y: number) => Promise<Uint8Array>; log: string[] } {
  const log: string[] = [];
  const fetchTile = (z: number, x: number, y: number): Promise<Uint8Array> => {
    log.push(`${z}/${x}/${y}`);
    return Promise.resolve(encodePng(SIZE, SIZE, (px, py) => terrariumRgb(plane(x * SIZE + px, y * SIZE + py))));
  };
  return { fetchTile, log };
}

describe("decodeTerrariumPixel", () => {
  it("decodes the Terrarium encoding", () => {
    expect(decodeTerrariumPixel(128, 0, 0)).toBe(0);
    expect(decodeTerrariumPixel(128, 100, 128)).toBe(100.5);
    expect(decodeTerrariumPixel(127, 255, 0)).toBe(-1);
    for (const e of [-430, 0, 12.25, 123.5, 8849]) {
      const [r, g, b] = terrariumRgb(e);
      expect(decodeTerrariumPixel(r, g, b)).toBe(e);
    }
  });
});

describe("terrariumProvider on synthetic tiles", () => {
  it("interpolates bilinearly, across tile seams too", async () => {
    const { fetchTile, log } = syntheticTiles();
    const provider = terrariumProvider({ zoom: ZOOM, fetchTile, decode: pngDecoder });
    const pixels: [number, number][] = [
      [0, 0],
      [1.25, 2.5],
      [3.5, 3.5], // the seam between all four tiles
      [3.9, 0.1],
      [6.75, 6.2],
      [7, 7],
    ];
    const got = await provider.elevations(pixels.map(([gx, gy]) => atPixel(gx, gy, ZOOM, SIZE)));
    pixels.forEach(([gx, gy], i) => expect(got[i], `pixel ${gx},${gy}`).toBeCloseTo(plane(gx, gy), 6));
    expect(new Set(log)).toEqual(new Set(["1/0/0", "1/1/0", "1/0/1", "1/1/1"]));
  });

  it("wraps around the antimeridian and clamps at the poles", async () => {
    const { fetchTile } = syntheticTiles();
    const provider = terrariumProvider({ zoom: ZOOM, fetchTile, decode: pngDecoder });
    const [wrapped, north, south] = await provider.elevations([
      atPixel(7.25, 2, ZOOM, SIZE),
      { lat: 89.9, lon: atPixel(2, 0, ZOOM, SIZE).lon },
      { lat: -90, lon: atPixel(5, 0, ZOOM, SIZE).lon },
    ]);
    expect(wrapped).toBeCloseTo(0.75 * plane(7, 2) + 0.25 * plane(0, 2), 6);
    expect(north).toBeCloseTo(plane(2, 0), 6);
    expect(south).toBeCloseTo(plane(5, 7), 6);
  });

  it("returns nothing for no points", async () => {
    const { fetchTile, log } = syntheticTiles();
    expect(await terrariumProvider({ zoom: ZOOM, fetchTile, decode: pngDecoder }).elevations([])).toEqual([]);
    expect(log).toEqual([]);
  });

  it("caches tiles across calls, evicting the least recently used", async () => {
    const { fetchTile, log } = syntheticTiles();
    const provider = terrariumProvider({ zoom: ZOOM, fetchTile, decode: pngDecoder, cacheSize: 2 });
    const a = atPixel(1.5, 1.5, ZOOM, SIZE); // tile 0/0 only
    const b = atPixel(5.5, 1.5, ZOOM, SIZE); // tile 1/0 only
    const c = atPixel(1.5, 5.5, ZOOM, SIZE); // tile 0/1 only
    await provider.elevations([a]);
    await provider.elevations([b]);
    await provider.elevations([a]); // hit; b is now least recent
    expect(log).toEqual(["1/0/0", "1/1/0"]);
    await provider.elevations([c]); // evicts b
    await provider.elevations([a]);
    expect(log).toEqual(["1/0/0", "1/1/0", "1/0/1"]);
    await provider.elevations([b]);
    expect(log).toEqual(["1/0/0", "1/1/0", "1/0/1", "1/1/0"]);
  });

  it("shares one fetch between concurrent requests for a tile", async () => {
    const { fetchTile, log } = syntheticTiles();
    const provider = terrariumProvider({ zoom: ZOOM, fetchTile, decode: pngDecoder });
    const p = atPixel(1.5, 1.5, ZOOM, SIZE);
    const [x, y] = await Promise.all([provider.elevations([p]), provider.elevations([p, p])]);
    expect(x).toEqual([plane(1.5, 1.5)]);
    expect(y).toEqual([plane(1.5, 1.5), plane(1.5, 1.5)]);
    expect(log).toEqual(["1/0/0"]);
  });

  it("reports a failed fetch as an ElevationError and retries it on the next call", async () => {
    const { fetchTile } = syntheticTiles();
    let calls = 0;
    const flaky = (z: number, x: number, y: number): Promise<Uint8Array> =>
      ++calls === 1 ? Promise.reject(new Error("offline")) : fetchTile(z, x, y);
    const provider = terrariumProvider({ zoom: ZOOM, fetchTile: flaky, decode: pngDecoder });
    const p = atPixel(1.5, 1.5, ZOOM, SIZE);
    const error = await provider.elevations([p]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElevationError);
    expect(error).toMatchObject({
      code: "fetch",
      message: "Could not download elevation data (Terrarium tile 1/0/0).",
    });
    expect((error as Error).cause).toEqual(new Error("offline"));
    expect(await provider.elevations([p])).toEqual([plane(1.5, 1.5)]);
    expect(calls).toBe(2);
  });

  it("does not let a late failure evict a newer entry", async () => {
    const { fetchTile } = syntheticTiles();
    let failFirst: (e: Error) => void = () => {};
    let calls = 0;
    const slow = (z: number, x: number, y: number): Promise<Uint8Array> =>
      ++calls === 1 ? new Promise((_, reject) => (failFirst = reject)) : fetchTile(z, x, y);
    const provider = terrariumProvider({ zoom: ZOOM, fetchTile: slow, decode: pngDecoder, cacheSize: 1 });
    const a = atPixel(1.5, 1.5, ZOOM, SIZE);
    const b = atPixel(5.5, 1.5, ZOOM, SIZE);
    const first = provider.elevations([a]).catch((e: unknown) => e);
    await provider.elevations([b]); // evicts the pending tile for a
    failFirst(new Error("late"));
    expect(await first).toBeInstanceOf(ElevationError);
    await provider.elevations([b]);
    expect(calls).toBe(2);
  });

  it("reports undecodable and malformed tiles", async () => {
    const { fetchTile } = syntheticTiles();
    const p = atPixel(1.5, 1.5, ZOOM, SIZE);
    const broken = terrariumProvider({ zoom: ZOOM, fetchTile, decode: () => Promise.reject(new Error("bad PNG")) });
    await expect(broken.elevations([p])).rejects.toMatchObject({ name: "ElevationError", code: "decode" });
    const oblong = terrariumProvider({
      zoom: ZOOM,
      fetchTile,
      decode: () => Promise.resolve({ width: 4, height: 2, data: new Uint8Array(32) }),
    });
    await expect(oblong.elevations([p])).rejects.toThrow(/is 4x2/);
    const short = terrariumProvider({
      zoom: ZOOM,
      fetchTile,
      decode: () => Promise.resolve({ width: 4, height: 4, data: new Uint8Array(8) }),
    });
    await expect(short.elevations([p])).rejects.toMatchObject({ code: "decode" });
  });

  it("validates its options", () => {
    const { fetchTile } = syntheticTiles();
    expect(() => terrariumProvider({ zoom: 16, fetchTile, decode: pngDecoder })).toThrow(RangeError);
    expect(() => terrariumProvider({ zoom: 1.5, fetchTile, decode: pngDecoder })).toThrow(RangeError);
    expect(() => terrariumProvider({ fetchTile, decode: pngDecoder, cacheSize: 0 })).toThrow(RangeError);
    // Node has no OffscreenCanvas, so a decoder is required.
    expect(() => terrariumProvider({ fetchTile })).toThrow(/pass a PNG `decode`/);
  });
});

describe("canvasTileDecoder", () => {
  it("is unavailable without OffscreenCanvas", () => {
    expect(canvasTileDecoder()).toBeUndefined();
  });

  it("decodes through createImageBitmap and OffscreenCanvas, without color changes", async () => {
    const calls: unknown[] = [];
    const rgba = new Uint8ClampedArray([1, 2, 3, 255]);
    let closed = false;
    vi.stubGlobal("createImageBitmap", (blob: Blob, options: object) => {
      calls.push(blob.type, options);
      return Promise.resolve({ width: 1, height: 1, close: () => (closed = true) });
    });
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}
        getContext(type: string, options: object) {
          calls.push(type, options);
          return {
            drawImage: (_: unknown, x: number, y: number) => calls.push(`draw at ${x},${y}`),
            getImageData: (x: number, y: number, w: number, h: number) => (
              calls.push(`read ${x},${y},${w},${h}`),
              { data: rgba }
            ),
          };
        }
      },
    );
    const decode = canvasTileDecoder();
    expect(decode).toBeDefined();
    expect(await decode?.(new Uint8Array([1]))).toEqual({ width: 1, height: 1, data: rgba });
    expect(closed).toBe(true);
    expect(calls).toEqual([
      "image/png",
      { premultiplyAlpha: "none", colorSpaceConversion: "none" },
      "2d",
      { willReadFrequently: true },
      "draw at 0,0",
      "read 0,0,1,1",
    ]);
    // The default decoder is picked up when present.
    const provider = terrariumProvider({
      zoom: 0,
      fetchTile: () => Promise.resolve(new Uint8Array([1])),
    });
    expect(await provider.elevations([{ lat: 0, lon: 0 }])).toEqual([decodeTerrariumPixel(1, 2, 3)]);
  });

  it("fails cleanly without a 2d context", async () => {
    vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 1, height: 1 }));
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return null;
        }
      },
    );
    await expect(canvasTileDecoder()?.(new Uint8Array([1]))).rejects.toThrow(/no 2d context/);
  });
});

describe("urlTileFetcher", () => {
  it("fetches the AWS Terrarium URL by default", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new Uint8Array([7, 8]).buffer),
      });
    });
    expect(await urlTileFetcher()(12, 1177, 1513)).toEqual(new Uint8Array([7, 8]));
    expect(await urlTileFetcher("https://tiles.example/{z}-{x}-{y}.png")(1, 2, 3)).toEqual(new Uint8Array([7, 8]));
    expect(urls).toEqual([
      "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1177/1513.png",
      "https://tiles.example/1-2-3.png",
    ]);
    expect(TERRARIUM_URL_TEMPLATE).toContain("{z}/{x}/{y}");
  });

  it("rejects on an HTTP error or a missing fetch", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: false, status: 404, arrayBuffer: () => Promise.reject(new Error()) }),
    );
    await expect(urlTileFetcher()(1, 0, 0)).rejects.toThrow(/HTTP 404/);
    const provider = terrariumProvider({ zoom: 1, decode: pngDecoder });
    await expect(provider.elevations([{ lat: 10, lon: 10 }])).rejects.toMatchObject({ code: "fetch" });
    vi.stubGlobal("fetch", undefined);
    await expect(urlTileFetcher()(1, 0, 0)).rejects.toThrow(/no global fetch/);
  });
});

describe("fixture DEM tiles", () => {
  it("are 256x256 Terrarium PNGs", async () => {
    const log: string[] = [];
    const provider = fixtureDemProvider({ log });
    // Cayuga Lake, off Stewart Park in Ithaca: the lake surface is about 116 m (382 ft).
    const [lake] = await provider.elevations([{ lat: 42.47, lon: -76.525 }]);
    expect(lake).toBeGreaterThan(113);
    expect(lake).toBeLessThan(119);
    expect(log).toEqual([`${DEFAULT_TERRARIUM_ZOOM}/1177/1513`]);
  });

  it("fail loudly for a tile that is not committed", async () => {
    await expect(fixtureDemProvider().elevations([{ lat: 40.7, lon: -74 }])).rejects.toMatchObject({ code: "fetch" });
  });
});

describe("decodePng (test support)", () => {
  it("round-trips the encoder and rejects what it does not support", () => {
    const png = encodePng(3, 2, (x, y) => [x, y, 9]);
    const { width, height, data } = decodePng(png);
    expect([width, height]).toEqual([3, 2]);
    expect(Array.from(data).slice(0, 8)).toEqual([0, 0, 9, 255, 1, 0, 9, 255]);
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
  });
});

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect([cache.has("a"), cache.has("c"), cache.size]).toEqual([true, true, 2]);
    cache.set("a", 4);
    cache.set("d", 5);
    expect([cache.get("a"), cache.get("c"), cache.get("d")]).toEqual([4, undefined, 5]);
    expect(cache.peek("c")).toBeUndefined();
    expect(cache.peek("d")).toBe(5);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(() => new LruCache(0)).toThrow(RangeError);
  });
});
