import {
  type ElevationProvider,
  buildElevationProfile,
  computePlan,
  parseGpx,
  simplifyForShare,
  terrariumProvider,
} from "@pp/core";
import { CORE_PROTOCOL_VERSION, type CoreOps } from "./protocol.ts";
import type { Handlers } from "./rpc.ts";

/** `parseGpx` with reading the file, measured inside the worker. */
export const PARSE_MEASURE = "pp:parse";
/** `computePlan` alone, measured inside the worker. */
export const PLAN_COMPUTE_MEASURE = "pp:plan-compute";

export interface CoreHandlerOptions {
  /** Makes the DEM provider on first use. Default: Terrarium tiles decoded with OffscreenCanvas. */
  elevationProvider?: () => ElevationProvider;
}

/** The core op handlers. The DEM provider (and its tile cache) is created once and shared across calls. */
export function createCoreHandlers(options: CoreHandlerOptions = {}): Handlers<CoreOps> {
  const makeProvider = options.elevationProvider ?? (() => terrariumProvider());
  let provider: ElevationProvider | undefined;
  return {
    ping: () => ({ protocol: CORE_PROTOCOL_VERSION }),
    parse: async (input) => {
      const start = performance.now();
      const file = parseGpx("text" in input ? input.text : await input.file.text());
      // In the worker's own timeline; `e2e/tests/load-perf.spec.ts` reads it there.
      performance.clearMeasures(PARSE_MEASURE);
      performance.measure(PARSE_MEASURE, { start, end: performance.now() });
      return file;
    },
    elevation: ({ course, ...rest }) =>
      buildElevationProfile(course, { ...rest, provider: (provider ??= makeProvider()) }),
    plan: ({ course, inputs }) => {
      const start = performance.now();
      const plan = computePlan(course, inputs);
      // In the worker's own timeline; `e2e/tests/plan-perf.spec.ts` reads it there.
      performance.clearMeasures(PLAN_COMPUTE_MEASURE);
      performance.measure(PLAN_COMPUTE_MEASURE, { start, end: performance.now() });
      return plan;
    },
    shareTrack: ({ points, maxChars }) => simplifyForShare(points, maxChars) ?? null,
  };
}
