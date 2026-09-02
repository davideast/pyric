/**
 * The runtime network guard: the enforcement half of the production-leak
 * invariant.
 *
 * A sandboxed app's Firebase traffic all routes to the local `/__pyric/*`
 * namespace. So a pyric-launched process that opens a connection to a real
 * Google/Firebase endpoint has escaped the sandbox: it is reading or writing
 * live production data with the developer believing otherwise. This module
 * detects that egress and, depending on one knob, warns about it or fails it.
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
 * 2. `net.connect` / `net.createConnection` / `tls.connect`, plus the
 *    `createConnection` on the `http.Agent` and `https.Agent` prototypes: the
 *    backstop for traffic that never goes through undici, such as
 *    `http.request`, gRPC, database drivers, anything holding a raw socket.
 *    Same catalog, same policy. (undici itself connects through `net.connect`,
 *    so a warn-mode fetch would report twice; the once-per-host dedupe below
 *    collapses that.)
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
 * Policy
 * ------
 * One knob, `PYRIC_GUARD=warn|block|off`, default `warn`:
 *   warn   report the egress, let it through
 *   block  report it and fail the request
 *   off    no hooks at all, one notice line at install time
 * The GCE metadata IP (`169.254.169.254`, `alwaysBlock` in the catalog) is
 * refused in warn mode and cannot be allowlisted, since its only use from a
 * dev process is credential theft. `off` is genuinely off, metadata IP
 * included; the off notice says so out loud.
 *
 * A blocked fetch surfaces to app code as a bare `TypeError: fetch failed`
 * (the reason is buried on `error.cause`), so the guard must log its own
 * denial: the app's error will never explain itself.
 *
 * The allowlist seam
 * ------------------
 * `PYRIC_GUARD_ALLOW` is a comma/whitespace separated list of hosts or URLs,
 * matched on label boundaries, permitting an otherwise-flagged catalog host
 * (an allowlisted hit is still reported once). Env is the seam by design:
 *   - the AI engine baseUrls live in the user's Vite config
 *     (`PyricAiOptions.engine.baseUrl`, `serve/vite-ai-config.ts`), which is
 *     read by the Vite plugin inside the serve host, a different process from
 *     the one this module loads into, and not parsed by the CLI at all;
 *   - `pyric.json` is read asynchronously by `runServe` (`cli/pyric-config.ts`)
 *     and this module runs on the `--import` hot path of every child, where a
 *     synchronous config-file read has no business being.
 * `cli/sandbox-runner.ts:buildChildEnv` spreads the parent env into the child,
 * so anything the pyric process exports reaches every descendant for free
 * (`NODE_OPTIONS` already propagates the register import the same way). To
 * wire a `pyric.json` `guardAllow` through, the whole change is: add the field
 * to `PyricConfig`, and have `buildChildEnv` set `PYRIC_GUARD_ALLOW` from it
 * at the `cli/serve.ts` call site, where `pyricConfig` is already in scope.
 *
 * Bun and Deno are out of scope: neither evaluates Node loader hooks (the
 * register module never loads there) and neither routes `fetch` through
 * undici's global dispatcher. `installNetGuard` degrades to the socket
 * backstop instead of throwing.
 */
import { createRequire } from 'node:module';
import {
  lookupGoogleEndpoint,
  matchesHostSuffix,
  normalizeHostname,
  type GoogleEndpoint,
} from '../google-endpoints.js';

/** undici's global-dispatcher slot. Version-suffixed by undici itself. */
const UNDICI_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

/** Marks a rejection as the guard's, so callers can tell it from a DNS/TLS
 *  failure. A blocked `fetch` only exposes it as `error.cause.code`. */
export const GUARD_BLOCKED_CODE = 'PYRIC_GUARD_BLOCKED';

const LOG_PREFIX = '@pyric/cli/register: net-guard';

/** How often to check that nobody replaced the global dispatcher under us. */
const REASSERT_INTERVAL_MS = 5_000;

export type GuardMode = 'warn' | 'block' | 'off';

/** What the guard decided about one outbound connection. */
export interface EgressVerdict {
  /** `warn` reported-and-permitted, `block` refused, `allow` allowlisted. */
  readonly verdict: 'warn' | 'block' | 'allow';
  /** Whether the connection may proceed. */
  readonly permitted: boolean;
  /**
   * The hostname actually being contacted, which is what the developer needs
   * in order to find the call. Not the catalog suffix: `cloudfunctions.net`
   * does not tell you which region or project a callable went to.
   */
  readonly host: string;
  /** The catalog suffix that matched (`host` when the match was exact). */
  readonly endpoint: string;
  /** Human service label, verbatim from the shared catalog. */
  readonly service: string;
  /** Present only for catalog entries that can never be a false positive. */
  readonly alwaysBlock?: true;
}

/** `PYRIC_GUARD` → mode. Unset, empty or unrecognised all mean the safe
 *  default: report, do not break the developer's app. */
export function parseGuardMode(raw: string | undefined): GuardMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'block') return 'block';
  if (value === 'off') return 'off';
  return 'warn';
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

