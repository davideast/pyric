/**
 * `pyric run [--sandbox <url>] -- <command...>`: run one command against a
 * sandbox host that is already running, such as a Vite dev server with
 * `pyric({ hosted: true })` or a `pyric sandbox --hosted` in another terminal.
 *
 * The child gets the environment `pyric sandbox` gives its own child
 * (`buildChildEnv`): the activator, the host's identity, and `--import` with
 * the absolute `file:` URL of this install's register module. Nothing in the
 * child resolves `@pyric/cli` by name, so the command works from any working
 * directory, including one outside the tree pyric is installed in.
 */
import type { ParsedArgs } from './parse-args.js';
import {
  buildChildEnv,
  registerModuleUrl,
  spawnSandboxChild,
  type SandboxChildPlan,
} from './sandbox-runner.js';
import { discoverServe, probeHostUrlAnswer, servesViteClient } from '../serve/discovery.js';
import { viteConfigIn } from './public-dir-hint.js';

export interface RunInvocation {
  /** The host URL named by `--sandbox` or `PYRIC_SANDBOX=remote:<url>`; null to discover it. */
  readonly hostUrl: string | null;
  readonly plan: SandboxChildPlan;
  /** How long to wait for the host to answer before giving up; 0 probes once. */
  readonly waitMs: number;
}

export const RUN_USAGE = 'usage: pyric run [--sandbox <url>] [--wait[=<seconds>]] -- <command> [args...]\n';

/** `--wait` without a value: the bound `pyric sandbox` gives its first-run race guard. */
export const DEFAULT_WAIT_SECONDS = 30;

/** Strip the optional `remote:` prefix the activator uses. Null when nothing names a URL. */
function hostUrlOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const url = value.startsWith('remote:') ? value.slice('remote:'.length) : value;
  const namesUrl = /^https?:\/\//.test(url);
  return namesUrl ? url : null;
}

/**
 * Read a `pyric run` invocation. The host comes from `--sandbox`, then from an
 * inherited `PYRIC_SANDBOX=remote:<url>`; with neither, the caller discovers
 * the project's running host. Returns a usage error string when the command or
 * the flag is missing or malformed.
 */
export function parseRunInvocation(parsed: ParsedArgs, env: NodeJS.ProcessEnv): RunInvocation | string {
  const passthrough = parsed.passthrough ?? [];
  const argv = passthrough.length > 0 ? passthrough : parsed.positional;
  if (argv.length === 0) return `pyric run: no command to run.\n${RUN_USAGE}`;
  const flag = parsed.flags.get('sandbox');
  let hostUrl: string | null;
  if (flag === undefined) {
    hostUrl = hostUrlOf(env.PYRIC_SANDBOX);
  } else {
    hostUrl = typeof flag === 'string' ? hostUrlOf(flag) : null;
    if (hostUrl === null) {
      return `pyric run: --sandbox needs a host URL, such as http://localhost:5173.\n${RUN_USAGE}`;
    }
  }
  const wait = parsed.flags.get('wait');
  let waitMs = 0;
  if (wait === true) {
    waitMs = DEFAULT_WAIT_SECONDS * 1000;
  } else if (wait !== undefined) {
    const seconds = typeof wait === 'string' ? Number(wait) : Number.NaN;
    const isDuration = Number.isFinite(seconds) && seconds > 0;
    if (!isDuration) return `pyric run: --wait takes a number of seconds, such as --wait=60.\n${RUN_USAGE}`;
    waitMs = seconds * 1000;
  }
  return { hostUrl, plan: { argv: [...argv], label: argv.join(' ') }, waitMs };
}

/**
 * Call `attempt` until it returns a value or `timeoutMs` passes, `intervalMs`
 * apart. A zero timeout makes one attempt. Injectable sleep for the unit suite.
 */
export async function pollUntil<T>(
  attempt: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<T | null> {
  const intervalMs = opts.intervalMs ?? 250;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const value = await attempt();
    if (value !== null) return value;
    if (now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/**
 * The refusal for a URL that answers but is not a sandbox host (#1568). A Vite
 * dev server whose plugin is in-page, `pyric()` with no `hosted`, is the
 * common one: it has no sandbox host, and `hosted: true` gives it one.
 */
export function notAHostMessage(hostUrl: string, isVite: boolean, viteConfig: string): string {
  if (isVite) {
    return (
      `pyric run: reached a Vite server without a hosted pyric sandbox at ${hostUrl}, so it can't run this command.\n` +
      `  Set pyric({ hosted: true }) in ${viteConfig}, restart Vite, then run this command again.\n`
    );
  }
  return (
    `pyric run: ${hostUrl} answers, but it is not a sandbox host: /__pyric/health did not return a health reply.\n` +
    `  Start a host with pyric sandbox --hosted, or for a Vite dev server set pyric({ hosted: true }) in ${viteConfig}.\n`
  );
}

export async function runRun(parsed: ParsedArgs): Promise<number> {
  const invocation = parseRunInvocation(parsed, process.env);
  if (typeof invocation === 'string') {
    process.stderr.write(invocation);
    return 1;
  }
  const cwd = process.cwd();
  let serveUrl: string;
  let instanceId: string | null;
  if (invocation.hostUrl !== null) {
    const hostUrl = invocation.hostUrl;
    // A server that answers but is not a sandbox host will not become one, so only silence is waited out.
    const answer = await pollUntil(async () => {
      const probed = await probeHostUrlAnswer(hostUrl);
      return probed.kind === 'no-answer' ? null : probed;
    }, { timeoutMs: invocation.waitMs });
    if (answer === null) {
      const waited = invocation.waitMs > 0 ? ` after waiting ${invocation.waitMs / 1000}s` : '';
      process.stderr.write(`pyric run: no sandbox host answers at ${hostUrl}/__pyric/health${waited}.\n`);
      return 2;
    }
    if (answer.kind === 'not-a-host') {
      const viteConfig = viteConfigIn(cwd) ?? 'vite.config.ts';
      process.stderr.write(notAHostMessage(hostUrl, await servesViteClient(answer.base), viteConfig));
      return 2;
    }
    serveUrl = answer.host.base;
    instanceId = answer.host.instanceId;
  } else {
    const log = (line: string): void => void process.stderr.write(`pyric run: ${line}\n`);
    const host = await pollUntil(() => discoverServe(cwd, log), { timeoutMs: invocation.waitMs });
    if (host === null) {
      process.stderr.write('pyric run: no running sandbox host found; pass --sandbox <url>.\n');
      return 2;
    }
    serveUrl = host.base;
    instanceId = host.instanceId;
  }
  const env = buildChildEnv(process.env, {
    serveUrl,
    registerUrl: registerModuleUrl(),
    instanceId: instanceId ?? undefined,
  });
  const child = spawnSandboxChild(invocation.plan, { cwd, env, json: false });
  const forward = (signal: NodeJS.Signals): void => child.signal(signal);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    return await child.exited;
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}
