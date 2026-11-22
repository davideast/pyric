import { beginAiActivity } from './activity.js';
/**
 * The sandbox model plane for `pyric/ai` -- everything between the public
 * `GenerativeModel`/`ChatSession` classes and the {@link AiBroker}:
 *
 *   - request NORMALIZATION: one JSON round-trip drops undefined keys, runs
 *     `Schema.toJSON()` (so `responseSchema` rides the request in wire
 *     form), and decouples the broker's view from caller-held references;
 *   - App Check claim acquisition before forwarding to the authoritative
 *     in-process or remote worker {@link AiBroker} (which enforces App Check
 *     before model and request validation so `request_rejected` events land
 *     on every execution plane);
 *   - pre-aborted `SingleRequestOptions.signal` rejection (AbortError,
 *     matching upstream's pre-fetch check);
 *   - broker error envelopes translated to SDK `AIError`s at this ONE seam;
 *   - streaming: the broker stream is pumped eagerly (upstream tees), the
 *     consumer iterates enhanced chunks, and `response` resolves with the
 *     2.12.0-style aggregate.
 */

import type {
  AppCheckClaim,
  CountTokensResponse,
  GenerateContentRequest,
  WireResponse,
} from './broker/index.js';
import { toAIError } from './errors.js';
import { isAppCheckRefusal } from './app-check-gate.js';
import {
  aggregateResponses,
  createEnhancedContentResponse,
  type EnhancedResponse,
} from './response-helpers.js';
import type { AITarget } from './types.js';

export interface SingleRequestOptions {
  timeout?: number;
  baseUrl?: string;
  maxSequentialFunctionCalls?: number;
  signal?: AbortSignal;
}

export interface GenerateContentResult {
  response: EnhancedResponse;
}

export interface GenerateContentStreamResult {
  stream: AsyncGenerator<EnhancedResponse>;
  response: Promise<EnhancedResponse>;
}

const DEFAULT_FETCH_TIMEOUT_MS = 180 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TIMEOUT_EXPIRED_MESSAGE = 'Timeout has expired.';
const ABORT_ERROR_NAME = 'AbortError';

interface RequestAbortScope {
  readonly signal: AbortSignal;
  clearTimeout(): void;
  dispose(): void;
  race<T>(promise: Promise<T>): Promise<T>;
}

function resolveTimeoutMillis(timeout: number | undefined): number | undefined {
  if (timeout === undefined || timeout === null) return DEFAULT_FETCH_TIMEOUT_MS;
  if (typeof timeout !== 'number' || Number.isNaN(timeout) || timeout < 0) {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }
  if (!Number.isFinite(timeout)) return undefined;
  return Math.min(timeout, MAX_TIMER_DELAY_MS);
}

