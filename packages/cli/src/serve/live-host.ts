/**
 * `@pyric/cli/serve/internal/live-host`: the one seam through which the
 * `pyric-live` command starts or probes the Node live host. Starting the host
 * runs `pyric sandbox --hosted` itself (`runServe`), with three differences:
 * the host reports its status as live, so the chip and Studio show its project
 * name; the pages it serves get no Firebase SDK (`live-host-pages.ts`); and it
 * refuses every one of pyric's own writes, as the Vite live host does
 * (`hosted/own-writes.ts`).
 *
 * The host runs in the Firebase project root: the nearest folder from the
 * working directory up that holds `.firebaserc` or `firebase.json`
 * (`findFirebaseProjectDir`, as the Vite plugin and the live register find
 * it), or the working directory when none does.
 *
 * The gate is an installed `@pyric/live`: the one whose command is running,
 * when the package resolves there, or else the one the project root
 * resolves, as the register finds it (`liveResolutionRoot`). Without it every
 * entry here refuses to run. `pyric sandbox` never reads this module, and no
 * flag, config key or environment variable reaches it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readLiveHostStatus } from 'pyric/sandbox/internal';
import { isLoopbackHost } from '../assurance/attachment.js';
import { boundedRequest } from '../bounded-request.js';
import { findFirebaseProjectDir, resolveFirebaseProject, type FirebaseProjectResolution } from '../cli/firebase-project.js';
import { parseArgs } from '../cli/parse-args.js';
import { viteConfigIn } from '../cli/public-dir-hint.js';
import { runServe } from '../cli/serve.js';
import { UNSUPPORTED_RUNTIME_CODE, detectUnsupportedRuntime } from '../cli/unsupported-runtime.js';
import { liveResolutionRoot } from '../register/live-package.js';
import {
  basesForPort,
  discoverPointerOnce,
  selectProjectHost,
  servesViteClient,
  urlPort,
} from './discovery.js';
import type { PyricWriteRefusal } from './hosted/own-writes.js';
import { installedLiveFile, liveNotInstalled, loadInstalledLiveExport } from './installed-live-package.js';
import { readPyricConfigProjectSync, requireLiveProject } from './live-project.js';
import {
  discoverHttpsPointer,
  fetchLoopbackTarget,
  inProcessSessionTokenForPort,
} from './local-session-token.js';

export { LiveProjectMissingError, liveProjectId } from './live-project.js';

/** The `@pyric/live` export whose presence opens this seam: the package's own command. */
const LIVE_COMMAND_SUBPATH = 'register';
/** The built `@pyric/live` export that gives this host its refusal of pyric's own writes. */
const WRITE_REFUSAL_SUBPATH = 'node-modules';
const HEALTH_PROBE_DEADLINE_MS = 1_000;
const POINTER_REL = join('.pyric', 'serve.json');
const SESSION_REL = join('.pyric', 'session.json');
const CANDIDATE_SUBDIRS = ['', 'web', 'frontend', 'client', 'app', 'ui', 'www'];
const WORKSPACE_GROUPS = ['apps', 'packages', 'services'];

const CHILD_COMMAND_REFUSAL =
  'pyric-live starts no command after --. Start your server in another terminal with: node --import @pyric/live/register server.js';

function liveHostResolution(argv: readonly string[], projectRoot: string): FirebaseProjectResolution {
  const flag = parseArgs(['sandbox', ...argv]).flags.get('project');
  const configProject = readPyricConfigProjectSync(projectRoot);
  return resolveFirebaseProject({
    projectDir: projectRoot,
    option: typeof flag === 'string' ? flag : undefined,
    configProject,
  });
}

function requireInstalledLive(projectRoot: string, liveRoot: string | undefined, action: string): string {
  const from = liveResolutionRoot(projectRoot, liveRoot);
  const installed = installedLiveFile(from, LIVE_COMMAND_SUBPATH);
  if (installed === null) throw liveNotInstalled(projectRoot, action);
  return from;
}

/** The Firebase project root for a `pyric-live` run started in `cwd`, or `cwd` when there is none. */
export function liveHostProjectRoot(cwd: string): string {
  return findFirebaseProjectDir(cwd) ?? cwd;
}

/** The project a `pyric-live` run with `argv` names: `--project`, else the app's Firebase config. */
export function liveHostProject(argv: readonly string[], projectRoot: string): string {
  return requireLiveProject(liveHostResolution(argv, projectRoot), projectRoot);
}

export interface LiveHostStart {
  /** The folder of the `@pyric/live` whose `pyric-live` command is running. */
  liveRoot?: string;
}

export interface LiveHostProbeOptions extends LiveHostStart {
  env?: NodeJS.ProcessEnv;
}

/**
 * Checks whether a `pyric-live run` child command launches a runtime without
 * Node `module.registerHooks` (`bun`, `bunx`, `deno`, including shell/npx wrappers).
 */
