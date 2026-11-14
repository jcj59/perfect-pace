/**
 * Elevation from a digital elevation model (DEM): the `ElevationProvider` interface and its
 * implementation on Terrarium tiles (Mapzen's encoding, served free and without a key from AWS
 * Open Data as `elevation-tiles-prod`).
 *
 * A Terrarium tile is a 256x256 Web Mercator PNG whose pixel colors encode elevation as
 * `R * 256 + G + B / 256 - 32768` meters. A point's elevation is bilinearly interpolated between the
 * four pixel centers around it, reading neighboring tiles at tile edges, so the surface has no
 * steps or seams that would show up as fake grade.
 *
 * Core has no DOM, so fetching and PNG decoding are injectable. By default, tiles are fetched with
 * the global `fetch` and decoded with `OffscreenCanvas` (browsers and Web Workers); Node and other
 * runtimes pass their own `decode`.
 */
import type { LatLon } from "./geo.ts";
import { LruCache } from "./lru.ts";

/** A source of elevations for arbitrary positions. */
export interface ElevationProvider {
  /** The elevation in meters of each point, in order. Rejects with an `ElevationError`. */
  elevations(points: readonly LatLon[]): Promise<number[]>;
}

/** Why elevation data could not be read. */
export type ElevationErrorCode = "fetch" | "decode";

