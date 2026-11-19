import { describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  UNITS_STORAGE_KEY,
  defaultUnits,
  initialAppState,
  readThemePreference,
  readUnits,
} from "../src/state/app.ts";
import { createStore } from "../src/state/store.ts";
import { nextSnap, releaseSnap, snapHeights, stepSnap, SHEET_PEEK_PX, SHEET_TOP_GAP_PX } from "../src/layout/sheet.ts";

describe("createStore", () => {
  it("merges partial updates and passes the new and previous state to listeners", () => {
    const store = createStore({ a: 1, b: "x" });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ a: 2 });
    expect(store.get()).toEqual({ a: 2, b: "x" });
    expect(listener).toHaveBeenCalledWith({ a: 2, b: "x" }, { a: 1, b: "x" });
  });

  it("accepts an updater function of the current state", () => {
    const store = createStore({ count: 1 });
    store.set((s) => ({ count: s.count + 1 }));
    store.set((s) => ({ count: s.count * 10 }));
    expect(store.get().count).toBe(20);
  });

  it("does not notify, or replace the state, when nothing changed", () => {
    const store = createStore({ a: 1, b: { nested: true } });
    const before = store.get();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ a: 1, b: before.b });
    store.set({});
    expect(listener).not.toHaveBeenCalled();
    expect(store.get()).toBe(before);
  });

  it("never mutates a state it handed out", () => {
    const store = createStore({ a: 1 });
    const before = store.get();
    store.set({ a: 2 });
    expect(before).toEqual({ a: 1 });
    expect(store.get()).not.toBe(before);
  });

  it("stops notifying after unsubscribe", () => {
    const store = createStore({ a: 1 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set({ a: 2 });
    unsubscribe();
    store.set({ a: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("units", () => {
  const stored = (value: string | null) => ({ getItem: (key: string) => (key === UNITS_STORAGE_KEY ? value : null) });

  it("defaults to miles where road distances are in miles, kilometers elsewhere", () => {
    expect(defaultUnits("en-US")).toBe("mi");
    expect(defaultUnits("en")).toBe("mi"); // maximizes to en-Latn-US
    expect(defaultUnits("en-GB")).toBe("mi");
    expect(defaultUnits("de-DE")).toBe("km");
    expect(defaultUnits("fr-CA")).toBe("km");
    expect(defaultUnits(undefined)).toBe("km");
    expect(defaultUnits("not a tag!")).toBe("km");
  });

  it("prefers the stored choice, and ignores a bad or unreadable one", () => {
    expect(readUnits(stored("km"), "en-US")).toBe("km");
    expect(readUnits(stored("mi"), "de-DE")).toBe("mi");
    expect(readUnits(stored("furlongs"), "de-DE")).toBe("km");
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readUnits(throwing, "en-US")).toBe("mi");
  });
});

describe("app state", () => {
  const storage = (value: string | null) => ({ getItem: (key: string) => (key === THEME_STORAGE_KEY ? value : null) });

  it("starts at the stored theme with the sheet at peek", () => {
    expect(initialAppState(storage("dark"), "en-US")).toEqual({
      theme: "dark",
      sheet: "peek",
      units: "mi",
      course: { status: "empty" },
      focusDistM: null,
      goalTimeS: null,
      paceChanges: 4,
      minSegmentM: 0.25 * 1609.344,
      planType: "optimal",
      splitM: 1609.344,
      breakpointsM: [],
      tableView: "segments",
      selectedSegment: null,
      linkError: null,
      race: null,
    });
    expect(initialAppState(storage("light")).theme).toBe("light");
    // Kilometer users start at half a kilometer, and kilometer splits.
    expect(initialAppState(storage(null), "de-DE").minSegmentM).toBe(500);
    expect(initialAppState(storage(null), "de-DE").splitM).toBe(1000);
  });

  it("falls back to the system theme for missing, unknown or unreadable values", () => {
    expect(readThemePreference(storage(null))).toBe("system");
    expect(readThemePreference(storage("sepia"))).toBe("system");
    expect(readThemePreference(undefined)).toBe("system");
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readThemePreference(throwing)).toBe("system");
  });
});

describe("sheet snaps", () => {
  const heights = snapHeights(800);

  it("puts peek at the header, half at half the height and full under the top gap", () => {
    expect(heights).toEqual({ peek: SHEET_PEEK_PX, half: 400, full: 800 - SHEET_TOP_GAP_PX });
  });

  it("raises peek above the home indicator and keeps full below the status bar", () => {
    // An iPhone 15 in portrait: 59 px status bar inset, 34 px home indicator.
    expect(snapHeights(800, { top: 59, bottom: 34 })).toEqual({
      peek: SHEET_PEEK_PX + 34,
      half: 400,
      full: 800 - SHEET_TOP_GAP_PX - 59,
    });
  });

  it("keeps the snaps ordered in a very short layout", () => {
    const short = snapHeights(120);
    expect(short.peek).toBeLessThanOrEqual(short.half);
    expect(short.half).toBeLessThanOrEqual(short.full);
  });

  it("releases a slow drag at the nearest snap", () => {
    expect(releaseSnap(200, 0, heights)).toBe("peek");
    expect(releaseSnap(300, 0, heights)).toBe("half");
    expect(releaseSnap(640, 0, heights)).toBe("full");
  });

  it("carries a fling past the nearest snap", () => {
    expect(releaseSnap(300, 1500, heights)).toBe("full");
    expect(releaseSnap(300, -1500, heights)).toBe("peek");
  });

  it("cycles on tap and clamps on arrow keys", () => {
    expect([nextSnap("peek"), nextSnap("half"), nextSnap("full")]).toEqual(["half", "full", "peek"]);
    expect(stepSnap("full", 1)).toBe("full");
    expect(stepSnap("peek", -1)).toBe("peek");
    expect(stepSnap("half", -1)).toBe("peek");
  });
});
