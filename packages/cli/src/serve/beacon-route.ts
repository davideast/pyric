/**
 * `POST /__pyric/beacon`, the host half of the interception handshake.
 *
 * `@pyric/cli/register` posts here once per activated child, after its module
 * hooks and net-guard are installed. Receiving it is the only positive proof
 * the dev server has that `NODE_OPTIONS=--import @pyric/cli/register` actually
 * reached that process; everything else about the launch is an assumption. See
 * `register/beacon.ts` for why the child reports on two channels.
 *
 * Who may post, and why it is locked down
 * ---------------------------------------
 * The dev server is reachable from any page the developer happens to have
 * open, so an unauthenticated route here would let a web page disarm the
 * watchdog (post a beacon the launcher counts) and would let any page grow the
 * server's memory with an unbounded body. Four checks close that, in order:
 *
 *  1. `content-type: application/json`. A cross-origin page cannot send that
 *     header on a POST without a CORS preflight, and this server answers no
 *     `OPTIONS` on this path, so the browser never sends the real request.
 *  2. No `Origin` header and no `Sec-Fetch-Mode: cors`. A browser attaches one
 *     or both to every cross-site request it makes; a Node child attaches
 *     neither.
 *  3. A per-launch secret in `x-pyric-beacon-token`, which the launcher put in
 *     the child's environment as `PYRIC_BEACON_TOKEN`. A page cannot read it.
 *  4. A 4 KB body cap. A report is under 200 bytes.
 *
 * Everything that passes those checks is still best-effort: a malformed body
 * gets 204 and is dropped, because the consequence of an absent beacon is a
 * warning on the parent side and must never be a failure on the child's.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BODY_TOO_LARGE_CODE, collectBody } from '../bridge/server/peer.js';
import { getHeader } from './server.js';
import { BEACON_TOKEN_HEADER, type BeaconReport } from '../register/beacon.js';

/** Largest beacon body accepted. A report is well under 200 bytes. */
export const BEACON_BODY_LIMIT_BYTES = 4_096;

export interface BeaconRouteOptions {
  /** The per-launch secret the child must present. */
  readonly token: string;
  /** Receives each accepted report. Absent means the route still 204s. */
  readonly onBeacon?: (report: BeaconReport) => void;
}

/** Constant-time string comparison over the token bytes. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Whether the request carries the browser markings of a cross-site fetch. */
function isBrowserOriginated(req: IncomingMessage): boolean {
  if (getHeader(req, 'origin') !== undefined) return true;
  return getHeader(req, 'sec-fetch-mode') === 'cors';
}

/** Whether the body is declared as JSON, the header a page cannot set without
 *  a preflight this server never answers. */
function declaresJsonBody(req: IncomingMessage): boolean {
  const contentType = getHeader(req, 'content-type');
  if (contentType === undefined) return false;
  return contentType.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

/**
 * Read a beacon body defensively. It is JSON off a socket, and the only fields
 * that matter are the ones the parent reports. `null` for anything that does
 * not carry a plausible report.
 */
export function parseBeaconReport(value: unknown): BeaconReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.pid !== 'number' || !Number.isFinite(raw.pid)) return null;
  const guard = raw.guard;
  if (guard !== 'warn' && guard !== 'block' && guard !== 'off') return null;
  if (typeof raw.hooks !== 'boolean') return null;
  return {
    pid: raw.pid,
    guard,
    hooks: raw.hooks,
    sandbox: typeof raw.sandbox === 'string' ? raw.sandbox : '',
  };
}

/** The one terminal line confirming a child is interlocked. A beacon that
 *  reports `hooks: false` is the interesting case: the child is running the
 *  register module, and it is telling us the rewrite did not install. */
export function formatBeaconReceipt(report: BeaconReport): string {
  if (!report.hooks) {
    return (
      `  ⚠ interlock pid=${report.pid}: register loaded but module hooks did NOT install. ` +
      `That process's firebase-admin/firebase imports are NOT routed to the sandbox ` +
      `(Node >= 22.15 is required for full coverage). Net-guard mode ${report.guard}.`
    );
  }
  return `  ⓘ interlock pid=${report.pid}: sandbox interception confirmed live (guard=${report.guard})`;
}

/** Handle `POST /__pyric/beacon`. */
export async function handleBeacon(
  opts: BeaconRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end('method not allowed');
    return;
  }
  if (!declaresJsonBody(req)) {
    res.writeHead(415, { 'content-type': 'text/plain' }).end('Unsupported Media Type');
    return;
  }
  if (isBrowserOriginated(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: browser origin');
    return;
  }
  if (!tokenMatches(getHeader(req, BEACON_TOKEN_HEADER), opts.token)) {
    res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid beacon token');
    return;
  }
  let body: unknown;
  try {
    body = await collectBody(req, BEACON_BODY_LIMIT_BYTES);
  } catch (err) {
    if ((err as { code?: string }).code === BODY_TOO_LARGE_CODE) {
      res.writeHead(413, { 'content-type': 'text/plain' }).end('Payload Too Large');
      return;
    }
    // Malformed JSON: drop it. Proof-of-life is a side channel.
    res.writeHead(204).end();
    return;
  }
  const report = parseBeaconReport(body);
  if (report !== null) opts.onBeacon?.(report);
  res.writeHead(204).end();
}
