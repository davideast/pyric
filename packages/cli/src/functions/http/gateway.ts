/**
 * The one place a plane hands an HTTP request to the Functions runtime.
 * `pyric sandbox` calls it from its static server and the Vite plugin from its
 * middleware stack, so both planes route, refuse, forward, and record
 * identically.
 *
 * Two routes reach a function: the emulator path
 * `/{projectId}/{region}/{name}[/...]`, and a firebase.json hosting rewrite
 * whose destination is a function. While the child is starting, reloading, or
 * waiting for a sandbox peer, a matched route answers 503 naming why
 * (functions-http#20) instead of falling through to a static 404.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { posix } from 'node:path';
import { getClock, type LocalSandbox } from 'pyric/sandbox';
import type { FunctionsChildHttpReady } from '../child-protocol.js';
import { maxHttpBodyBytes } from './child-server.js';
import { DEFAULT_REGION, type HttpFunctionInfo } from './discovery.js';
import { emitHttpExecutionEvent } from './host-events.js';
import { refuseForeignOrigin, type AppOriginCheck } from './private-origin.js';
import { proxyToChild, writeProxyBadGateway, type ProxyTarget } from './proxy.js';
import { captureInboundRequestBody } from './request-body-buffer.js';
import {
  attachedFunctionsRequestGuard,
  evaluateFunctionsRequestGuard,
  parseGuardRequestUrl,
  writeGuardRejectionResponse,
} from './request-guard.js';
import type { RequestGuardPolicy, TrustProxyPolicy } from '../../serve/guard-policy.js';
import { rewriteTarget, sessionCookieOnly, type HostingRewrite, type RewriteFunction } from './rewrites.js';
import { matchEmulatorPath } from './routes.js';
import { unavailableReason, type FunctionsPlane } from './unavailable.js';

export type { AppOriginCheck } from './private-origin.js';

export type FunctionsHttpState =
  /** Waiting for a sandbox peer before the first start. */
  | { kind: 'waiting-peer'; serveUrl: string }
  /** No peer connected within the start's wait. */
  | { kind: 'peer-timeout'; serveUrl: string }
  | { kind: 'starting' }
  | { kind: 'reloading' }
  | { kind: 'failed'; message: string }
  /** The child stopped beating; the runtime is restarting it. */
  | { kind: 'unresponsive' }
  /** The child exited unexpectedly; the runtime is restarting a fresh instance (#1942). */
  | { kind: 'restarting'; code: number; ready?: Promise<void> }
  /** The child exited after it was ready and is not restarting. */
  | { kind: 'exited'; code: number }
  | { kind: 'stopped' }
  | { kind: 'ready'; http: FunctionsChildHttpReady | null };

