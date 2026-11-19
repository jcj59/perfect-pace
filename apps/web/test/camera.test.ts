import { describe, expect, it } from "vitest";
import {
  CAMERA_STORAGE_KEY,
  type MapCamera,
  keepsStartCamera,
  holdStartCamera,
  parseCamera,
  readCamera,
  releaseStartCamera,
  serializeCamera,
  startFraming,
  writeCamera,
} from "../src/state/camera.ts";

const boston: MapCamera = { center: { lat: 42.35, lon: -71.08 }, zoom: 13.25 };

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}
const throwing = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("startFraming", () => {
  const cases: [string, Parameters<typeof startFraming>[0], ReturnType<typeof startFraming>][] = [
    [
      "a share link wins over everything",
      { shareLink: true, savedCamera: boston, sessionCourse: true },
      { kind: "share" },
    ],
    ["a share link alone", { shareLink: true, savedCamera: undefined, sessionCourse: false }, { kind: "share" }],
    [
      "the saved camera wins over the session course",
      { shareLink: false, savedCamera: boston, sessionCourse: true },
      { kind: "saved", camera: boston },
    ],
    [
      "the saved camera alone",
      { shareLink: false, savedCamera: boston, sessionCourse: false },
      { kind: "saved", camera: boston },
    ],
    [
      "the session course is fit without a saved camera",
      { shareLink: false, savedCamera: undefined, sessionCourse: true },
      { kind: "session" },
    ],
    ["nothing at all", { shareLink: false, savedCamera: undefined, sessionCourse: false }, { kind: "default" }],
  ];
  for (const [name, inputs, expected] of cases) {
    it(name, () => expect(startFraming(inputs)).toEqual(expected));
  }

  it("a corrupt saved camera falls through to the session, then the default", () => {
    const savedCamera = parseCamera("{not json");
    expect(startFraming({ shareLink: false, savedCamera, sessionCourse: true })).toEqual({ kind: "session" });
    expect(startFraming({ shareLink: false, savedCamera, sessionCourse: false })).toEqual({ kind: "default" });
  });
});

describe("parseCamera", () => {
  it("reads back what serializeCamera wrote", () => {
    expect(parseCamera(serializeCamera(boston))).toEqual(boston);
  });

  it("rounds to a stable precision", () => {
    const text = serializeCamera({ center: { lat: 42.123456789, lon: -71.987654321 }, zoom: 12.3456789 });
    expect(JSON.parse(text)).toEqual({ v: 1, lat: 42.123457, lon: -71.987654, zoom: 12.346 });
  });

  it("accepts the edges of the range", () => {
    expect(parseCamera(JSON.stringify({ v: 1, lat: 85.051129, lon: 180, zoom: 22 }))).toBeDefined();
    expect(parseCamera(JSON.stringify({ v: 1, lat: -85.051129, lon: -180, zoom: 0 }))).toBeDefined();
  });

  const rejected: [string, string | null][] = [
    ["nothing", null],
    ["an empty string", ""],
    ["not JSON", "{lat:"],
    ["JSON null", "null"],
    ["a number", "42"],
    ["an array", "[1,2,3]"],
    ["no version", JSON.stringify({ lat: 1, lon: 1, zoom: 1 })],
    ["another version", JSON.stringify({ v: 2, lat: 1, lon: 1, zoom: 1 })],
    ["a missing field", JSON.stringify({ v: 1, lat: 1, zoom: 1 })],
    ["a string number", JSON.stringify({ v: 1, lat: "1", lon: 1, zoom: 1 })],
    ["latitude past the map", JSON.stringify({ v: 1, lat: 86, lon: 1, zoom: 1 })],
    ["longitude past 180", JSON.stringify({ v: 1, lat: 1, lon: 181, zoom: 1 })],
    ["a negative zoom", JSON.stringify({ v: 1, lat: 1, lon: 1, zoom: -1 })],
    ["a zoom past 22", JSON.stringify({ v: 1, lat: 1, lon: 1, zoom: 23 })],
    ["infinity (as JSON writes it, null)", JSON.stringify({ v: 1, lat: Infinity, lon: 1, zoom: 1 })],
  ];
  for (const [name, text] of rejected) {
    it(`ignores ${name}`, () => expect(parseCamera(text)).toBeUndefined());
  }
});

describe("camera storage", () => {
  it("writes and reads the camera under pp:camera", () => {
    const storage = memoryStorage();
    writeCamera(storage, boston);
    expect(JSON.parse(storage.items.get(CAMERA_STORAGE_KEY)!)).toEqual({ v: 1, lat: 42.35, lon: -71.08, zoom: 13.25 });
    expect(readCamera(storage)).toEqual(boston);
  });

  it("works without storage, or with storage that throws", () => {
    expect(readCamera(undefined)).toBeUndefined();
    expect(readCamera(throwing)).toBeUndefined();
    expect(() => writeCamera(undefined, boston)).not.toThrow();
    expect(() => writeCamera(throwing, boston)).not.toThrow();
  });

  it("ignores a corrupt value", () => {
    expect(readCamera(memoryStorage({ [CAMERA_STORAGE_KEY]: "garbage" }))).toBeUndefined();
  });
});

describe("keeping the start camera for the restored course", () => {
  it("keeps it for the first route only, and again for that same route", () => {
    const restored = [{}];
    const next = [{}];
    holdStartCamera();
    expect(keepsStartCamera(restored)).toBe(true);
    expect(keepsStartCamera(restored)).toBe(true);
    expect(keepsStartCamera(next)).toBe(false);
    // A release once the restored course is on the map changes nothing for it.
    releaseStartCamera();
    expect(keepsStartCamera(restored)).toBe(true);
  });

  it("frames every route once released before the restored one arrived", () => {
    holdStartCamera();
    releaseStartCamera();
    expect(keepsStartCamera([{}])).toBe(false);
  });
});
