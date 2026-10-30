/** Internal adapter seam for transport-backed AI handles. */
import type { FirebaseApp } from '../app/types.js';
import { BackendType, GoogleAIBackend, VertexAIBackend } from './backend.js';
import type { AnswerEngine } from './broker/types.js';
import { TARGET_SYMBOL } from './target.js';
import { appCheckAttachmentFor } from './app-check-gate.js';
import type { AI, AIOptions, TransportTarget } from './types.js';

export { aiErrorFromEnvelope } from './errors.js';
/** The App Check claim a transport forwards with each request. */
export type { AppCheckClaim } from './broker/types.js';
/** Host-only seam for the dev server's terminal diagnostics: the credential
 *  masking every printed upstream URL goes through, and the gemini endpoint
 *  the startup banner names when no `baseUrl` overrides it. Published here so
 *  `@pyric/cli` reads one definition instead of copying both. `GeminiUpstream`
 *  is the gemini engine's own request and credentials, which the dev server's
 *  `/__pyric/ai-proxy/gemini` route sends for a browser engine.
 *  `redactUpstreamError` and `redactUpstreamText` remove the exact
 *  credentials a request carried from what the upstream answered, the same
 *  masking the gemini engine applies to its own errors. */
export {
  GEMINI_DEFAULT_BASE_URL,
  GeminiUpstream,
  hasGeminiStaticKey,
  redactUpstreamError,
  redactUpstreamText,
  redactUrl,
  type GeminiUpstreamOptions,
} from './broker/index.js';

const transportHandles = new WeakMap<FirebaseApp, Map<string, AI>>();

function backendKey(options?: AIOptions): { key: string; location: string } {
  const backend = options?.backend ?? new GoogleAIBackend();
  if (backend.backendType === BackendType.VERTEX_AI) {
    const location = (backend as VertexAIBackend).location;
    return { key: `vertexai/${location}`, location };
  }
  return { key: 'googleai', location: '' };
}

/**
 * Create an app-shaped AI handle whose operations go straight to an adapter
 * transport. Unlike {@link getAI}, this never creates a page-local sandbox or
 * {@link AiBroker}; the remote runtime remains the only semantic broker and
 * the only source of AI operation events.
 */
export function createTransportAI(
  app: FirebaseApp,
  options: AIOptions | undefined,
  transport: AnswerEngine,
  assertAlive?: () => void,
): AI {
  const { key, location } = backendKey(options);
  let handles = transportHandles.get(app);
  if (!handles) {
    handles = new Map();
    transportHandles.set(app, handles);
  }
  const existing = handles.get(key);
  if (existing) return existing;

  const backend = options?.backend ?? new GoogleAIBackend();
  const handle: AI = {
    app,
    backend,
    location,
    ...(options !== undefined ? { options } : {}),
  };
  const target: TransportTarget = {
    kind: 'transport',
    transport,
    ...(assertAlive !== undefined ? { assertAlive } : {}),
    // Read App Check now, as the SDK's AI service does when it is built; the
    // claim crosses to the remote broker with every request.
    appCheck: appCheckAttachmentFor(app, options?.useLimitedUseAppCheckTokens === true),
  };
  Object.defineProperty(handle, TARGET_SYMBOL, { value: target, enumerable: false });
  handles.set(key, handle);
  return handle;
}

export { packAiEvidence, unpackAiEvidence, getAiEvidence, setAiEvidence, type AiEvidence } from '../sandbox/internal/ai-evidence.js';

/** Explicit host configuration revisions sharing one sandbox event/state owner. */
export { createConfiguredSandboxAI } from './instances.js';
