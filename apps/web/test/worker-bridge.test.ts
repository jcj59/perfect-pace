// The worker bridge over a real MessageChannel, so every message goes through structured clone
// exactly as it does between the page and the Web Worker.
import { type ElevationProvider, type LatLon, computePlan, parseGpx } from "@pp/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreHandlers } from "../src/worker/handlers.ts";
import { CORE_PROTOCOL_VERSION, type CoreOps } from "../src/worker/protocol.ts";
import { type Endpoint, type OpMap, RpcError, createRpcClient, serveRpc } from "../src/worker/rpc.ts";

/** A straight 2 km track north from (42.44, -76.5), one point every ~111 m, without elevation. */
function gpx(): string {
  const points = Array.from({ length: 19 }, (_, i) => `<trkpt lat="${(42.44 + i * 0.001).toFixed(3)}" lon="-76.5"/>`);
  return `<?xml version="1.0"?><gpx version="1.1" creator="test"><trk><name>Hill</name><trkseg>${points.join("")}</trkseg></trk></gpx>`;
}

/** A DEM with one hill: up 40 m over the first half of the track, back down over the second. */
const hillProvider: ElevationProvider = {
  elevations: (points: readonly LatLon[]) =>
    Promise.resolve(points.map((p) => 200 + 40 * Math.max(0, 1 - Math.abs(p.lat - 42.449) / 0.009))),
};

const channels: MessageChannel[] = [];
function connect<Ops extends OpMap>(handlers: Parameters<typeof serveRpc<Ops>>[1]) {
  const channel = new MessageChannel();
  channels.push(channel);
  serveRpc<Ops>(channel.port2, handlers);
  return createRpcClient<Ops>(channel.port1);
}

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

describe("core worker ops", () => {
  const client = () => connect<CoreOps>(createCoreHandlers({ elevationProvider: () => hillProvider }));

  it("answers ping with the protocol version", async () => {
    await expect(client().call("ping", null)).resolves.toEqual({ protocol: CORE_PROTOCOL_VERSION });
  });

  it("round-trips parse, elevation and plan to the same plan as calling core directly", async () => {
    const core = client();
    const file = await core.call("parse", { text: gpx() });
    expect(file.tracks).toHaveLength(1);
    expect(file.tracks[0]?.name).toBe("Hill");
    const course = file.tracks[file.defaultTrack]!.course;

    const profile = await core.call("elevation", { course, origin: "file" });
    expect(profile.source).toBe("dem");
    expect(profile.gpsIssue).toBe("missing");
    expect(profile.stats.maxM).toBeGreaterThan(profile.stats.minM + 30);

    const inputs = { goalTimeS: 600, paceChanges: 2, unit: "mi" } as const;
    const plan = await core.call("plan", { course: profile.course, inputs });
    expect(plan).toEqual(computePlan(profile.course, inputs));
    expect(plan.segments.length).toBeGreaterThan(1);
    expect(plan.totalTimeS).toBeCloseTo(600, 3);
    // Sanity check that the parse result crossed the channel intact.
    expect(file).toEqual(parseGpx(gpx()));
  });

  it("rejects with the core error's class name and code", async () => {
    const error = await client()
      .call("parse", { text: "<gpx><trk></trk></gpx>" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ op: "parse", errorName: "GpxError", code: expect.any(String) as string });
  });

  it("rejects plain errors without a code", async () => {
    const error = await client()
      .call("plan", { course: { points: [] }, inputs: { goalTimeS: 600, paceChanges: 1, unit: "km" } })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ op: "plan", errorName: "RangeError", code: undefined });
    expect((error as Error).message).toMatch(/at least two points/);
  });

  it("reports a DEM failure from the elevation op", async () => {
    const failing: ElevationProvider = { elevations: () => Promise.reject(new Error("offline")) };
    const core = connect<CoreOps>(createCoreHandlers({ elevationProvider: () => failing }));
    const course = parseGpx(gpx()).tracks[0]!.course;
    await expect(core.call("elevation", { course })).rejects.toThrow("offline");
  });
});

describe("rpc transport", () => {
  type TestOps = {
    echo: { input: { value: number; delayMs: number }; output: number };
    boom: { input: null; output: never };
  };
  const handlers = {
    echo: ({ value, delayMs }: { value: number; delayMs: number }) =>
      new Promise<number>((resolve) => setTimeout(() => resolve(value), delayMs)),
    boom: () => {
      throw new TypeError("bad input");
    },
  };

  it("matches responses to calls when they finish out of order", async () => {
    const rpc = connect<TestOps>(handlers);
    const slow = rpc.call("echo", { value: 1, delayMs: 30 });
    const fast = rpc.call("echo", { value: 2, delayMs: 0 });
    expect(rpc.pending).toBe(2);
    await expect(fast).resolves.toBe(2);
    await expect(slow).resolves.toBe(1);
    expect(rpc.pending).toBe(0);
  });

  it("turns a synchronous throw into a rejection", async () => {
    const rpc = connect<TestOps>(handlers);
    await expect(rpc.call("boom", null)).rejects.toMatchObject({ errorName: "TypeError", message: "bad input" });
  });

  it("rejects an op the server does not know", async () => {
    const rpc = connect<TestOps>({ echo: handlers.echo } as typeof handlers);
    await expect(rpc.call("boom", null)).rejects.toMatchObject({ code: "unknown_op" });
  });

  it("aborts a call and drops its late result", async () => {
    const rpc = connect<TestOps>(handlers);
    const controller = new AbortController();
    const call = rpc.call("echo", { value: 1, delayMs: 20 }, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    expect(rpc.pending).toBe(0);
    // The next call still gets its own answer.
    await expect(rpc.call("echo", { value: 3, delayMs: 30 })).resolves.toBe(3);
  });

  it("rejects at once with an already aborted signal", async () => {
    const rpc = connect<TestOps>(handlers);
    await expect(rpc.call("echo", { value: 1, delayMs: 0 }, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(rpc.pending).toBe(0);
  });

  it("rejects input that cannot be cloned without sending it", async () => {
    const rpc = connect<{ echo: { input: unknown; output: unknown } }>({ echo: (x) => x });
    await expect(rpc.call("echo", { fn: () => 1 })).rejects.toMatchObject({ errorName: "DataCloneError" });
    expect(rpc.pending).toBe(0);
  });

  it("fails every pending call when the worker errors", async () => {
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    const fake: Endpoint = {
      postMessage: () => undefined,
      addEventListener: (type: string, listener: (event: never) => void) => {
        (listeners[type] ??= []).push(listener as (event: unknown) => void);
      },
      removeEventListener: () => undefined,
    };
    const rpc = createRpcClient<TestOps>(fake);
    const a = rpc.call("echo", { value: 1, delayMs: 0 });
    const b = rpc.call("echo", { value: 2, delayMs: 0 });
    for (const listener of listeners["error"] ?? []) listener(new Event("error"));
    await expect(a).rejects.toThrow("The worker failed");
    await expect(b).rejects.toThrow("The worker failed");
    expect(rpc.pending).toBe(0);
  });
});