/** One request a function served, as both planes log it (functions-http#21, functions-callable#23). */
export interface FunctionsHttpRecord {
  exportName: string;
  kind?: 'http' | 'callable';
  method: string;
  /** The path and query the function saw. */
  path: string;
  /** The status the client received, or null when no complete response reached it. */
  status: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface FunctionsHttpGatewayOptions {
  projectId: string;
  initial: FunctionsHttpState;
  /** firebase.json hosting rewrites, in order. */
  rewrites?: readonly HostingRewrite[];
  /** Whether a static file answers this (undecoded, normalized) path; Hosting serves a file before any rewrite. */
  staticFileExists?(pathname: string): boolean;
  onServed?(record: FunctionsHttpRecord): void;
  /** A rewrite pyric refuses as the CLI would; reported once per function. */
  onWarning?(warning: string): void;
  /** Hosting's cut for a rewritten request; tests shorten it. */
  hostingRewriteTimeoutSeconds?: number;
  /** Optional proxy trust policy forwarded to `proxyToChild` for `x-forwarded-proto`. */
  trustProxy?: TrustProxyPolicy;
  /** Optional unified request guard policy enforced on every matched function route. */
  guardPolicy?: RequestGuardPolicy;
  /** Optional Node-hosted sandbox receiving `execution_finished` events for served `onRequest` calls (#1768). */
  sandbox?: LocalSandbox | (() => LocalSandbox | null | undefined);
  plane: FunctionsPlane;
}

export interface FunctionsHttpGateway {
  /**
   * Handle the request if it is for a function; false lets the plane carry on.
   * `allowsAppOrigin` is the plane's Origin check, applied to private functions.
   */
  handle(req: IncomingMessage, res: ServerResponse, allowsAppOrigin: AppOriginCheck): Promise<boolean>;
  update(state: FunctionsHttpState): void;
  state(): FunctionsHttpState;
}

/** Firebase's request timeout when a function sets none. */
const DEFAULT_TIMEOUT_SECONDS = 60;
/** Hosting cuts a rewritten request at 60 s, whatever the function's own timeoutSeconds. */
const HOSTING_REWRITE_TIMEOUT_SECONDS = 60;
/** The longest timeoutSeconds production allows an HTTP function; it also keeps setTimeout's delay in range. */
const MAX_TIMEOUT_SECONDS = 3_600;
/** Maximum time a request waits for a post-crash cold start before falling back to 503. */
const CRASH_RESTART_WAIT_MS = 10_000;
/** Brief window to absorb TCP-before-IPC close ordering when a handler calls process.exit(). */
const DEAD_CHILD_TRANSITION_WAIT_MS = 200;

interface RequestTimeout {
  seconds: number;
  /** True when Hosting's rewrite cap, not the function's own timeout, sets `seconds`. */
  cutByHosting: boolean;
}

/**
 * How long a request may run before it gets a 504. A rewritten request is
 * capped at Hosting's 60 s (firebase.google.com/docs/hosting/functions); the
 * emulator path keeps the function's own timeout.
 */
function requestTimeout(
  fn: HttpFunctionInfo,
  route: { viaRewrite: boolean },
  hostingCapSeconds: number = HOSTING_REWRITE_TIMEOUT_SECONDS,
): RequestTimeout {
  const own = Math.min(fn.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
  const cutByHosting = route.viaRewrite && hostingCapSeconds < own;
  let seconds = own;
  if (cutByHosting) {
    seconds = hostingCapSeconds;
  }
  return { seconds, cutByHosting };
}

export function requestTimeoutSeconds(fn: HttpFunctionInfo, route: { viaRewrite: boolean }): number {
  return requestTimeout(fn, route).seconds;
}

/** The 504 body, naming the limit that cut the request. */
function timeoutMessage(exportName: string, timeout: RequestTimeout): string {
  if (timeout.cutByHosting) {
    return `pyric: ${exportName} did not respond within Hosting's ${timeout.seconds} s limit for a rewritten request.`;
  }
  return `pyric: ${exportName} did not respond within its timeout (${timeout.seconds} s).`;
}

function waitBounded(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, timeoutMs);
    timer.unref();
    void promise.finally(() => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref();
  });
}

const PLAIN_TEXT = { 'content-type': 'text/plain; charset=utf-8' };

/** What a request resolved to before the lifecycle decides whether it can be served. */
type Resolved =
  | { kind: 'function'; fn: HttpFunctionInfo; forwardUrl: string; viaRewrite: boolean }
  | { kind: 'refused'; message: string }
  /** The emulator path shape with a key no served function has, and no rewrite for it. */
  | { kind: 'unknown-function'; key: string }
  | { kind: 'pending' };

type RewriteMatch =
  | { kind: 'function'; fn: HttpFunctionInfo }
  | { kind: 'refused'; message: string; ambiguous: boolean };

/**
 * The function a rewrite reaches. A rewrite that names a region needs the
 * function in it. One that names none takes the region from the source: the
 * function's us-central1 deployment when it has one, otherwise its only
 * region. With several and no us-central1 it is refused, as firebase-tools
 * 15.23.0 refuses it (`lib/deploy/hosting/convertConfig.js:48-56`).
 */
