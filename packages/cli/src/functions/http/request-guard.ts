/**
 * Unified `evaluateGuard` enforcement for Functions HTTP and Callable routes
 * across `pyric sandbox` (`server.ts`), Vite (`vite-generation-functions.ts`),
 * and `createFunctionsHttpGateway` (`gateway.ts`).
 *
 * Enforces TCP peer admission (`allowPeers`), `Host` / trusted proxy host
 * checks (`allowedHosts`, `trustProxy`), and mandatory per-boot session
 * capability authentication (`sessionToken`) consistently with `/__pyric/*`
 * and Auth/RTDB REST routes, while preserving zero-config loopback invocation
 * and public-function CORS on loopback.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import {
  createGuardPolicy,
  evaluateGuard,
  type GuardDecision,
  type GuardRequest,
  type RemoteAccessOptions,
  type RequestGuardPolicy,
} from '../../serve/guard-policy.js';

export interface FunctionsRequestGuardContext {
  readonly policy: RequestGuardPolicy;
  readonly url?: URL;
}

export interface FunctionsGuardPolicyInput {
  readonly boundHost: string;
  readonly boundPort?: number;
  readonly allowedHosts?: readonly string[];
  readonly remoteAccess?: RemoteAccessOptions;
  readonly sessionToken?: string;
  readonly requireSessionToken?: boolean;
}

const requestGuardContexts = new WeakMap<IncomingMessage, FunctionsRequestGuardContext>();

/** Merge explicit and remote-access host allowlists without duplicates. */
export function mergeAllowedHostEntries(
  primary: readonly string[] | undefined,
  secondary: readonly string[] | undefined,
): string[] {
  const merged: string[] = [];
  for (const host of primary ?? []) {
    if (!merged.includes(host)) merged.push(host);
  }
  for (const host of secondary ?? []) {
    if (!merged.includes(host)) merged.push(host);
  }
  return merged;
}

/** Compile the canonical `RequestGuardPolicy` for Functions HTTP/Callable routes. */
export function createFunctionsGuardPolicy(input: FunctionsGuardPolicyInput): RequestGuardPolicy {
  return createGuardPolicy({
    boundHost: input.boundHost,
    boundPort: input.boundPort,
    allowedHosts: mergeAllowedHostEntries(input.allowedHosts, input.remoteAccess?.allowedHosts),
    allowPeers: input.remoteAccess?.allowPeers,
    trustProxy: input.remoteAccess?.trustProxy,
    browserUnlock: input.remoteAccess?.browserUnlock,
    remoteAccessEnabled: input.remoteAccess !== undefined,
    sessionToken: input.sessionToken,
    requireSessionToken: input.requireSessionToken === true,
  });
}

/** Attach a compiled guard context to an inbound HTTP request and return a detach callback. */
export function attachFunctionsRequestGuard(
  req: IncomingMessage,
  context: FunctionsRequestGuardContext,
): () => void {
  requestGuardContexts.set(req, context);
  return () => {
    if (requestGuardContexts.get(req) === context) {
      requestGuardContexts.delete(req);
    }
  };
}

/** Read the guard context attached by the host plane (`server.ts` or Vite), if any. */
export function attachedFunctionsRequestGuard(
  req: IncomingMessage,
): FunctionsRequestGuardContext | undefined {
  return requestGuardContexts.get(req);
}

/** Safely parse an HTTP request URL for session-token and guard evaluation. */
export function parseGuardRequestUrl(req: IncomingMessage): URL | undefined {
  let baseHost = 'localhost';
  if (typeof req.headers.host === 'string' && req.headers.host.length > 0) {
    baseHost = req.headers.host;
  }
  try {
    return new URL(req.url ?? '/', `http://${baseHost}`);
  } catch (err: unknown) {
    if (err instanceof TypeError) return undefined;
    throw err;
  }
}

function withoutBrowserOriginHeaders(req: GuardRequest): GuardRequest {
  const headers = req.headers;
  if (headers === undefined) return req;
  if (headers instanceof Headers) {
    const filtered = new Headers();
    headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower !== 'origin' && lower !== 'sec-fetch-site') {
        filtered.append(key, value);
      }
    });
    return { method: req.method, headers: filtered, socket: req.socket };
  }
  const filtered: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower !== 'origin' && lower !== 'sec-fetch-site') {
      filtered[key] = value;
    }
  }
  return { method: req.method, headers: filtered, socket: req.socket };
}

/**
 * Evaluate `evaluateGuard` for a Functions HTTP / Callable request.
 *
 * Step 1 runs transport-level peer, `Host` / trusted forwarded host, legacy
 * extra-host, and remote session-token checks via `evaluateGuard`.
 * Step 2 runs full `evaluateGuard` (including `Origin` and `Sec-Fetch-Site`)
 * whenever the request is remote (`isRemoteRequest === true`), preventing
 * cross-origin CSRF and scheme downgrades on unlocked remote sessions while
 * keeping loopback public-function CORS and `private-origin.ts` diagnostics intact.
 */
export function evaluateFunctionsRequestGuard(
  req: GuardRequest,
  policy: RequestGuardPolicy,
  options?: { url?: URL },
): GuardDecision {
  const transportDecision = evaluateGuard(
    withoutBrowserOriginHeaders(req),
    policy,
    'rest-auth-rtdb',
    { url: options?.url },
  );
  if (!transportDecision.ok) return transportDecision;
  if (transportDecision.isRemoteRequest) {
    return evaluateGuard(req, policy, 'rest-auth-rtdb', { url: options?.url });
  }
  return transportDecision;
}

/** Write the canonical JSON guard rejection response (`401` / `403`, with unlock hint when eligible). */
export function writeGuardRejectionResponse(
  res: ServerResponse,
  decision: Extract<GuardDecision, { ok: false }>,
): void {
  res.writeHead(decision.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (decision.unlockRequired) {
    res.end(
      JSON.stringify({
        error: 'unlock_required',
        reason: decision.reason,
        unlockPath: '/__pyric/unlock',
        message: decision.message,
      }),
    );
    return;
  }
  res.end(JSON.stringify({ error: decision.message, reason: decision.reason }));
}
