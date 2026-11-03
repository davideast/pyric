/**
 * The outermost egress block for a local run: a bubblewrap sandbox with an
 * allowlist file system and a network namespace of its own with only
 * loopback. Every process of a run's install, plant or build phase runs
 * inside it, so a request no recorder hooks (Bun's fetch, curl, a native
 * binary) never leaves the machine, and nothing of the host it was not given
 * is there to reach.
 *
 * The sandbox sees only what `sandboxArgs` binds: /usr and a few /etc files
 * read-only, the harness's view of its repo (`harness-view.ts`: its own
 * code and packages, not the repo's sources, tests or git history),
 * toolchain and caches read-only,
 * the run directory read-write, a fresh /dev, /proc, /tmp and /run, and its own
 * resolv.conf and hosts (`recorder/sandbox-etc/`). There is no /mnt, no /run/WSL and no /run/user. A
 * cache the run must write to (npm's) gets an overlay whose writes stay in
 * the sandbox's /tmp, so the host's copy never changes.
 *
 *   bwrap --unshare-all --uid 0 --gid 0 --cap-add CAP_NET_ADMIN --cap-add CAP_NET_BIND_SERVICE <layout> \
 *     sh -c 'ip route add local 0.0.0.0/0 dev lo table local && ip -6 route add local ::/0 dev lo table local && exec node holder.mjs'
 *
 * The routes send every address to loopback, where the holder's catch-all
 * listener records any connection to ports 80 and 443 and its resolver
 * records every DNS query. Processes run as root of the sandbox's own user
 * namespace, as they did under `unshare -r`; containment comes from the
 * file system layout and the network namespace. A command enters with
 * `nsenter -t <bwrap's child pid> -U -m -n -p -i -u -C --preserve-credentials --root env -C <dir> <command>`.
 *
 * At start the harness checks from inside that loopback is the only
 * interface and runs `sandbox-inventory.ts`. Without `bwrap`, `nsenter` or
 * `ip`, or when a check fails, it refuses to run. It never falls back to
 * running without the sandbox.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unreapedExit } from '../apps/unreaped-exit.ts';
import { harnessView, type View } from './harness-view.ts';
import { linkNames, loopbackOnlyProblem, READ_AHEAD_LISTINGS } from './sandbox-inventory.ts';

const HOLDER = fileURLToPath(new URL('./recorder/holder.mjs', import.meta.url));
const INVENTORY = fileURLToPath(new URL('./sandbox-inventory.ts', import.meta.url));
const REQUIRED_TOOLS = ['bwrap', 'nsenter', 'ip'];
const READY_TIMEOUT_MS = 15_000;

/** The top-level entries of a merged-/usr system, linked or bound into the sandbox as the host has them. */
const USR_LINKS = ['bin', 'lib', 'lib64', 'sbin'];

/**
 * The /etc entries the sandbox gets read-only: the loader, certificates,
 * fonts, users and name-service config. Of /etc/ssl only the certificates and
 * openssl.cnf: /etc/ssl/private is root-only, and the inventory fails on a
 * directory it can't list.
 */
export const ETC_ENTRIES: readonly string[] = [
  'alternatives', 'ca-certificates', 'fonts', 'gai.conf', 'group', 'host.conf', 'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d',
  'localtime', 'mime.types', 'nsswitch.conf', 'os-release', 'passwd', 'protocols', 'services', 'ssl/certs', 'ssl/openssl.cnf',
];

/** The holder's script: route every address to loopback, then start the loggers. */
const HOLDER_SCRIPT = 'ip route add local 0.0.0.0/0 dev lo table local && ip -6 route add local ::/0 dev lo table local && exec node "$1"';

/**
 * The sandbox's /etc/resolv.conf (127.0.0.1 alone) and /etc/hosts, checked
 * in and bound read-only. The harness writes neither into the run directory:
 * a write there, while another sandbox of the same run is up, would follow a
 * link that sandbox planted to any file of the host's.
 */
