/**
 * The HANDSHAKE BEACON — register's proof that interception is LIVE in this
 * process.
 *
 * `pyric dev` sets `PYRIC_SANDBOX` and appends `--import @pyric/cli/register`
 * to the child's `NODE_OPTIONS`, and then… hopes. Every link in that chain is
 * silently breakable by the user's own command: a `bun`/`deno` runner that
 * never evaluates Node loader hooks, a script that overwrites `NODE_OPTIONS`
 * wholesale, a `NODE_ENV=production` that trips the activation refusal, an
 * intermediate process that strips the env. In every one of those cases the
 * child comes up looking perfectly healthy while its `firebase-admin` /
 * `firebase` imports resolve to the REAL SDKs and reach LIVE Firebase.
 *
 * The beacon closes that loop the only honest way: the child says so itself,
 * after the hooks and the net-guard are actually installed.
 *
 * ── Two channels, on purpose ──────────────────────────────────────────────
 * 1. A single structured stderr line, ALWAYS. `pyric dev` prefixes every
 *    child line with `[dev] `, so this is scrapeable even when nothing else
 *    is reachable — no server, no port, no network. It is the fallback that
 *    cannot fail.
 * 2. A fire-and-forget `POST <bridge>/__pyric/beacon`, whenever a bridge URL
 *    is knowable from the child's OWN env. That is the machine channel: it
 *    reaches the dev server across an arbitrary depth of intermediate
 *    processes (npm → next → worker), where stderr scraping stops being
 *    attributable.
 *
 * ── Where the bridge URL comes from ───────────────────────────────────────
 * `cli/sandbox-runner.ts:buildChildEnv` sets `PYRIC_SANDBOX=remote:<serveUrl>`
 * — the activator IS the address. Nothing else needs to be plumbed, and the
 * beacon works for any descendant that inherited the env, not just the direct
 * child. When the activator carries no URL (`PYRIC_SANDBOX=local`, or a
 * hand-set value), there is no endpoint and the line says `bridge=none`
 * rather than guessing.
 *
 * ── The POST must never be able to hurt the child ─────────────────────────
 * It is diagnostics. A refused connection, a 500, an unreachable host — every
 * one of those is swallowed, and the stderr line is written regardless.
 * `emitBeacon` is `void`, never awaited.
 *
 * It is sent over a raw `node:http` request — an unref'd socket under a hard
 * one-second bound (see {@link BEACON_TIMEOUT_MS}) — rather than `fetch`,
 * whose pending promise has neither knob. A short `node seed.js` child must
 * not sit around after finishing its work just to deliver a diagnostic. A
 * child that exits before the beacon lands simply loses the machine channel,
 * which is exactly why the watchdog on the other end is warn-only.
 *
 * The POST targets loopback, which is not in the shared Google endpoint
 * catalog, so it passes the net-guard installed moments earlier without a
 * verdict.
 */
import { createRequire } from 'node:module';
import type { GuardMode } from './net-guard.js';

/** The dev server route that receives beacons (`serve/namespace.ts`). */
export const BEACON_PATH = '/__pyric/beacon';

const LOG_PREFIX = '@pyric/cli/register: beacon';

/** What one activated child asserts about itself. Wire shape of the POST body
 *  and the fields of the stderr line, kept identical on purpose. */
export interface BeaconReport {
  /** The child's own pid — the only durable handle a parent has on it. */
  readonly pid: number;
  /** Net-guard mode actually in force in this process. */
  readonly guard: GuardMode;
  /** Whether module resolution hooks were installed. `false` means imports
   *  are NOT being rewritten, which is the whole thing worth knowing. */
  readonly hooks: boolean;
  /** The activator verbatim, so the parent can attribute the beacon. */
  readonly sandbox: string;
}

export interface BeaconHooks {
  readonly write?: (line: string) => void;
  /** Delivery seam for the machine channel. Defaults to
   *  {@link sendBeaconRequest}. */
  readonly send?: (endpoint: string, body: string) => void;
}

/**
 * The hard bound on how long a beacon may delay a child's exit.
 *
 * One second, because this is loopback: the bridge is the dev server that
 * launched us. If it has not accepted a connection in a second it is not
 * going to, and no diagnostic is worth more of the child's life than that.
 */
const BEACON_TIMEOUT_MS = 1_000;

