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
 * 2. `net.connect` / `net.createConnection` / `tls.connect`, the
 *    `createConnection` on the `http.Agent` and `https.Agent` prototypes, and
 *    `net.Socket.prototype.connect`: the backstop for traffic that never goes
 *    through undici, such as `http.request`, gRPC, database drivers, anything
 *    holding a raw socket. Same catalog, same policy. (undici itself connects
 *    through `net.connect`, so a warn-mode fetch would report twice; the
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
 * 3. `http.ClientRequest.prototype.onSocket`, for a request to a proxy. The
 *    socket reaches only the proxy; the real destination is the `CONNECT`
 *    target or the absolute-form URL in the request's path, and the request is
 *    the only object that still carries its path. Likewise a TLS session over a
 *    tunnel names its destination only in `servername`, which the socket seams
 *    check beside `host`.
 *
 * Every host is compared in the catalog's one spelling (`normalizeHostname`),
 * which writes each IPv4 form the resolver accepts (`2852039166`,
 * `0xa9fea9fe`, `169.254.43518`) and each IPv4-mapped IPv6 address as a dotted
 * quad, so no respelling of the metadata IP gets past its entry. Worker
 * threads load the register too (`./worker-guard.js`).
 *
 * Policy
 * ------
 * One knob, `PYRIC_GUARD=warn|block|off`, default `warn`:
 *   warn   report the egress, naming the service it reached, and let it through
 *   block  report it and fail the request; only when the developer asks for it
 *   off    no hooks at all, one notice line at install time
 * Unset, empty and unrecognized values all mean `warn`. A process may talk to
 * the sandbox and to live production at once on purpose, so the guard's
 * default job is to say which system each request reached, never to refuse
 * it. Under `block`, the GCE metadata IP (`169.254.169.254`, `alwaysBlock` in
 * the catalog) is refused and cannot be allowlisted; under `warn` it is
 * reported like any other catalog host.
 *
 * A blocked fetch surfaces to app code as a bare `TypeError: fetch failed`
 * (the reason is buried on `error.cause`), so the guard must log its own
 * denial, naming the two ways to let the host through: the app's error will
 * never explain itself.
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
 * (`NODE_OPTIONS` already propagates the register import the same way).
 * `pyric sandbox` uses that seam for the AI upstream it resolves
 * (`serve/ai-proxy.ts:aiUpstreamGuardAllowance`): `buildChildEnv` appends it to
 * the child's `PYRIC_GUARD_ALLOW`, so a Vertex AI upstream keeps working under
 * `block`. A `pyric.json` `guardAllow` would take the same route: add the field
 * to `PyricConfig` and pass it to `buildChildEnv` at the `cli/serve.ts` call
 * site, where `pyricConfig` is already in scope.
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
import {
  describeCatalogHosts,
  describeGoogleHostSuffixes,
  describeMetadataServerHosts,
  lookupGoogleHost,
} from '../google-hosts.js';
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

export type GuardMode = 'warn' | 'block' | 'off';

/**
 * Which hosts the guard checks. `catalog` is the endpoint catalog, for every
 * mode. `google` is every Google host (`../google-hosts.ts`), which the
 * real-admin tripwire switches a guard to, together with `block` (#1475).
 */
export type GuardScope = 'catalog' | 'google';

/** What `evaluateEgress` decides by. `scope` defaults to `catalog`. */
export interface GuardPolicy {
  readonly mode: GuardMode;
  readonly allow: readonly string[];
  readonly scope?: GuardScope;
}

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
  /** Present only when the guard checks every Google host, after the tripwire. */
  readonly scope?: 'google';
}

/** `PYRIC_GUARD` → mode. Unset, empty or unrecognised all mean `warn`;
 *  `block` and `off` take effect only when named. */
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

/** `name:port`: one colon, so never a bare IPv6 address. */
const NAME_WITH_PORT = /^([^:]+):\d+$/;

/** `[v6]` or `[v6]:port`. */
const BRACKETED_HOST = /^\[([^\]]+)\](?::\d+)?$/;

