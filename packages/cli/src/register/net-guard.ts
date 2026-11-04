/**
 * The runtime network guard: the credential choke point.
 *
 * The module swap keeps a sandboxed app's Firebase traffic on the local
 * `/__pyric/*` namespace, and stops a real `firebase` or `firebase-admin` load
 * where pyric intends a swap. What the swap can't see, such as a bundled copy
 * of `firebase-admin` or another Google client library, can act with admin
 * authority only once it holds a Google access token. This module refuses
 * every request for one.
 *
 * Where it hooks, and why exactly there
 * -------------------------------------
 * 1. `Symbol.for('undici.globalDispatcher.1')`, the undici global dispatcher.
 *    Measured against Next 15.5 / Node 24 / undici 7, this one seam covers
 *    Node route handlers, edge route handlers and middleware, under both the
 *    webpack and turbopack dev servers. Patching `globalThis.fetch` does not:
 *    the edge sandbox bundles its own undici, and that copy's
 *    `getGlobalDispatcher()` reads the host realm's symbol, which is precisely
 *    why hooking the dispatcher reaches it and hooking `fetch` does not.
 *
 *    Three mechanics the seam depends on:
 *      - undici installs the property `configurable: false, writable: true`, so
 *        we install by plain assignment. A `defineProperty` with
 *        `configurable: true` throws a TypeError and takes the dev server down
 *        with it. Accessor traps are useless anyway, because
 *        `setGlobalDispatcher` uses `defineProperty`, which bypasses setters.
 *      - The property does not exist until undici is first touched, and undici
 *        only installs a default agent when it finds the slot empty. So we
 *        materialize it first with `new Headers()` (loads undici, zero
 *        network) and wrap whatever real Agent that produces.
 *      - The `handler` argument of `dispatch(opts, handler)` must pass through
 *        opaque and by identity. Edge hands a v6-shaped handler to the host's
 *        v7 Agent and that cross-version handoff only survives untouched. We
 *        read `opts.origin` and nothing else.
 *
 * 2. `net.connect` / `net.createConnection` / `tls.connect`, the
 *    `createConnection` on the `http.Agent` and `https.Agent` prototypes, and
 *    `net.Socket.prototype.connect`: the backstop for traffic that never goes
 *    through undici, such as `http.request`, gRPC, database drivers, anything
 *    holding a raw socket. Same list, same policy. (undici itself connects
 *    through `net.connect`, so a refused fetch would report twice; the
 *    once-per-host dedupe below collapses that.)
 *
 *    `Socket.prototype.connect` is the seam every client connection reaches:
 *    `net.connect` and `net.createConnection` build a socket and call it with
 *    their arguments normalized into one `[options, callback]` array, and
 *    `tls.connect` calls it on the `TLSSocket` it builds. Patching the module
 *    functions alone leaves two routes open: a reference to `net.connect` a
 *    library took before this module ran, and `new net.Socket().connect(...)`.
 *
 *    The Agent prototypes need their own patch because
 *    `http.Agent.prototype.createConnection` is a copied reference to
 *    `net.createConnection`, taken when `_http_agent` first loaded. If anything
 *    loaded `node:http` before this module ran, that copy is the unpatched
 *    function and every plain `http.request` would sail past the backstop,
 *    including a request to the metadata server. It is also why the socket
 *    patches are installed BEFORE the dispatcher is materialized: materializing
 *    loads undici, which loads `_http_agent`.
 *
 * 3. `http.ClientRequest.prototype.onSocket`, for a request's path. A request
 *    to a proxy names its real destination only in the `CONNECT` target or the
 *    absolute-form URL in its path, and a token request to `www.googleapis.com`
 *    differs from that host's other APIs only in its path. The request is the
 *    only object that still carries it; undici's `opts.path` is the other.
 *    Likewise a TLS session over a tunnel names its destination only in
 *    `servername`, which the socket seams check beside `host`.
 *
 * Every host is compared in one spelling (`normalizeHostname`), which writes
 * each IPv4 form the resolver accepts (`2852039166`, `0xa9fea9fe`,
 * `169.254.43518`) and each IPv4-mapped IPv6 address as a dotted quad, so no
 * respelling of the metadata IP gets past its entry. Worker
 * threads load the register too (`./worker-guard.js`).
 *
 * Policy
 * ------
 * The guard is a credential choke point (ADR 0022). It refuses only the places
 * a server-side Google access token comes from (`../google-token-endpoints.ts`):
 * the OAuth 2.0, STS and IAM credentials hosts, the token paths on
 * `www.googleapis.com`, the metadata server, and the hosts `GCE_METADATA_*` and
 * the credentials file name. Every other host passes without a report. The
 * Firebase client SDK never asks for a token, so live mode and production AI
 * mode never meet it.
 *
 * One knob, `PYRIC_GUARD`:
 *   unset, empty, unrecognized, `block`   refuse token sources
 *   warn   the same, with one notice line saying `warn` no longer lets them through
 *   off    no hooks at all, one notice line at install time
 * Swap or stop (`./swap-or-stop.ts`) doesn't depend on this knob.
 *
 * A blocked fetch surfaces to app code as a bare `TypeError: fetch failed`
 * (the reason is buried on `error.cause`), so the guard logs its own denial:
 * the app's error will never explain itself.
 *
 * `PYRIC_GUARD_ALLOW` and `permit` still parse, but nothing the guard refuses
 * can be allowed (ruling 3), so they change nothing.
 *
 * Bun and Deno are out of scope: neither evaluates Node loader hooks (the
 * register module never loads there) and neither routes `fetch` through
 * undici's global dispatcher. `installNetGuard` degrades to the socket
 * backstop instead of throwing.
 */
