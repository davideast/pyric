/**
 * `pyric-live run [--host <url>] [--wait[=<seconds>]] -- <command> [args...]`:
 * runs one command under `@pyric/live/register` against an already-running live
 * host (`pyric-live` or Vite with `pyricLive()`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import Module from 'node:module';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkLiveRunRuntime,
  discoverLiveHost,
  probeLiveHostUrl,
  type LiveHostProbeAnswer,
  type LiveHostTarget,
} from '@pyric/cli/serve/internal/live-host';
import { LIVE_PINNED_PROJECT_VARIABLE } from './admin/project-gate.js';

export const DEFAULT_WAIT_SECONDS = 30;

const LIVE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '&']);

export const LIVE_RUN_USAGE = 'usage: pyric-live run [--host <url>] [--wait[=<seconds>]] -- <command> [args...]\n';

export const LIVE_RUN_HELP = `Usage: pyric-live run [--host <url>] [--wait[=<seconds>]] -- <command> [args...]

Runs a Node command under @pyric/live/register against a running live host
(npx pyric-live, or a Vite dev server with pyricLive() from @pyric/live/vite).

The register module is passed via NODE_OPTIONS by absolute file URL, and the
live host's project is passed via PYRIC_PROJECT when none is already set, so
commands and multi-environment .firebaserc workspaces resolve the host project.

Options:
  --host <url>         Loopback live host URL (default: PYRIC_SANDBOX=remote:<url>, else .pyric/serve.json).
  --wait[=<seconds>]   Wait for the live host to answer /__pyric/health (default: 30s).
  -h, --help           Show this help.
`;

export interface LiveRunPlan {
  readonly argv: string[];
  readonly label: string;
}

export type ParsedLiveRun =
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'run';
      readonly hostUrl: string | null;
      readonly plan: LiveRunPlan;
      readonly waitMs: number;
    };

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') return true;
  const parts = normalized.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

type HostUrlParseResult =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly reason: 'missing-scheme' | 'invalid-url' | 'non-loopback' };

function parseHostUrlValue(raw: string): HostUrlParseResult {
  const candidate = raw.startsWith('remote:') ? raw.slice('remote:'.length) : raw;
  if (!/^https?:\/\//.test(candidate)) {
    return { ok: false, reason: 'missing-scheme' };
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  const hasCredentials = parsed.username.length > 0 || parsed.password.length > 0;
  const hasExtraPath =
    (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search.length > 0 || parsed.hash.length > 0;
  if (hasCredentials || hasExtraPath) {
    return { ok: false, reason: 'invalid-url' };
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    return { ok: false, reason: 'non-loopback' };
  }
  return { ok: true, origin: parsed.origin };
}

function hostFlagErrorMessage(raw: string, reason: 'missing-scheme' | 'invalid-url' | 'non-loopback'): string {
  if (reason === 'non-loopback') {
    return (
      `pyric-live run: --host accepts loopback URLs only (localhost, 127.0.0.1, or [::1]); refusing '${raw}'.\n` +
      LIVE_RUN_USAGE
    );
  }
  return `pyric-live run: --host needs a host URL, such as http://localhost:5173.\n${LIVE_RUN_USAGE}`;
}

function hasExecutableToken(argv: readonly string[]): boolean {
  let index = 0;
  while (index < argv.length && ENV_ASSIGNMENT.test(argv[index]!)) {
    index += 1;
  }
  return index < argv.length;
}

/** Parse arguments after `pyric-live run`. */
export function parseLiveRunInvocation(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedLiveRun {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let passthrough: string[] | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--') {
      passthrough = argv.slice(i + 1);
      break;
    }
    if (positional.length > 0) {
      positional.push(arg);
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      flags.set('help', true);
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if ((key === 'host' || key === 'wait') && next !== undefined && !next.startsWith('-')) {
          flags.set(key, next);
          i += 1;
        } else {
          flags.set(key, true);
        }
      }
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      return { kind: 'error', message: `pyric-live run: unknown option ${arg}.\n${LIVE_RUN_USAGE}` };
    }
    positional.push(arg);
  }

  if (flags.get('help') === true) {
    return { kind: 'help' };
  }
  for (const key of flags.keys()) {
    if (key !== 'host' && key !== 'wait') {
      const hint = key === 'sandbox' ? '; pass --host <url>' : '';
      return { kind: 'error', message: `pyric-live run: unknown option --${key}${hint}.\n${LIVE_RUN_USAGE}` };
    }
  }

  let childArgv: string[];
  if (passthrough !== null) {
    childArgv = passthrough.length > 0 ? passthrough : [];
  } else {
    childArgv = positional;
  }
  if (!hasExecutableToken(childArgv)) {
    return { kind: 'error', message: `pyric-live run: no command to run.\n${LIVE_RUN_USAGE}` };
  }

  const hostFlag = flags.get('host');
  let hostUrl: string | null = null;
  if (hostFlag !== undefined) {
    if (typeof hostFlag !== 'string' || hostFlag.trim().length === 0) {
      return {
        kind: 'error',
        message: `pyric-live run: --host needs a host URL, such as http://localhost:5173.\n${LIVE_RUN_USAGE}`,
      };
    }
    const parsedHost = parseHostUrlValue(hostFlag);
    if (!parsedHost.ok) {
      return { kind: 'error', message: hostFlagErrorMessage(hostFlag, parsedHost.reason) };
    }
    hostUrl = parsedHost.origin;
  } else if (typeof env.PYRIC_SANDBOX === 'string' && env.PYRIC_SANDBOX.startsWith('remote:')) {
    const remoteTarget = env.PYRIC_SANDBOX.slice('remote:'.length);
    if (remoteTarget.length > 0) {
      const parsedEnvHost = parseHostUrlValue(remoteTarget);
      if (!parsedEnvHost.ok) {
        let detail = `pyric-live run: PYRIC_SANDBOX=remote:${remoteTarget} is not a valid loopback host URL.\n`;
        if (parsedEnvHost.reason === 'non-loopback') {
          detail = `pyric-live run: PYRIC_SANDBOX=remote:${remoteTarget} must name a loopback URL (localhost, 127.0.0.1, or [::1]).\n`;
        }
        return { kind: 'error', message: `${detail}${LIVE_RUN_USAGE}` };
      }
      hostUrl = parsedEnvHost.origin;
    }
  }

  const wait = flags.get('wait');
  let waitMs = 0;
  if (wait === true) {
    waitMs = DEFAULT_WAIT_SECONDS * 1000;
  } else if (wait !== undefined) {
    const seconds = typeof wait === 'string' ? Number(wait) : Number.NaN;
    const isDuration = Number.isFinite(seconds) && seconds > 0;
    if (!isDuration) {
      return {
        kind: 'error',
        message: `pyric-live run: --wait takes a number of seconds, such as --wait=60.\n${LIVE_RUN_USAGE}`,
      };
    }
    waitMs = seconds * 1000;
  }

  return {
    kind: 'run',
    hostUrl,
    plan: { argv: [...childArgv], label: childArgv.join(' ') },
    waitMs,
  };
}