function rewriteFunction(target: RewriteFunction, functions: readonly HttpFunctionInfo[]): RewriteMatch {
  const named = functions.find((candidate) => candidate.exportName === target.functionId);
  if (target.region !== null) {
    const servesRegion = named?.regions.includes(target.region) ?? false;
    if (named && servesRegion) return { kind: 'function', fn: named };
    return { kind: 'refused', message: unknownRewriteTarget(`${target.region}-${target.functionId}`, functions), ambiguous: false };
  }
  if (!named) return { kind: 'refused', message: unknownRewriteTarget(target.functionId, functions), ambiguous: false };
  const isUnambiguous = named.regions.includes(DEFAULT_REGION) || named.regions.length === 1;
  if (isUnambiguous) return { kind: 'function', fn: named };
  const message =
    `More than one backend found for function name: ${target.functionId}. ` +
    'If the function is deployed in multiple regions, you must specify a region.';
  return { kind: 'refused', message, ambiguous: true };
}

/** A rewrite names a function the source does not serve (in that region). */
function unknownRewriteTarget(key: string, functions: readonly HttpFunctionInfo[]): string {
  const served = functions.flatMap((fn) => fn.regions.map((region) => `${region}-${fn.exportName}`));
  return `Function ${key} named by a hosting rewrite does not exist, valid functions are: ${served.join(', ')}`;
}

/** firebase-tools' 404 for an unknown trigger key (`functionsEmulator.js:1239-1243`). */
function notFoundText(key: string, functions: readonly HttpFunctionInfo[]): string {
  const keys = functions.flatMap((fn) => fn.regions.map((region) => `${region}-${fn.exportName}`));
  return `Function ${key} does not exist, valid functions are: ${keys.join(', ')}`;
}

/** A GET or HEAD may be for a static file under a directory named after the project id. */
function mayBeStaticRead(req: IncomingMessage): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

/**
 * The path Hosting matches rewrites against, as superstatic computes it
 * (`slasher(url.parse(req.url).pathname)`): undecoded, without the query or
 * fragment, with `.` and `..` segments and repeated slashes resolved.
 */