/**
 * POST one beacon body, fire and forget, over an unref'd socket. See the
 * module header for why this is `node:http` and not `fetch`.
 */
export function sendBeaconRequest(endpoint: string, body: string): void {
  const require = createRequire(import.meta.url);
  const secure = endpoint.startsWith('https:');
  const http = require(secure ? 'node:https' : 'node:http') as {
    request: (url: string, options: unknown) => {
      on(event: string, listener: (arg: unknown) => void): unknown;
      destroy(): void;
      end(chunk: string): void;
    };
  };
  const req = http.request(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  });

  // ── The two mechanisms that keep a diagnostic from outliving its child ──
  //
  // Both are needed, and each covers what the other cannot. Measured against
  // a loopback address that blackholes the SYN (a firewall, a stale
  // `PYRIC_SANDBOX` from a dev server that is gone):
  //
  //   - `socket.unref()` does NOT release the loop while a CONNECT REQUEST is
  //     in flight — libuv holds it open for the pending request, not the
  //     handle. It earns its place only once the connect lands (a peer that
  //     accepts and then stalls).
  //   - `req.setTimeout()` does NOT bound the connect either: Node arms the
  //     socket's idle timer on the `connect` event, so against a blackhole a
  //     300 ms request timeout was observed firing at 5006 ms — when the
  //     KERNEL finally reset the connection, not when we asked.
  //
  // So the bound is an explicit UNREF'D timer that destroys the request. It
  // cannot hold the loop by itself, and it always gets to run, because the
  // pending connect is exactly what is keeping the loop alive.
  const abort = setTimeout(() => req.destroy(), BEACON_TIMEOUT_MS);
  abort.unref?.();
  const settle = (): void => clearTimeout(abort);

  req.on('socket', (socket) => {
    (socket as { unref?: () => void }).unref?.();
  });
  // A refused/reset connection is an expected outcome, not an error the child
  // should ever hear about.
  req.on('error', settle);
  req.on('close', settle);
  req.on('response', (res) => {
    (res as { resume?: () => void }).resume?.();
    settle();
  });
  req.end(body);
}

/**
 * The beacon endpoint implied by an activator value, or `null` when none is.
 * Accepts `remote:<url>` (what `buildChildEnv` writes) and a bare URL; any
 * non-http(s) scheme, and anything unparseable, is `null` — an unfetchable
 * guess is worse than an honest absence.
 */
export function beaconEndpoint(sandbox: string | undefined): string | null {
  if (sandbox === undefined) return null;
  const raw = sandbox.trim();
  if (raw.length === 0) return null;
  const value = raw.startsWith('remote:') ? raw.slice('remote:'.length).trim() : raw;
  if (value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return `${url.origin}${BEACON_PATH}`;
}

/**
 * One stderr line, structured the way net-guard's verdict lines are: fixed
 * leading fields first so it is greppable (`beacon ACTIVE pid= guard= hooks=
 * bridge=`), the human explanation after the em dash.
 */
export function formatBeaconLine(report: BeaconReport, endpoint: string | null): string {
  const head =
    `${LOG_PREFIX} ACTIVE pid=${report.pid} guard=${report.guard} ` +
    `hooks=${report.hooks ? 1 : 0} bridge=${endpoint ?? 'none'}`;
  const hooksNote = report.hooks
    ? 'firebase-admin/firebase imports in this process are rewritten to the pyric sandbox'
    : 'module hooks did NOT install, so firebase-admin/firebase imports in this process are NOT rewritten';
  return `${head} — ${hooksNote}, net-guard mode ${report.guard}.\n`;
}

/**
 * Emit the beacon on both channels. Never throws, never returns a promise:
 * the caller is the `--import` hot path of every pyric-launched process.
 */
export function emitBeacon(report: BeaconReport, hooks: BeaconHooks = {}): void {
  const write = hooks.write ?? ((line: string) => void process.stderr.write(line));
  const endpoint = beaconEndpoint(report.sandbox);
  write(formatBeaconLine(report, endpoint));
  if (endpoint === null) return;
  try {
    (hooks.send ?? sendBeaconRequest)(endpoint, JSON.stringify(report));
  } catch {
    // A runtime with no usable http module (or an endpoint that slipped the
    // URL parse) loses the machine channel only — the stderr line stands.
  }
}