export function checkLiveRunRuntime(
  argv: readonly string[],
  cwd: string,
  start: LiveHostStart = {},
): { readonly runtime: string; readonly code: string } | null {
  const projectRoot = liveHostProjectRoot(cwd);
  requireInstalledLive(projectRoot, start.liveRoot, 'pyric-live run did not start.');
  const runtime = detectUnsupportedRuntime(argv);
  return runtime === null ? null : { runtime, code: UNSUPPORTED_RUNTIME_CODE };
}

/**
 * Runs the Node host for `argv` (`pyric sandbox --hosted`'s flags) in the
 * project root found from the working directory, and resolves with its exit
 * code when it stops. Throws when `@pyric/live` is not installed there or no
 * project is set.
 */
export async function runLiveHost(argv: readonly string[], start: LiveHostStart = {}): Promise<number> {
  const projectRoot = liveHostProjectRoot(process.cwd());
  const from = requireInstalledLive(projectRoot, start.liveRoot, 'The live host did not start.');
  // `runServe` reads its project from the working directory: firebase.json, pyric.json, rules and Hosting files.
  process.chdir(projectRoot);
  const parsed = parseArgs(['sandbox', ...argv]);
  const hasChildCommand = (parsed.passthrough ?? []).length > 0;
  if (hasChildCommand) throw new Error(CHILD_COMMAND_REFUSAL);
  // A child command would get the sandbox register, so the live host starts none.
  parsed.flags.set('no-run', true);
  // The host names the project every live entry resolves, so the start line and the chip agree.
  const project = liveHostResolution(argv, projectRoot);
  parsed.flags.set('project', requireLiveProject(project, projectRoot));
  parsed.flags.set('hosted', true);
  const refusal = await loadInstalledLiveExport(from, WRITE_REFUSAL_SUBPATH, 'liveWriteRefusal', 'The live host did not start.');
  return runServe(parsed, { liveHost: { project, writeRefusal: refusal.fn as unknown as PyricWriteRefusal } });
}

/** A verified running live host on loopback that `pyric-live run` attaches a child process to. */
export interface LiveHostTarget {
  /** Canonical loopback origin (`http://localhost:3473` or explicit `--host` origin). */
  readonly serveUrl: string;
  /** Loopback base that answered `/__pyric/health`. */
  readonly base: string;
  /** Bridge `instanceId`, when reported. */
  readonly instanceId: string | null;
  /** Configured Firebase project ID reported by the live host (`live.configProjectId`). */
  readonly projectId: string;
  /** Verified capability token for this loopback host. */
  readonly sessionToken: string;
}

/** Outcome of probing a loopback URL or project `.pyric/serve.json` pointer for a live host. */
export type LiveHostProbeAnswer =
  | { readonly kind: 'live'; readonly host: LiveHostTarget }
  | { readonly kind: 'sandbox'; readonly url: string; readonly base: string; readonly viteConfig: string }
  | { readonly kind: 'token-gated'; readonly url: string; readonly base: string }
  | { readonly kind: 'not-a-host'; readonly base: string; readonly isVite: boolean; readonly viteConfig: string }
  | { readonly kind: 'no-answer' };

interface DiskTokenEntry {
  pid?: unknown;
  port?: unknown;
  url?: unknown;
  mcpUrl?: unknown;
  instanceId?: unknown;
  token?: unknown;
}

function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

