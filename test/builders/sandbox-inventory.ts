/**
 * What a run's sandbox must not contain, checked from inside it. The harness
 * runs this when the sandbox starts, and the plant phase runs it again before
 * any plant, so a caller that skips the sandbox fails before anything is
 * planted. It only looks: it lists interfaces, reads resolv.conf, its own
 * capabilities and mount table, checks that some paths are absent, and walks
 * the file tree for socket files.
 *
 *   node test/builders/sandbox-inventory.ts <own dir>...
 *
 * prints `{"problems":[...],"walked":N}` and exits 1 when there is a problem.
 * `<own dir>` are the run's own directories (its run root and its fresh
 * /tmp), whose sockets and writable mounts are the run's own.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Paths the sandbox must not have: the Windows drives, WSL's interop and the user runtime directory. */
export const ABSENT_PATHS: readonly string[] = ['/mnt', '/run/WSL', '/run/user'];

/** Pseudo file systems the walk skips: their entries describe processes, not files a socket could live in. */
const PSEUDO_DIRS: readonly string[] = ['/proc', '/sys'];

/**
 * File systems the sandbox makes fresh, in memory, which may be writable
 * anywhere: nothing written to them reaches the host. An overlay counts only
 * when its upper layer is in the sandbox's /tmp.
 */
const FRESH_FILE_SYSTEMS: ReadonlySet<string> = new Set(['tmpfs', 'proc', 'devpts', 'mqueue']);

/**
 * Writable mounts of host files that are allowed, each with its reason:
 * bwrap's `--dev` binds these device nodes from the host's /dev. Writing to
 * them writes to the device, not to a file.
 */
export const WRITABLE_DEVICE_NODES: readonly string[] = ['/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom', '/dev/tty'];

/** A directory the walk may fail to list, and why that is safe. */
export interface Unlistable {
  pattern: RegExp;
  reason: string;
}

/**
 * The directories the walk may fail to list. Anything else it can't list is
 * a problem: it could hold a socket the walk did not see.
 */
export const UNLISTABLE: readonly Unlistable[] = [
  {
    pattern: /^\/usr\/lib\/modules\/[^/]+\/lost\+found$/,
    reason: 'the lost+found of the WSL kernel-modules image: root-only on the host, written only by fsck, and unreachable here too',
  },
];

export interface InventoryInput {
  /** The tree to inspect; `/` inside the sandbox. */
  root: string;
  /** Directories under `root` whose sockets and writable mounts are the run's own. */
  ownDirs: readonly string[];
  /** Interface names, from `ip -o link` and `os.networkInterfaces()`. */
  interfaces: readonly string[];
  /** `/proc/self/status` of the inspecting process. */
  status: string;
  /** `/proc/self/mountinfo` of the inspecting process. */
  mountinfo: string;
  /** Directories the walk may fail to list, each with its reason. */
  unlistable: readonly Unlistable[];
}

export interface Inventory {
  problems: string[];
  /** How many directories the walk listed. */
  walked: number;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The nameservers a resolv.conf names. */
export function nameservers(resolvConf: string): string[] {
  return resolvConf.split('\n').map((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1]).filter((server): server is string => server !== undefined);
}

/** The interface names `ip -o link show` lists, without a `@peer` suffix. */
export function linkNames(ipOutput: string): string[] {
  return ipOutput
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (line.split(':')[1]?.trim() ?? '').replace(/@.*$/, ''));
}

/** What is wrong with an interface list, or undefined when it is loopback alone. */
export function loopbackOnlyProblem(names: readonly string[]): string | undefined {
  const isLoopbackOnly = names.length === 1 && names[0] === 'lo';
  return isLoopbackOnly ? undefined : `has interfaces besides loopback: ${names.join(', ') || 'none'}`;
}

/** The problems with a process's capabilities: its effective and bounding sets must be empty. */
export function capabilityProblems(status: string): string[] {
  return ['CapEff', 'CapBnd'].flatMap((field) => {
    const value = new RegExp(`^${field}:\\s*([0-9a-f]+)$`, 'm').exec(status)?.[1];
    if (value === undefined) return [`${field} is missing from /proc/self/status`];
    return /^0+$/.test(value) ? [] : [`${field} is ${value}, not 0`];
  });
}

export interface Mount {
  mountPoint: string;
  options: string[];
  fileSystem: string;
  superOptions: string[];
}

/** A mountinfo path, with its octal escapes (`\040` for a space) decoded. */
const unescapeMountPath = (path: string) => path.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** Each line of a mountinfo table. */
export function parseMountinfo(mountinfo: string): Mount[] {
  return mountinfo
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      const [before, after] = line.split(' - ');
      const fields = before?.split(' ') ?? [];
      const [fileSystem, , superOptions] = after?.split(' ') ?? [];
      const mountPoint = fields[4];
      const options = fields[5];
      if (mountPoint === undefined || options === undefined || fileSystem === undefined) return [];
      return [{ mountPoint: unescapeMountPath(mountPoint), options: options.split(','), fileSystem, superOptions: (superOptions ?? '').split(',') }];
    });
}

const isUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir.replace(/\/+$/, '')}/`);

function isFresh(mount: Mount): boolean {
  if (FRESH_FILE_SYSTEMS.has(mount.fileSystem)) return true;
  if (mount.fileSystem !== 'overlay') return false;
  const upper = mount.superOptions.find((option) => option.startsWith('upperdir='))?.slice('upperdir='.length);
  return upper !== undefined && isUnder(upper, '/tmp');
}

/** Every writable mount that could write to the host: outside the run's own directories, not fresh, not a device node. */
export function mountProblems(mounts: readonly Mount[], ownDirs: readonly string[]): string[] {
  return mounts
    .filter((mount) => !mount.options.includes('ro'))
    .filter((mount) => !ownDirs.some((dir) => isUnder(mount.mountPoint, dir)))
    .filter((mount) => !isFresh(mount) && !WRITABLE_DEVICE_NODES.includes(mount.mountPoint))
    .map((mount) => `${mount.mountPoint} is mounted read-write (${mount.fileSystem})`);
}

function listed(dir: string): Dirent[] | undefined {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

/** Every socket file under `root`, without following symlinks, skipping `skip`, and every directory it could not list. */
export function socketFiles(root: string, skip: readonly string[]): { sockets: string[]; unlisted: string[]; walked: number } {
  const skipped = new Set(skip);
  const sockets: string[] = [];
  const unlisted: string[] = [];
  const pending = [root];
  let walked = 0;
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const entries = listed(dir);
    if (entries === undefined) {
      unlisted.push(dir);
      continue;
    }
    walked += 1;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (skipped.has(path)) continue;
      if (entry.isSocket()) sockets.push(path);
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return { sockets: sockets.sort(), unlisted: unlisted.sort(), walked };
}

/** The sandbox's problems; none means it has only what the harness put in it. */
export function inventory(input: InventoryInput): Inventory {
  const problems: string[] = [];
  const interfaceProblem = loopbackOnlyProblem([...new Set(input.interfaces)]);
  if (interfaceProblem !== undefined) problems.push(interfaceProblem);
  const resolvConf = join(input.root, 'etc/resolv.conf');
  const servers = exists(resolvConf) ? nameservers(readFileSync(resolvConf, 'utf8')) : [];
  const namesOnlyLoopback = servers.length === 1 && servers[0] === '127.0.0.1';
  if (!namesOnlyLoopback) problems.push(`/etc/resolv.conf names ${servers.join(', ') || 'no nameserver'}, not only 127.0.0.1`);
  for (const path of ABSENT_PATHS) {
    if (exists(join(input.root, path))) problems.push(`${path} exists`);
  }
  problems.push(...capabilityProblems(input.status));
  problems.push(...mountProblems(parseMountinfo(input.mountinfo), input.ownDirs));
  const skip = [...PSEUDO_DIRS, ...input.ownDirs].map((dir) => join(input.root, dir));
  const { sockets, unlisted, walked } = socketFiles(input.root, skip);
  if (sockets.length > 0) problems.push(`socket files outside the run's own directories: ${sockets.join(', ')}`);
  const inSandbox = (dir: string) => dir.slice(input.root.replace(/\/+$/, '').length) || '/';
  const unexplained = unlisted.filter((dir) => !input.unlistable.some((allowed) => allowed.pattern.test(inSandbox(dir))));
  if (unexplained.length > 0) problems.push(`directories the walk could not list, so could not check: ${unexplained.join(', ')}`);
  return { problems, walked };
}

/** What stands in for `ip`'s list when `ip -o link` fails, so the interface check fails too. */
export const IP_LINK_FAILED = '(ip -o link failed)';

/**
 * Interface names from `ip -o link`, which also lists interfaces with no
 * address, and from Node, which leaves those out. A failed `ip` never falls
 * back to Node's list alone.
 */
export function interfaceNames(ip: { status: number | null; stdout: string }, nodeNames: readonly string[]): string[] {
  const ipSucceeded = ip.status === 0;
  const listedByIp = ipSucceeded ? linkNames(ip.stdout) : [IP_LINK_FAILED];
  return [...listedByIp, ...nodeNames];
}

function sandboxInterfaces(): string[] {
  const ip = spawnSync('ip', ['-o', 'link', 'show'], { encoding: 'utf8' });
  return interfaceNames(ip, Object.keys(networkInterfaces()));
}

/** The inventory of the sandbox this process runs in. */
export function sandboxInventory(ownDirs: readonly string[]): Inventory {
  return inventory({
    root: '/',
    ownDirs,
    interfaces: sandboxInterfaces(),
    status: readFileSync('/proc/self/status', 'utf8'),
    mountinfo: readFileSync('/proc/self/mountinfo', 'utf8'),
    unlistable: UNLISTABLE,
  });
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const result = sandboxInventory(process.argv.slice(2));
  console.log(JSON.stringify(result));
  process.exit(result.problems.length === 0 ? 0 : 1);
}