function abortReasonOf(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('The operation was aborted.', ABORT_ERROR_NAME);
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortReasonOf(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortReasonOf(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Combines caller `signal` and request `timeout` using upstream @firebase/ai
 * semantics: pre-aborted external signals throw immediately before any work,
 * timeouts abort with `DOMException('Timeout has expired.', 'AbortError')`,
 * and `dispose()` always clears timers and external listeners.
 */
function createRequestAbortScope(singleRequestOptions?: SingleRequestOptions): RequestAbortScope {
  const externalSignal = singleRequestOptions?.signal;
  if (externalSignal?.aborted) {
    const reason = externalSignal.reason;
    const message = reason ?? 'Aborted externally before fetch';
    throw new DOMException(message as string, ABORT_ERROR_NAME);
  }

  const controller = new AbortController();
  const timeoutMillis = resolveTimeoutMillis(singleRequestOptions?.timeout);
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerId = undefined;
    }
  };

  const onExternalAbort = (): void => {
    clearTimer();
    if (!controller.signal.aborted) {
      controller.abort(externalSignal?.reason);
    }
  };

  if (externalSignal !== undefined) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  if (timeoutMillis !== undefined) {
    timerId = setTimeout(() => {
      timerId = undefined;
      if (!controller.signal.aborted) {
        controller.abort(new DOMException(TIMEOUT_EXPIRED_MESSAGE, ABORT_ERROR_NAME));
      }
    }, timeoutMillis);
  }

  const dispose = (): void => {
    clearTimer();
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  };

  return {
    signal: controller.signal,
    clearTimeout: clearTimer,
    dispose,
    race: <T>(promise: Promise<T>): Promise<T> => raceWithSignal(promise, controller.signal),
  };
}

/**
 * One JSON round-trip: runs `toJSON()` on Schema instances, drops undefined
 * values, and clones so later caller mutations never reach the broker.
 */
function normalizeRequest<T>(request: T): T {
  return JSON.parse(JSON.stringify(request)) as T;
}



/** Translate a failure to the SDK's error, logging pyric's App Check guidance once per app beside it. */
function planeError(target: AITarget, err: unknown, modelResource: string, op: string): unknown {
  const error = toAIError(err, modelResource, op, target.backend);
  if (isAppCheckRefusal(error)) target.appCheck?.warnRefused();
  return error;
}

export async function planeGenerateContent(
  target: AITarget,
  modelResource: string,
  request: Record<string, unknown>,
  singleRequestOptions?: SingleRequestOptions,
): Promise<GenerateContentResult> {
  const activity = beginAiActivity(target, modelResource, 'generateContent');
  let scope: RequestAbortScope | undefined;
  try {
    scope = createRequestAbortScope(singleRequestOptions);
    const normalized = normalizeRequest(request) as unknown as GenerateContentRequest;
    // A handle with no app has no claim, and its dispatch takes no extra turn.
    let appCheck: AppCheckClaim | undefined;
    const attachment = target.appCheck;
    if (attachment !== undefined) appCheck = await scope.race(attachment.claim());
    const dispatch = target.kind === 'transport' ? target.transport : target.broker;
    const response = await scope.race(
      dispatch.generateContent(normalized, modelResource, appCheck, { signal: scope.signal }),
    );
    activity.finish(response);
    return { response: createEnhancedContentResponse(response) };
  } catch (err) {
    activity.fail(err);
    throw planeError(target, err, modelResource, 'generateContent');
  } finally {
    scope?.dispose();
  }
}

function closeIteratorSafely(iterator: AsyncIterator<WireResponse>): void {
  if (typeof iterator.return !== 'function') return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Best-effort cleanup if the iterator throws synchronously on return().
  }
}

function emptyStream(): AsyncGenerator<EnhancedResponse> {
  return (async function* doneStream(): AsyncGenerator<EnhancedResponse> {
    // Completed empty stream with no chunks.
  })();
}

