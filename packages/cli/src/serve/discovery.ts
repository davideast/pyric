/**
 * Discovery of a RUNNING `pyric dev --bridge` -- shared by the stdio MCP
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
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  basesForPort,
  canonicalServeUrl,
  healthyBase,
  LOOPBACK_HOSTNAMES,
  probeHealth,
  probeHostUrl,
  probeHostUrlAnswer,
  probePort,
  SCAN_PORTS,
  servesViteClient,
  urlPort,
  type AnsweringHost,
  type HealthLite,
  type HostUrlAnswer,
} from './discovery-health.js';
import { inProcessSessionTokenForPort, resolveSessionTokenForTarget } from './local-session-token.js';

export {
  basesForPort,
  canonicalServeUrl,
  healthyBase,
  probeHealth,
  probeHostUrl,
  probeHostUrlAnswer,
  SCAN_PORTS,
  servesViteClient,
  urlPort,
  type AnsweringHost,
  type HealthLite,
  type HostUrlAnswer,
};

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

export interface Discovered {
  /** Canonical directory containing the discovered .pyric/serve.json; absent for a port scan. */
  pointerProjectDir?: string;
  mcpUrl: string;
  /** The CANONICAL display URL -- what a human/browser should OPEN. */
  url: string;
  /** `http://<family>:<port>` the server actually answered on. */
  base: string;
  /** Identity pinned at discovery. Null only when talking to an older server
   *  that predates the instanceId field (matching is then skipped). */
  instanceId: string | null;
  /** Per-boot session capability token from `.pyric/serve.json` or in-process registry. */
  token?: string;
  source: string;
}