/** Absolute `file:` URL of `@pyric/live`'s built `dist/register.js`. */
export function liveRegisterModuleUrl(): string {
  const sibling = new URL('./register.js', import.meta.url);
  if (existsSync(fileURLToPath(sibling))) return sibling.href;
  return pathToFileURL(join(LIVE_ROOT, 'dist', 'register.js')).href;
}

export interface LiveChildActivation {
  readonly serveUrl: string;
  readonly registerUrl: string;
  readonly projectId: string;
  readonly instanceId?: string | null | undefined;
  readonly sessionToken?: string | undefined;
}

/**
 * Build the child process environment for `pyric-live run`. Prepends
 * `--import <registerFileUrl>` to `NODE_OPTIONS` so `@pyric/live/register`
 * loads first without activating `@pyric/cli/register`, pins the live host via
 * `PYRIC_SANDBOX=remote:<serveUrl>`, and defaults `PYRIC_PROJECT` to the host's
 * `projectId` when unset.
 */
export function buildLiveChildEnv(
  base: NodeJS.ProcessEnv,
  opts: LiveChildActivation,
): NodeJS.ProcessEnv {
  const importFlag = `--import ${opts.registerUrl}`;
  const existingNodeOptions = (base.NODE_OPTIONS ?? '').trim();
  let nodeOptions: string;
  if (existingNodeOptions.includes(opts.registerUrl)) {
    nodeOptions = existingNodeOptions;
  } else if (existingNodeOptions === '') {
    nodeOptions = importFlag;
  } else {
    nodeOptions = `${importFlag} ${existingNodeOptions}`;
  }
  const env: NodeJS.ProcessEnv = {
    ...base,
    PYRIC_SANDBOX: `remote:${opts.serveUrl}`,
    NODE_OPTIONS: nodeOptions,
  };
  if ((env.PYRIC_PROJECT ?? '') === '' && opts.projectId !== '') {
    env.PYRIC_PROJECT = opts.projectId;
  }
  delete env.PYRIC_SANDBOX_INSTANCE;
  if (opts.instanceId !== undefined && opts.instanceId !== null && opts.instanceId !== '') {
    env.PYRIC_SANDBOX_INSTANCE = opts.instanceId;
  }
  delete env.PYRIC_SESSION_TOKEN;
  if (opts.sessionToken !== undefined && opts.sessionToken !== '') {
    env.PYRIC_SESSION_TOKEN = opts.sessionToken;
  }
  delete env.PYRIC_WORKER_INIT;
  delete env.PYRIC_WORKER_INIT_HOST;
  delete env.PYRIC_LIVE_PROJECT_ROOT;
  delete env.PYRIC_LIVE_SDK_ROOT;
  delete env.PYRIC_LIVE_PASS_THROUGH;
  delete env[LIVE_PINNED_PROJECT_VARIABLE];
  return env;
}