export const SANDBOX_RESOLV_CONF = fileURLToPath(new URL('./recorder/sandbox-etc/resolv.conf', import.meta.url));
export const SANDBOX_HOSTS = fileURLToPath(new URL('./recorder/sandbox-etc/hosts', import.meta.url));

/** Why the harness will not run: no sandbox, so no kernel-level block. */
export class NamespaceUnavailable extends Error {}

export interface EgressNamespace {
  /** bwrap's child pid: the sandbox's first process, which commands enter through. */
  pid: number;
  /** `command args` as run inside the sandbox, in `cwd`. */
  enter(command: string, args: readonly string[], cwd: string): { command: string; args: string[] };
  /** Stops the sandbox; `still-running` when bwrap outlived its stop and SIGKILL, which makes the run invalid. */
  stop(): Promise<SandboxStop>;
}

export interface SandboxOptions {
  /** Where the resolver and the catch-all listener record. */
  networkLog: string;
  /** The run directory: bound read-write. The harness writes nothing into it. */
  runRoot: string;
  /** Directories the run reads but never writes: a tarball directory, Playwright's browsers. The harness's view of its repo and the toolchain are added. */
  readOnly?: readonly string[];
  /**
   * Directories the run reads and writes, whose writes stay in the sandbox:
   * bound read-only, with an overlay on top whose upper layer is in the
   * sandbox's /tmp. npm writes local tarballs into its cache even offline;
   * this keeps the shared cache unchanged.
   */
  overlaid?: readonly string[];
  /**
   * Host directories bound read-only over a path inside the run root, after
   * it: a session sees the harness's check results at `<run>/checks` and
   * can't change them.
   */
  innerViews?: readonly View[];
  /** Starts bwrap; tests pass one that loses its exit, as Bun can (#1274). */
  spawnChild?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** How `stop` waits for bwrap; tests pass short waits. */
  stopTiming?: StopTiming;
}

/** How long `stop` waits for bwrap to exit, then for it to die after SIGKILL, and how often it looks in /proc. */
export interface StopTiming {
  exitMs: number;
  killMs: number;
  pollMs: number;
}

const STOP_TIMING: StopTiming = { exitMs: 15_000, killMs: 5_000, pollMs: 250 };

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where `tool` is on PATH, as this process's PATH reads now. */
function whichTool(tool: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '');
  return dirs.map((dir) => join(dir, tool)).find(isExecutable);
}

/** The install prefixes of `node` and `bun` on PATH, when they live outside /usr. */
export function toolchainDirs(): string[] {
  const dirs: string[] = [];
  const node = whichTool('node');
  if (node !== undefined) dirs.push(dirname(dirname(realpathSync(node))));
  const bun = whichTool('bun');
  if (bun !== undefined) dirs.push(dirname(realpathSync(bun)));
  return dirs.filter((dir) => dir !== '/usr' && !dir.startsWith('/usr/'));
}

/** `--symlink` for an entry the host links into /usr, `--ro-bind` for one it keeps as a directory. */
function usrEntryArgs(entry: string): string[] {
  const path = `/${entry}`;
  if (!existsSync(path)) return [];
  const isLink = lstatSync(path).isSymbolicLink();
  return isLink ? ['--symlink', readlinkSync(path), path] : ['--ro-bind', path, path];
}

/** bwrap's binds for the host's /usr and its top-level links into it, read-only. */
export function systemBinds(): string[] {
  return ['--ro-bind', '/usr', '/usr', ...USR_LINKS.flatMap(usrEntryArgs)];
}