/**
 * Best-effort hostname from a host, `host:port`, `[v6]:port`, or full URL.
 * Normalization and suffix matching are the catalog's, so the guard and the
 * catalog can never disagree about what a hostname is.
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

/**
 * The whole verdict, pure: catalog lookup, then `alwaysBlock`, then the
 * allowlist, then the mode. `null` means nothing to say: either not a
 * production endpoint, or the guard is off.
 */
export function evaluateEgress(hostname: string, policy: GuardPolicy): EgressVerdict | null {
  if (policy.mode === 'off') return null;
  const host = hostnameOf(hostname);
  if (host.length === 0) return null;
  const checksEveryGoogleHost = policy.scope === 'google';
  const lookup = checksEveryGoogleHost ? lookupGoogleHost : lookupGoogleEndpoint;
  const entry: GoogleEndpoint | undefined = lookup(host);
  if (entry === undefined) return null;
  const verdict = matchedVerdict(host, entry, policy);
  if (!checksEveryGoogleHost) return verdict;
  return { ...verdict, scope: 'google' };
}

/** The verdict for a host the policy's scope matched to `entry`. */
function matchedVerdict(host: string, entry: GoogleEndpoint, policy: GuardPolicy): EgressVerdict {

  // Under `block`, `alwaysBlock` outranks the allowlist: the metadata server
  // is refused whatever PYRIC_GUARD_ALLOW says. Under `warn` it is reported
  // like any other catalog host.
  const refusesAlways = entry.alwaysBlock === true && policy.mode === 'block';
  if (refusesAlways) {
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
  let remedy = '';
  if (verdict.alwaysBlock === true) {
    why = 'the credential metadata server is refused under PYRIC_GUARD=block, and no allowlist entry permits it';
  } else {
    why = 'live production egress refused';
    remedy = ` To reach it deliberately, ${guardRemedy(verdict)}.`;
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
  return `${head} ${why}; ${surfaces}.${remedy} ${tail}\n`;
}

/** The ways to let a refused host through, for the log line and the error
 *  alike: two for a catalog host, only the allowlist after the tripwire, whose
 *  escalation an explicit `PYRIC_GUARD=warn` does not undo. The metadata
 *  server has none. */
function guardRemedy(verdict: EgressVerdict): string {
  const isAfterTripwire = verdict.scope === 'google';
  if (isAfterTripwire) return `set PYRIC_GUARD_ALLOW=${verdict.host} to permit this host`;
  return (
    `set PYRIC_GUARD_ALLOW=${verdict.host} to permit this host, ` +
    `or PYRIC_GUARD=warn to report live egress without refusing it`
  );
}

function blockedError(verdict: EgressVerdict, transport: 'fetch' | 'socket'): Error {
  let remedy: string;
  if (verdict.alwaysBlock === true) {
    remedy = 'The credential metadata server is refused under PYRIC_GUARD=block, and no allowlist entry permits it.';
  } else {
    remedy = `To reach it deliberately, ${guardRemedy(verdict)}.`;
  }
  return Object.assign(
    new Error(
      `pyric net-guard blocked ${transport} egress to ${verdict.host} (${verdict.service}): ` +
        `this is LIVE production, not the pyric sandbox. ${remedy}`,
    ),
    { code: GUARD_BLOCKED_CODE, host: verdict.host, service: verdict.service },
  );
}

// ─── the reporter: evaluate, log once, permit or refuse ───────────────────────

export interface ReporterOptions extends GuardPolicy {
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
  const reported = options.reported ?? new Set<string>();
  return {
    check(hostname, transport) {
      if (hostname === undefined) return;
      // Read per check: an escalated guard (`NetGuard.escalate`) changes the mode and scope.
      const verdict = evaluateEgress(hostname, { mode: options.mode, allow: options.allow, scope: options.scope });
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
  /** The mode in force now; `escalate` can move it from `warn` to `block`. */
  readonly mode: GuardMode;
  readonly allow: readonly string[];
  /** The hosts the guard checks now; `escalate` can widen it to `google`. */
  readonly scope: GuardScope;
  /**
   * Move the guard to `block` for the rest of this process, checking `scope`'s
   * hosts, and write one line naming `reason` and what is now refused. It sets
   * `PYRIC_GUARD=block` in the environment, so processes started afterward
   * inherit `block`. Returns whether the mode or the scope changed; a guard
   * already there is left as it is, and says nothing.
   *
   * `withPyric` escalates to `catalog` in the Next dev server. The real-admin
   * tripwire escalates to `google` (#1443, #1475): a real `firebase-admin`
   * holding this machine's credentials reaches Google APIs no catalog lists.
   */
  escalate(reason: string, scope?: GuardScope): boolean;
  /** Permit one more host, given bare or as a URL, for the rest of this
   *  process. A launcher that learns a destination after install, such as the
   *  Vite plugin's configured AI upstream, names it here. */
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
  // One mode and scope for every seam, read on each check, so `escalate` reaches them all.
  const state: { mode: GuardMode; scope: GuardScope } = { mode, scope: 'catalog' };
  const reporterOptions: ReporterOptions = {
    get mode() {
      return state.mode;
    },
    get scope() {
      return state.scope;
    },
    allow,
    write,
    context,
    reported: new Set(),
  };

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
  // destination. The socket itself only reaches the proxy.
  for (const prototype of hooks.requestPrototypes ?? nodeClientRequestPrototypes()) {
    guardProxiedRequest(prototype, reporter);
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
    get mode() {
      return state.mode;
    },
    get scope() {
      return state.scope;
    },
    allow,
    escalate(reason: string, scope: GuardScope = 'catalog'): boolean {
      env.PYRIC_GUARD = 'block';
      const blocks = state.mode !== 'block';
      const widens = scope === 'google' && state.scope !== 'google';
      const changes = blocks || widens;
      if (!changes) return false;
      state.mode = 'block';
      if (widens) state.scope = 'google';
      write(escalationLine(reason, state.scope));
      return true;
    },
    permit(hostOrUrl: string): void {
      for (const host of parseAllowHosts(hostOrUrl)) {
        if (!allow.includes(host)) allow.push(host);
      }
    },
    reassert: wrapGlobalDispatcher,
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}

/** The line `escalate` writes: why, and exactly which hosts are now refused. */
function escalationLine(reason: string, scope: GuardScope): string {
  let refused: string;
  if (scope === 'google') {
    refused =
      `every connection to ${describeGoogleHostSuffixes()}, ` +
      `and to the GCE metadata server (${describeMetadataServerHosts()})`;
  } else {
    refused = `every connection to the hosts in its endpoint catalog (${describeCatalogHosts()})`;
  }
  return (
    `${LOG_PREFIX} escalated to block: ${reason}. This process now refuses ${refused}, ` +
    `with ${GUARD_BLOCKED_CODE}. PYRIC_GUARD_ALLOW permits a host on purpose, but never the metadata server. ` +
    `Processes started from now on inherit PYRIC_GUARD=block.\n`
  );
}

/**
 * Check the destination a request to a proxy names before its request line is
 * written. A refusal goes to `onSocket` as its error argument, which is how
 * Node fails a request whose socket could not be used: the request emits
 * `error` with the guard's error and the proxy receives nothing. Throwing here
 * instead would surface as an uncaught exception from the Agent's callback.
 */
function guardProxiedRequest(prototype: RequestPrototype, reporter: Reporter): void {
  const original = prototype.onSocket;
  if (typeof original !== 'function') return;
  prototype.onSocket = function (this: RequestLike, socket: unknown, error?: unknown): unknown {
    const target = proxiedTarget(this);
    if (target === undefined || error !== undefined) return original.call(this, socket, error);
    try {
      reporter.check(target, 'socket');
    } catch (refusal) {
      return original.call(this, socket, refusal);
    }
    return original.call(this, socket, error);
  };
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
