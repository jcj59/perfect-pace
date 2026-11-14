import { type ElevationProvider, buildElevationProfile, computePlan, parseGpx, terrariumProvider } from "@pp/core";
import { CORE_PROTOCOL_VERSION, type CoreOps } from "./protocol.ts";
import type { Handlers } from "./rpc.ts";

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
    parse: ({ text }) => parseGpx(text),
    elevation: ({ course, ...rest }) =>
      buildElevationProfile(course, { ...rest, provider: (provider ??= makeProvider()) }),
    plan: ({ course, inputs }) => computePlan(course, inputs),
  };
}