export interface SandboxLayout {
  runRoot: string;
  readOnly: readonly string[];
  /** Host paths bound read-only elsewhere in the sandbox: the harness's packages. */
  views?: readonly View[];
  /** The sandbox's own /etc/resolv.conf and /etc/hosts, on the host. */
  resolvConf: string;
  hosts: string;
  /** The /etc entries the host has, from `ETC_ENTRIES`. */
  etc: readonly string[];
  /** Extra empty directories, such as a TMPDIR outside /tmp. */
  dirs?: readonly string[];
  /** Read-only binds over paths inside the run root, made after it. */
  innerViews?: readonly View[];
}

/** bwrap's arguments for a run, before the command. Parents bind before children. */
export function sandboxArgs(layout: SandboxLayout): string[] {
  const inPlace = [...new Set(layout.readOnly)].map((dir): View => ({ source: dir, dest: dir }));
  const readOnly = [...inPlace, ...(layout.views ?? [])].sort((a, b) => a.dest.length - b.dest.length);
  return [
    '--unshare-all',
    '--uid', '0', '--gid', '0',
    '--cap-add', 'CAP_NET_ADMIN', '--cap-add', 'CAP_NET_BIND_SERVICE',
    '--die-with-parent', '--new-session',
    ...systemBinds(),
    '--dir', '/etc',
    ...layout.etc.flatMap((entry) => ['--ro-bind', `/etc/${entry}`, `/etc/${entry}`]),
    '--ro-bind', layout.resolvConf, '/etc/resolv.conf',
    '--ro-bind', layout.hosts, '/etc/hosts',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    ...(layout.dirs ?? []).flatMap((dir) => ['--dir', dir]),
    ...readOnly.flatMap(({ source, dest }) => ['--ro-bind', source, dest]),
    '--bind', layout.runRoot, layout.runRoot,
    ...(layout.innerViews ?? []).flatMap(({ source, dest }) => ['--ro-bind', source, dest]),
  ];
}

/**
 * The namespaces a command enters: every one bwrap's `--unshare-all` makes
 * (user, mount, network, pid, IPC, UTS, cgroup). Not `-a`, which also names
 * the time namespace the sandbox shares with the host, and nsenter can't
 * enter that one.
 */
const ENTERED_NAMESPACES = ['-U', '-m', '-n', '-p', '-i', '-u', '-C'];

/**
 * What every entered command runs under: no capabilities, now or after any
 * exec. A command nsenter starts in the sandbox's user namespace has every
 * capability there, enough to remount a read-only bind of a host directory
 * read-write. `setpriv` empties the bounding, inheritable and ambient sets,
 * and `noroot` (locked) keeps uid 0 from regaining them on exec.
 */
export const DROP_CAPABILITIES = ['/usr/bin/setpriv', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--securebits=+noroot,+noroot_locked', '--'];

function nsenterArgs(pid: number): string[] {
  return ['-t', String(pid), ...ENTERED_NAMESPACES, '--preserve-credentials', '--root'];
}

/**
 * `nsenter` into the sandbox, drop every capability, then `env -C <cwd>`
 * inside it. Not nsenter's `--wd=<dir>`: it opens the directory on the host
 * before entering, which would leave the command's working directory on a
 * host mount, outside the sandbox's root.
 */
export function enterArgs(pid: number, command: string, args: readonly string[], cwd: string): { command: string; args: string[] } {
  return { command: 'nsenter', args: [...nsenterArgs(pid), ...DROP_CAPABILITIES, '/usr/bin/env', '-C', cwd, command, ...args] };
}

/** A setup command that keeps its capabilities: only the overlay mount, before any run command enters. */
function enterPrivileged(pid: number, script: string): { command: string; args: string[] } {
  return { command: 'nsenter', args: [...nsenterArgs(pid), '/bin/sh', '-c', script] };
}

/** Reads bwrap's `--info-fd` JSON for the child pid. */
function childPid(child: ChildProcess): Promise<number> {
  const info = child.stdio[3];
  return new Promise((resolve, reject) => {
    if (info === null || info === undefined) return reject(new NamespaceUnavailable('bwrap has no info pipe'));
    let text = '';
    info.on('data', (chunk) => { text += String(chunk); });
    info.once('end', () => {
      const pid = /"child-pid":\s*(\d+)/.exec(text)?.[1];
      if (pid === undefined) reject(new NamespaceUnavailable(`bwrap reported no child pid: ${text}`));
      else resolve(Number(pid));
    });
  });
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const fail = (reason: string) => reject(new NamespaceUnavailable(`the sandbox did not start: ${reason}\n${output}`));
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
      fail(`bwrap exited ${code}`);
    });
  });
}

