/**
 * The outermost egress block for a local run: an unprivileged user, network
 * and mount namespace with only loopback. Every process of a run's plant or
 * build phase runs inside it, so a request no recorder hooks (Bun's fetch,
 * curl, a native binary) fails at the kernel instead of leaving the machine.
 * The recorders still record what was attempted: the Node preload and the
 * Chromium NetLog as before, and `recorder/dns-log.mjs`, the namespace's only
 * resolver, records every DNS query any runtime sends.
 *
 *   unshare -rnm sh -c 'ip link set lo up && mount --bind <resolv.conf> /etc/resolv.conf && exec node dns-log.mjs'
 *
 * The DNS logger holds the namespace open; a command enters it with
 * `nsenter -t <pid> -U -n -m --preserve-credentials`. Without `unshare`,
 * `nsenter` or `ip`, or with any interface besides loopback inside, the
 * harness refuses to run. It never falls back to running without the block.
 *
 * Installs that need the npm registry run before the namespace starts, so
 * they are recorded by the Node preload but not blocked by the kernel.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DNS_LOG = fileURLToPath(new URL('./recorder/dns-log.mjs', import.meta.url));
const REQUIRED_TOOLS = ['unshare', 'nsenter', 'ip'];
const READY_TIMEOUT_MS = 15_000;

/** Why the harness will not run: no namespace, so no kernel-level block. */
export class NamespaceUnavailable extends Error {}

export interface EgressNamespace {
  /** The DNS logger's pid, which holds the namespace. */
  pid: number;
  /** `command args` as run inside the namespace, in `cwd`. */
  enter(command: string, args: readonly string[], cwd: string): { command: string; args: string[] };
  stop(): Promise<void>;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether `tool` is an executable on PATH, as this process's PATH reads now. */
function hasTool(tool: string): boolean {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '');
  return dirs.some((dir) => isExecutable(join(dir, tool)));
}

/** The commands that build the namespace, as one `sh -c` script with positional arguments. */
const HOLDER_SCRIPT = 'ip link set lo up && mount --bind "$1" /etc/resolv.conf && exec node "$2"';

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const fail = (reason: string) => reject(new NamespaceUnavailable(`the network namespace did not start: ${reason}\n${output}`));
    const timer = setTimeout(() => fail(`no ready line within ${READY_TIMEOUT_MS / 1000}s`), READY_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
      if (!output.includes('{"ready":true}')) return;
      clearTimeout(timer);
      resolve();
    });
    child.stderr?.on('data', (chunk) => { output += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error.message);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(`unshare exited ${code}`);
    });
  });
}

function enterArgs(pid: number, command: string, args: readonly string[], cwd: string): { command: string; args: string[] } {
  return { command: 'nsenter', args: ['-t', String(pid), '-U', '-n', '-m', '--preserve-credentials', `--wd=${cwd}`, command, ...args] };
}

/** Fails closed unless loopback is the only interface inside the namespace. */
function assertLoopbackOnly(pid: number): void {
  const { command, args } = enterArgs(pid, 'ip', ['-o', 'link', 'show'], '/');
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new NamespaceUnavailable(`could not list the namespace's interfaces:\n${result.stderr}`);
  const interfaces = result.stdout.trim().split('\n').map((line) => line.split(':')[1]?.trim() ?? '');
  const isLoopbackOnly = interfaces.length === 1 && interfaces[0] === 'lo';
  if (!isLoopbackOnly) throw new NamespaceUnavailable(`the namespace has interfaces besides loopback: ${interfaces.join(', ')}`);
}

/**
 * Starts a run's namespace. `networkLog` is where the DNS logger records;
 * `runRoot` holds the namespace's resolv.conf.
 */
export async function startEgressNamespace(options: { networkLog: string; runRoot: string }): Promise<EgressNamespace> {
  const missing = REQUIRED_TOOLS.filter((tool) => !hasTool(tool));
  if (missing.length > 0) throw new NamespaceUnavailable(`missing ${missing.join(', ')}: the harness runs builders only inside a network namespace`);
  const resolvConf = join(options.runRoot, 'resolv.conf');
  writeFileSync(resolvConf, 'nameserver 127.0.0.1\noptions attempts:1 timeout:1\n');
  const child = spawn('unshare', ['-rnm', 'sh', '-c', HOLDER_SCRIPT, 'sh', resolvConf, DNS_LOG], {
    env: { PATH: process.env.PATH, PYRIC_BUILDER_NETWORK_LOG: options.networkLog },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await waitForReady(child);
  const pid = child.pid;
  if (pid === undefined) throw new NamespaceUnavailable('unshare started without a pid');
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    assertLoopbackOnly(pid);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return {
    pid,
    enter: (command, args, cwd) => enterArgs(pid, command, args, cwd),
    async stop() {
      child.stdin?.end();
      await exited;
    },
  };
}
