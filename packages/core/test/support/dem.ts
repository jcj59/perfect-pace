/**
 * DEM test support: a minimal PNG codec on `node:zlib` (Node has no OffscreenCanvas), the fixture
 * Terrarium provider that reads `test/fixtures/dem/` and never touches the network, and helpers
 * for synthetic tiles.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import {
  type DecodedImage,
  type ElevationProvider,
  type LatLon,
  type TerrariumOptions,
  type TileFetcher,
  terrariumProvider,
} from "../../src/index.ts";

export const DEM_DIR = join(import.meta.dirname, "..", "fixtures", "dem");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode an 8-bit, non-interlaced grayscale, RGB or RGBA PNG to RGBA, like `ImageData`. */
export function decodePng(bytes: Uint8Array): DecodedImage {
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      channels = CHANNELS[color as number] ?? 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) throw new Error("unsupported PNG format");
    } else if (type === "IDAT") idat.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (pixels[y * stride + i - channels] as number) : 0;
      const b = y > 0 ? (pixels[(y - 1) * stride + i] as number) : 0;
      const c = y > 0 && i >= channels ? (pixels[(y - 1) * stride + i - channels] as number) : 0;
      const x = line[i] as number;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter as number];
      if (predictor === undefined) throw new Error(`bad PNG filter ${filter}`);
      pixels[y * stride + i] = (x + predictor) & 0xff;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const src = pixels.subarray(p * channels, (p + 1) * channels);
    const [r, g, b] = channels >= 3 ? [src[0], src[1], src[2]] : [src[0], src[0], src[0]];
    data.set([r as number, g as number, b as number, channels % 2 === 0 ? (src[channels - 1] as number) : 255], p * 4);
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, crc]);
}

/** Encode an RGB PNG (filter 0 on every line), for synthetic tiles. */
export function encodePng(
  width: number,
  height: number,
  rgb: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(rgb(x, y), y * (width * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The Terrarium RGB for an elevation in meters (inverse of `decodeTerrariumPixel`). */
export function terrariumRgb(eleM: number): [number, number, number] {
  const v = eleM + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v) - r * 256;
  const b = Math.round((v - Math.floor(v)) * 256);
  return [r, g, Math.min(255, b)];
}

/** Async PNG decoder for `terrariumProvider`. */
export const pngDecoder = (bytes: Uint8Array): Promise<DecodedImage> => Promise.resolve(decodePng(bytes));

/** A fetcher over the committed tiles at `test/fixtures/dem/{z}/{x}/{y}.png`, logging each request. */
export function fixtureTileFetcher(log: string[] = []): TileFetcher {
  return (z, x, y) => {
    const key = `${z}/${x}/${y}`;
    log.push(key);
    const file = join(DEM_DIR, `${key}.png`);
    if (!existsSync(file)) {
      return Promise.reject(new Error(`No fixture DEM tile ${key}; see test/fixtures/dem/README.md`));
    }
    return Promise.resolve(new Uint8Array(readFileSync(file)));
  };
}

/** The fixture DEM provider: Terrarium on the committed tiles, decoded in Node. */
export function fixtureDemProvider(
  options: Omit<TerrariumOptions, "fetchTile" | "decode"> & { log?: string[] } = {},
): ElevationProvider {
  return terrariumProvider({ ...options, fetchTile: fixtureTileFetcher(options.log), decode: pngDecoder });
}

/** A provider on an elevation function, for synthetic tests. Records how many points it served. */
export function functionProvider(f: (p: LatLon) => number): ElevationProvider & { served: number } {
  const provider = {
    served: 0,
    elevations(points: readonly LatLon[]): Promise<number[]> {
      provider.served += points.length;
      return Promise.resolve(points.map(f));
    },
  };
  return provider;
}

/** A provider that fails the test if asked for anything. */
export const noDemProvider: ElevationProvider = {
  elevations: () => Promise.reject(new Error("the DEM provider should not have been called")),
};