import { createRequire } from 'node:module';
import { normalizeHostname } from '../google-endpoints.js';
import {
  findTokenSource,
  tokenEndpointsFrom,
  type TokenEndpoints,
} from '../google-token-endpoints.js';
import {
  nodeAgentPrototypes,
  nodeClientRequestPrototypes,
  nodeSocketPrototypes,
} from './connect-prototypes.js';

/** undici's version-suffixed global-dispatcher slots (`undici.globalDispatcher.1` in undici 6 / Node 20–22, `.2` in undici 7+ / Node 24+). */
const UNDICI_DISPATCHER_KEY_PREFIX = 'undici.globalDispatcher.';
const KNOWN_UNDICI_DISPATCHER_SLOTS: readonly symbol[] = [
  Symbol.for('undici.globalDispatcher.1'),
  Symbol.for('undici.globalDispatcher.2'),
];

function undiciDispatcherSlots(scope: Record<symbol, unknown>): Set<symbol> {
  const slots = new Set<symbol>(KNOWN_UNDICI_DISPATCHER_SLOTS);
  for (const sym of Object.getOwnPropertySymbols(scope)) {
    if (Symbol.keyFor(sym)?.startsWith(UNDICI_DISPATCHER_KEY_PREFIX)) {
      slots.add(sym);
    }
  }
  return slots;
}

/** Marks a rejection as the guard's, so callers can tell it from a DNS/TLS
 *  failure. A blocked `fetch` only exposes it as `error.cause.code`. */
export const GUARD_BLOCKED_CODE = 'PYRIC_GUARD_BLOCKED';

const LOG_PREFIX = '@pyric/cli/register: net-guard';

/** How often to check that nobody replaced the global dispatcher under us. */
const REASSERT_INTERVAL_MS = 5_000;

/**
 * `PYRIC_GUARD` as the developer named it. `warn` and `block` both refuse
 * token sources; `warn` is kept apart only so the beacon and the interlock line
 * report the value that was set.
 */
export type GuardMode = 'warn' | 'block' | 'off';

