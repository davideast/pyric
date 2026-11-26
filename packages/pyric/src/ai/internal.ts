/** Internal adapter seam for transport-backed AI handles. */
import type { FirebaseApp } from '../app/types.js';
import { BackendType, GoogleAIBackend } from './backend.js';
import { AIError, AIErrorCode } from './errors.js';
import type { AnswerEngine } from './broker/types.js';
import { TARGET_SYMBOL } from './target.js';
import { appCheckAttachmentFor } from './app-check-gate.js';
import type { AI, AIOptions, TransportTarget } from './types.js';

export { aiErrorFromEnvelope } from './errors.js';
/** The one set of finish reasons that withhold a response's content, which a
 *  live host's terminal reads as the sandbox's `response_blocked` does. */
export { isBlockingFinishReason } from './blocked.js';
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
 *  masking the gemini engine applies to its own errors. `urlCredentials`
 *  and `redactUpstreamUrl` add the userinfo of a configured base URL to that
 *  masking (#1766). */
export {
  GEMINI_DEFAULT_BASE_URL,
  GeminiUpstream,
  hasGeminiStaticKey,
  redactUpstreamError,
  redactUpstreamText,
  redactUpstreamUrl,
  redactUrl,
  urlCredentials,
  type GeminiUpstreamOptions,
} from './broker/index.js';
export { GEMINI_SERVER_KEYS } from './broker/gemini-upstream.js';
export {
  joinUpstreamUrl,
  normalizeUpstreamBaseUrl,
} from './broker/upstream-error-redaction.js';
export {
  isJsonErrorEnvelope,
  maskStreamErrors,
  redactUpstreamSuccessBody,
  type RedactSuccessBodyOptions,
} from './broker/upstream-stream-redaction.js';

const transportHandles = new WeakMap<FirebaseApp, Map<string, AI>>();

function backendKey(options?: AIOptions): { key: string } {
  const backend = options?.backend ?? new GoogleAIBackend();
  if (backend.backendType === BackendType.GOOGLE_AI) {
    return { key: 'googleai' };
  }
  if (backend.backendType === BackendType.AGENT_PLATFORM) {
    const rawLocation = (backend as { readonly location?: string }).location;
    const location = rawLocation ? rawLocation : 'global';
    return { key: `agentplatform/${location}` };
  }
  throw new AIError(AIErrorCode.ERROR, `Invalid backend: ${JSON.stringify(backend.backendType)}`);
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
  const { key } = backendKey(options);
  let handles = transportHandles.get(app);
  if (!handles) {
    handles = new Map();
    transportHandles.set(app, handles);
  }
  const resolvedOptions: AIOptions = {
    useLimitedUseAppCheckTokens: options?.useLimitedUseAppCheckTokens === true,
  };
  const existing = handles.get(key);
  if (existing) {
    existing.options = resolvedOptions;
    return existing;
  }

  const backend = options?.backend ?? new GoogleAIBackend();
  const handle: AI = {
    app,
    backend,
    options: resolvedOptions,
  };
  const target: TransportTarget = {
    kind: 'transport',
    backend,
    transport,
    app,
    resolveLimitedUse: () => handle.options?.useLimitedUseAppCheckTokens === true,
    // Read App Check now, as the SDK's AI service does when it is built; the
    // claim crosses to the remote broker with every request.
    appCheck: appCheckAttachmentFor(app, resolvedOptions.useLimitedUseAppCheckTokens === true),
  };
  if (assertAlive !== undefined) {
    target.assertAlive = assertAlive;
  }
  Object.defineProperty(handle, TARGET_SYMBOL, { value: target, enumerable: false });
  handles.set(key, handle);
  return handle;
}

export { packAiEvidence, unpackAiEvidence, getAiEvidence, setAiEvidence, type AiEvidence } from '../sandbox/internal/ai-evidence.js';

/** Explicit host configuration revisions sharing one sandbox event/state owner. */
export { createConfiguredSandboxAI } from './instances.js';