function extractEntryPort(entry: DiskTokenEntry): number | undefined {
  if (typeof entry.port === 'number' && Number.isInteger(entry.port) && entry.port > 0) {
    return entry.port;
  }
  for (const raw of [entry.mcpUrl, entry.url]) {
    if (typeof raw !== 'string') continue;
    const match = raw.match(/:(\d{2,5})(?:[/?]|$)/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function liveTokenFiles(startDir: string, projectRoot: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const addDir = (dir: string): void => {
    for (const rel of [POINTER_REL, SESSION_REL]) {
      const candidate = join(dir, rel);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        files.push(candidate);
      }
    }
  };
  let current = resolve(startDir);
  for (;;) {
    for (const sub of CANDIDATE_SUBDIRS) {
      addDir(sub ? join(current, sub) : current);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const resolvedProjectRoot = resolve(projectRoot);
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = join(resolvedProjectRoot, group);
    if (!existsSync(groupDir)) continue;
    try {
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (entry.isDirectory()) addDir(join(groupDir, entry.name));
      }
    } catch {
      // Unreadable workspace directory.
    }
  }
  return files;
}

function resolveLiveHostToken(input: {
  port: number;
  cwd: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  explicitToken?: string;
  expectedInstanceId?: string | null;
}): { token?: string; expectedInstanceId?: string } {
  const initialExpected =
    typeof input.expectedInstanceId === 'string' && input.expectedInstanceId.length > 0
      ? input.expectedInstanceId
      : undefined;
  if (typeof input.explicitToken === 'string' && input.explicitToken.length > 0) {
    return { token: input.explicitToken, expectedInstanceId: initialExpected };
  }
  const inProcess = inProcessSessionTokenForPort(input.port);
  if (inProcess !== undefined) {
    return { token: inProcess, expectedInstanceId: initialExpected };
  }
  for (const filePath of liveTokenFiles(input.cwd, input.projectRoot)) {
    if (!existsSync(filePath)) continue;
    try {
      const entry = JSON.parse(readFileSync(filePath, 'utf8')) as DiskTokenEntry;
      if (typeof entry.token !== 'string' || entry.token.length === 0) continue;
      if (!isProcessAlive(entry.pid)) continue;
      if (extractEntryPort(entry) !== input.port) continue;
      const entryId = typeof entry.instanceId === 'string' && entry.instanceId.length > 0 ? entry.instanceId : undefined;
      return { token: entry.token, expectedInstanceId: initialExpected ?? entryId };
    } catch {
      // Ignore unreadable or mid-write pointer files.
    }
  }
  const envToken = input.env.PYRIC_SESSION_TOKEN;
  if (typeof envToken === 'string' && envToken.length > 0) {
    return { token: envToken, expectedInstanceId: initialExpected };
  }
  return { expectedInstanceId: initialExpected };
}

function parseLoopbackHostOrigin(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`'${rawUrl}' is not a valid absolute URL.`);
  }
  const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  const hasCredentials = parsed.username.length > 0 || parsed.password.length > 0;
  const hasExtraPath =
    (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search.length > 0 || parsed.hash.length > 0;
  if (!isHttp || hasCredentials || hasExtraPath || !isLoopbackHost(parsed.hostname)) {
    throw new Error('Live host URLs must be credential-free HTTP(S) loopback origins (localhost, 127.0.0.1, or [::1]).');
  }
  return parsed;
}

function loopbackBasesForOrigin(parsed: URL): string[] {
  const port = urlPort(parsed);
  if (parsed.protocol === 'https:') {
    const candidates = [`https://127.0.0.1:${port}`, `https://[::1]:${port}`, parsed.origin];
    return [...new Set(candidates)];
  }
  return basesForPort(port);
}

function resolveViteConfigName(cwd: string, projectRoot: string): string {
  return viteConfigIn(cwd) ?? viteConfigIn(projectRoot) ?? 'vite.config.ts';
}

async function probeLiveHostAtBase(input: {
  base: string;
  port: number;
  cwd: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  explicitToken?: string;
  expectedInstanceId?: string | null;
}): Promise<LiveHostProbeAnswer> {
  const { token, expectedInstanceId } = resolveLiveHostToken({
    port: input.port,
    cwd: input.cwd,
    projectRoot: input.projectRoot,
    env: input.env,
    explicitToken: input.explicitToken,
    expectedInstanceId: input.expectedInstanceId,
  });
  let status: number;
  let rawBody: string;
  if (input.base.startsWith('https://')) {
    try {
      const httpsRes = await fetchLoopbackTarget(
        `${input.base}/__pyric/health`,
        {
          headers: {
            accept: 'application/json',
            ...(token !== undefined ? { 'x-pyric-session-token': token } : {}),
          },
          signal: AbortSignal.timeout(HEALTH_PROBE_DEADLINE_MS),
        },
        input.cwd,
      );
      status = httpsRes.status;
      rawBody = await httpsRes.text();
    } catch {
      return { kind: 'no-answer' };
    }
  } else {
    const response = await boundedRequest(`${input.base}/__pyric/health`, {
      headers: {
        accept: 'application/json',
        ...(token !== undefined ? { 'x-pyric-session-token': token } : {}),
      },
      deadlineMs: HEALTH_PROBE_DEADLINE_MS,
    });
    if (response === null) return { kind: 'no-answer' };
    status = response.status;
    rawBody = response.body.toString('utf8');
  }
  if (status === 503) return { kind: 'no-answer' };
  const viteConfig = resolveViteConfigName(input.cwd, input.projectRoot);
  if (status !== 200) {
    return { kind: 'not-a-host', base: input.base, isVite: await servesViteClient(input.base), viteConfig };
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { kind: 'not-a-host', base: input.base, isVite: await servesViteClient(input.base), viteConfig };
  }
  const isBridge = typeof body === 'object' && body !== null && (body as { mode?: unknown }).mode === 'sandbox';
  if (!isBridge) {
    return { kind: 'not-a-host', base: input.base, isVite: await servesViteClient(input.base), viteConfig };
  }
  const sandboxConnected = (body as { sandboxConnected?: unknown }).sandboxConnected;
  const hasFullHealth = typeof (body as { version?: unknown }).version === 'string';
  const live = readLiveHostStatus(body);
  if (live === null) {
    // Full bridge health (`version` present) with no `live` report is definitively a sandbox host,
    // even when no browser peer has connected yet (`sandboxConnected: false`).
    if (hasFullHealth) {
      return { kind: 'sandbox', url: input.base, base: input.base, viteConfig };
    }
    // Stripped health (`version` omitted) means a token-gated mount rejected or lacked `x-pyric-session-token`
    // (either a live host still writing `.pyric/serve.json`, or a host whose token is outside `cwd`).
    return { kind: 'token-gated', url: input.base, base: input.base };
  }
  // Every genuine Pyric live host requires `x-pyric-session-token`; refuse unauthenticated/unowned `live` bodies.
  if (token === undefined) {
    return { kind: 'token-gated', url: input.base, base: input.base };
  }
  const rawId = (body as { instanceId?: unknown }).instanceId;
  const instanceId = typeof rawId === 'string' && rawId !== '' ? rawId : null;
  if (expectedInstanceId !== undefined && instanceId !== expectedInstanceId) {
    return { kind: 'token-gated', url: input.base, base: input.base };
  }
  if (sandboxConnected === false) return { kind: 'no-answer' };
  return {
    kind: 'live',
    host: {
      serveUrl: input.base,
      base: input.base,
      instanceId,
      projectId: live.configProjectId,
      sessionToken: token,
    },
  };
}

/** Probe an explicit loopback `--host <url>` for a running live host. */
export async function probeLiveHostUrl(
  url: string,
  cwd: string,
  options: LiveHostProbeOptions = {},
): Promise<LiveHostProbeAnswer> {
  const projectRoot = liveHostProjectRoot(cwd);
  requireInstalledLive(projectRoot, options.liveRoot, 'pyric-live run did not start.');
  const parsed = parseLoopbackHostOrigin(url);
  const serveUrl = parsed.origin;
  const port = urlPort(parsed);
  const env = options.env ?? process.env;

  let sandboxHit: Extract<LiveHostProbeAnswer, { kind: 'sandbox' }> | null = null;
  let tokenGatedHit: Extract<LiveHostProbeAnswer, { kind: 'token-gated' }> | null = null;
  let notHostHit: Extract<LiveHostProbeAnswer, { kind: 'not-a-host' }> | null = null;
  for (const base of loopbackBasesForOrigin(parsed)) {
    const probed = await probeLiveHostAtBase({ base, port, cwd, projectRoot, env });
    if (probed.kind === 'live') {
      return { kind: 'live', host: { ...probed.host, serveUrl } };
    }
    if (probed.kind === 'sandbox') sandboxHit ??= probed;
    if (probed.kind === 'token-gated') tokenGatedHit ??= probed;
    if (probed.kind === 'not-a-host') notHostHit ??= probed;
  }
  if (sandboxHit !== null) {
    return { kind: 'sandbox', url: serveUrl, base: sandboxHit.base, viteConfig: sandboxHit.viteConfig };
  }
  if (tokenGatedHit !== null) {
    return { kind: 'token-gated', url: serveUrl, base: tokenGatedHit.base };
  }
  if (notHostHit !== null) return notHostHit;
  return { kind: 'no-answer' };
}

/** Discover the project's running host through `.pyric/serve.json` (single probe) and verify it is a live host. */
export async function discoverLiveHost(
  cwd: string,
  options: LiveHostProbeOptions = {},
): Promise<LiveHostProbeAnswer> {
  const projectRoot = liveHostProjectRoot(cwd);
  requireInstalledLive(projectRoot, options.liveRoot, 'pyric-live run did not start.');
  const httpsDiscovered = await discoverHttpsPointer(cwd);
  const rawDiscovered = httpsDiscovered ?? (await discoverPointerOnce(cwd));
  const discovered = selectProjectHost(rawDiscovered, () => {});
  if (discovered === null) return { kind: 'no-answer' };
  const parsed = parseLoopbackHostOrigin(discovered.base);
  const probed = await probeLiveHostAtBase({
    base: discovered.base,
    port: urlPort(parsed),
    cwd,
    projectRoot,
    env: options.env ?? process.env,
    explicitToken: discovered.token,
    expectedInstanceId: discovered.instanceId,
  });
  if (probed.kind === 'live') {
    return {
      kind: 'live',
      host: {
        ...probed.host,
        serveUrl: discovered.url,
        instanceId: discovered.instanceId ?? probed.host.instanceId,
      },
    };
  }
  if (probed.kind === 'sandbox') {
    return { kind: 'sandbox', url: discovered.url, base: discovered.base, viteConfig: probed.viteConfig };
  }
  if (probed.kind === 'token-gated') {
    return { kind: 'token-gated', url: discovered.url, base: discovered.base };
  }
  return probed;
}