/** A refused request: which token source, or which other endpoint, it reached. */
export interface EgressVerdict {
  /** Always `block`: the guard reports nothing it lets through. */
  readonly verdict: 'block';
  readonly permitted: false;
  /** The hostname actually being contacted, which is what the developer needs to find the call. */
  readonly host: string;
  /** Human service label, verbatim from the token list. */
  readonly service: string;
  /** Why it is refused. Defaults to the token-source reason. */
  readonly reason?: string;
  /** What the developer can do instead. Defaults to the token-source remedy. */
  readonly remedy?: string;
}

/** The verdict a guard reads for one request: a refusal, or null to let it through. */
export type EgressRule = (hostname: string, path: string | undefined) => EgressVerdict | null;

/** `PYRIC_GUARD` → mode. Unset, empty and unrecognised values mean `block`;
 *  `warn` and `off` take effect only when named. */
export function parseGuardMode(raw: string | undefined): GuardMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'warn') return 'warn';
  if (value === 'off') return 'off';
  return 'block';
}

/** `PYRIC_GUARD_ALLOW` → hostnames. Accepts bare hosts and full URLs, because
 *  the values it carries are configured as URLs (AI engine baseUrls). */
export function parseAllowHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const entry = token.trim();
    if (entry.length === 0) continue;
    out.push(hostnameOf(entry));
  }
  return out;
}

/** `name:port`: one colon, so never a bare IPv6 address. */
const NAME_WITH_PORT = /^([^:]+):\d+$/;

/** `[v6]` or `[v6]:port`. */
const BRACKETED_HOST = /^\[([^\]]+)\](?::\d+)?$/;

/**
 * Best-effort hostname from a host, `host:port`, `[v6]:port`, or full URL, in
 * `normalizeHostname`'s spelling, the one the token list is written in.
 */
function hostnameOf(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('://')) {
    try {
      return normalizeHostname(new URL(trimmed).hostname);
    } catch {
      // Not a parseable URL: fall through to the textual forms.
    }
  }
  const withoutPath = trimmed.split('/')[0] ?? trimmed;
  const hostPart =
    BRACKETED_HOST.exec(withoutPath)?.[1] ?? NAME_WITH_PORT.exec(withoutPath)?.[1] ?? withoutPath;
  return normalizeHostname(hostPart);
}

/** The token sources in force and the mode, which is all a verdict reads. */
export interface EgressPolicy {
  readonly mode: GuardMode;
  readonly endpoints: TokenEndpoints;
}

/**
 * The whole verdict, pure: `null` unless the guard is on and `hostname`, with
 * `path` when the seam knows it, is a token source. `hostname` may be a proxy's
 * absolute-form target (`http://host/path`), which carries its own path.
 */
export function evaluateEgress(hostname: string, policy: EgressPolicy, path?: string): EgressVerdict | null {
  if (policy.mode === 'off') return null;
  const target = destinationOf(hostname, path);
  if (target.host.length === 0) return null;
  const source = findTokenSource(policy.endpoints, target.host, target.path);
  if (source === undefined) return null;
  return { verdict: 'block', permitted: false, host: source.host, service: source.service };
}

function destinationOf(hostname: string, path: string | undefined): { host: string; path?: string } {
  const isUrl = hostname.includes('://');
  if (!isUrl) return { host: hostnameOf(hostname), path };
  try {
    const url = new URL(hostname);
    return { host: normalizeHostname(url.hostname), path: url.pathname };
  } catch {
    return { host: hostnameOf(hostname), path };
  }
}

const REMEDY =
  'To use real Google credentials, run this command outside pyric sandbox, or set PYRIC_GUARD=off for it';

const TOKEN_REASON = "a sandboxed process can't get a server-side Google access token";

/** One stderr line per refused host: structured (fixed leading fields, so it
 *  is greppable) and attributable (service + transport + initiating command).
 *  The request path is deliberately never logged: it carries ids and tokens. */
