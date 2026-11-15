/**
 * A typed request/response layer over `postMessage`. An op map describes each operation's input
 * and output; the client gets one promise per call, and the server maps each op to a handler.
 * Inputs and outputs must be structured-cloneable (no functions or class instances; errors are
 * flattened to `SerializedError` and rebuilt as `RpcError`). An op can also have a `WireCodec`
 * for its input or output, which turns the value into a cheaper form for the trip (typed arrays
 * that are transferred rather than copied) and back again on the other side.
 */

/** Op name to `{ input, output }`. */
export type OpMap = Record<string, { input: unknown; output: unknown }>;

/** The part of a Worker, a worker's global scope or a MessagePort that the RPC layer uses. */
export interface Endpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  /** MessagePorts queue messages until started; Workers have no `start`. */
  start?(): void;
}

/** How a value crosses `postMessage`: `encode` on the sending side, `decode` on the receiving one. */
export interface WireCodec<T> {
  /** The form to post, and the buffers in it to transfer (the sender must not use them afterwards). */
  encode(value: T): { wire: unknown; transfer: Transferable[] };
  decode(wire: unknown): T;
}

/** Codecs for some ops' inputs and outputs; the rest cross as plain structured clones. Both sides must share them. */
export type Codecs<Ops extends OpMap> = {
  [K in keyof Ops & string]?: { input?: WireCodec<Ops[K]["input"]>; output?: WireCodec<Ops[K]["output"]> };
};

function encodeWith<T>(codec: WireCodec<T> | undefined, value: T): { wire: unknown; transfer: Transferable[] } {
  return codec ? codec.encode(value) : { wire: value, transfer: [] };
}

export type RpcRequest<Ops extends OpMap> = {
  [K in keyof Ops & string]: { id: number; op: K; input: Ops[K]["input"] };
}[keyof Ops & string];

export interface SerializedError {
  name: string;
  message: string;
  /** A typed error's `code` (for example `GpxError` or `ElevationError`). */
  code?: string;
}

export type RpcResponse = { id: number; ok: true; output: unknown } | { id: number; ok: false; error: SerializedError };

/** A failure reported by the other side, or by the transport itself. */
export class RpcError extends Error {
  readonly op: string;
  readonly code: string | undefined;
  /** The original error's class name (`GpxError`, `RangeError`, ...), or `RpcError` for transport failures. */
  readonly errorName: string;

  constructor(op: string, error: SerializedError) {
    super(error.message);
    this.name = "RpcError";
    this.op = op;
    this.code = error.code;
    this.errorName = error.name;
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { name: error.name, message: error.message, ...(typeof code === "string" ? { code } : {}) };
  }
  return { name: "Error", message: String(error) };
}

export interface CallOptions {
  /** Rejects the call with an `AbortError` and drops its result when the signal aborts. */
  signal?: AbortSignal;
  /** Buffers to transfer instead of copy. */
  transfer?: Transferable[];
}

export interface RpcClient<Ops extends OpMap> {
  call<K extends keyof Ops & string>(op: K, input: Ops[K]["input"], options?: CallOptions): Promise<Ops[K]["output"]>;
  /** Calls still waiting for a response. */
  readonly pending: number;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export function createRpcClient<Ops extends OpMap>(endpoint: Endpoint, codecs: Codecs<Ops> = {}): RpcClient<Ops> {
  let nextId = 1;
  const waiting = new Map<
    number,
    {
      op: string;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      decode?: (wire: unknown) => unknown;
    }
  >();

  endpoint.addEventListener("message", (event: MessageEvent) => {
    const response = event.data as RpcResponse;
    const entry = waiting.get(response.id);
    if (!entry) return; // aborted, or not ours
    waiting.delete(response.id);
    if (!response.ok) {
      entry.reject(new RpcError(entry.op, response.error));
      return;
    }
    try {
      entry.resolve(entry.decode ? entry.decode(response.output) : response.output);
    } catch (error) {
      entry.reject(new RpcError(entry.op, serializeError(error)));
    }
  });
  // A crashed worker or an uncloneable reply fails every outstanding call instead of hanging it.
  const failAll = (message: string) => () => {
    for (const [id, entry] of waiting) {
      waiting.delete(id);
      entry.reject(new RpcError(entry.op, { name: "RpcError", message }));
    }
  };
  endpoint.addEventListener("error", failAll("The worker failed"));
  endpoint.addEventListener("messageerror", failAll("A worker reply could not be read"));
  endpoint.start?.();

  return {
    call(op, input, options = {}) {
      const { signal, transfer } = options;
      if (signal?.aborted) return Promise.reject(abortError());
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (waiting.delete(id)) reject(abortError());
        };
        const settle =
          <A extends unknown[]>(fn: (...args: A) => void) =>
          (...args: A) => {
            signal?.removeEventListener("abort", onAbort);
            fn(...args);
          };
        const codec = codecs[op];
        const outputCodec = codec?.output;
        waiting.set(id, {
          op,
          resolve: settle(resolve),
          reject: settle(reject),
          ...(outputCodec ? { decode: (wire: unknown) => outputCodec.decode(wire) } : {}),
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const encoded = encodeWith(codec?.input, input);
          endpoint.postMessage({ id, op, input: encoded.wire }, [...(transfer ?? []), ...encoded.transfer]);
        } catch (error) {
          waiting.get(id)?.reject(new RpcError(op, serializeError(error)));
          waiting.delete(id);
        }
      });
    },
    get pending() {
      return waiting.size;
    },
  };
}

export type Handlers<Ops extends OpMap> = {
  [K in keyof Ops & string]: (input: Ops[K]["input"]) => Ops[K]["output"] | Promise<Ops[K]["output"]>;
};

/** Answer requests on `endpoint` with `handlers`. Requests run concurrently; each gets exactly one response. */
export function serveRpc<Ops extends OpMap>(
  endpoint: Endpoint,
  handlers: Handlers<Ops>,
  codecs: Codecs<Ops> = {},
): void {
  endpoint.addEventListener("message", (event: MessageEvent) => {
    const { id, op, input } = event.data as RpcRequest<Ops>;
    const reply = (response: RpcResponse, transfer: Transferable[] = []) => {
      try {
        endpoint.postMessage(response, transfer);
      } catch (error) {
        endpoint.postMessage({ id, ok: false, error: serializeError(error) } satisfies RpcResponse);
      }
    };
    const handler = Object.hasOwn(handlers, op) ? handlers[op] : undefined;
    if (!handler) {
      reply({ id, ok: false, error: { name: "RpcError", message: `Unknown op "${op}"`, code: "unknown_op" } });
      return;
    }
    const codec = Object.hasOwn(codecs, op) ? codecs[op] : undefined;
    Promise.resolve()
      .then(() => handler(codec?.input ? codec.input.decode(input) : input))
      .then((output) => encodeWith(codec?.output, output))
      .then(
        ({ wire, transfer }) => reply({ id, ok: true, output: wire }, transfer),
        (error: unknown) => reply({ id, ok: false, error: serializeError(error) }),
      );
  });
  endpoint.start?.();
}