export function hostingPathname(rawUrl: string): string {
  const end = rawUrl.search(/[?#]/);
  const raw = end === -1 ? rawUrl : rawUrl.slice(0, end);
  return posix.normalize(posix.join('/', raw));
}

export function createFunctionsHttpGateway(options: FunctionsHttpGatewayOptions): FunctionsHttpGateway {
  let current = options.initial;
  const rewrites = options.rewrites ?? [];
  const warned = new Set<string>();
  const warnOnce = (functionId: string, warning: string): void => {
    if (warned.has(functionId)) return;
    warned.add(functionId);
    options.onWarning?.(warning);
  };

  const resolve = (rawUrl: string, functions: readonly HttpFunctionInfo[] | null): Resolved | null => {
    const emulator = matchEmulatorPath(rawUrl, { projectId: options.projectId, functions });
    if (emulator?.kind === 'function') {
      if (emulator.ambiguousRunService) {
        const { service, exports } = emulator.ambiguousRunService;
        warnOnce(
          `run-service:${service}`,
          `httpsCallableFromURL run.app service '${service}' matches multiple onCall exports (${exports.join(', ')}); routing to ${emulator.fn.exportName}.`,
        );
      }
      return { kind: 'function', fn: emulator.fn, forwardUrl: emulator.forwardUrl, viaRewrite: false };
    }
    if (emulator?.kind === 'emulator-path') return { kind: 'pending' };
    const pathname = hostingPathname(rawUrl);
    const target = rewriteTarget(rewrites, pathname);
    const isRewritten = target !== null && !options.staticFileExists?.(pathname);
    if (!isRewritten) {
      if (emulator?.kind === 'unknown-function') return { kind: 'unknown-function', key: emulator.key };
      return null;
    }
    if (functions === null) return { kind: 'pending' };
    const match = rewriteFunction(target, functions);
    if (match.kind === 'refused') {
      if (match.ambiguous) warnOnce(target.functionId, `firebase.json hosting rewrite: ${match.message}`);
      return { kind: 'refused', message: match.message };
    }
    return { kind: 'function', fn: match.fn, forwardUrl: rawUrl, viaRewrite: true };
  };

  const waitForFreshChildAfterRefusal = async (deadToken: string): Promise<FunctionsChildHttpReady | null> => {
    const deadline = Date.now() + DEAD_CHILD_TRANSITION_WAIT_MS;
    while (Date.now() < deadline) {
      const observed = current;
      if (observed.kind === 'restarting') {
        if (observed.ready !== undefined) {
          await waitBounded(observed.ready, CRASH_RESTART_WAIT_MS);
        }
        if (current.kind === 'ready' && current.http !== null && current.http.token !== deadToken) {
          return current.http;
        }
        return null;
      }
      if (observed.kind === 'ready' && observed.http !== null && observed.http.token !== deadToken) {
        return observed.http;
      }
      if (observed.kind !== 'ready') {
        return null;
      }
      await delayMs(10);
    }
    return null;
  };

  return {
    state: () => current,
    update(state) {
      current = state;
    },
    async handle(req, res, allowsAppOrigin) {
      const rawUrl = req.url ?? '/';
      const evaluateRequestGuard = (): ReturnType<typeof evaluateFunctionsRequestGuard> | null => {
        const attached = attachedFunctionsRequestGuard(req);
        if (attached !== undefined) {
          return evaluateFunctionsRequestGuard(req, attached.policy, { url: attached.url });
        }
        if (options.guardPolicy !== undefined) {
          return evaluateFunctionsRequestGuard(req, options.guardPolicy, { url: parseGuardRequestUrl(req) });
        }
        return null;
      };

      let guardDecision: ReturnType<typeof evaluateFunctionsRequestGuard> | null = null;
      let capturedForRestart = false;
      if (current.kind === 'restarting' && current.ready !== undefined) {
        const probeMatch = resolve(rawUrl, null);
        if (probeMatch === null) return false;
        guardDecision = evaluateRequestGuard();
        if (guardDecision !== null && !guardDecision.ok) {
          writeGuardRejectionResponse(res, guardDecision);
          return true;
        }
        captureInboundRequestBody(req);
        capturedForRestart = true;
        await waitBounded(current.ready, CRASH_RESTART_WAIT_MS);
      }

      const drainIfCaptured = (): void => {
        if (capturedForRestart) {
          captureInboundRequestBody(req).drainRemaining();
        }
      };

      const state = current;
      let http: FunctionsChildHttpReady | null = null;
      let functions: readonly HttpFunctionInfo[] | null = null;
      if (state.kind === 'ready') {
        http = state.http;
        functions = http?.functions ?? [];
      }
      const resolved = resolve(rawUrl, functions);
      if (resolved === null) {
        drainIfCaptured();
        return false;
      }
      if (resolved.kind === 'unknown-function' && (http === null || mayBeStaticRead(req))) {
        drainIfCaptured();
        return false;
      }
      if (guardDecision === null) {
        guardDecision = evaluateRequestGuard();
      }
      if (guardDecision !== null && !guardDecision.ok) {
        drainIfCaptured();
        writeGuardRejectionResponse(res, guardDecision);
        return true;
      }
      const reason = unavailableReason(state, options.plane);
      if (reason !== null) {
        drainIfCaptured();
        res.writeHead(503, { ...PLAIN_TEXT, 'retry-after': '1' }).end(reason);
        return true;
      }
      if (resolved.kind === 'unknown-function' && http !== null) {
        drainIfCaptured();
        res.writeHead(404, PLAIN_TEXT).end(notFoundText(resolved.key, http.functions));
        return true;
      }
      if (resolved.kind !== 'function' || http === null) {
        let message = unknownRewriteTarget('unknown', functions ?? []);
        if (resolved.kind === 'refused') {
          message = resolved.message;
        }
        drainIfCaptured();
        res.writeHead(404, PLAIN_TEXT).end(message);
        return true;
      }
      const guardVerifiedOrigin = guardDecision !== null && guardDecision.ok && guardDecision.isRemoteRequest;
      if (refuseForeignOrigin(req, res, resolved.fn, allowsAppOrigin, { guardVerifiedOrigin })) {
        drainIfCaptured();
        return true;
      }

      let headerOverrides: Record<string, string | undefined> | undefined;
      if (resolved.viaRewrite) {
        headerOverrides = {
          cookie: sessionCookieOnly(req.headers.cookie),
          'x-forwarded-host': req.headers.host ?? '',
          'x-original-url': rawUrl,
        };
      }
      const resolveGatewaySandbox = (): LocalSandbox | null => {
        if (typeof options.sandbox === 'function') {
          return options.sandbox() ?? null;
        }
        return options.sandbox ?? null;
      };
      const startedAt = Date.now();
      let sandboxStartedAt: number | undefined;
      if (resolved.fn.kind !== 'callable') {
        const activeSandbox = resolveGatewaySandbox();
        if (activeSandbox !== null) {
          try {
            sandboxStartedAt = getClock(activeSandbox).now();
          } catch {
            // Best-effort clock read; falls back to wall-clock duration offset.
          }
        }
      }
      const timeout = requestTimeout(resolved.fn, resolved, options.hostingRewriteTimeoutSeconds);
      const buildTarget = (activeHttp: FunctionsChildHttpReady, deferRefused: boolean): ProxyTarget => {
        const proxyTarget: ProxyTarget = {
          port: activeHttp.port,
          token: activeHttp.token,
          exportName: resolved.fn.exportName,
          forwardUrl: resolved.forwardUrl,
          timeoutMs: timeout.seconds * 1_000,
          timeoutMessage: timeoutMessage(resolved.fn.exportName, timeout),
          maxBodyBytes: maxHttpBodyBytes(resolved.fn.platform),
          deferConnectRefused: deferRefused,
        };
        if (options.trustProxy !== undefined) {
          proxyTarget.trustProxy = options.trustProxy;
        }
        if (headerOverrides !== undefined) {
          proxyTarget.headerOverrides = headerOverrides;
        }
        return proxyTarget;
      };

      let outcome = await proxyToChild(req, res, buildTarget(http, true));
      if (outcome.connectRefused === true) {
        const replacementHttp = await waitForFreshChildAfterRefusal(http.token);
        if (replacementHttp !== null) {
          outcome = await proxyToChild(req, res, buildTarget(replacementHttp, false));
        } else {
          captureInboundRequestBody(req).drainRemaining();
          writeProxyBadGateway(res);
          outcome = { status: 502, timedOut: false };
        }
      }

      const method = req.method ?? 'GET';
      const isCallablePreflight = resolved.fn.kind === 'callable' && method === 'OPTIONS';
      if (!isCallablePreflight) {
        const record: FunctionsHttpRecord = {
          exportName: resolved.fn.exportName,
          method,
          path: resolved.forwardUrl,
          status: outcome.status,
          timedOut: outcome.timedOut,
          durationMs: Date.now() - startedAt,
        };
        if (resolved.fn.kind === 'callable') {
          record.kind = 'callable';
        }
        options.onServed?.(record);
        if (resolved.fn.kind !== 'callable') {
          const targetSandbox = resolveGatewaySandbox();
          if (targetSandbox !== null) {
            emitHttpExecutionEvent(targetSandbox, record, sandboxStartedAt);
          }
        }
      }
      return true;
    },
  };
}