function pumpStream(
  target: AITarget,
  modelResource: string,
  activity: ReturnType<typeof beginAiActivity>,
  streamScope: RequestAbortScope,
  inner: AsyncIterable<WireResponse> | undefined,
  preOpenedIterator: AsyncIterator<WireResponse> | undefined,
  buffered: WireResponse[],
): GenerateContentStreamResult {
  // Pump eagerly (upstream tees the body stream): the aggregate resolves
  // even if the consumer never drains `stream`.
  let done = false;
  let hasFailure = false;
  let failure: unknown;
  let notify: (() => void) | undefined;
  const wake = (): void => {
    notify?.();
    notify = undefined;
  };

  const pumped = (async () => {
    let iterator = preOpenedIterator;
    try {
      if (iterator === undefined) {
        if (inner === undefined) {
          throw new Error('Missing stream iterable.');
        }
        iterator = inner[Symbol.asyncIterator]();
      }
      for (;;) {
        const step = await streamScope.race(iterator.next());
        streamScope.clearTimeout();
        if (step.done) break;
        activity.chunk(step.value);
        buffered.push(step.value);
        wake();
      }
    } catch (err) {
      if (streamScope.signal.aborted && iterator !== undefined) {
        closeIteratorSafely(iterator);
      }
      activity.fail(err);
      failure = planeError(target, err, modelResource, 'streamGenerateContent');
      hasFailure = true;
      wake();
      throw failure;
    } finally {
      streamScope.dispose();
      done = true;
      wake();
    }
    const lastChunk = buffered.length > 0 ? buffered[buffered.length - 1] : undefined;
    const aggregate = aggregateResponses(buffered);
    activity.finish(lastChunk ?? {}, aggregate);
    return aggregate;
  })();

  const response: Promise<EnhancedResponse> = pumped.then((aggregate) =>
    createEnhancedContentResponse(aggregate),
  );
  // Consumers may only iterate `stream` -- never let an un-awaited aggregate
  // rejection surface as an unhandled rejection (the error still reaches
  // whoever DOES await `response`).
  void response.catch(() => undefined);

  async function* stream(): AsyncGenerator<EnhancedResponse> {
    let next = 0;
    for (;;) {
      if (streamScope.signal.aborted) {
        if (hasFailure) throw failure;
        throw abortReasonOf(streamScope.signal);
      }
      if (next < buffered.length) {
        const chunk = buffered[next];
        next += 1;
        if (chunk === undefined) continue;
        // Chunks are broker-owned fresh objects; enhance in place.
        activity.progress();
        yield createEnhancedContentResponse(structuredClone(chunk));
        continue;
      }
      if (hasFailure) throw failure;
      if (done) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  return { stream: stream(), response };
}

export async function planeGenerateContentStream(
  target: AITarget,
  modelResource: string,
  request: Record<string, unknown>,
  singleRequestOptions?: SingleRequestOptions,
): Promise<GenerateContentStreamResult> {
  const activity = beginAiActivity(target, modelResource, 'generateContentStream');
  const isTransport = target.kind === 'transport';
  let activeScope: RequestAbortScope | undefined;
  let inner: AsyncIterable<WireResponse> | undefined;
  let iterator: AsyncIterator<WireResponse> | undefined;
  const buffered: WireResponse[] = [];
  let initialDone = false;
  try {
    activeScope = createRequestAbortScope(singleRequestOptions);
    const normalized = normalizeRequest(request) as unknown as GenerateContentRequest;
    // A handle with no app has no claim, and its dispatch takes no extra turn.
    let appCheck: AppCheckClaim | undefined;
    const attachment = target.appCheck;
    if (attachment !== undefined) appCheck = await activeScope.race(attachment.claim());
    // The App Check gate and broker validation run eagerly here -- a refused
    // or bad request throws before iteration, the way production answers
    // HTTP errors instead of a stream.
    const admitsBeforeStream = target.kind === 'sandbox' && appCheck !== undefined;
    if (admitsBeforeStream) {
      await activeScope.race(target.broker.admitAppCheck(modelResource, appCheck));
    }
    // Once admitted here, the claim is spent: the broker then validates at the
    // call instead of deferring validation behind its own gate.
    const claimForStream = admitsBeforeStream ? undefined : appCheck;
    const scopeRef = activeScope;
    const dispatch = isTransport ? target.transport : target.broker;
    inner = dispatch.streamGenerateContent(normalized, modelResource, claimForStream, {
      signal: scopeRef.signal,
      onStreamOpen: () => scopeRef.clearTimeout(),
    });
    if (isTransport) {
      // On SharedWorker and Node host planes, App Check admission, validation,
      // and upstream checks run over the worker port. Wait for the first stream
      // event or refusal before resolving generateContentStream (#1553).
      iterator = inner[Symbol.asyncIterator]();
      const firstStep = await activeScope.race(iterator.next());
      activeScope.clearTimeout();
      if (firstStep.done) {
        initialDone = true;
      } else {
        activity.chunk(firstStep.value);
        buffered.push(firstStep.value);
      }
    }
  } catch (err) {
    if (iterator !== undefined) {
      closeIteratorSafely(iterator);
    }
    activeScope?.dispose();
    activity.fail(err);
    throw planeError(target, err, modelResource, 'streamGenerateContent');
  }

  if (initialDone) {
    activeScope.dispose();
    const aggregate = aggregateResponses([]);
    activity.finish({}, aggregate);
    return {
      stream: emptyStream(),
      response: Promise.resolve(createEnhancedContentResponse(aggregate)),
    };
  }

  if (isTransport) {
    return pumpStream(target, modelResource, activity, activeScope, undefined, iterator, buffered);
  }
  return pumpStream(target, modelResource, activity, activeScope, inner, undefined, buffered);
}

export async function planeCountTokens(
  target: AITarget,
  modelResource: string,
  request: Record<string, unknown>,
  singleRequestOptions?: SingleRequestOptions,
): Promise<CountTokensResponse> {
  const activity = beginAiActivity(target, modelResource, 'countTokens');
  let scope: RequestAbortScope | undefined;
  try {
    scope = createRequestAbortScope(singleRequestOptions);
    const dispatch = target.kind === 'transport' ? target.transport : target.broker;
    const normalized = normalizeRequest(request) as unknown as Parameters<
      typeof dispatch.countTokens
    >[0];
    // A handle with no app has no claim, and its dispatch takes no extra turn.
    let appCheck: AppCheckClaim | undefined;
    const attachment = target.appCheck;
    if (attachment !== undefined) appCheck = await scope.race(attachment.claim());
    const result = await scope.race(
      dispatch.countTokens(normalized, modelResource, appCheck, { signal: scope.signal }),
    );
    activity.finish(result);
    return result;
  } catch (err) {
    activity.fail(err);
    throw planeError(target, err, modelResource, 'countTokens');
  } finally {
    scope?.dispose();
  }
}