/** Only a trailing `:port` is stripped; a bare IPv6 address is left alone. */
const HOST_WITH_PORT = /^(.+):\d+$/;

/**
 * Best-effort hostname from a host, `host:port`, or full URL. Normalization
 * and suffix matching are the catalog's, so the guard and the catalog can
 * never disagree about what a hostname is.
 */
function hostnameOf(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('://')) {
    try {
      return normalizeHostname(new URL(trimmed).hostname).replace(/^\[|\]$/g, '');
    } catch {
      // Not a parseable URL: fall through to the textual forms.
    }
  }
  const withoutPath = trimmed.split('/')[0] ?? trimmed;
  const portMatch = HOST_WITH_PORT.exec(withoutPath);
  let hostPart: string;
  if (portMatch === null) {
    hostPart = withoutPath;
  } else {
    hostPart = portMatch[1]!;
  }
  return normalizeHostname(hostPart);
}

/**
 * The whole verdict, pure: catalog lookup, then `alwaysBlock`, then the
 * allowlist, then the mode. `null` means nothing to say: either not a
 * production endpoint, or the guard is off.
 */
export function evaluateEgress(
  hostname: string,
  policy: { mode: GuardMode; allow: readonly string[] },
): EgressVerdict | null {
  if (policy.mode === 'off') return null;
  const host = hostnameOf(hostname);
  if (host.length === 0) return null;
  const entry: GoogleEndpoint | undefined = lookupGoogleEndpoint(host);
  if (entry === undefined) return null;

  // `alwaysBlock` outranks both the mode and the allowlist: the metadata
  // server is never a legitimate destination for a sandboxed dev process, so
  // there is no configuration that should be able to permit it.
  if (entry.alwaysBlock === true) {
    return {
      verdict: 'block',
      permitted: false,
      host,
      endpoint: entry.host,
      service: entry.service,
      alwaysBlock: true,
    };
  }

  if (policy.allow.some((allowed) => matchesHostSuffix(host, allowed))) {
    return { verdict: 'allow', permitted: true, host, endpoint: entry.host, service: entry.service };
  }

  if (policy.mode === 'block') {
    return {
      verdict: 'block',
      permitted: false,
      host,
      endpoint: entry.host,
      service: entry.service,
    };
  }
  return { verdict: 'warn', permitted: true, host, endpoint: entry.host, service: entry.service };
}

/** One stderr line per verdict: structured (fixed leading fields, so it is
 *  greppable) and attributable (service + transport + initiating command).
 *  The request PATH is deliberately never logged: it carries ids and tokens. */
export function formatGuardLine(
  verdict: EgressVerdict,
  transport: 'fetch' | 'socket',
  context: string | undefined,
): string {
  let where = `via ${transport}`;
  if (context !== undefined && context.length > 0) where = `${where} from ${context}`;
  const head = `${LOG_PREFIX} ${verdict.verdict.toUpperCase()} ${verdict.host} (${verdict.service}) ${where}:`;
  const tail = 'Further attempts to this host are not logged.';
  if (verdict.verdict === 'allow') {
    return `${head} live production egress permitted by PYRIC_GUARD_ALLOW. ${tail}\n`;
  }
  if (verdict.verdict === 'warn') {
    return (
      `${head} LIVE production egress. A sandboxed app routes Firebase traffic to /__pyric/*, ` +
      `so this is reaching real data. Set PYRIC_GUARD=block to fail these requests instead. ${tail}\n`
    );
  }
  let why: string;
  if (verdict.alwaysBlock === true) {
    why = 'the credential metadata server is refused in every mode except PYRIC_GUARD=off';
  } else {
    why = 'live production egress refused (PYRIC_GUARD=block)';
  }
  // What the app actually observes differs by seam: undici swallows our throw
  // into the opaque `TypeError: fetch failed`, while a raw socket caller gets
  // the error itself. Say which, or the developer cannot connect the two.
  let surfaces: string;
  if (transport === 'fetch') {
    surfaces = `the caller sees \`TypeError: fetch failed\` with cause ${GUARD_BLOCKED_CODE}`;
  } else {
    surfaces = `the caller sees an error with code ${GUARD_BLOCKED_CODE}`;
  }
  return `${head} ${why}; ${surfaces}. ${tail}\n`;
}

function blockedError(verdict: EgressVerdict, transport: 'fetch' | 'socket'): Error {
  return Object.assign(
    new Error(
      `pyric net-guard blocked ${transport} egress to ${verdict.host} (${verdict.service}): ` +
        `this is LIVE production, not the pyric sandbox. ` +
        `Set PYRIC_GUARD=warn to allow it, or PYRIC_GUARD_ALLOW to permit this host.`,
    ),
    { code: GUARD_BLOCKED_CODE, host: verdict.host, service: verdict.service },
  );
}

// ─── the reporter: evaluate, log once, permit or refuse ───────────────────────

