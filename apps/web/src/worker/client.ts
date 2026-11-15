import { CORE_CODECS } from "./codecs.ts";
import type { CoreOps } from "./protocol.ts";
import { type RpcClient, createRpcClient } from "./rpc.ts";

let client: RpcClient<CoreOps> | undefined;

/** The app's one core worker, started on first use. */
export function coreClient(): RpcClient<CoreOps> {
  client ??= createRpcClient<CoreOps>(
    new Worker(new URL("./core.worker.ts", import.meta.url), { type: "module", name: "core" }),
    CORE_CODECS,
  );
  return client;
}

/**
 * Start the worker and wait until it answers, so the first real op does not pay for loading it.
 * Sets the `pp:worker-ready` performance mark (budgeted in `e2e/tests/perf.spec.ts`).
 */
export async function warmUpCoreWorker(): Promise<void> {
  await coreClient().call("ping", null);
  performance.mark("pp:worker-ready");
}
