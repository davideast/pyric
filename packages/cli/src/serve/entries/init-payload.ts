import './bundled-worker-init.js';
import {
  deferDiagnosticReporting,
  recordDiagnostic,
  resumeDiagnosticReporting,
  stopDiagnosticReporting,
} from '../runtime/diagnostics-client.js';
import { stampedSessionToken } from '../runtime/hosted-target.js';
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
const hasExpectedProjectKey = typeof expectedProjectKey === 'string' && expectedProjectKey.length > 0;
const checksProjectKey = declaresNodeHost && hasExpectedProjectKey;
const HOSTED_INIT_TIMEOUT_MS = 5_000;
const HOSTED_INIT_MAX_BACKOFF_MS = 5_000;

/** A host that answered with another host or project identity; retrying cannot change the answer. */
class InitIdentityError extends Error {}

const MAX_REFUSAL_DETAIL_LENGTH = 240;
const ANSI_ESCAPE_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function sanitizeRefusalText(value: string): string {
  const clean = value
    .replace(ANSI_ESCAPE_RE, ' ')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= MAX_REFUSAL_DETAIL_LENGTH) return clean;
  return clean.slice(0, MAX_REFUSAL_DETAIL_LENGTH).trimEnd();
}

async function readRefusalDetail(response: Response): Promise<{ detail: string; unlockPath?: string }> {
  if (typeof response.text !== 'function') return { detail: '' };
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return { detail: '' };
  }
  let contentType = '';
  if (typeof response.headers?.get === 'function') {
    contentType = response.headers.get('content-type') ?? '';
  }
  const mediaHeader = contentType.split(';')[0];
  let mediaType = '';
  if (mediaHeader !== undefined) mediaType = mediaHeader.trim().toLowerCase();
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        const errCode = typeof record.error === 'string' ? sanitizeRefusalText(record.error) : '';
        const rawUnlock = typeof record.unlockPath === 'string' ? record.unlockPath : '';
        if (errCode === 'unlock_required') {
          const safeUnlock = rawUnlock.startsWith('/__pyric/unlock') ? rawUnlock : '/__pyric/unlock';
          return { detail: errCode, unlockPath: sanitizeRefusalText(safeUnlock) };
        }
        if (errCode.length > 0) return { detail: errCode };
      }
    } catch {
      return { detail: '' };
    }
    return { detail: '' };
  }
  if (mediaType !== '' && mediaType !== 'text/plain') return { detail: '' };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith('<')) return { detail: '' };
  return { detail: sanitizeRefusalText(trimmed) };
}

function currentRelativeNextPath(): string {
  if (typeof globalThis.location !== 'object' || globalThis.location === null) return '/';
  const pathname = typeof globalThis.location.pathname === 'string' ? globalThis.location.pathname : '/';
  const search = typeof globalThis.location.search === 'string' ? globalThis.location.search : '';
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return '/';
  return `${pathname}${search}`;
}

let loggedInsecureContextWarning = false;

function warnIfInsecureBrowserContext(): void {
  if (loggedInsecureContextWarning) return;
  if (isNodeRealm || !hasDocument) return;
  if (typeof globalThis.isSecureContext === 'boolean' && globalThis.isSecureContext === false) {
    loggedInsecureContextWarning = true;
    console.warn(
      '[pyric sandbox] plain HTTP non-localhost origin is not a browser Secure Context: ' +
        'navigator.serviceWorker APIs (messaging/sw, storage/sw) are unavailable here. ' +
        'Use HTTPS (reverse proxy) or an SSH tunnel to http://localhost when testing service workers.',
    );
  }
}

/**
 * True once `/__pyric/init.json` has returned a non-refused, local-peer
 * payload in this browser realm. Until then, HTTP diagnostic flushes stay
 * deferred so a slow init round-trip cannot race the 100ms flush timer and
 * POST `/__pyric/diagnostics` from a refused or remote peer (#3264).
 */
let diagnosticReportingConfirmed = false;