/** Best-effort port extraction from a pointer url/mcpUrl. */
function portOf(u: string | undefined): number | null {
  const m = u?.match(/:(\d{2,5})(?:\/|$)/);
  if (m) return Number(m[1]);
  return null;
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
  | { kind: 'explicit'; serveUrl: string; base: string; token?: string }
  /** The URL is stale or names another host, and this project has a running
   *  host: attach to that one, after showing `notice` once. */
  | { kind: 'project'; host: Discovered; notice: string }
  /** Nothing answers at the URL and this project has no running host. */
  | { kind: 'stale'; message: string }
  /** A host answers at the URL, but nothing ties it to this project. */
  | { kind: 'refused'; message: string };

/**
 * Resolve an explicit host URL against the project's own host.
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
  const probeFn = input.probe ?? probeHostUrl;
  const answered = await probeFn(serveUrl);
  const answeredId = answered?.instanceId ?? null;
  const launcherId = input.launcherInstanceId;
  const isLauncherHost =
    answered !== null && launcherId !== undefined && launcherId !== '' && answeredId === launcherId;
  if (isLauncherHost) {
    const token = resolveSessionTokenForTarget({ url: answered.base, cwd: input.cwd });
    const choice: ExplicitHostChoice = { kind: 'explicit', serveUrl, base: answered.base };
    if (token !== undefined) choice.token = token;
    return choice;
  }

  const discoverFn = input.discover ?? discoverServe;
  const project = selectProjectHost(await discoverFn(input.cwd), () => {});
  const isProjectHost =
    answered !== null && project !== null && answeredId !== null && answeredId === project.instanceId;
  if (isProjectHost) {
    const token = project.token ?? resolveSessionTokenForTarget({ url: answered.base, cwd: input.cwd });
    const choice: ExplicitHostChoice = { kind: 'explicit', serveUrl, base: answered.base };
    if (token !== undefined) choice.token = token;
    return choice;
  }
  const projectAnswersAtUrl = answered === null && project !== null && urlNamesHost(serveUrl, project);
  if (projectAnswersAtUrl) {
    const token = project.token ?? resolveSessionTokenForTarget({ url: project.base, cwd: input.cwd });
    const choice: ExplicitHostChoice = { kind: 'explicit', serveUrl, base: project.base };
    if (token !== undefined) choice.token = token;
    return choice;
  }

  const portable = "Set PYRIC_SANDBOX=remote to find this project's host through .pyric/serve.json.";
  if (project !== null) {
    let why = 'nothing answers there';
    if (answered !== null) {
      why = "the host answering there is not the host this project's .pyric/serve.json names";
    }
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
    return (error as { code?: string }).code === 'EPERM';
  }
}

/**
 * Whether a project's `.pyric/serve.json` names another host that is still
 * running, so a server starting in the same project must not replace it.
 */
export function pointerHeldByAnotherHost(
  pointer: { pid?: unknown; instanceId?: unknown },
  instanceId: string,
): boolean {
  if (pointer.instanceId === instanceId) return false;
  const pid = pointer.pid;
  const hasPid = typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
  if (!hasPid || pid === process.pid) return false;
  return isPointerProcessAlive(pid);
}

/** What a project's `.pyric/serve.json` records, read without a health probe. */
export interface ProjectPointer {
  /** The display URL of the host the pointer names. */
  url: string;
  /** The host's identity, or `null` for a pointer that records none. */
  instanceId: string | null;
  /** Per-boot session capability token, when recorded in the pointer. */
  token?: string;
}

/** A pointer's identity, or `null` when it records none. */
function pointerInstanceId(pointer: ServePointer): string | null {
  const id = pointer.instanceId;
  const hasId = typeof id === 'string' && id !== '';
  if (hasId) return id;
  return null;
}

function pointerToken(pointer: ServePointer): string | undefined {
  const token = pointer.token;
  if (typeof token === 'string' && token !== '') return token;
  return undefined;
}

/**
 * The project's `.pyric/serve.json`, read without a health probe, for callers
 * that must resolve synchronously. A pointer whose writing process has exited
 * is skipped. `null` when no live pointer is found from `cwd`.
 */
export function readProjectPointer(cwd: string): ProjectPointer | null {
  for (const pointerPath of candidatePointerPaths(cwd)) {
    const hasPointerFile = existsSync(pointerPath);
    if (!hasPointerFile) continue;
    try {
      const p = JSON.parse(readFileSync(pointerPath, 'utf8')) as ServePointer;
      const isLeftOver = !isPointerProcessAlive(p.pid);
      if (isLeftOver) continue;
      const port = p.port ?? portOf(p.mcpUrl) ?? portOf(p.url);
      const hasPort = port !== null && Boolean(port);
      if (hasPort) {
        const token = pointerToken(p) ?? inProcessSessionTokenForPort(port);
        const result: ProjectPointer = {
          url: canonicalServeUrl(port, p.url),
          instanceId: pointerInstanceId(p),
        };
        if (token !== undefined) result.token = token;
        return result;
      }
    } catch {
      /* corrupt pointer: try the next candidate */
    }
  }
  return null;
}

/** The display URL {@link readProjectPointer} finds, or `null`. */
export function readProjectPointerUrl(cwd: string): string | null {
  return readProjectPointer(cwd)?.url ?? null;
}

/**
 * Whether the host a pointer names answers its health probe as that host.
 */
export async function pointerHostAnswers(pointer: ServePointer): Promise<boolean> {
  const port = pointer.port ?? portOf(pointer.mcpUrl) ?? portOf(pointer.url);
  const hasPort = port !== null && Boolean(port);
  if (!hasPort) return false;
  return (await healthyBase(port, pointerInstanceId(pointer))) !== null;
}

const LIVE_POINTER_WAIT_MS = 10_000;
const LIVE_POINTER_POLL_MS = 250;

/** A `.pyric/serve.json` as read from disk. */
export interface ServePointer {
  url?: string;
  mcpUrl?: string;
  port?: number;
  pid?: unknown;
  instanceId?: string;
  token?: string;
}

type PointerOutcome =
  | { kind: 'found'; host: Discovered }
  | { kind: 'unanswered'; port: number; expectedId: string | null; waits: boolean }
  | { kind: 'unusable' };

function readPointer(pointerPath: string): ServePointer | null {
  const hasPointerFile = existsSync(pointerPath);
  if (!hasPointerFile) return null;
  try {
    return JSON.parse(readFileSync(pointerPath, 'utf8')) as ServePointer;
  } catch {
    return null;
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
  const expectedId = pointerInstanceId(p);
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
    return { kind: 'unusable' };
  }
  const token = pointerToken(p) ?? inProcessSessionTokenForPort(port);
  const host: Discovered = {
    pointerProjectDir,
    mcpUrl: `${match.base}/__pyric/mcp`,
    url: canonicalServeUrl(port, p.url),
    base: match.base,
    instanceId: match.instanceId,
    source: `pointer ${pointerPath}`,
  };
  if (token !== undefined) host.token = token;
  return { kind: 'found', host };
}

async function waitForPointerHost(pointerPath: string): Promise<PointerOutcome> {
  const deadline = Date.now() + LIVE_POINTER_WAIT_MS;
  let outcome = await probePointer(pointerPath);
  while (outcome.kind === 'unanswered' && outcome.waits && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, LIVE_POINTER_POLL_MS));
    outcome = await probePointer(pointerPath);
  }
  return outcome;
}

/**
 * One non-waiting look at the project's `.pyric/serve.json` candidates in `cwd`
 * (no {@link LIVE_POINTER_WAIT_MS} retry loop and no blind port scan).
 */
export async function discoverPointerOnce(cwd: string): Promise<Discovered | null> {
  for (const pointerPath of candidatePointerPaths(cwd)) {
    const outcome = await probePointer(pointerPath);
    if (outcome.kind === 'found') return outcome.host;
    if (outcome.kind === 'unusable') continue;
    if (outcome.expectedId !== null) return null;
  }
  return null;
}

/** Find the running serve: pointer first (in `cwd`), then a port scan. */
export async function discoverServe(
  cwd: string,
  log: (m: string) => void = () => {},
  scanPorts: number[] = SCAN_PORTS,
): Promise<Discovered | null> {
  for (const pointerPath of candidatePointerPaths(cwd)) {
    const outcome = await waitForPointerHost(pointerPath);
    if (outcome.kind === 'found') return outcome.host;
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
      const token = inProcessSessionTokenForPort(port);
      const host: Discovered = {
        mcpUrl: `${hit.base}/__pyric/mcp`,
        url: canonicalServeUrl(port),
        base: hit.base,
        instanceId: hit.instanceId,
        source: `port scan (:${port})`,
      };
      if (token !== undefined) host.token = token;
      return host;
    }
  }
  return null;
}
