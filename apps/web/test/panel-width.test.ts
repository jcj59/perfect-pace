import { describe, expect, it } from "vitest";
import {
  PANEL_DEFAULT_WIDTH_PX,
  PANEL_WIDTH_STORAGE_KEY,
  clampPanelWidth,
  keyedPanelWidth,
  panelWidthRange,
  readPanelWidth,
  writePanelWidth,
} from "../src/layout/panelWidth.ts";

/** An in-memory storage, or one that throws on every call (blocked or full). */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}
const throwing = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("panel width range", () => {
  it("runs from 320 px to 720 px on a wide window", () => {
    expect(panelWidthRange(1920)).toEqual({ min: 320, max: 720 });
    expect(panelWidthRange(1200)).toEqual({ min: 320, max: 720 });
  });

  it("caps the width at 60% of a narrower window, in whole pixels", () => {
    expect(panelWidthRange(1000)).toEqual({ min: 320, max: 600 });
    expect(panelWidthRange(801)).toEqual({ min: 320, max: 480 });
  });

  it("never puts the maximum under the minimum", () => {
    expect(panelWidthRange(400)).toEqual({ min: 320, max: 320 });
  });
});

describe("clampPanelWidth", () => {
  it("keeps a width inside the range, rounded", () => {
    expect(clampPanelWidth(500.4, 1280)).toBe(500);
    expect(clampPanelWidth(100, 1280)).toBe(320);
    expect(clampPanelWidth(5000, 1280)).toBe(720);
  });

  it("brings a width back in when the window shrinks", () => {
    expect(clampPanelWidth(700, 1280)).toBe(700);
    expect(clampPanelWidth(700, 1000)).toBe(600);
    expect(clampPanelWidth(700, 768)).toBe(460);
  });
});

describe("keyedPanelWidth", () => {
  const range = panelWidthRange(1280);

  it("moves 16 px per arrow key, within the range", () => {
    expect(keyedPanelWidth("ArrowRight", 384, range)).toBe(400);
    expect(keyedPanelWidth("ArrowUp", 384, range)).toBe(400);
    expect(keyedPanelWidth("ArrowLeft", 384, range)).toBe(368);
    expect(keyedPanelWidth("ArrowDown", 384, range)).toBe(368);
    expect(keyedPanelWidth("ArrowLeft", 330, range)).toBe(320);
    expect(keyedPanelWidth("ArrowRight", 712, range)).toBe(720);
  });

  it("jumps to the limits with Home and End, and ignores other keys", () => {
    expect(keyedPanelWidth("Home", 500, range)).toBe(320);
    expect(keyedPanelWidth("End", 500, range)).toBe(720);
    expect(keyedPanelWidth("Enter", 500, range)).toBeNull();
    expect(keyedPanelWidth("a", 500, range)).toBeNull();
  });
});

describe("the stored panel width", () => {
  it("reads back what was written", () => {
    const storage = memoryStorage();
    writePanelWidth(storage, 560);
    expect(storage.items.get(PANEL_WIDTH_STORAGE_KEY)).toBe("560");
    expect(readPanelWidth(storage)).toBe(560);
  });

  it("removes the key for the default width", () => {
    const storage = memoryStorage({ [PANEL_WIDTH_STORAGE_KEY]: "560" });
    writePanelWidth(storage, PANEL_DEFAULT_WIDTH_PX);
    expect(storage.items.has(PANEL_WIDTH_STORAGE_KEY)).toBe(false);
    expect(readPanelWidth(storage)).toBe(PANEL_DEFAULT_WIDTH_PX);
  });

  it("keeps a stored width the window cannot show, for the window to clamp", () => {
    expect(readPanelWidth(memoryStorage({ [PANEL_WIDTH_STORAGE_KEY]: "700" }))).toBe(700);
  });

  it("falls back to the default for a missing, bad or unreadable value", () => {
    expect(readPanelWidth(undefined)).toBe(PANEL_DEFAULT_WIDTH_PX);
    expect(readPanelWidth(memoryStorage())).toBe(PANEL_DEFAULT_WIDTH_PX);
    for (const bad of ["", "wide", "-40", "0", "Infinity", "NaN"]) {
      expect(readPanelWidth(memoryStorage({ [PANEL_WIDTH_STORAGE_KEY]: bad }))).toBe(PANEL_DEFAULT_WIDTH_PX);
    }
    expect(readPanelWidth(throwing)).toBe(PANEL_DEFAULT_WIDTH_PX);
  });

  it("ignores storage that refuses the write", () => {
    expect(() => writePanelWidth(throwing, 500)).not.toThrow();
    expect(() => writePanelWidth(undefined, 500)).not.toThrow();
  });
});
