/**
 * `pyric run [--sandbox <url>] -- <command...>`: run one command against a
 * sandbox host that is already running, such as a Vite dev server with the
 * pyric plugin or a `pyric sandbox` in another terminal.
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
import { discoverServe, probeHostUrl } from '../serve/discovery.js';

export interface RunInvocation {
  /** The host URL named by `--sandbox` or `PYRIC_SANDBOX=remote:<url>`; null to discover it. */
  readonly hostUrl: string | null;
  readonly plan: SandboxChildPlan;
}

export const RUN_USAGE = 'usage: pyric run [--sandbox <url>] -- <command> [args...]\n';

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
  return { hostUrl, plan: { argv: [...argv], label: argv.join(' ') } };
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
    const host = await probeHostUrl(invocation.hostUrl);
    if (host === null) {
      process.stderr.write(`pyric run: no sandbox host answers at ${invocation.hostUrl}/__pyric/health.\n`);
      return 2;
    }
    serveUrl = host.base;
    instanceId = host.instanceId;
  } else {
    const host = await discoverServe(cwd, (line) => void process.stderr.write(`pyric run: ${line}\n`));
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