/** A failure to fetch or decode elevation data. */
export class ElevationError extends Error {
  override readonly name = "ElevationError";
  constructor(
    readonly code: ElevationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** A decoded image: `data` holds RGBA bytes, row by row (the layout of `ImageData`). */
export interface DecodedImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** Decodes the bytes of a PNG tile. */
export type TileDecoder = (bytes: Uint8Array) => Promise<DecodedImage>;

/** Fetches the raw bytes of tile `z/x/y`. */
export type TileFetcher = (z: number, x: number, y: number) => Promise<Uint8Array>;

/** The public AWS Terrarium tile URL template. */
export const TERRARIUM_URL_TEMPLATE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/**
 * Default DEM zoom: 12, about 28 m per pixel at 42 degrees latitude (38 m at the equator). That is
 * finer than the elevation smoothing (see `elevation.ts`), and a marathon needs only about a dozen
 * tiles. In the US the tiles come from 10 m USGS 3DEP data, so higher zooms add little after
 * smoothing but many more requests.
 */
export const DEFAULT_TERRARIUM_ZOOM = 12;

/** Default tile cache size: 64 decoded tiles, 16 MB, room for several marathons. */
export const DEFAULT_TILE_CACHE_SIZE = 64;

/** The elevation in meters encoded by one Terrarium pixel. */
export function decodeTerrariumPixel(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

// Structural types for the browser APIs used below, since core is compiled without the DOM lib.
interface Bitmap {
  width: number;
  height: number;
  close?: () => void;
}
interface Context2d {
  drawImage(image: Bitmap, x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
}
interface CanvasGlobals {
  OffscreenCanvas?: new (
    w: number,
    h: number,
  ) => {
    getContext(type: "2d", options?: object): Context2d | null;
  };
  createImageBitmap?: (source: unknown, options?: object) => Promise<Bitmap>;
  Blob?: new (parts: unknown[], options?: { type: string }) => unknown;
}
interface FetchResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
type FetchFn = (url: string) => Promise<FetchResponse>;

/**
 * A decoder on `createImageBitmap` and `OffscreenCanvas`, or `undefined` where they are missing
 * (Node, React Native). Premultiplied alpha and color space conversion are turned off: either one
 * would change the RGB bytes, which here are data, not colors.
 */
export function canvasTileDecoder(): TileDecoder | undefined {
  const { OffscreenCanvas, createImageBitmap, Blob } = globalThis as CanvasGlobals;
  if (!OffscreenCanvas || !createImageBitmap || !Blob) return undefined;
  return async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
    const { width, height } = bitmap;
    const context = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("OffscreenCanvas has no 2d context");
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return { width, height, data: context.getImageData(0, 0, width, height).data };
  };
}

/** A fetcher on the global `fetch` for a `{z}/{x}/{y}` URL template. */
export function urlTileFetcher(template: string = TERRARIUM_URL_TEMPLATE): TileFetcher {
  return async (z, x, y) => {
    const fetchFn = (globalThis as { fetch?: FetchFn }).fetch;
    if (!fetchFn) throw new Error("no global fetch");
    const url = template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

/** Options for `terrariumProvider`. */
export interface TerrariumOptions {
  /** Tile zoom level, an integer in [0, 15]. Default `DEFAULT_TERRARIUM_ZOOM`. */
  zoom?: number;
  /** Tile source. Default `urlTileFetcher()` (AWS). */
  fetchTile?: TileFetcher;
  /** PNG decoder. Default `canvasTileDecoder()`, required where that is unavailable. */
  decode?: TileDecoder;
  /** How many decoded tiles to keep. Default `DEFAULT_TILE_CACHE_SIZE`. */
  cacheSize?: number;
}

interface Tile {
  size: number;
  ele: Float32Array;
}

/** Web Mercator stops just short of the poles; clamp to it. */
const MAX_LAT = 85.05112878;

/**
 * An `ElevationProvider` on Terrarium tiles. Each call fetches the tiles it needs in parallel;
 * decoded tiles stay in an LRU cache shared across calls, and concurrent requests for one tile
 * share one fetch. A failed tile is not cached, so a later call retries it.
 */
export function terrariumProvider(options: TerrariumOptions = {}): ElevationProvider {
  const { zoom = DEFAULT_TERRARIUM_ZOOM, cacheSize = DEFAULT_TILE_CACHE_SIZE } = options;
  if (!(Number.isInteger(zoom) && zoom >= 0 && zoom <= 15)) {
    throw new RangeError(`terrariumProvider: zoom must be an integer in [0, 15], got ${zoom}`);
  }
  const fetchTile = options.fetchTile ?? urlTileFetcher();
  const maybeDecode = options.decode ?? canvasTileDecoder();
  if (!maybeDecode) {
    throw new TypeError("terrariumProvider: this runtime has no OffscreenCanvas, so pass a PNG `decode` function");
  }
  const decode = maybeDecode;
  const cache = new LruCache<string, Promise<Tile>>(cacheSize);
  const tilesPerSide = 2 ** zoom;

  async function loadTile(x: number, y: number): Promise<Tile> {
    const where = `Terrarium tile ${zoom}/${x}/${y}`;
    let bytes: Uint8Array;
    try {
      bytes = await fetchTile(zoom, x, y);
    } catch (cause) {
      throw new ElevationError("fetch", `Could not download elevation data (${where}).`, { cause });
    }
    let image: DecodedImage;
    try {
      image = await decode(bytes);
    } catch (cause) {
      throw new ElevationError("decode", `Could not read elevation data (${where}).`, { cause });
    }
    const { width, height, data } = image;
    if (width !== height || width === 0 || data.length < width * height * 4) {
      throw new ElevationError("decode", `Could not read elevation data (${where} is ${width}x${height}).`);
    }
    const ele = new Float32Array(width * height);
    for (let i = 0; i < ele.length; i++) {
      ele[i] = decodeTerrariumPixel(data[4 * i] as number, data[4 * i + 1] as number, data[4 * i + 2] as number);
    }
    return { size: width, ele };
  }

  function tile(x: number, y: number): Promise<Tile> {
    const key = `${x}/${y}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = loadTile(x, y);
      cache.set(key, pending);
      pending.catch(() => {
        if (cache.peek(key) === pending) cache.delete(key);
      });
    }
    return pending;
  }

  /** Fractional tile coordinates of a point (x wraps around the antimeridian, y is clamped). */
  function tileCoords(p: LatLon): { tx: number; ty: number } {
    const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p.lat)) * (Math.PI / 180);
    const tx = ((p.lon + 180) / 360) * tilesPerSide;
    const ty = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * tilesPerSide;
    return { tx, ty };
  }

  return {
    async elevations(points) {
      // Tile size comes from the tiles themselves (256 for Terrarium), so read the home tile of
      // every point first, then any neighbors that bilinear sampling reaches into.
      const coords = points.map(tileCoords);
      const tiles = new Map<string, Tile>();
      const need = (x: number, y: number): string => {
        const wx = ((x % tilesPerSide) + tilesPerSide) % tilesPerSide;
        const wy = Math.min(tilesPerSide - 1, Math.max(0, y));
        return `${wx}/${wy}`;
      };
      const fetchAll = async (keys: Set<string>): Promise<void> => {
        const missing = [...keys].filter((k) => !tiles.has(k));
        const loaded = await Promise.all(
          missing.map((k) => {
            const [x, y] = k.split("/").map(Number) as [number, number];
            return tile(x, y);
          }),
        );
        missing.forEach((k, i) => tiles.set(k, loaded[i] as Tile));
      };
      await fetchAll(new Set(coords.map(({ tx, ty }) => need(Math.floor(tx), Math.floor(ty)))));

      const samples = coords.map(({ tx, ty }) => {
        const size = (tiles.get(need(Math.floor(tx), Math.floor(ty))) as Tile).size;
        // Pixel centers sit at half-pixel offsets, so shift by half a pixel before flooring.
        const gx = tx * size - 0.5;
        const gy = Math.min(tilesPerSide * size - 1, Math.max(0, ty * size - 0.5));
        return { size, gx, gy, x0: Math.floor(gx), y0: Math.floor(gy) };
      });
      const neighbors = new Set<string>();
      for (const { size, x0, y0 } of samples) {
        for (const px of [x0, x0 + 1])
          for (const py of [y0, y0 + 1]) neighbors.add(need(Math.floor(px / size), Math.floor(py / size)));
      }
      await fetchAll(neighbors);

      const pixel = (size: number, px: number, py: number): number => {
        const wrap = tilesPerSide * size;
        const x = ((px % wrap) + wrap) % wrap;
        const y = Math.min(wrap - 1, Math.max(0, py));
        const t = tiles.get(need(Math.floor(x / size), Math.floor(y / size))) as Tile;
        return t.ele[(y % size) * size + (x % size)] as number;
      };
      return samples.map(({ size, gx, gy, x0, y0 }) => {
        const fx = gx - x0;
        const fy = gy - y0;
        const top = pixel(size, x0, y0) * (1 - fx) + pixel(size, x0 + 1, y0) * fx;
        const bottom = pixel(size, x0, y0 + 1) * (1 - fx) + pixel(size, x0 + 1, y0 + 1) * fx;
        return top * (1 - fy) + bottom * fy;
      });
    },
  };
}