export function formatGuardLine(
  verdict: EgressVerdict,
  transport: 'fetch' | 'socket',
  context: string | undefined,
  prefix: string = LOG_PREFIX,
): string {
  let where = `via ${transport}`;
  if (context !== undefined && context.length > 0) where = `${where} from ${context}`;
  const head = `${prefix} BLOCK ${verdict.host} (${verdict.service}) ${where}:`;
  // What the app actually observes differs by seam: undici swallows our throw
  // into the opaque `TypeError: fetch failed`, while a raw socket caller gets
  // the error itself. Say which, or the developer cannot connect the two.
  let surfaces: string;
  if (transport === 'fetch') {
    surfaces = `the caller sees \`TypeError: fetch failed\` with cause ${GUARD_BLOCKED_CODE}`;
  } else {
    surfaces = `the caller sees an error with code ${GUARD_BLOCKED_CODE}`;
  }
  return (
    `${head} ${verdict.reason ?? TOKEN_REASON}; ` +
    `${surfaces}. ${verdict.remedy ?? REMEDY}. Further attempts to this host are not logged.\n`
  );
}

export function blockedError(verdict: EgressVerdict, transport: 'fetch' | 'socket'): Error {
  return Object.assign(
    new Error(
      `pyric net-guard blocked ${transport} egress to ${verdict.host} (${verdict.service}): ` +
        `${verdict.reason ?? TOKEN_REASON}. ${verdict.remedy ?? REMEDY}.`,
    ),
    { code: GUARD_BLOCKED_CODE, host: verdict.host, service: verdict.service },
  );
}

// ─── the reporter: evaluate, log once, refuse ─────────────────────────────────

export interface ReporterOptions {
  readonly mode: GuardMode;
  /** The token sources to refuse. Defaults to the fixed list, with nothing from the environment. */
  readonly endpoints?: TokenEndpoints;
  readonly write?: (line: string) => void;
  /** Initiating command, for attribution. Usually `basename(argv[1])`. */
  readonly context?: string;
  /** The verdict to read in place of the token-source one, as live mode's guard does. */
  readonly rule?: EgressRule;
  /** What each logged line starts with. Defaults to the register's `net-guard` prefix. */
  readonly logPrefix?: string;
  /**
   * The shared "already reported" ledger. `installNetGuard` hands the SAME set
   * to the dispatcher wrapper and the socket backstop, because undici connects
   * through `net.connect`: a refused fetch trips both seams and would
   * otherwise print the same host twice. It also survives a re-assert, so
   * being re-wrapped does not restart the noise.
   */
  readonly reported?: Set<string>;
}

export interface Reporter {
  /** Logs a refusal at most once per host, and throws it. */
  check(hostname: string | undefined, transport: 'fetch' | 'socket', path?: string): void;
  /** Logs `verdict` at most once per host, and returns the error to fail the request with. */
  refuse(verdict: EgressVerdict, transport: 'fetch' | 'socket'): Error;
}

export function createReporter(options: ReporterOptions): Reporter {
  const write = options.write ?? ((line: string) => void process.stderr.write(line));
  const reported = options.reported ?? new Set<string>();
  const policy: EgressPolicy = { mode: options.mode, endpoints: options.endpoints ?? tokenEndpointsFrom({ env: {} }) };
  const rule: EgressRule = options.rule ?? ((hostname, path) => evaluateEgress(hostname, policy, path));
  const refuse = (verdict: EgressVerdict, transport: 'fetch' | 'socket'): Error => {
    // A dev server retries relentlessly; one line per host is the signal,
    // and it also collapses the undici-over-net.connect double report.
    if (!reported.has(verdict.host)) {
      reported.add(verdict.host);
      write(formatGuardLine(verdict, transport, options.context, options.logPrefix));
    }
    return blockedError(verdict, transport);
  };
  return {
    check(hostname, transport, path) {
      if (hostname === undefined) return;
      const verdict = rule(hostname, path);
      if (verdict === null) return;
      throw refuse(verdict, transport);
    },
    refuse,
  };
}

