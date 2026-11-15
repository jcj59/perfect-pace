/**
 * The operations the core Web Worker runs. Each maps to one `@pp/core` entry point; inputs and
 * outputs are plain data. Courses and long number arrays cross `postMessage` packed into
 * transferred typed arrays (see `codecs.ts`), the rest as structured clones.
 */
import type {
  Course,
  ElevationProfile,
  ElevationProfileOptions,
  GpxFile,
  LatLon,
  Plan,
  PlanInputs,
  ShareTrack,
} from "@pp/core";

/** Bumped when an op's input or output changes shape, so a stale cached worker is detectable. */
export const CORE_PROTOCOL_VERSION = 3;

/** `computePlan` inputs that can be cloned: the pace model is fixed to the default inside the worker. */
export type PlanRequest = Omit<PlanInputs, "model">;

export type CoreOps = {
  /** Answers once the worker has loaded; the app sends it at startup to warm the worker up. */
  ping: { input: null; output: { protocol: number } };
  /**
   * `parseGpx`, of the text or of a picked file (read in the worker, so a large file is never
   * decoded or copied on the main thread). Rejects with `code` set to the `GpxErrorCode`.
   */
  parse: { input: { text: string } | { file: Blob }; output: GpxFile };
  /** `buildElevationProfile` with Terrarium DEM tiles. Rejects with `code` set to the `ElevationErrorCode`. */
  elevation: {
    input: { course: Course } & Omit<ElevationProfileOptions, "provider">;
    output: ElevationProfile;
  };
  /** `computePlan` on a course with elevation (the `course` of an `ElevationProfile`). */
  plan: { input: { course: Course; inputs: PlanRequest }; output: Plan };
  /** `simplifyForShare`, off the main thread (a long track takes a while): null when it cannot fit. */
  shareTrack: { input: { points: readonly LatLon[]; maxChars: number }; output: ShareTrack | null };
};

export type CoreOp = keyof CoreOps;
