/**
 * Discovery of a RUNNING `pyric dev --bridge` — shared by the stdio MCP
 * proxy (`cli/mcp-proxy.ts`) and the Node remote-sandbox client
 * (`remote/index.ts`). Extracted here so both speak the SAME pointer +
 * identity-pinning rules instead of drifting copies.
 *
 * Strategy: the `.pyric/serve.json` pointer serve writes in the project cwd
 * first, then a health probe across the scan window as a fallback. The
 * canonical pointer directory is returned for endpoint verification; copying
 * a pointer does not establish project ownership. If no serve is found, or the
 * pointed server's identity can't be matched, callers get `null` (plus a
 * `log` diagnostic).
 *
 * IDENTITY — the discovery pointer records the bridge's `instanceId`; a
 * server is accepted only if its `/__pyric/health` reports the SAME id. Two
 * sandboxes can collide on one port across loopback families (IPv4 `*:P` +
 * `[::1]:P`); without this, a client locks onto whichever family answers
 * first while the browser is on the other — split-brain.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getJsonWithin } from '../bounded-request.js';

/** Ports probed when the pointer is absent — serve's default scan window PLUS
 *  the standard Vite dev ports (5173-5177), which the plain 3473+ window would miss
 *  (so a vite-only or monorepo split-directory project is reliably found by scan).
 *  The standalone `pyric bridge` serves `/health` (not `/__pyric/health`) and
 *  writes no pointer, so it is registered directly via `claude mcp add`, not discovered here. */
export const SCAN_PORTS = [3473, 3474, 3475, 3476, 3477, 5173, 5174, 5175, 5176, 5177];
export const POINTER = join('.pyric', 'serve.json');