/** Fails closed unless `ip -o link` inside the sandbox lists loopback alone. */
function assertLoopbackOnly(pid: number): void {
  const { command, args } = enterArgs(pid, 'ip', ['-o', 'link', 'show'], '/');
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new NamespaceUnavailable(`could not list the sandbox's interfaces:\n${result.stderr}`);
  const problem = loopbackOnlyProblem(linkNames(result.stdout));
  if (problem !== undefined) throw new NamespaceUnavailable(`the sandbox ${problem}`);
}

/** The script that mounts an in-memory overlay on each of `dirs`, inside the sandbox. */
export function overlayScript(dirs: readonly string[]): string {
  return dirs
    .map((dir, index) => {
      const layer = `/tmp/.overlay/${index}`;
      return `mkdir -p ${layer}/upper ${layer}/work && mount -t overlay overlay -o lowerdir=${dir},upperdir=${layer}/upper,workdir=${layer}/work ${dir}`;
    })
    .join(' && ');
}

/** Mounts the overlays from inside, with the capabilities every later command is denied. */
function mountOverlays(pid: number, dirs: readonly string[]): void {
  if (dirs.length === 0) return;
  const { command, args } = enterPrivileged(pid, overlayScript(dirs));
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new NamespaceUnavailable(`could not mount the overlays on ${dirs.join(', ')}:\n${result.stderr}`);
}

/** Fails closed unless `sandbox-inventory.ts` finds nothing inside the sandbox. */
function assertInventory(pid: number, ownDirs: readonly string[]): void {
  const { command, args } = enterArgs(pid, 'node', [INVENTORY, ...ownDirs], '/');
  const env = { ...process.env, UV_THREADPOOL_SIZE: String(READ_AHEAD_LISTINGS) };
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, env });
  console.error(`DIAG inventory ${result.stderr}`);
  if (result.status === 0) return;
  throw new NamespaceUnavailable(`the sandbox inventory failed (exit ${result.status}):\n${result.stdout}${result.stderr}`);
}

const isUnderTmp = (dir: string) => dir === '/tmp' || dir.startsWith('/tmp/');

/**
 * The run's own directories, whose sockets and writable mounts are its own:
 * the run root and its fresh /tmp. TMPDIR counts only inside that /tmp; one
 * elsewhere is walked like any other directory.
 */
export function ownDirs(runRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const tmpdir = env.TMPDIR?.replace(/\/+$/, '');
  const freshTmpdir = tmpdir !== undefined && tmpdir !== '' && isUnderTmp(tmpdir) ? [tmpdir] : [];
  return [...new Set([runRoot, '/tmp', ...freshTmpdir])];
}

/** How a sandbox's stop ended. */
export type SandboxStop = 'exited' | 'still-running';

