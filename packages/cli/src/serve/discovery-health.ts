import { boundedRequest, type BoundedResponse } from '../bounded-request.js';

/** Ports probed when the pointer is absent -- serve's default scan window PLUS
 *  the standard Vite dev ports (5173-5177), which the plain 3473+ window would miss
 *  (so a vite-only or monorepo split-directory project is reliably found by scan).
 *  The standalone `pyric bridge` serves `/health` (not `/__pyric/health`) and
 *  writes no pointer, so it is registered directly via `claude mcp add`, not discovered here. */
export const SCAN_PORTS = [3473, 3474, 3475, 3476, 3477, 5173, 5174, 5175, 5176, 5177];

export interface HealthLite {
  mode?: string;
  instanceId?: string;
  /** Whether a browser tab is currently connected as the sandbox peer. */
  sandboxConnected?: boolean;
}

/** A host that answered a health probe: the base it answered on and its identity. */
export interface AnsweringHost {
  base: string;
  instanceId: string | null;
}

/**
 * Probe BOTH loopback families on a port and return the base that answers.
 *
 * Hostname-based URLs are a trap here: serve writes `http://localhost:...`
 * for humans (browsers dual-stack fine), but `localhost` resolution differs
 * by runtime -- node/undici prefers IPv6 `::1`, and a serve under one runtime
 * may bind `127.0.0.1`-only while under another binds `::1`-only. So a
 * discovery client never trusts the hostname: it takes the PORT and tries
 * explicit `127.0.0.1` and `[::1]`, using whichever the server is actually on.
 */
export function basesForPort(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://[::1]:${port}`];
}

/** How long one health probe may take, connect included. Loopback answers in
 *  milliseconds; a port that has not answered in a second is not going to. */
const HEALTH_PROBE_DEADLINE_MS = 1000;

/**
 * What `/__pyric/health` at one base answered. A sandbox host answers 200 with
 * its health reply (`mode: 'sandbox'`), or 503 while its mount is closing
 * (`bridge-mount.ts`). Any other answer comes from a server that is not a
 * sandbox host: an in-page Vite server answers 404 to a JSON request.
 */
export type HealthAnswer =
  | { readonly kind: 'sandbox'; readonly health: HealthLite }
  | { readonly kind: 'no-answer' }
  | { readonly kind: 'other' };

const NO_HEALTH_ANSWER: HealthAnswer = { kind: 'no-answer' };
const OTHER_HEALTH_ANSWER: HealthAnswer = { kind: 'other' };

/** The health reply in a response, or `null` when the response is not one. */
function sandboxHealthOf(response: BoundedResponse): HealthLite | null {
  const isOk = response.status === 200;
  if (!isOk) return null;
  let body: unknown;
  try {
    body = JSON.parse(response.body.toString('utf8'));
  } catch {
    return null;
  }
  const health = body as HealthLite | null;
  const isSandbox = typeof health === 'object' && health !== null && health.mode === 'sandbox';
  if (!isSandbox) return null;
  return health;
}

/** Bounded by {@link HEALTH_PROBE_DEADLINE_MS} and leaves no socket behind (#1162). */
export async function healthAnswer(base: string): Promise<HealthAnswer> {
  const response = await boundedRequest(`${base}/__pyric/health`, {
    headers: { accept: 'application/json' },
    deadlineMs: HEALTH_PROBE_DEADLINE_MS,
  });
  if (response === null) return NO_HEALTH_ANSWER;
  const isClosingHost = response.status === 503;
  if (isClosingHost) return NO_HEALTH_ANSWER;
  const health = sandboxHealthOf(response);
  if (health === null) return OTHER_HEALTH_ANSWER;
  return { kind: 'sandbox', health };
}

/** A sandbox bridge's health at `base`, or `null`. Bounded by
 *  {@link HEALTH_PROBE_DEADLINE_MS} and leaves no socket behind (#1162). */
export async function probeHealth(base: string): Promise<HealthLite | null> {
  const answer = await healthAnswer(base);
  if (answer.kind === 'sandbox') return answer.health;
  return null;
}

/** What answered on a port's loopback families. */
export interface PortProbe {
  /** The family that answered as the expected sandbox, or `null`. */
  match: AnsweringHost | null;
  /** Whether a sandbox with another identity answered. */
  otherAnswered: boolean;
}

