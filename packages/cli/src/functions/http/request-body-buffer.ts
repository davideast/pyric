/**
 * Captures an HTTP `IncomingMessage` body synchronously on the request callback
 * turn so Bun's `node:http` server tracks request completion cleanly, applies
 * backpressure while waiting for an upstream consumer, replays unread buffered
 * bytes across a deferred `ECONNREFUSED` retry, enforces uncompressed byte
 * quotas, and drains unread tail bytes when an upstream handler responds early.
 */
import type { ClientRequest, IncomingMessage } from 'node:http';

export interface BodyByteLimit {
  readonly enforcesIdentityLimit: boolean;
  readonly maxBodyBytes: number | undefined;
}

interface PullBodyStreamOptions {
  readonly limit: BodyByteLimit;
  onStarted(): void;
  onTooLarge(): void;
}

interface PipeBodyToRequestOptions {
  readonly limit: BodyByteLimit;
  onStarted(): void;
  onTooLarge(): void;
  onClientError(): void;
}

export interface BodyStreamHandle {
  readonly stream: ReadableStream<Uint8Array>;
  detachConsumer(): void;
}

export interface InboundRequestBody {
  /** True when the client still has unparsed body bytes in flight on its socket. */
  hasIncompleteClientBody(): boolean;
  /** Create a demand-pulled `ReadableStream` (`highWaterMark: 0`) for `fetch`. */
  createReadableStream(options: PullBodyStreamOptions): BodyStreamHandle;
  /** Pump buffered and arriving chunks into a `node:http` `ClientRequest`. */
  pipeToClientRequest(upstream: ClientRequest, options: PipeBodyToRequestOptions): () => void;
  /** Discard buffered chunks and drain any remaining client bytes to EOF. */
  drainRemaining(): void;
}

const INBOUND_BODIES = new WeakMap<IncomingMessage, InboundRequestBody>();

function safeControllerEnqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  chunk: Uint8Array,
): void {
  try {
    controller.enqueue(chunk);
  } catch {
    // Stream already settled by cancellation or upstream abort.
  }
}

function safeControllerClose(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    // Stream already settled.
  }
}

function safeControllerError(
  controller: ReadableStreamDefaultController<Uint8Array>,
  error: Error,
): void {
  try {
    controller.error(error);
  } catch {
    // Stream already settled.
  }
}

function exceedsByteLimit(limit: BodyByteLimit, forwardedBytes: number): boolean {
  if (!limit.enforcesIdentityLimit) return false;
  if (limit.maxBodyBytes === undefined) return false;
  return forwardedBytes > limit.maxBodyBytes;
}