function candidatePointerPaths(startDir: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const subdirs = ['', 'web', 'frontend', 'client', 'app', 'ui', 'www'];
  let current = resolve(startDir);
  while (true) {
    for (const sub of subdirs) {
      const p = sub ? join(current, sub, POINTER) : join(current, POINTER);
      if (!seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

export interface HealthLite {
  mode?: string;
  instanceId?: string;
  /** Whether a browser tab is currently connected as the sandbox peer. */
  sandboxConnected?: boolean;
}

export interface Discovered {
  /** Canonical directory containing the discovered .pyric/serve.json; absent for a port scan. */
  pointerProjectDir?: string;
  mcpUrl: string;
  /**
   * The CANONICAL display URL — what a human/browser should OPEN. Comes from
   * the serve-written pointer when present (`http://localhost:<port>` for the
   * default host, the explicit `--host` otherwise); falls back to
   * `http://localhost:<port>`. NEVER a literal loopback address: to a browser
   * `localhost` and `127.0.0.1` are DIFFERENT ORIGINS (different
   * SharedWorkers, so different sandboxes), and serve's banner/auto-open use
   * `localhost` — guidance built from this field must land on the SAME origin.
   * Node-side connectivity uses `base`/`mcpUrl` instead.
   */
  url: string;
  /** `http://<family>:<port>` the server actually answered on. */
  base: string;
  /** Identity pinned at discovery. Null only when talking to an older server
   *  that predates the instanceId field (matching is then skipped). */
  instanceId: string | null;
  source: string;
}

/**
 * Probe BOTH loopback families on a port and return the base that answers.
 *
 * Hostname-based URLs are a trap here: serve writes `http://localhost:...`
 * for humans (browsers dual-stack fine), but `localhost` resolution differs
 * by runtime — node/undici prefers IPv6 `::1`, and a serve under one runtime
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

/** A sandbox bridge's health at `base`, or `null`. Bounded by
 *  {@link HEALTH_PROBE_DEADLINE_MS} and leaves no socket behind (#1162). */
export async function probeHealth(base: string): Promise<HealthLite | null> {
  const response = await getJsonWithin(`${base}/__pyric/health`, HEALTH_PROBE_DEADLINE_MS);
  if (response === null) return null;
  const body = response.body as HealthLite | null;
  const isSandbox = typeof body === 'object' && body !== null && body.mode === 'sandbox';
  return isSandbox ? body : null;
}

/**
 * First loopback base on `port` whose health reports a sandbox bridge. With an
 * `expectedInstanceId`, returns ONLY a family whose health identity matches —
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

/** What answered on a port's loopback families. */
interface PortProbe {
  /** The family that answered as the expected sandbox, or `null`. */
  match: AnsweringHost | null;
  /** Whether a sandbox with another identity answered. */
  otherAnswered: boolean;
}

async function probePort(port: number, expectedInstanceId?: string | null): Promise<PortProbe> {
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

/** Best-effort port extraction from a pointer url/mcpUrl. */
function portOf(u: string | undefined): number | null {
  const m = u?.match(/:(\d{2,5})(?:\/|$)/);
  return m ? Number(m[1]) : null;
}

/**
 * Canonical display URL for a serve on `port`. Prefers the pointer's own
 * `url` (serve writes `http://<requested host>:<port>` — `localhost` for the
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
      /* malformed pointer url — fall through to the localhost default */
    }
  }
  return `http://localhost:${port}`;
}

/**
 * The host a command may attach to: one found through the project's
 * `.pyric/serve.json` pointer. A server found only by the port scan may belong
 * to another project, so it is logged as unattached and not returned. Every
 * command that attaches to a running host selects it through this function.
 */
export function selectProjectHost(
  discovered: Discovered | null,
  log: (m: string) => void,
): Discovered | null {
  if (discovered === null) return null;
  const foundByPointer = discovered.source.startsWith('pointer');
  if (foundByPointer) return discovered;
  log(
    `a sandbox server is answering at ${discovered.base} (${discovered.source}), but no ` +
      '.pyric/serve.json in this project names it, so it is not attached to. Start `pyric serve` ' +
      'from this project to write the pointer, or ignore the server if it belongs to another project.',
  );
  return null;
}

/** A host that answered a health probe: the base it answered on and its identity. */
export interface AnsweringHost {
  base: string;
  instanceId: string | null;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Health-probe an explicit host URL. A loopback URL is probed on both loopback
 * families by port, as discovery does, because `localhost` resolves to
 * different families under different runtimes. Any other URL is probed as given.
 */
export async function probeHostUrl(url: string): Promise<AnsweringHost | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const isLoopback = LOOPBACK_HOSTNAMES.has(parsed.hostname);
  if (isLoopback) return healthyBase(urlPort(parsed));
  const base = `${parsed.protocol}//${parsed.host}`;
  const health = await probeHealth(base);
  if (health === null) return null;
  return { base, instanceId: health.instanceId ?? null };
}

/** The port a URL names, or its scheme's default when it names none. */
function urlPort(parsed: URL): number {
  const defaultPort = parsed.protocol === 'https:' ? 443 : 80;
  return parsed.port === '' ? defaultPort : Number(parsed.port);
}

/**
 * Whether `url` reaches the project's host: the same port on loopback, where
 * `localhost` and either loopback address name one server, as
 * {@link probeHostUrl} probes them; otherwise the same origin.
 */
function urlNamesHost(url: string, host: Discovered): boolean {
  let wanted: URL;
  let found: URL;
  try {
    wanted = new URL(url);
    found = new URL(host.base);
  } catch {
    return false;
  }
  const bothLoopback = LOOPBACK_HOSTNAMES.has(wanted.hostname) && LOOPBACK_HOSTNAMES.has(found.hostname);
  if (bothLoopback) return urlPort(wanted) === urlPort(found);
  return wanted.origin === found.origin;
}

/** How an explicit `PYRIC_SANDBOX=remote:<url>` resolves. */
export type ExplicitHostChoice =
  /** The URL answers as this project's host: attach there. */
  | { kind: 'explicit'; serveUrl: string; base: string }
  /** The URL is stale or names another host, and this project has a running
   *  host: attach to that one, after showing `notice` once. */
  | { kind: 'project'; host: Discovered; notice: string }
  /** Nothing answers at the URL and this project has no running host. */
  | { kind: 'stale'; message: string }
  /** A host answers at the URL, but nothing ties it to this project. */
  | { kind: 'refused'; message: string };

/**
 * Resolve an explicit host URL against the project's own host.
 *
 * The URL is used when the host answering there is the one this project's
 * `.pyric/serve.json` names, or the one the launcher that set the URL pinned
 * (`launcherInstanceId`, from `PYRIC_SANDBOX_INSTANCE`). Otherwise the URL is
 * stale or belongs to another project: the project's own host is used when one
 * is running, and the result says why the URL was passed over. A host found
 * only at the URL is never attached to, by the same rule as
 * {@link selectProjectHost}.
 */
export async function selectExplicitHost(input: {
  url: string;
  cwd: string;
  launcherInstanceId?: string;
  discover?: (cwd: string) => Promise<Discovered | null>;
  probe?: (url: string) => Promise<AnsweringHost | null>;
}): Promise<ExplicitHostChoice> {
  const serveUrl = input.url.replace(/\/$/, '');
  const setting = `PYRIC_SANDBOX=remote:${serveUrl}`;
  const answered = await (input.probe ?? probeHostUrl)(serveUrl);
  const answeredId = answered?.instanceId ?? null;
  const launcherId = input.launcherInstanceId;
  const isLauncherHost = answered !== null && launcherId !== undefined && launcherId !== '' && answeredId === launcherId;
  if (isLauncherHost) return { kind: 'explicit', serveUrl, base: answered.base };

  const project = selectProjectHost(await (input.discover ?? discoverServe)(input.cwd), () => {});
  const isProjectHost = answered !== null && project !== null && answeredId !== null && answeredId === project.instanceId;
  if (isProjectHost) return { kind: 'explicit', serveUrl, base: answered.base };
  // The probe found nothing, and discovery, a moment later, found this
  // project's host at the same url: the host was starting or restarting
  // between the two, so the url is current, not stale (#1527).
  const projectAnswersAtUrl = answered === null && project !== null && urlNamesHost(serveUrl, project);
  if (projectAnswersAtUrl) return { kind: 'explicit', serveUrl, base: project.base };

  const portable = 'Set PYRIC_SANDBOX=remote to find this project\'s host through .pyric/serve.json.';
  if (project !== null) {
    const why = answered === null
      ? 'nothing answers there'
      : 'the host answering there is not the host this project\'s .pyric/serve.json names';
    return {
      kind: 'project',
      host: project,
      notice: `${setting} is stale: ${why}. Using this project's running host at ${project.url}. ${portable}`,
    };
  }
  if (answered === null) {
    return {
      kind: 'stale',
      message:
        `${setting} is stale: nothing answers there, and no running \`pyric sandbox\` for this ` +
        `project was found through .pyric/serve.json in ${input.cwd}. Start \`pyric sandbox\` ` +
        `in this project. ${portable}`,
    };
  }
  return {
    kind: 'refused',
    message:
      `${setting} names a running sandbox host, but no .pyric/serve.json in ${input.cwd} names it, ` +
      'so it is not attached to: it may belong to another project. Start `pyric sandbox` in this ' +
      `project. ${portable}`,
  };
}

/** Whether the process a pointer names is still running. A pointer without a
 *  pid cannot be checked and counts as live. */
function isPointerProcessAlive(pid: unknown): boolean {
  const hasPid = typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
  if (!hasPid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as { code?: string }).code === 'EPERM';
  }
}

/**
 * Whether a project's `.pyric/serve.json` names another host that is still
 * running, so a server starting in the same project must not replace it.
 * The pointer is held only when it names a different instance and a live pid
 * other than this process: a pointer without a pid, or one this process wrote
 * for an earlier mount (a Vite restart), can be replaced, so a stale pointer
 * never locks discovery out.
 */
export function pointerHeldByAnotherHost(pointer: { pid?: unknown; instanceId?: unknown }, instanceId: string): boolean {
  if (pointer.instanceId === instanceId) return false;
  const pid = pointer.pid;
  const hasPid = typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
  if (!hasPid || pid === process.pid) return false;
  return isPointerProcessAlive(pid);
}

/**
 * The display URL the project's `.pyric/serve.json` records, read without a
 * health probe, for callers that must resolve synchronously. A pointer whose
 * writing process has exited is skipped. `null` when no live pointer is found
 * from `cwd`.
 */
export function readProjectPointerUrl(cwd: string): string | null {
  for (const pointerPath of candidatePointerPaths(cwd)) {
    const hasPointerFile = existsSync(pointerPath);
    if (!hasPointerFile) continue;
    try {
      const p = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
        url?: string;
        mcpUrl?: string;
        port?: number;
        pid?: number;
      };
      const isLeftOver = !isPointerProcessAlive(p.pid);
      if (isLeftOver) continue;
      const port = p.port ?? portOf(p.mcpUrl) ?? portOf(p.url);
      const hasPort = port !== null && Boolean(port);
      if (hasPort) return canonicalServeUrl(port, p.url);
    } catch {
      /* corrupt pointer: try the next candidate */
    }
  }
  return null;
}

