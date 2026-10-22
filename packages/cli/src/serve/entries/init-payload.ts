import { recordDiagnostic } from '../runtime/diagnostics-client.js';
import { pageListenerObservation } from '../runtime/listener-observation.js';
import type { InitPayload } from '../init-payload.js';
import { initPayloadUrl, nodeRuntimeOrigin } from './runtime-origin.js';

const hasDocument = typeof document !== 'undefined';
if (hasDocument) pageListenerObservation(document);
const documentLike = hasDocument ? document : undefined;
const hostedDeclaration = documentLike?.querySelector('meta[name="pyric-sandbox-host"]');
// A Node process the register bootstrap activated (#1082) requires the Node
// host as a page that declares it does; the host it discovered is this project's.
const isNodeRealm = nodeRuntimeOrigin() !== undefined;
const declaresNodeHost = hostedDeclaration?.getAttribute('content') === 'node';
const requiresHostedSandbox = declaresNodeHost || isNodeRealm;
const expectedProjectKey = hostedDeclaration?.getAttribute('data-project-key');
const checksProjectKey = declaresNodeHost;
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
    const response = await fetch(await initPayloadUrl(), { signal: abortController.signal });
    status = response.status;
    const hasFailedResponse = !response.ok;
    if (hasFailedResponse) throw new Error(`/__pyric/init.json → ${response.status}`);
    const payload: InitPayload = await response.json();
    // A Node process names the off-host case itself, as a refusal (worker-runtime.ts).
    const isDifferentHost = declaresNodeHost && payload.hosted !== true;
    if (isDifferentHost) throw new InitIdentityError('/__pyric/init.json does not select the requested Node host.');
    const isDifferentProject = checksProjectKey && payload.projectKey !== expectedProjectKey;
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
      // A Node process fails its calls at once when the host is down, as the
      // Node remote client does before its first attach; a page waits for it.
      const isFinal = !requiresHostedSandbox || isNodeRealm || error instanceof InitIdentityError;
      if (isFinal) throw error;
      const delay = Math.min(HOSTED_INIT_MAX_BACKOFF_MS, 250 * 2 ** attempt);
      const jitter = Math.random() * Math.min(250, delay / 10);
      await new Promise(resolve => setTimeout(resolve, Math.min(HOSTED_INIT_MAX_BACKOFF_MS, delay + jitter)));
    }
  }
}

/**
 * A promise whose work starts at its first use. A page reads `init.json` as it
 * loads; a Node process reads it at its first call, so importing an SDK opens
 * no connection and holds nothing, as the production SDK does (#1082). An
 * answer is kept; a failure is not, so a process started before its host
 * reads `init.json` again at its next call.
 */
function startedOnUse<T>(start: () => Promise<T>): Promise<T> {
  let started: Promise<T> | undefined;
  const run = (): Promise<T> => {
    if (started !== undefined) return started;
    const attempt = start();
    started = attempt;
    attempt.catch(() => {
      const isLatest = started === attempt;
      if (isLatest) started = undefined;
    });
    return attempt;
  };
  const lazy = {
    then: (onFulfilled?: ((value: T) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) =>
      run().then(onFulfilled, onRejected),
    catch: (onRejected?: ((reason: unknown) => unknown) | null) => run().catch(onRejected),
    finally: (onFinally?: (() => void) | null) => run().finally(onFinally),
    [Symbol.toStringTag]: 'Promise',
  };
  return lazy as unknown as Promise<T>;
}

/** Shared by transport selection and page initialization without a module cycle. */
export const initPayloadRequest: Promise<InitPayload> = isNodeRealm
  ? startedOnUse(requestInitPayloadWhenAvailable)
  : requestInitPayloadWhenAvailable();

const readPayload = (): Promise<InitPayload | null> => initPayloadRequest.catch((error: unknown) => {
  if (requiresHostedSandbox) {
    const isError = error instanceof Error;
    const detail = isError ? error.message : String(error);
    throw new Error(`Hosted sandbox initialization failed: ${detail}`, { cause: error });
  }
  return null;
});

export const initPayload: Promise<InitPayload | null> = isNodeRealm ? startedOnUse(readPayload) : readPayload();

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

/** Reads `init.json` from the host serving it now; the read also answers the next session-token read. */
async function readHostPayload(): Promise<InitPayload> {
  const payload = await requestInitPayload();
  sessionTokenRequest = Promise.resolve(payload.sessionToken ?? null);
  sessionTokenIsStale = false;
  return payload;
}

/** The read a reattach made for its socket url, which its boot id comes from too. */
let readForReattach: Promise<InitPayload> | undefined;

/**
 * The `init.json` of the host serving now, read afresh before a Node process
 * reattaches: its bridge url says where the socket goes, on a host that may
 * have moved. The next {@link currentHostInstanceId} answers from this read.
 */
export function currentHostPayload(): Promise<InitPayload> {
  const read = readHostPayload();
  readForReattach = read;
  return read;
}

/**
 * The boot id of the host serving `init.json` now, read afresh. A Node process
 * presents it when it reattaches, so after a host restart it presents the new
 * boot. It comes from the read the reattach made for its url when there is one,
 * and that read answers the next session-token read, so a reconnect reads
 * `init.json` once.
 */
export async function currentHostInstanceId(): Promise<string | undefined> {
  const pending = readForReattach;
  readForReattach = undefined;
  const payload = await (pending ?? readHostPayload());
  return payload.instanceId;
}