function createInboundRequestBody(req: IncomingMessage): InboundRequestBody {
  const queued: Buffer[] = [];
  let sourceEnded = req.readableEnded;
  let streamError: Error | null = null;
  let attached = false;
  let draining = false;
  let wakeConsumer: (() => void) | null = null;

  const notifyConsumer = (): void => {
    const pending = wakeConsumer;
    if (pending !== null) {
      wakeConsumer = null;
      pending();
    }
  };

  const detachSourceListeners = (): void => {
    if (!attached) return;
    attached = false;
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onError);
    req.off('close', onClose);
  };

  function onData(chunk: Buffer | Uint8Array): void {
    if (draining) {
      return;
    }
    let buffer: Buffer;
    if (Buffer.isBuffer(chunk)) {
      buffer = chunk;
    } else {
      buffer = Buffer.from(chunk);
    }
    queued.push(buffer);
    if (wakeConsumer !== null) {
      notifyConsumer();
      return;
    }
    req.pause();
  }

  function onEnd(): void {
    sourceEnded = true;
    detachSourceListeners();
    notifyConsumer();
  }

  function onError(err: Error): void {
    streamError = err;
    detachSourceListeners();
    notifyConsumer();
  }

  function onClose(): void {
    if (sourceEnded) return;
    const closedBeforeBodyCompleted = !req.complete && !req.readableEnded && !draining;
    if (closedBeforeBodyCompleted) {
      onError(new Error('Client request closed before body completed'));
      return;
    }
    onEnd();
  }

  const attachSourceListeners = (): void => {
    if (attached || sourceEnded) return;
    attached = true;
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('close', onClose);
  };

  // Attach synchronously during the `(req, res)` callback turn: Bun 1.3.11's
  // `node:http` `uWS` adapter retains `pending_requests > 0` across async
  // responses (hanging `server.close()`) unless a `'data'` listener is
  // registered on `req` before the initial request callback returns.
  attachSourceListeners();

  const drainRemaining = (): void => {
    if (draining) return;
    draining = true;
    queued.length = 0;
    notifyConsumer();
    if (sourceEnded || req.readableEnded) {
      sourceEnded = true;
      detachSourceListeners();
      return;
    }
    attachSourceListeners();
    req.resume();
  };

  const hasIncompleteClientBody = (): boolean => {
    if (sourceEnded) return false;
    return !req.complete && !req.readableEnded;
  };

  const createReadableStream = (options: PullBodyStreamOptions): BodyStreamHandle => {
    let consumerDetached = false;
    let abortedTooLarge = false;
    let forwardedBytes = 0;

    const detachConsumer = (): void => {
      if (consumerDetached) return;
      consumerDetached = true;
      notifyConsumer();
    };

    const trySettleStep = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
      if (abortedTooLarge) {
        safeControllerError(controller, new Error('Payload Too Large'));
        return true;
      }
      if (consumerDetached || draining) {
        safeControllerClose(controller);
        return true;
      }
      if (streamError !== null) {
        safeControllerError(controller, streamError);
        return true;
      }
      const next = queued.shift();
      if (next !== undefined) {
        forwardedBytes += next.byteLength;
        if (exceedsByteLimit(options.limit, forwardedBytes)) {
          abortedTooLarge = true;
          consumerDetached = true;
          drainRemaining();
          options.onTooLarge();
          safeControllerError(controller, new Error('Payload Too Large'));
          return true;
        }
        safeControllerEnqueue(controller, next);
        return true;
      }
      if (sourceEnded) {
        safeControllerClose(controller);
        return true;
      }
      return false;
    };

    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          options.onStarted();
          if (trySettleStep(controller)) {
            return;
          }
          return new Promise<void>((resolvePull) => {
            const onWake = (): void => {
              if (trySettleStep(controller)) {
                resolvePull();
                return;
              }
              wakeConsumer = onWake;
              req.resume();
            };
            wakeConsumer = onWake;
            req.resume();
          });
        },
        cancel() {
          detachConsumer();
        },
      },
      { highWaterMark: 0 },
    );

    return { stream, detachConsumer };
  };

  const pipeToClientRequest = (
    upstream: ClientRequest,
    options: PipeBodyToRequestOptions,
  ): (() => void) => {
    let consumerDetached = false;
    let forwardedBytes = 0;
    let waitingForUpstreamDrain = false;

    const detachConsumer = (): void => {
      if (consumerDetached) return;
      consumerDetached = true;
      if (wakeConsumer === pump) {
        wakeConsumer = null;
      }
      upstream.off('drain', onUpstreamDrain);
    };

    const onUpstreamDrain = (): void => {
      if (consumerDetached) return;
      waitingForUpstreamDrain = false;
      pump();
    };

    function pump(): void {
      if (consumerDetached || draining || waitingForUpstreamDrain) return;
      while (queued.length > 0) {
        const next = queued.shift();
        if (next === undefined) break;
        forwardedBytes += next.byteLength;
        if (exceedsByteLimit(options.limit, forwardedBytes)) {
          detachConsumer();
          drainRemaining();
          options.onTooLarge();
          return;
        }
        const canContinue = upstream.write(next);
        if (!canContinue) {
          waitingForUpstreamDrain = true;
          req.pause();
          return;
        }
      }
      if (streamError !== null) {
        detachConsumer();
        options.onClientError();
        return;
      }
      if (sourceEnded) {
        detachConsumer();
        upstream.end();
        return;
      }
      wakeConsumer = pump;
      req.resume();
    }

    options.onStarted();
    upstream.on('drain', onUpstreamDrain);
    pump();
    return detachConsumer;
  };

  return {
    hasIncompleteClientBody,
    createReadableStream,
    pipeToClientRequest,
    drainRemaining,
  };
}

/**
 * Return the memoized `InboundRequestBody` for `req`, attaching synchronous
 * stream listeners on first capture so retries reuse buffered chunks intact.
 */
export function captureInboundRequestBody(req: IncomingMessage): InboundRequestBody {
  const existing = INBOUND_BODIES.get(req);
  if (existing !== undefined) {
    return existing;
  }
  const created = createInboundRequestBody(req);
  INBOUND_BODIES.set(req, created);
  return created;
}