export interface ReporterOptions {
  readonly mode: GuardMode;
  readonly allow: readonly string[];
  readonly write?: (line: string) => void;
  /** Initiating command, for attribution. Usually `basename(argv[1])`. */
  readonly context?: string;
  /**
   * The shared "already reported" ledger. `installNetGuard` hands the SAME set
   * to the dispatcher wrapper and the socket backstop, because undici connects
   * through `net.connect`: a warn-mode fetch trips both seams and would
   * otherwise print the same host twice. It also survives a re-assert, so
   * being re-wrapped does not restart the noise.
   */
  readonly reported?: Set<string>;
}

interface Reporter {
  /** Returns the verdict, having logged it at most once per host, and throws
   *  when the verdict refuses the connection. */
  check(hostname: string | undefined, transport: 'fetch' | 'socket'): void;
}

function createReporter(options: ReporterOptions): Reporter {
  const write = options.write ?? ((line: string) => void process.stderr.write(line));
  const policy = { mode: options.mode, allow: options.allow };
  const reported = options.reported ?? new Set<string>();
  return {
    check(hostname, transport) {
      if (hostname === undefined) return;
      const verdict = evaluateEgress(hostname, policy);
      if (verdict === null) return;
      // A dev server retries relentlessly; one line per host is the signal,
      // and it also collapses the undici-over-net.connect double report.
      const key = `${verdict.verdict}:${verdict.host}`;
      if (!reported.has(key)) {
        reported.add(key);
        write(formatGuardLine(verdict, transport, options.context));
      }
      if (!verdict.permitted) throw blockedError(verdict, transport);
    },
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
    reporter.check(originHost(opts), 'fetch');
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
}

export interface NetGuard {
  readonly mode: GuardMode;
  readonly allow: readonly string[];
  /** Re-wrap the global dispatcher if something replaced it (a future Next
   *  calling `setGlobalDispatcher` would otherwise silently unhook us). */
  reassert(): void;
  /** Stop the periodic re-assert. Used by the CLI's own tests. */
  stop(): void;
}

/** `basename(argv[1])`, the cheapest honest attribution available. */
function contextFrom(argv: readonly string[] | undefined): string | undefined {
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
 * The `http.Agent` and `https.Agent` prototypes, or an empty list on a runtime
 * without them. Each carries its own `createConnection`: `http`'s is a copied
 * reference to `net.createConnection` snapshotted at `_http_agent` load time,
 * so patching `net` alone leaves it unguarded whenever `node:http` loaded
 * first.
 */
function nodeAgentPrototypes(): AgentPrototype[] {
  const require = createRequire(import.meta.url);
  const prototypes: AgentPrototype[] = [];
  for (const id of ['node:http', 'node:https']) {
    try {
      const mod = require(id) as { Agent?: { prototype?: unknown } };
      const prototype = mod.Agent?.prototype;
      if (typeof prototype === 'object' && prototype !== null) {
        prototypes.push(prototype as AgentPrototype);
      }
    } catch {
      // Runtime without that module: the other seams still apply.
    }
  }
  return prototypes;
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
      `${LOG_PREFIX} disabled (PYRIC_GUARD=off): egress from this process to live ` +
        `Google/Firebase endpoints is neither reported nor blocked, not even the GCE ` +
        `metadata server (169.254.169.254).\n`,
    );
    return null;
  }

  const allow = parseAllowHosts(env.PYRIC_GUARD_ALLOW);
  const context = contextFrom(hooks.argv ?? process.argv);
  const reporterOptions: ReporterOptions = { mode, allow, write, context, reported: new Set() };

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
      reporter.check(connectHost(args), 'socket');
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

  let installed: unknown;
  const wrapGlobalDispatcher = (): void => {
    const current = scope[UNDICI_GLOBAL_DISPATCHER];
    if (current === undefined || current === null) return;
    if (current === installed) return;
    if (typeof (current as Dispatcher).dispatch !== 'function') return;
    // PLAIN ASSIGNMENT. undici's own property is
    // `configurable: false, writable: true`; a `defineProperty` that tries to
    // make it configurable throws and takes the process down.
    installed = wrapDispatcher(current as Dispatcher, reporterOptions);
    scope[UNDICI_GLOBAL_DISPATCHER] = installed;
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
    mode,
    allow,
    reassert: wrapGlobalDispatcher,
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}

/**
 * Extract the destination host from `net.connect` / `tls.connect` arguments,
 * across all of their overloads: `(options[, cb])`, `(port[, host][, cb])`,
 * `(path[, cb])`. An IPC path or a portless local socket has no host, which is
 * exactly the "nothing to say" answer.
 */
function connectHost(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === 'object' && first !== null) {
    const host = (first as { host?: unknown; hostname?: unknown }).host ??
      (first as { hostname?: unknown }).hostname;
    return typeof host === 'string' ? host : undefined;
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    // (port, host?, ...): the host, when given, is the next string argument.
    const second = args[1];
    if (typeof second === 'string') return second;
    if (typeof second === 'object' && second !== null) {
      const host = (second as { host?: unknown }).host;
      return typeof host === 'string' ? host : undefined;
    }
  }
  return undefined;
}