/** A process's start time in clock ticks since boot, from /proc; null once it is gone. */
export function startTimeOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Waits for bwrap to exit: its `close` event, or /proc showing it exited
 * when no event said so. Under load Bun can miss a child's exit (#1274),
 * leaving it an unreaped zombie or reaping it without a `close`; a run
 * that waited on the event alone never ended (#1767). `started` is bwrap's
 * start time, read right after it was spawned; a null one (it was gone by
 * then) counts as exited. Past `exitMs` it kills bwrap, which takes the
 * sandbox down with it, and past `killMs` more it stops waiting and
 * resolves `still-running`.
 */
export async function awaitSandboxExit(child: ChildProcess, exited: Promise<void>, started: string | null, timing: StopTiming = STOP_TIMING): Promise<SandboxStop> {
  const pid = child.pid;
  // Gone, or its pid reused by another process; or a zombie nobody reaps.
  const exitedUnseen = () => pid === undefined || started === null || startTimeOf(pid) !== started || unreapedExit(pid) !== undefined;
  const exitWithin = (ms: number) => new Promise<boolean>((resolve) => {
    const settle = (hasExited: boolean) => {
      clearInterval(poll);
      clearTimeout(limit);
      resolve(hasExited);
    };
    const poll = setInterval(() => { if (exitedUnseen()) settle(true); }, timing.pollMs);
    const limit = setTimeout(() => settle(false), ms);
    void exited.then(() => settle(true));
  });
  if (await exitWithin(timing.exitMs)) return 'exited';
  if (!exitedUnseen()) child.kill('SIGKILL');
  if (await exitWithin(timing.killMs)) return 'exited';
  console.error(`▸ the sandbox (bwrap pid ${pid}) did not exit within ${(timing.exitMs + timing.killMs) / 1000}s of its stop, even after SIGKILL; the run is invalid`);
  return 'still-running';
}

/** The harness's view of its repo; `NamespaceUnavailable` when a package it needs can't be bound. */
function harnessViewOrRefuse(): ReturnType<typeof harnessView> {
  try {
    return harnessView();
  } catch (error) {
    throw new NamespaceUnavailable(`the harness's view of its repo is incomplete: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Starts a run's sandbox, checks it, and returns how to enter it. Throws
 * `NamespaceUnavailable`, having started nothing that stays running, when the
 * sandbox can't start or a check fails.
 */
export async function startEgressNamespace(options: SandboxOptions): Promise<EgressNamespace> {
  const missing = REQUIRED_TOOLS.filter((tool) => whichTool(tool) === undefined);
  if (missing.length > 0) throw new NamespaceUnavailable(`missing ${missing.join(', ')}: the harness runs builders only inside a sandbox`);
  const tmpdir = process.env.TMPDIR;
  const harness = harnessViewOrRefuse();
  const layout: SandboxLayout = {
    runRoot: options.runRoot,
    readOnly: [...harness.readOnly, ...toolchainDirs(), ...(options.readOnly ?? []), ...(options.overlaid ?? [])],
    views: harness.views,
    resolvConf: SANDBOX_RESOLV_CONF,
    hosts: SANDBOX_HOSTS,
    etc: ETC_ENTRIES.filter((entry) => existsSync(`/etc/${entry}`)),
    dirs: tmpdir ? [tmpdir] : [],
    innerViews: options.innerViews ?? [],
  };
  const spawnChild = options.spawnChild ?? spawn;
  const child = spawnChild('bwrap', [...sandboxArgs(layout), '--info-fd', '3', 'sh', '-c', HOLDER_SCRIPT, 'sh', HOLDER], {
    env: { PATH: process.env.PATH, PYRIC_BUILDER_NETWORK_LOG: options.networkLog },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  // Read now, while bwrap surely runs, so a pid reused after its exit never reads as bwrap.
  const started = child.pid === undefined ? null : startTimeOf(child.pid);
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  try {
    const [pid] = await Promise.all([childPid(child), waitForReady(child)]);
    assertLoopbackOnly(pid);
    mountOverlays(pid, options.overlaid ?? []);
    assertInventory(pid, ownDirs(options.runRoot));
    return {
      pid,
      enter: (command, args, cwd) => enterArgs(pid, command, args, cwd),
      async stop() {
        child.stdin?.end();
        return awaitSandboxExit(child, exited, started, options.stopTiming);
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    await awaitSandboxExit(child, exited, started, options.stopTiming);
    throw error;
  }
}
