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
import type { FunctionsChildHttpReady } from '../child-protocol.js';
import { DEFAULT_REGION, type HttpFunctionInfo } from './discovery.js';
import { proxyToChild } from './proxy.js';
import { rewriteTarget, sessionCookieOnly, type HostingRewrite, type RewriteFunction } from './rewrites.js';
import { matchEmulatorPath } from './routes.js';

export type FunctionsHttpState =
  | { kind: 'waiting-peer'; serveUrl: string }
  | { kind: 'starting' }
  | { kind: 'reloading' }
  | { kind: 'failed'; message: string }
  /** The child stopped beating; the runtime is restarting it. */
  | { kind: 'unresponsive' }
  /** The child exited after it was ready. */
  | { kind: 'exited'; code: number }
  | { kind: 'stopped' }
  | { kind: 'ready'; http: FunctionsChildHttpReady | null };

/** One request a function served, as both planes log it (functions-http#21). */
export interface FunctionsHttpRecord {
  exportName: string;
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
  /** A rewrite whose target pyric had to guess; reported once per function. */
  onWarning?(warning: string): void;
}

export interface FunctionsHttpGateway {
  /** Handle the request if it is for a function; false lets the plane carry on. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  update(state: FunctionsHttpState): void;
  state(): FunctionsHttpState;
}

/** Firebase's request timeout when a function sets none. */
const DEFAULT_TIMEOUT_SECONDS = 60;
/** Hosting cuts a rewritten request at 60 s, whatever the function's own timeoutSeconds. */
const HOSTING_REWRITE_TIMEOUT_SECONDS = 60;
/** The longest timeoutSeconds production allows an HTTP function; it also keeps setTimeout's delay in range. */
const MAX_TIMEOUT_SECONDS = 3_600;

/**
 * How long a request may run before it gets a 504. A rewritten request is
 * capped at Hosting's 60 s (firebase.google.com/docs/hosting/functions); the
 * emulator path keeps the function's own timeout.
 */
export function requestTimeoutSeconds(fn: HttpFunctionInfo, route: { viaRewrite: boolean }): number {
  const own = Math.min(fn.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
  return route.viaRewrite ? Math.min(own, HOSTING_REWRITE_TIMEOUT_SECONDS) : own;
}

const PLAIN_TEXT = { 'content-type': 'text/plain; charset=utf-8' };

/** What a request resolved to before the lifecycle decides whether it can be served. */
type Resolved =
  | { kind: 'function'; fn: HttpFunctionInfo; forwardUrl: string; viaRewrite: boolean }
  | { kind: 'unknown'; key: string }
  | { kind: 'pending' };

/** Why a matched route cannot be served now; null once the child is ready. */
function unavailableReason(state: FunctionsHttpState): string | null {
  switch (state.kind) {
    case 'waiting-peer':
      return `Functions are not running yet: no browser tab is connected to pyric sandbox. Open ${state.serveUrl} to start them.`;
    case 'starting':
      return 'Functions are starting. Retry in a moment.';
    case 'reloading':
      return 'Functions are reloading after a source change. Retry in a moment.';
    case 'failed':
      return `Functions failed to start: ${state.message}`;
    case 'unresponsive':
      return 'The Functions child is unresponsive: a handler may be stuck in a synchronous loop. pyric is restarting it; retry in a moment.';
    case 'exited':
      return `The Functions child exited (code ${state.code}). Save a Functions source file or restart pyric to start it again.`;
    case 'stopped':
      return 'Functions are stopped.';
    case 'ready':
      return null;
  }
}

type RewriteMatch =
  | { kind: 'function'; fn: HttpFunctionInfo; warning: string | null }
  | { kind: 'unknown'; key: string };

/**
 * The function a rewrite reaches. A rewrite that names a region needs the
 * function in it. One that names none takes the region from the source: the
 * function's us-central1 deployment when it has one, otherwise its only
 * region; with several and no us-central1, the first, with a warning.
 */
export function rewriteFunction(target: RewriteFunction, functions: readonly HttpFunctionInfo[]): RewriteMatch {
  const named = functions.find((candidate) => candidate.exportName === target.functionId);
  if (target.region !== null) {
    const servesRegion = named?.regions.includes(target.region) ?? false;
    return named && servesRegion ? { kind: 'function', fn: named, warning: null } : { kind: 'unknown', key: `${target.region}-${target.functionId}` };
  }
  if (!named) return { kind: 'unknown', key: target.functionId };
  const isUnambiguous = named.regions.includes(DEFAULT_REGION) || named.regions.length === 1;
  if (isUnambiguous) return { kind: 'function', fn: named, warning: null };
  const warning =
    `firebase.json hosting rewrite to ${named.exportName} names no region, and ${named.exportName} deploys to ` +
    `${named.regions.join(', ')} but not ${DEFAULT_REGION}; pyric routes it to ${named.regions[0]}. Add "region" to the rewrite to choose one.`;
  return { kind: 'function', fn: named, warning };
}

/** A rewrite names a function the source does not serve (in that region). */
function unknownRewriteTarget(key: string, functions: readonly HttpFunctionInfo[]): string {
  const served = functions.flatMap((fn) => fn.regions.map((region) => `${region}-${fn.exportName}`));
  return `Function ${key} named by a hosting rewrite does not exist, valid functions are: ${served.join(', ')}`;
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
  const warnOnce = (exportName: string, warning: string | null): void => {
    if (warning === null || warned.has(exportName)) return;
    warned.add(exportName);
    options.onWarning?.(warning);
  };

  const resolve = (rawUrl: string, functions: readonly HttpFunctionInfo[] | null): Resolved | null => {
    const emulator = matchEmulatorPath(rawUrl, { projectId: options.projectId, functions });
    if (emulator?.kind === 'function') return { kind: 'function', fn: emulator.fn, forwardUrl: emulator.forwardUrl, viaRewrite: false };
    if (emulator?.kind === 'emulator-path') return { kind: 'pending' };
    const pathname = hostingPathname(rawUrl);
    const target = rewriteTarget(rewrites, pathname);
    if (target === null || options.staticFileExists?.(pathname)) return null;
    if (functions === null) return { kind: 'pending' };
    const match = rewriteFunction(target, functions);
    if (match.kind === 'unknown') return match;
    warnOnce(match.fn.exportName, match.warning);
    return { kind: 'function', fn: match.fn, forwardUrl: rawUrl, viaRewrite: true };
  };

  return {
    state: () => current,
    update(state) {
      current = state;
    },
    async handle(req, res) {
      const state = current;
      const http = state.kind === 'ready' ? state.http : null;
      const functions = state.kind === 'ready' ? http?.functions ?? [] : null;
      const rawUrl = req.url ?? '/';
      const resolved = resolve(rawUrl, functions);
      if (resolved === null) return false;
      const reason = unavailableReason(state);
      if (reason !== null) {
        res.writeHead(503, { ...PLAIN_TEXT, 'retry-after': '1' }).end(reason);
        return true;
      }
      if (resolved.kind !== 'function' || http === null) {
        const key = resolved.kind === 'unknown' ? resolved.key : 'unknown';
        res.writeHead(404, PLAIN_TEXT).end(unknownRewriteTarget(key, functions ?? []));
        return true;
      }
      const headerOverrides = resolved.viaRewrite
        ? {
            cookie: sessionCookieOnly(req.headers.cookie),
            'x-forwarded-host': req.headers.host ?? '',
            'x-original-url': rawUrl,
          }
        : undefined;
      const startedAt = Date.now();
      const outcome = await proxyToChild(req, res, {
        port: http.port,
        exportName: resolved.fn.exportName,
        forwardUrl: resolved.forwardUrl,
        timeoutMs: requestTimeoutSeconds(resolved.fn, resolved) * 1_000,
        ...(headerOverrides ? { headerOverrides } : {}),
      });
      options.onServed?.({
        exportName: resolved.fn.exportName,
        method: req.method ?? 'GET',
        path: resolved.forwardUrl,
        status: outcome.status,
        timedOut: outcome.timedOut,
        durationMs: Date.now() - startedAt,
      });
      return true;
    },
  };
}