// ─── the undici dispatcher wrapper ─────────────────────────────────────────

interface Dispatcher {
  dispatch(opts: unknown, handler: unknown): unknown;
}

/** `opts.origin` is a URL or an origin string; anything else means "no idea",
 *  and an unrecognisable origin is passed through rather than guessed at. */
function originHost(opts: unknown): string | undefined {
  const origin = (opts as { origin?: unknown } | null | undefined)?.origin;
  if (origin === undefined || origin === null) return undefined;
  if (typeof origin === 'object' && 'hostname' in origin) {
    const hostname = (origin as { hostname?: unknown }).hostname;
    return typeof hostname === 'string' ? hostname.toLowerCase() : undefined;
  }
  if (typeof origin !== 'string') return undefined;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** `opts.path`, which names a token path on a host that serves other APIs too. */
function requestPath(opts: unknown): string | undefined {
  const path = (opts as { path?: unknown } | null | undefined)?.path;
  return typeof path === 'string' ? path : undefined;
}

/**
 * Wrap a dispatcher so `dispatch` is guarded and every other member still
 * belongs to the real instance.
 *
 * A `Proxy` rather than a subclass or a copy: undici's Agent keeps state in
 * private fields and internal symbols, and every forwarded call must run with
 * `this` bound to the REAL instance (hence `Reflect.get(target, prop, target)`
 * and the bind) or those fields are not there. `instanceof` keeps working.
 */
export function wrapDispatcher<T extends Dispatcher>(real: T, options: ReporterOptions): T {
  const reporter = createReporter(options);
  const guardedDispatch = (opts: unknown, handler: unknown): unknown => {
    reporter.check(originHost(opts), 'fetch', requestPath(opts));
    // Both arguments cross UNTOUCHED. Edge hands a v6 handler to the host's
    // v7 Agent, and that handoff only survives by identity.
    return real.dispatch(opts, handler);
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'dispatch') return guardedDispatch;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as T;
}

// ─── install ───────────────────────────────────────────────────────────────

type ConnectFn = (...args: unknown[]) => unknown;

/** A `createConnection`-bearing object: an `http.Agent`/`https.Agent`
 *  prototype in production, a stand-in under test. */
type AgentPrototype = { createConnection?: unknown };

/** A `connect`-bearing object: `net.Socket.prototype` in production, a
 *  stand-in under test. */
type SocketPrototype = { connect?: unknown };

export interface NetGuardHooks {
  /** Object carrying the undici dispatcher symbol. Defaults to `globalThis`. */
  scope?: Record<symbol, unknown>;
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
  write?: (line: string) => void;
  net?: { connect: ConnectFn; createConnection: ConnectFn };
  tls?: { connect: ConnectFn };
  /** Prototypes whose `createConnection` is patched. Defaults to the
   *  `http.Agent` and `https.Agent` prototypes. */
  agentPrototypes?: readonly AgentPrototype[];
  /** Prototypes whose `connect` is patched. Defaults to the `net.Socket`
   *  prototype. */
  socketPrototypes?: readonly SocketPrototype[];
  /** Prototypes whose `onSocket` is patched. Defaults to the
   *  `http.ClientRequest` prototype. */
  requestPrototypes?: readonly RequestPrototype[];
}

/** An `onSocket`-bearing object: `http.ClientRequest.prototype` in
 *  production, a stand-in under test. */
type RequestPrototype = { onSocket?: unknown };

export interface NetGuard {
  /** The mode `PYRIC_GUARD` named. `warn` and `block` refuse the same requests. */
  readonly mode: GuardMode;
  /** The hosts `PYRIC_GUARD_ALLOW` and `permit` named. They change no verdict:
   *  nothing the guard refuses can be allowed (ADR 0022, ruling 3). */
  readonly allow: readonly string[];
  /** Record one more host, given bare or as a URL. Kept for the Vite plugin's
   *  AI upstream; it changes no verdict. */
  permit(hostOrUrl: string): void;
  /** Re-wrap the global dispatcher if something replaced it (a future Next
   *  calling `setGlobalDispatcher` would otherwise silently unhook us). */
  reassert(): void;
  /** Stop the periodic re-assert. Used by the CLI's own tests. */
  stop(): void;
}

/**
 * Where the register publishes the installed guard. A symbol on `globalThis`
 * rather than a module variable, because the Vite plugin can load its own copy
 * of this module from the app's `node_modules` while the register loaded
 * another from the CLI that launched the process.
 */
export const NET_GUARD_GLOBAL = Symbol.for('pyric.netGuard');

/**
 * Permit `hostOrUrl` on the guard installed in this process, if there is one.
 * A process with no guard (no `PYRIC_SANDBOX`, or `PYRIC_GUARD=off`) has
 * nothing to permit.
 */
export function permitGuardHost(hostOrUrl: string): void {
  const guard = (globalThis as unknown as Record<symbol, Pick<NetGuard, 'permit'> | undefined>)[NET_GUARD_GLOBAL];
  guard?.permit(hostOrUrl);
}

/** `basename(argv[1])`, the cheapest honest attribution available. */
export function contextFrom(argv: readonly string[] | undefined): string | undefined {
  const entry = argv?.[1];
  if (typeof entry !== 'string' || entry.length === 0) return undefined;
  const parts = entry.split(/[\\/]/);
  return parts[parts.length - 1] || undefined;
}

/**
 * Materialize undici's lazy global dispatcher without touching the network.
 * `new Headers()` loads Node's undici, whose module body installs a default
 * Agent into the symbol only if the slot is still empty, so this must run
 * before we put anything there. It also loads `_http_agent`, which is why the
 * socket patches go in first.
 */
function materializeGlobalDispatcher(): void {
  try {
    new Headers();
  } catch {
    // No WHATWG Headers, or a runtime that never had undici. The socket
    // backstop still applies.
  }
}

/**
 * Install the guard. Gated on `PYRIC_SANDBOX` exactly like the rest of the
 * register module: without the activator this is a no-op, so the module stays
 * safe to import anywhere. Returns `null` when nothing was installed.
 */
export function installNetGuard(hooks: NetGuardHooks = {}): NetGuard | null {
  const env = hooks.env ?? process.env;
  if (!env.PYRIC_SANDBOX) return null;

  const write = hooks.write ?? ((line: string) => void process.stderr.write(line));
  const mode = parseGuardMode(env.PYRIC_GUARD);

  if (mode === 'off') {
    write(
      `${LOG_PREFIX} disabled (PYRIC_GUARD=off): this process may request server-side ` +
        `Google access tokens, from the GCE metadata server too. Loads of the real firebase ` +
        `and firebase-admin still stop.\n`,
    );
    return null;
  }
  if (mode === 'warn') {
    write(
      `${LOG_PREFIX} PYRIC_GUARD=warn no longer lets token requests through: requests for a ` +
        `server-side Google access token are refused, as they are by default.\n`,
    );
  }

  const allow = parseAllowHosts(env.PYRIC_GUARD_ALLOW);
  const context = contextFrom(hooks.argv ?? process.argv);
  const reporterOptions: ReporterOptions = {
    mode,
    endpoints: tokenEndpointsFrom({ env }),
    write,
    context,
    reported: new Set(),
  };
  const installed = installEgressHooks(hooks, reporterOptions);

  return {
    mode,
    allow,
    permit(hostOrUrl: string): void {
      for (const host of parseAllowHosts(hostOrUrl)) {
        if (!allow.includes(host)) allow.push(host);
      }
    },
    reassert: installed.reassert,
    stop: installed.stop,
  };
}

/** The installed hooks of one guard. */
export interface EgressHooks {
  /** Re-wrap the global dispatcher if something replaced it. */
  reassert(): void;
  /** Stop the periodic re-assert. */
  stop(): void;
}

/**
 * Install the guard's hooks with `reporterOptions`: the socket backstop, the
 * request check and the undici dispatcher wrapper, in that order. The
 * register's guard and live mode's (`./live-net-guard.ts`) both install
 * through this, each with its own verdict.
 */
export function installEgressHooks(hooks: NetGuardHooks, reporterOptions: ReporterOptions): EgressHooks {
  const scope = hooks.scope ?? (globalThis as unknown as Record<symbol, unknown>);

  // ── socket backstop: http.request, gRPC, DB drivers, raw sockets ──
  //
  // This runs FIRST, before the dispatcher is materialized. Materializing
  // loads undici, which loads `_http_agent`, which snapshots
  // `net.createConnection` onto `http.Agent.prototype.createConnection`. With
  // the order reversed, that snapshot is the unpatched function and every
  // plain `http.request` escapes the guard, the metadata server included.
  const require = createRequire(import.meta.url);
  const netModule =
    hooks.net ?? (require('node:net') as { connect: ConnectFn; createConnection: ConnectFn });
  const tlsModule = hooks.tls ?? (require('node:tls') as { connect: ConnectFn });
  const reporter = createReporter(reporterOptions);

  const guardConnect = (target: { [k: string]: unknown }, name: string): void => {
    const original = target[name];
    if (typeof original !== 'function') return;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      for (const host of connectHosts(args)) reporter.check(host, 'socket');
      return (original as ConnectFn).apply(this, args);
    };
    target[name] = wrapped;
  };
  guardConnect(netModule as unknown as { [k: string]: unknown }, 'connect');
  guardConnect(netModule as unknown as { [k: string]: unknown }, 'createConnection');
  guardConnect(tlsModule as unknown as { [k: string]: unknown }, 'connect');
  // And the Agent prototypes, so a `node:http` that loaded before this module
  // is still covered. `https.Agent` also reaches the patched `tls.connect`, so
  // its own patch is a second check on the same egress; the once-per-host
  // dedupe keeps that from printing twice.
  for (const prototype of hooks.agentPrototypes ?? nodeAgentPrototypes()) {
    guardConnect(prototype as { [k: string]: unknown }, 'createConnection');
  }
  // And the Socket prototype, which every client connection reaches, so a
  // captured `net.connect` or a hand-built socket is checked too. A call
  // through the patched `net.connect` is checked twice; the dedupe keeps that
  // to one line.
  for (const prototype of hooks.socketPrototypes ?? nodeSocketPrototypes()) {
    guardConnect(prototype as { [k: string]: unknown }, 'connect');
  }
  // And the request a socket carries, whose path names a proxy's real
  // destination, or a token path on a host that serves other APIs too. The
  // socket itself sees only the host it reaches.
  for (const prototype of hooks.requestPrototypes ?? nodeClientRequestPrototypes()) {
    guardRequest(prototype, reporter);
  }

  const installed = new Map<symbol, Dispatcher>();
  const wrapGlobalDispatcher = (): void => {
    for (const slot of undiciDispatcherSlots(scope)) {
      const current = scope[slot];
      if (current === undefined || current === null) continue;
      if (current === installed.get(slot)) continue;
      if (typeof (current as Dispatcher).dispatch !== 'function') continue;
      // PLAIN ASSIGNMENT. undici's own property is
      // `configurable: false, writable: true`; a `defineProperty` that tries to
      // make it configurable throws and takes the process down.
      const wrapped = wrapDispatcher(current as Dispatcher, reporterOptions);
      installed.set(slot, wrapped);
      scope[slot] = wrapped;
    }
  };
  if (hooks.scope === undefined) materializeGlobalDispatcher();
  wrapGlobalDispatcher();

  let timer: ReturnType<typeof setInterval> | undefined;
  if (hooks.scope === undefined) {
    timer = setInterval(wrapGlobalDispatcher, REASSERT_INTERVAL_MS);
    // Never hold the event loop open: a guarded child must still exit.
    timer.unref?.();
  }

  return {
    reassert: wrapGlobalDispatcher,
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}

/**
 * Check what a request names before its request line is written: the
 * destination a request to a proxy names in its path, or else the request's
 * own host and path, which tell a token request to `www.googleapis.com` from
 * that host's other APIs. A refusal goes to `onSocket` as its error argument,
 * which is how Node fails a request whose socket could not be used: the
 * request emits `error` with the guard's error and the server receives
 * nothing. Throwing here instead would surface as an uncaught exception from
 * the Agent's callback.
 */
function guardRequest(prototype: RequestPrototype, reporter: Reporter): void {
  const original = prototype.onSocket;
  if (typeof original !== 'function') return;
  prototype.onSocket = function (this: RequestLike, socket: unknown, error?: unknown): unknown {
    if (error !== undefined) return original.call(this, socket, error);
    try {
      checkRequest(this, reporter);
    } catch (refusal) {
      return original.call(this, socket, refusal);
    }
    return original.call(this, socket, error);
  };
}

function checkRequest(request: RequestLike, reporter: Reporter): void {
  const target = proxiedTarget(request);
  if (target !== undefined) {
    reporter.check(target, 'socket');
    return;
  }
  const host = typeof request.host === 'string' ? request.host : undefined;
  const path = typeof request.path === 'string' ? request.path : undefined;
  reporter.check(host, 'socket', path);
}

/**
 * Every host a `net.connect` / `tls.connect` / `Socket.prototype.connect` /
 * `Agent.prototype.createConnection` call names, across their overloads:
 * `(options[, cb])`, `(port[, host][, cb])`, `(path[, cb])`, and the
 * `[options, cb]` array `net.connect` hands the socket once it has normalized
 * its own arguments. An IPC path or a portless local socket names no host,
 * which is exactly the "nothing to say" answer.
 *
 * The TCP peer is not the only host. A connection tunnelled through a proxy
 * names its real destination elsewhere, and each of those is checked too.
 */
function connectHosts(args: readonly unknown[]): string[] {
  const first = args[0];
  if (Array.isArray(first)) return connectHosts(first);
  if (typeof first === 'object' && first !== null) return optionHosts(first as ConnectOptions);
  const isPort = typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first));
  if (!isPort) return [];
  // (port, host?, ...): the host, when given, is the next string argument.
  const second = args[1];
  if (typeof second === 'string') return [second];
  if (typeof second === 'object' && second !== null) return optionHosts(second as ConnectOptions);
  return [];
}

/** The connect options the guard reads. */
interface ConnectOptions {
  host?: unknown;
  hostname?: unknown;
  /** The TLS SNI name: the real destination of a TLS session over a tunnel. */
  servername?: unknown;
}

function optionHosts(options: ConnectOptions): string[] {
  const named = [options.host ?? options.hostname, options.servername];
  return named.filter((host): host is string => typeof host === 'string' && host.length > 0);
}

/** The parts of an `http.ClientRequest` the guard reads. */
interface RequestLike {
  method?: unknown;
  path?: unknown;
  /** The host the request was made to: the proxy, for a request to a proxy. */
  host?: unknown;
}

/** Matches an absolute-form request target, `http://host/...`. */
const ABSOLUTE_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The destination a request to a proxy names in its path: the `host:port`
 * target of a `CONNECT`, or the URL of a forward-proxy request
 * (`GET http://host/...`). An ordinary request path names none.
 */
function proxiedTarget(request: RequestLike): string | undefined {
  if (typeof request.path !== 'string') return undefined;
  const isConnect = typeof request.method === 'string' && request.method.toUpperCase() === 'CONNECT';
  if (isConnect || ABSOLUTE_FORM.test(request.path)) return request.path;
  return undefined;
}