/**
 * How long discovery waits for the host a pointer names when the pointer's
 * process is running but nothing answers on its port: a dev server that is
 * restarting, or one whose event loop is busy past the one-second health
 * probe. Not answering is not the same as gone (#1527). It matches how long
 * the Node remote client holds calls for a host that dropped its connection.
 */
const LIVE_POINTER_WAIT_MS = 10_000;
const LIVE_POINTER_POLL_MS = 250;

interface ServePointer {
  url?: string;
  mcpUrl?: string;
  port?: number;
  pid?: unknown;
  instanceId?: string;
}

type PointerOutcome =
  | { kind: 'found'; host: Discovered }
  /** Nothing answered as the pointer's host. `waits` when its process still runs and nothing else holds the port. */
  | { kind: 'unanswered'; port: number; expectedId: string | null; waits: boolean }
  /** No pointer here, or one discovery cannot use. */
  | { kind: 'unusable' };

function readPointer(pointerPath: string): ServePointer | null {
  const hasPointerFile = existsSync(pointerPath);
  if (!hasPointerFile) return null;
  try {
    return JSON.parse(readFileSync(pointerPath, 'utf8')) as ServePointer;
  } catch {
    return null; // corrupt, or caught mid-write: try the next candidate
  }
}

/** Whether a pointer records a pid and that process is running. */
function hasRunningProcess(pid: unknown): boolean {
  const hasPid = typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
  return hasPid && isPointerProcessAlive(pid);
}