async function requestInitPayload(resolvedUrl?: string): Promise<InitPayload> {
  if (!isNodeRealm && !diagnosticReportingConfirmed) {
    deferDiagnosticReporting();
  }
  recordDiagnostic({ phase: 'init-request' });
  const abortController = new AbortController();
  let status: number | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  if (requiresHostedSandbox) {
    deadline = setTimeout(() => {
      abortController.abort(
        new Error(`/__pyric/init.json did not complete within ${HOSTED_INIT_TIMEOUT_MS} ms.`),
      );
    }, HOSTED_INIT_TIMEOUT_MS);
  }
  try {
    const fetchHost = nodeRuntimeOrigin()?.socketRealm.fetch ?? fetch;
    const token = stampedSessionToken();
    const targetUrl = resolvedUrl ?? (await initPayloadUrl());
    const requestOptions: RequestInit = { signal: abortController.signal };
    if (token !== undefined) {
      requestOptions.headers = { 'x-pyric-session-token': token };
    }
    const response = await fetchHost(targetUrl, requestOptions);
    status = response.status;
    const isTerminalRefusal = response.status === 401 || response.status === 403;
    if (isTerminalRefusal) {
      stopDiagnosticReporting();
      const refusal = await readRefusalDetail(response);
      if (response.status === 401 && refusal.unlockPath !== undefined) {
        const nextQuery = encodeURIComponent(currentRelativeNextPath());
        let unlockUrl = refusal.unlockPath;
        if (!unlockUrl.includes('?')) {
          unlockUrl = `${unlockUrl}?next=${nextQuery}`;
        }
        throw new InitIdentityError(
          `Pyric session unlock required (401). Open ${unlockUrl} and enter the per-boot token printed in the server terminal.`,
        );
      }
      const suffix = refusal.detail.length > 0 ? `: ${refusal.detail}` : '';
      throw new InitIdentityError(`/__pyric/init.json refused the request (${response.status})${suffix}`);
    }
    const hasFailedResponse = !response.ok;
    if (hasFailedResponse) throw new Error(`/__pyric/init.json -> ${response.status}`);
    const payload: InitPayload = await response.json();
    if (payload.remotePeer === true) {
      stopDiagnosticReporting();
    } else if (!isNodeRealm) {
      diagnosticReportingConfirmed = true;
      resumeDiagnosticReporting();
    }
    const isRefusedRemotePage = declaresNodeHost && payload.remotePeer === true;
    if (isRefusedRemotePage) {
      throw new InitIdentityError(
        'This Node host serves project data only to clients on its own machine, and this page was opened from another one.',
      );
    }
    warnIfInsecureBrowserContext();
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
async function requestInitPayloadWhenAvailable(resolvedUrl?: string): Promise<InitPayload> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestInitPayload(resolvedUrl);
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

const VITE_SSR_SERVER_EPOCH = Symbol.for('pyric.vite.ssrServerEpoch');

function currentViteSsrEpoch(): number | undefined {
  const reader = (globalThis as Record<symbol, unknown>)[VITE_SSR_SERVER_EPOCH];
  if (typeof reader !== 'function') return undefined;
  const value = (reader as () => unknown)();
  return typeof value === 'number' ? value : undefined;
}

interface CachedNodeInitPayload {
  readonly url: string;
  readonly epoch: number | undefined;
  readonly request: Promise<InitPayload>;
}

let cachedNodeInit: CachedNodeInitPayload | undefined;
let nodeInitIsStale = false;
let sessionTokenRequest: Promise<string | null> | undefined;
let sessionTokenIsStale = false;

/**
 * A promise whose work starts when awaited. A page reads `init.json` as it
 * loads; a Node process reads it at its first call (#1082), and re-reads it
 * when the active host URL or Vite SSR server generation changes (#1145) or
 * after a dropped connection invalidates it.
 */
function lazyPromise<T>(run: () => Promise<T>): Promise<T> {
  const lazy = {
    then: (
      onFulfilled?: ((value: T) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => run().then(onFulfilled, onRejected),
    catch: (onRejected?: ((reason: unknown) => unknown) | null) => run().catch(onRejected),
    finally: (onFinally?: (() => void) | null) => run().finally(onFinally),
    [Symbol.toStringTag]: 'Promise',
  };
  return lazy as unknown as Promise<T>;
}

async function requestNodeInitPayload(): Promise<InitPayload> {
  const url = await initPayloadUrl();
  const epoch = currentViteSsrEpoch();
  const matchesCached =
    !nodeInitIsStale &&
    cachedNodeInit !== undefined &&
    cachedNodeInit.url === url &&
    cachedNodeInit.epoch === epoch;
  if (matchesCached && cachedNodeInit !== undefined) {
    return cachedNodeInit.request;
  }
  const changedTarget =
    cachedNodeInit !== undefined &&
    (cachedNodeInit.url !== url || cachedNodeInit.epoch !== epoch);
  if (changedTarget) {
    sessionTokenRequest = undefined;
    sessionTokenIsStale = false;
  }
  nodeInitIsStale = false;
  const attempt = requestInitPayloadWhenAvailable(url);
  const entry: CachedNodeInitPayload = { url, epoch, request: attempt };
  cachedNodeInit = entry;
  attempt.catch(() => {
    if (cachedNodeInit === entry) {
      cachedNodeInit = undefined;
    }
  });
  return attempt;
}

function selectInitPayloadRequest(): Promise<InitPayload> {
  if (isNodeRealm) return lazyPromise(requestNodeInitPayload);
  return requestInitPayloadWhenAvailable();
}

/** Shared by transport selection and page initialization without a module cycle. */
export const initPayloadRequest: Promise<InitPayload> = selectInitPayloadRequest();

const readPayload = (): Promise<InitPayload | null> => initPayloadRequest.catch((error: unknown) => {
  if (requiresHostedSandbox) {
    const isError = error instanceof Error;
    const detail = isError ? error.message : String(error);
    throw new Error(`Hosted sandbox initialization failed: ${detail}`, { cause: error });
  }
  return null;
});

export const initPayload: Promise<InitPayload | null> = isNodeRealm ? lazyPromise(readPayload) : readPayload();

const loggedInitPayloadFailures = new WeakSet<object>();

/**
 * Logs a failed {@link initPayload} once per page, however many of its readers
 * see the failure. The app learns of a refusal from its own calls; this is the
 * page's one console line for it.
 */
export function logInitPayloadFailure(error: unknown): void {
  const isTracked = typeof error === 'object' && error !== null;
  const isLogged = isTracked && loggedInitPayloadFailures.has(error);
  if (isLogged) return;
  if (isTracked) loggedInitPayloadFailures.add(error);
  const detail = error instanceof Error ? error.message : String(error);
  console.error('[pyric sandbox] init payload unavailable:', detail);
}

/**
 * The byte-route session token of the host this page is attached to. A failed
 * request is not remembered, and a restarted host's token replaces the old one.
 */
export function currentSessionToken(): Promise<string | null> {
  if (isNodeRealm && cachedNodeInit !== undefined && cachedNodeInit.epoch !== currentViteSsrEpoch()) {
    sessionTokenRequest = undefined;
  }
  const needsFreshPayload = sessionTokenIsStale;
  if (sessionTokenRequest === undefined || needsFreshPayload) {
    sessionTokenIsStale = false;
    const payload = needsFreshPayload ? requestInitPayload() : initPayload;
    const request = payload.then(value => value?.sessionToken ?? stampedSessionToken() ?? null);
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

/** The host may have restarted; the next token or Node init read fetches `init.json` again. */
export function forgetSessionToken(): void {
  sessionTokenIsStale = true;
  nodeInitIsStale = true;
}

/** Reads `init.json` from the host serving it now; the read also answers the next session-token read. */
async function readHostPayload(): Promise<InitPayload> {
  const url = await initPayloadUrl();
  const epoch = currentViteSsrEpoch();
  const payload = await requestInitPayload(url);
  if (isNodeRealm) {
    cachedNodeInit = { url, epoch, request: Promise.resolve(payload) };
    nodeInitIsStale = false;
  }
  sessionTokenRequest = Promise.resolve(payload.sessionToken ?? stampedSessionToken() ?? null);
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
