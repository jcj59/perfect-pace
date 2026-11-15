// The Web Worker entry: runs `@pp/core` off the main thread. Talk to it through `coreClient`.
import { CORE_CODECS } from "./codecs.ts";
import { createCoreHandlers } from "./handlers.ts";
import type { CoreOps } from "./protocol.ts";
import { type Endpoint, serveRpc } from "./rpc.ts";

serveRpc<CoreOps>(self as unknown as Endpoint, createCoreHandlers(), CORE_CODECS);
