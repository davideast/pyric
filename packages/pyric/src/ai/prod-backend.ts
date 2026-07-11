/**
 * Prod backend — thin wrappers around the installed `firebase/ai` so the
 * dispatch in `index.ts` stays a one-line `target.kind === 'prod'` branch
 * (auth's prod-backend pattern, same static-import house style).
 *
 * The prod arm is PASS-THROUGH (registry row ai#getai-prod-dispatch: "the
 * mirror adds no translation"): `getAI(app)` returns the installed SDK's AI
 * instance itself (stamped with our target brand), and
 * `getGenerativeModel(prodAi, ...)` returns the installed `GenerativeModel`.
 * Requests, streaming, and error envelopes are the real SDK's.
 */

import type { FirebaseApp } from 'firebase/app';
import * as fbai from 'firebase/ai';

import { BackendType, VertexAIBackend, type Backend } from './backend.js';
import type { AIOptions } from './target.js';
import type { ModelParams, RequestOptions } from './models.js';

/**
 * Translate OUR backend marker into the installed SDK's class — upstream
 * `encodeInstanceIdentifier` does `instanceof` checks against its own
 * classes, so the marker cannot pass through structurally.
 */
function toUpstreamBackend(backend: Backend | undefined): fbai.Backend | undefined {
  if (!backend) return undefined;
  if (backend.backendType === BackendType.VERTEX_AI) {
    return new fbai.VertexAIBackend((backend as VertexAIBackend).location);
  }
  return new fbai.GoogleAIBackend();
}

export function prodGetAI(app: FirebaseApp, options?: AIOptions): fbai.AI {
  if (options === undefined) {
    return fbai.getAI(app);
  }
  const upstreamOptions: fbai.AIOptions = {};
  const backend = toUpstreamBackend(options.backend);
  if (backend) upstreamOptions.backend = backend;
  if (options.useLimitedUseAppCheckTokens !== undefined) {
    upstreamOptions.useLimitedUseAppCheckTokens = options.useLimitedUseAppCheckTokens;
  }
  return fbai.getAI(app, upstreamOptions);
}

export function prodGetGenerativeModel(
  ai: fbai.AI,
  modelParams: ModelParams,
  requestOptions?: RequestOptions,
): fbai.GenerativeModel {
  return fbai.getGenerativeModel(
    ai,
    modelParams as unknown as fbai.ModelParams,
    requestOptions as fbai.RequestOptions | undefined,
  );
}
