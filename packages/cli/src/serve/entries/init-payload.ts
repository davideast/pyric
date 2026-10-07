import { recordDiagnostic } from '../runtime/diagnostics-client.js';
import { pageListenerObservation } from '../runtime/listener-observation.js';
import type { InitPayload } from '../init-payload.js';

const hasDocument = typeof document !== 'undefined';
if (hasDocument) pageListenerObservation(document);
const documentLike = hasDocument ? document : undefined;
const hostedDeclaration = documentLike?.querySelector('meta[name="pyric-sandbox-host"]');
const requiresHostedSandbox = hostedDeclaration?.getAttribute('content') === 'node';
const expectedProjectKey = hostedDeclaration?.getAttribute('data-project-key');
const HOSTED_INIT_TIMEOUT_MS = 5_000;
const HOSTED_INIT_MAX_BACKOFF_MS = 5_000;

/** A host that answered with another host or project identity; retrying cannot change the answer. */
class InitIdentityError extends Error {}

async function requestInitPayload(): Promise<InitPayload> {
  recordDiagnostic({ phase: 'init-request' });
  const abortController = new AbortController();
  let status: number | undefined;
  const deadline = requiresHostedSandbox
    ? setTimeout(() => abortController.abort(new Error(
      `/__pyric/init.json did not complete within ${HOSTED_INIT_TIMEOUT_MS} ms.`,
    )), HOSTED_INIT_TIMEOUT_MS)
    : undefined;
  try {
    const response = await fetch('/__pyric/init.json', { signal: abortController.signal });
    status = response.status;
    const hasFailedResponse = !response.ok;
    if (hasFailedResponse) throw new Error(`/__pyric/init.json → ${response.status}`);
    const payload: InitPayload = await response.json();
    const isDifferentHost = requiresHostedSandbox && payload.hosted !== true;
    if (isDifferentHost) throw new InitIdentityError('/__pyric/init.json does not select the requested Node host.');
    const isDifferentProject = requiresHostedSandbox && payload.projectKey !== expectedProjectKey;
    if (isDifferentProject) throw new InitIdentityError('/__pyric/init.json belongs to a different project.');
    recordDiagnostic({ phase: 'init-ready', code: status });
    return payload;
  } catch (error) {
    const phase = abortController.signal.aborted ? 'timeout' : 'init-failed';
    recordDiagnostic({ phase, code: status });
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * A hosted page can load while its host is unreachable, so an unavailable host is
 * retried with the transport's reconnect backoff. A different host or project is final.
 */
async function requestInitPayloadWhenAvailable(): Promise<InitPayload> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestInitPayload();
    } catch (error) {
      const isFinal = !requiresHostedSandbox || error instanceof InitIdentityError;
      if (isFinal) throw error;
      const delay = Math.min(HOSTED_INIT_MAX_BACKOFF_MS, 250 * 2 ** attempt);
      const jitter = Math.random() * Math.min(250, delay / 10);
      await new Promise(resolve => setTimeout(resolve, Math.min(HOSTED_INIT_MAX_BACKOFF_MS, delay + jitter)));
    }
  }
}

/** Shared by transport selection and page initialization without a module cycle. */
export const initPayloadRequest = requestInitPayloadWhenAvailable();

export const initPayload: Promise<InitPayload | null> = initPayloadRequest.catch((error: unknown) => {
  if (requiresHostedSandbox) {
    const isError = error instanceof Error;
    const detail = isError ? error.message : String(error);
    throw new Error(`Hosted sandbox initialization failed: ${detail}`, { cause: error });
  }
  return null;
});

let sessionTokenRequest: Promise<string | null> | undefined;
let sessionTokenIsStale = false;

/**
 * The byte-route session token of the host this page is attached to. A failed
 * request is not remembered, and a restarted host's token replaces the old one.
 */
export function currentSessionToken(): Promise<string | null> {
  const needsFreshPayload = sessionTokenIsStale;
  if (sessionTokenRequest === undefined || needsFreshPayload) {
    sessionTokenIsStale = false;
    const payload = needsFreshPayload ? requestInitPayload() : initPayload;
    const request = payload.then(value => value?.sessionToken ?? null);
    sessionTokenRequest = request;
    request.catch(() => {
      const isLatest = sessionTokenRequest === request;
      if (!isLatest) return;
      sessionTokenRequest = undefined;
      sessionTokenIsStale = needsFreshPayload;
    });
  }
  return sessionTokenRequest;
}

/** The host may have restarted; the next token read fetches `init.json` again. */
export function forgetSessionToken(): void {
  sessionTokenIsStale = true;
}
