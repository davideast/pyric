/**
 * The sandbox model plane for `pyric/ai` — everything between the public
 * `GenerativeModel`/`ChatSession` classes and the {@link AiBroker}:
 *
 *   - production-shaped MODEL validation before any engine runs: a
 *     `gemini-1.5-*` name answers the captured retired-model 404
 *     (`ai-error-retired-model`, ErrorInfo detail verbatim); anything
 *     outside the `gemini-*` family answers the captured unknown-model 404
 *     (`ai-error-unknown-model`);
 *   - request NORMALIZATION: one JSON round-trip drops undefined keys, runs
 *     `Schema.toJSON()` (so `responseSchema` rides the request in wire
 *     form), and decouples the broker's view from caller-held references;
 *   - pre-aborted `SingleRequestOptions.signal` rejection (AbortError,
 *     matching upstream's pre-fetch check);
 *   - broker error envelopes translated to SDK `AIError`s at this ONE seam;
 *   - streaming: the broker stream is pumped eagerly (upstream tees), the
 *     consumer iterates enhanced chunks, and `response` resolves with the
 *     2.12.0-style aggregate.
 */

import {
  AiBrokerError,
  errorEnvelope,
  unknownModel,
  type CountTokensResponse,
  type GenerateContentRequest,
  type WireErrorEnvelope,
  type WireResponse,
} from './broker/index.js';
import { toAIError } from './errors.js';
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

/** `ai-error-retired-model`: captured message + ErrorInfo detail, verbatim. */
export function retiredModel(): WireErrorEnvelope {
  const envelope = errorEnvelope(
    404,
    'Gemini 1.5 models are retired as of September 24, 2025. Update to a newer model version. [Learn more.](https://firebase.google.com/docs/ai-logic/faq-and-troubleshooting#discontinued-models)',
    'NOT_FOUND',
  );
  envelope.error.details = [
    {
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'RETIRED_MODEL',
      domain: 'firebasevertexai.googleapis.com',
    },
  ];
  return envelope;
}

/**
 * Production-shaped model routing. The sandbox serves the `gemini-*` family
 * (aliases resolve in the synthesizer); retired 1.5 models and unknown
 * names answer the captured 404 envelopes.
 */
function validateModel(modelResource: string): void {
  const bare = modelResource.startsWith('models/')
    ? modelResource.slice('models/'.length)
    : modelResource;
  if (/^gemini-1\.5/.test(bare)) {
    throw new AiBrokerError(retiredModel());
  }
  if (!/^gemini-/.test(bare)) {
    throw new AiBrokerError(unknownModel(bare));
  }
}

/** Upstream rejects a pre-aborted signal before any fetch; so do we. */
function checkSignal(singleRequestOptions?: SingleRequestOptions): void {
  const signal = singleRequestOptions?.signal;
  if (signal?.aborted) {
    throw new DOMException(
      (signal.reason as string | undefined) ?? 'Aborted externally before fetch',
      'AbortError',
    );
  }
}

/**
 * One JSON round-trip: runs `toJSON()` on Schema instances, drops undefined
 * values, and clones so later caller mutations never reach the broker.
 */
function normalizeRequest<T>(request: T): T {
  return JSON.parse(JSON.stringify(request)) as T;
}

export async function planeGenerateContent(
  target: AITarget,
  modelResource: string,
  request: Record<string, unknown>,
  singleRequestOptions?: SingleRequestOptions,
): Promise<GenerateContentResult> {
  target.assertAlive?.();
  checkSignal(singleRequestOptions);
  try {
    validateModel(modelResource);
    const normalized = normalizeRequest(request) as unknown as GenerateContentRequest;
    const response = await (target.kind === 'transport' ? target.transport : target.broker)
      .generateContent(normalized, modelResource);
    return { response: createEnhancedContentResponse(response) };
  } catch (err) {
    throw toAIError(err, modelResource, 'generateContent');
  }
}

export async function planeGenerateContentStream(
  target: AITarget,
  modelResource: string,
  request: Record<string, unknown>,
  singleRequestOptions?: SingleRequestOptions,
): Promise<GenerateContentStreamResult> {
  target.assertAlive?.();
  checkSignal(singleRequestOptions);
  let inner: AsyncIterable<WireResponse>;
  try {
    validateModel(modelResource);
    const normalized = normalizeRequest(request) as unknown as GenerateContentRequest;
    // Broker validation runs eagerly here — a bad request throws before
    // iteration, the way production answers HTTP errors instead of a stream.
    inner = (target.kind === 'transport' ? target.transport : target.broker)
      .streamGenerateContent(normalized, modelResource);
  } catch (err) {
    throw toAIError(err, modelResource, 'streamGenerateContent');
  }

  // Pump eagerly (upstream tees the body stream): the aggregate resolves
  // even if the consumer never drains `stream`.
  const buffered: WireResponse[] = [];
  let done = false;
  let failure: unknown;
  let notify: (() => void) | undefined;
  const wake = (): void => {
    notify?.();
    notify = undefined;
  };

  const pumped = (async () => {
    try {
      for await (const chunk of inner) {
        buffered.push(chunk);
        wake();
      }
    } catch (err) {
      failure = toAIError(err, modelResource, 'streamGenerateContent');
      wake();
      throw failure;
    } finally {
      done = true;
      wake();
    }
    return aggregateResponses(buffered);
  })();

  const response: Promise<EnhancedResponse> = pumped.then((aggregate) =>
    createEnhancedContentResponse(aggregate),
  );
  // Consumers may only iterate `stream` — never let an un-awaited aggregate
  // rejection surface as an unhandled rejection (the error still reaches
  // whoever DOES await `response`).
  void response.catch(() => undefined);

  async function* stream(): AsyncGenerator<EnhancedResponse> {
    let next = 0;
    for (;;) {
      if (next < buffered.length) {
        // Chunks are broker-owned fresh objects; enhance in place.
        yield createEnhancedContentResponse(structuredClone(buffered[next++]!));
        continue;
      }
      if (failure !== undefined) throw failure;
      if (done) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  return { stream: stream(), response };
}

export async function planeCountTokens(
  target: AITarget,
  modelResource: string,
  request: Record<string, unknown>,
  singleRequestOptions?: SingleRequestOptions,
): Promise<CountTokensResponse> {
  target.assertAlive?.();
  checkSignal(singleRequestOptions);
  try {
    validateModel(modelResource);
    const dispatch = target.kind === 'transport' ? target.transport : target.broker;
    const normalized = normalizeRequest(request) as unknown as Parameters<
      typeof dispatch.countTokens
    >[0];
    return await dispatch.countTokens(normalized, modelResource);
  } catch (err) {
    throw toAIError(err, modelResource, 'countTokens');
  }
}