export function formatLiveUnsupportedRuntimeStop(runtime: string, code: string, label?: string): string {
  const commandNote = label !== undefined && label.trim().length > 0 ? ` (\`${label}\`)` : '';
  return (
    `pyric-live run: stopped before starting \`${runtime}\`${commandNote} [${code}].\n` +
    `  \`${runtime}\` does not run Node module.registerHooks, so @pyric/live/register cannot observe or project-check firebase and firebase-admin imports.\n` +
    `  Run the command with \`node\` (Node >= 22.15) or \`npx tsx\` instead.\n`
  );
}

export function notALiveHostMessage(hostUrl: string, isVite: boolean, viteConfig: string): string {
  if (isVite) {
    return (
      `pyric-live run: reached a Vite server without a pyric live host at ${hostUrl}, so it can't run this command.\n` +
      `  Set pyricLive() from @pyric/live/vite in ${viteConfig}, restart Vite, then run this command again.\n`
    );
  }
  return (
    `pyric-live run: ${hostUrl} answers, but it is not a pyric live host: /__pyric/health did not return a health reply.\n` +
    `  Start a live host with npx pyric-live, or for a Vite dev server set pyricLive() from @pyric/live/vite in ${viteConfig}.\n`
  );
}

export function sandboxHostRefusalMessage(hostUrl: string, viteConfig: string): string {
  return (
    `pyric-live run: the host at ${hostUrl} is a sandbox host, not a live host, so it cannot run this command in live mode.\n` +
    `  Stop it, then start a live host with npx pyric-live, or set pyricLive() from @pyric/live/vite in ${viteConfig}.\n`
  );
}

export function tokenGatedHostMessage(hostUrl: string, cwd: string): string {
  return (
    `pyric-live run: the host at ${hostUrl} requires a session token, and no matching .pyric/serve.json was found from ${cwd}.\n` +
    `  Run pyric-live run from the project directory where npx pyric-live or pyricLive() is running.\n`
  );
}

async function pollLiveHost<T>(
  attempt: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T | null> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await attempt();
    if (value !== null) return value;
    if (performance.now() >= deadline) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}

