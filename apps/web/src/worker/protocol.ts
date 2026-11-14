/**
 * The operations the core Web Worker runs. Each maps to one `@pp/core` entry point; inputs and
 * outputs are plain data, so they cross `postMessage` as structured clones.
 */
import type { Course, ElevationProfile, ElevationProfileOptions, GpxFile, Plan, PlanInputs } from "@pp/core";

/** Bumped when an op's input or output changes shape, so a stale cached worker is detectable. */
export const CORE_PROTOCOL_VERSION = 1;

/** `computePlan` inputs that can be cloned: the pace model is fixed to the default inside the worker. */
export type PlanRequest = Omit<PlanInputs, "model">;

export type CoreOps = {
  /** Answers once the worker has loaded; the app sends it at startup to warm the worker up. */
  ping: { input: null; output: { protocol: number } };
  /** `parseGpx`. Rejects with `code` set to the `GpxErrorCode`. */
  parse: { input: { text: string }; output: GpxFile };
  /** `buildElevationProfile` with Terrarium DEM tiles. Rejects with `code` set to the `ElevationErrorCode`. */
  elevation: {
    input: { course: Course } & Omit<ElevationProfileOptions, "provider">;
    output: ElevationProfile;
  };
  /** `computePlan` on a course with elevation (the `course` of an `ElevationProfile`). */
  plan: { input: { course: Course; inputs: PlanRequest }; output: Plan };
};

export type CoreOp = keyof CoreOps;