/** One look at the host the pointer at `pointerPath` names. */
async function probePointer(pointerPath: string): Promise<PointerOutcome> {
  const p = readPointer(pointerPath);
  if (p === null) return { kind: 'unusable' };
  const port = p.port ?? portOf(p.mcpUrl) ?? portOf(p.url);
  const hasPort = port !== null && Boolean(port);
  if (!hasPort) return { kind: 'unusable' };
  const hasExpectedId = typeof p.instanceId === 'string' && p.instanceId !== '';
  const expectedId = hasExpectedId ? p.instanceId ?? null : null;
  const probe = await probePort(port, expectedId);
  const match = probe.match;
  if (match === null) {
    const waits = !probe.otherAnswered && hasRunningProcess(p.pid);
    return { kind: 'unanswered', port, expectedId, waits };
  }
  let pointerProjectDir: string;
  try {
    pointerProjectDir = realpathSync(dirname(dirname(pointerPath)));
  } catch {
    return { kind: 'unusable' }; // the pointer's directory went away
  }
  return {
    kind: 'found',
    host: {
      pointerProjectDir,
      mcpUrl: `${match.base}/__pyric/mcp`,
      url: canonicalServeUrl(port, p.url),
      base: match.base,
      instanceId: match.instanceId,
      source: `pointer ${pointerPath}`,
    },
  };
}

/**
 * The host the pointer names, waiting up to {@link LIVE_POINTER_WAIT_MS} while
 * its process runs and nothing answers. The pointer is read again each time,
 * since a restarted dev server rewrites it.
 */
async function waitForPointerHost(pointerPath: string): Promise<PointerOutcome> {
  const deadline = Date.now() + LIVE_POINTER_WAIT_MS;
  let outcome = await probePointer(pointerPath);
  while (outcome.kind === 'unanswered' && outcome.waits && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LIVE_POINTER_POLL_MS));
    outcome = await probePointer(pointerPath);
  }
  return outcome;
}

/** Find the running serve: pointer first (in `cwd`), then a port scan. The
 *  pointer gives the PORT and (when present) the identity; the family is
 *  resolved by probing, so the returned base always uses the address the
 *  server is actually reachable on. */
export async function discoverServe(
  cwd: string,
  log: (m: string) => void = () => {},
  // Injectable so discovery can be tested hermetically — the default scan probes
  // real localhost ports, which a test environment can't guarantee are free.
  scanPorts: number[] = SCAN_PORTS,
): Promise<Discovered | null> {
  for (const pointerPath of candidatePointerPaths(cwd)) {
    const outcome = await waitForPointerHost(pointerPath);
    if (outcome.kind === 'found') return outcome.host;
    // The pointer named a specific identity we could NOT find on its port:
    // a different sandbox may be squatting it (cross-family collision) or
    // the server stopped. Do NOT scan into a possibly-wrong server — that
    // split-brain is exactly what this identity check prevents. Fail legibly.
    if (outcome.kind === 'unusable') continue;
    const expectedId = outcome.expectedId;
    const pinsInstance = expectedId !== null;
    if (pinsInstance) {
      log(
        `pointer ${pointerPath} names a server (instanceId ${expectedId.slice(0, 8)}…) ` +
          `that isn't answering on port ${outcome.port} — another sandbox may be squatting the ` +
          `port on the other loopback family, or the server stopped. Not falling back to ` +
          `a blind port scan (it could hit the wrong sandbox). Restart your dev server, ` +
          `and open the exact URL it prints (http://localhost:<port> by default) — every ` +
          `page must share that ONE origin, or the browser splits into separate sandboxes.`,
      );
      return null;
    }
  }
  for (const port of scanPorts) {
    const hit = await healthyBase(port);
    const foundByScan = hit !== null;
    if (foundByScan) {
      return {
        mcpUrl: `${hit.base}/__pyric/mcp`,
        url: canonicalServeUrl(port),
        base: hit.base,
        instanceId: hit.instanceId,
        source: `port scan (:${port})`,
      };
    }
  }
  return null;
}