function splitLeadingEnvAssignments(argv: readonly string[]): {
  inlineEnv: Record<string, string>;
  commandArgv: string[];
} {
  const commandArgv = [...argv];
  const inlineEnv: Record<string, string> = {};
  while (commandArgv.length > 0 && ENV_ASSIGNMENT.test(commandArgv[0]!)) {
    const token = commandArgv.shift()!;
    const eq = token.indexOf('=');
    inlineEnv[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { inlineEnv, commandArgv };
}

function quoteLiveShellWord(word: string): string {
  if (word.length > 0 && /^[A-Za-z0-9_./:@=-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, "'\\''")}'`;
}

function formatLiveShellCommand(tokens: readonly string[]): string {
  return tokens
    .map((token) => {
      if (SHELL_OPERATORS.has(token) || token === '(' || token === ')') return token;
      const envMatch = /^([A-Za-z_][A-Za-z0-9_]*=)(.*)$/.exec(token);
      if (envMatch) {
        return `${envMatch[1]}${quoteLiveShellWord(envMatch[2]!)}`;
      }
      return quoteLiveShellWord(token);
    })
    .join(' ');
}

function spawnLiveChild(
  commandArgv: readonly string[],
  label: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; stderr: (text: string) => void },
): { child: ChildProcess; exited: Promise<number> } {
  const hasShellOperators = commandArgv.some((token) => SHELL_OPERATORS.has(token));
  const [command, ...args] = commandArgv;
  let child: ChildProcess;
  if (hasShellOperators) {
    child = spawn(formatLiveShellCommand(commandArgv), [], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: 'inherit',
      shell: true,
    });
  } else {
    child = spawn(command!, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }

  const exited = new Promise<number>((resolveExit) => {
    child.once('error', (err) => {
      opts.stderr(`pyric-live run: failed to run \`${label}\`: ${err.message}\n`);
      resolveExit(1);
    });
    child.once('exit', (code, signal) => {
      if (typeof code === 'number') {
        resolveExit(code);
        return;
      }
      if (signal !== null) {
        const sigNum = osConstants.signals[signal];
        const exitCode = typeof sigNum === 'number' ? 128 + sigNum : 1;
        resolveExit(exitCode);
        return;
      }
      resolveExit(0);
    });
  });

  return { child, exited };
}

function defaultHasRegisterHooks(): boolean {
  return (
    process.versions.bun !== undefined ||
    typeof (Module as unknown as { registerHooks?: unknown }).registerHooks === 'function'
  );
}

export async function runLiveRun(
  argv: readonly string[],
  io: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    hasRegisterHooks?: () => boolean;
  } = {},
): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const writeOut = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const hasRegisterHooks = io.hasRegisterHooks ?? defaultHasRegisterHooks;

  const invocation = parseLiveRunInvocation(argv, env);
  if (invocation.kind === 'help') {
    writeOut(LIVE_RUN_HELP);
    return 0;
  }
  if (invocation.kind === 'error') {
    writeErr(invocation.message);
    return 1;
  }

  const unsupported = checkLiveRunRuntime(invocation.plan.argv, cwd, { liveRoot: LIVE_ROOT });
  if (unsupported !== null) {
    writeErr(formatLiveUnsupportedRuntimeStop(unsupported.runtime, unsupported.code, invocation.plan.label));
    return 1;
  }
  if (!hasRegisterHooks()) {
    writeErr('pyric-live run: live mode needs module.registerHooks, in Node 22.15 or later.\n');
    return 1;
  }

  let target: LiveHostTarget;
  if (invocation.hostUrl !== null) {
    const hostUrl = invocation.hostUrl;
    let lastTokenGated: Extract<LiveHostProbeAnswer, { kind: 'token-gated' }> | null = null;
    const answer = await pollLiveHost(async () => {
      const probed = await probeLiveHostUrl(hostUrl, cwd, { liveRoot: LIVE_ROOT, env });
      if (probed.kind === 'no-answer') return null;
      if (probed.kind === 'token-gated') {
        lastTokenGated = probed;
        return invocation.waitMs > 0 ? null : probed;
      }
      return probed;
    }, invocation.waitMs);
    const resolved = answer ?? lastTokenGated;
    if (resolved === null) {
      const waited = invocation.waitMs > 0 ? ` after waiting ${invocation.waitMs / 1000}s` : '';
      writeErr(`pyric-live run: no live host answers at ${hostUrl}/__pyric/health${waited}.\n`);
      return 2;
    }
    if (resolved.kind === 'sandbox') {
      writeErr(sandboxHostRefusalMessage(hostUrl, resolved.viteConfig));
      return 2;
    }
    if (resolved.kind === 'token-gated') {
      writeErr(tokenGatedHostMessage(hostUrl, cwd));
      return 2;
    }
    if (resolved.kind === 'not-a-host') {
      writeErr(notALiveHostMessage(hostUrl, resolved.isVite, resolved.viteConfig));
      return 2;
    }
    target = resolved.host;
  } else {
    let lastTokenGated: Extract<LiveHostProbeAnswer, { kind: 'token-gated' }> | null = null;
    const answer = await pollLiveHost(async () => {
      const probed = await discoverLiveHost(cwd, { liveRoot: LIVE_ROOT, env });
      if (probed.kind === 'no-answer') return null;
      if (probed.kind === 'token-gated') {
        lastTokenGated = probed;
        return invocation.waitMs > 0 ? null : probed;
      }
      return probed;
    }, invocation.waitMs);
    const resolved = answer ?? lastTokenGated;
    if (resolved === null) {
      const waited = invocation.waitMs > 0 ? ` after waiting ${invocation.waitMs / 1000}s` : '';
      writeErr(
        `pyric-live run: no running live host found${waited}; start one with npx pyric-live or pyricLive() from @pyric/live/vite, or pass --host <url>.\n`,
      );
      return 2;
    }
    if (resolved.kind === 'sandbox') {
      writeErr(sandboxHostRefusalMessage(resolved.url, resolved.viteConfig));
      return 2;
    }
    if (resolved.kind === 'token-gated') {
      writeErr(tokenGatedHostMessage(resolved.url, cwd));
      return 2;
    }
    if (resolved.kind === 'not-a-host') {
      writeErr(notALiveHostMessage(resolved.base, resolved.isVite, resolved.viteConfig));
      return 2;
    }
    target = resolved.host;
  }

  const { inlineEnv, commandArgv } = splitLeadingEnvAssignments(invocation.plan.argv);
  const childEnv = buildLiveChildEnv(
    { ...env, ...inlineEnv },
    {
      serveUrl: target.serveUrl,
      registerUrl: liveRegisterModuleUrl(),
      projectId: target.projectId,
      instanceId: target.instanceId,
      sessionToken: target.sessionToken,
    },
  );
  const { child, exited } = spawnLiveChild(commandArgv, invocation.plan.label, {
    cwd,
    env: childEnv,
    stderr: writeErr,
  });
  const forward = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    return await exited;
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}