export async function probePort(port: number, expectedInstanceId?: string | null): Promise<PortProbe> {
  let otherAnswered = false;
  for (const base of basesForPort(port)) {
    const health = await probeHealth(base);
    if (!health) continue;
    const id = health.instanceId ?? null;
    // Healthy but the WRONG server (the cross-family squatter): skip, try next.
    const isOtherHost = Boolean(expectedInstanceId) && id !== expectedInstanceId;
    if (isOtherHost) {
      otherAnswered = true;
      continue;
    }
    return { match: { base, instanceId: id }, otherAnswered };
  }
  return { match: null, otherAnswered };
}

/**
 * First loopback base on `port` whose health reports a sandbox bridge. With an
 * `expectedInstanceId`, returns ONLY a family whose health identity matches --
 * so when two sandboxes collide on one port across families, the client locks
 * onto the one the pointer names, not merely the first to answer. (An older
 * server with no `instanceId` field can't be identity-checked; matching is
 * skipped in that case so the pointer still resolves.)
 */
export async function healthyBase(
  port: number,
  expectedInstanceId?: string | null,
): Promise<{ base: string; instanceId: string | null } | null> {
  return (await probePort(port, expectedInstanceId)).match;
}

/**
 * Canonical display URL for a serve on `port`. Prefers the pointer's own
 * `url` (serve writes `http://<requested host>:<port>` -- `localhost` for the
 * default, the explicit `--host` otherwise) so guidance shares the origin the
 * banner/auto-open used; falls back to `http://localhost:<port>` (browsers
 * resolve `localhost` dual-stack, so it reaches either loopback family).
 */
export function canonicalServeUrl(port: number, pointerUrl?: string): string {
  if (pointerUrl) {
    try {
      const u = new URL(pointerUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return `${u.protocol}//${u.host}`;
      }
    } catch {
      /* malformed pointer url -- fall through to the localhost default */
    }
  }
  return `http://localhost:${port}`;
}

export const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * What an explicit host URL's health probe found: a sandbox host; no answer,
 * which is worth waiting for; or a server that answers but is not a sandbox
 * host, which waiting will not change.
 */
export type HostUrlAnswer =
  | { readonly kind: 'host'; readonly host: AnsweringHost }
  | { readonly kind: 'no-answer' }
  | { readonly kind: 'not-a-host'; readonly base: string };

const NO_HOST_URL_ANSWER: HostUrlAnswer = { kind: 'no-answer' };

/** The port a URL names, or its scheme's default when it names none. */
export function urlPort(parsed: URL): number {
  const defaultPort = parsed.protocol === 'https:' ? 443 : 80;
  if (parsed.port === '') return defaultPort;
  return Number(parsed.port);
}

/**
 * The bases a host URL is probed on. A loopback URL is probed on both loopback
 * families by port, as discovery does, because `localhost` resolves to
 * different families under different runtimes. Any other URL is probed as given.
 */
function basesForHostUrl(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const isLoopback = LOOPBACK_HOSTNAMES.has(parsed.hostname);
  if (isLoopback) return basesForPort(urlPort(parsed));
  return [`${parsed.protocol}//${parsed.host}`];
}

/** Health-probe an explicit host URL on each of its bases; a sandbox host on any base wins. */
export async function probeHostUrlAnswer(url: string): Promise<HostUrlAnswer> {
  let notHostBase: string | null = null;
  for (const base of basesForHostUrl(url)) {
    const answer = await healthAnswer(base);
    if (answer.kind === 'sandbox') {
      return { kind: 'host', host: { base, instanceId: answer.health.instanceId ?? null } };
    }
    const isOtherServer = answer.kind === 'other';
    if (isOtherServer) notHostBase ??= base;
  }
  if (notHostBase === null) return NO_HOST_URL_ANSWER;
  return { kind: 'not-a-host', base: notHostBase };
}

/** Health-probe an explicit host URL: the sandbox host it reaches, or `null`. */
export async function probeHostUrl(url: string): Promise<AnsweringHost | null> {
  const answer = await probeHostUrlAnswer(url);
  if (answer.kind === 'host') return answer.host;
  return null;
}

/** Whether `base` serves Vite's client environment module, which every Vite dev server serves. */
export async function servesViteClient(base: string): Promise<boolean> {
  const response = await boundedRequest(`${base}/@vite/env`, { deadlineMs: HEALTH_PROBE_DEADLINE_MS });
  return response !== null && response.status === 200;
}
