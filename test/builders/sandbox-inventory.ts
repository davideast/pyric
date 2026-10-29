/**
 * What a run's sandbox must not contain, checked from inside it. The harness
 * runs this when the sandbox starts, and the plant phase runs it again before
 * any plant, so a caller that skips the sandbox fails before anything is
 * planted. It only looks: it lists interfaces, reads resolv.conf, checks that
 * some paths are absent, and walks the file tree for socket files.
 *
 *   node test/builders/sandbox-inventory.ts <own dir>...
 *
 * prints `{"problems":[...],"walked":N}` and exits 1 when there is a problem.
 * `<own dir>` are the run's own directories (its run root and its fresh
 * /tmp), whose sockets are the run's own processes'.
 */
import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Paths the sandbox must not have: the Windows drives, WSL's interop and the user runtime directory. */
export const ABSENT_PATHS: readonly string[] = ['/mnt', '/run/WSL', '/run/user'];

/** Pseudo file systems the walk skips: their entries describe processes, not files a socket could live in. */
const PSEUDO_DIRS: readonly string[] = ['/proc', '/sys'];

export interface InventoryInput {
  /** The tree to inspect; `/` inside the sandbox. */
  root: string;
  /** Directories under `root` whose sockets are the run's own. */
  ownDirs: readonly string[];
  /** Interface names, as `os.networkInterfaces()` lists them. */
  interfaces: readonly string[];
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

function listed(dir: string): Dirent[] | undefined {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // A directory the run cannot list is one it cannot reach a socket in either.
    return undefined;
  }
}

/** Every socket file under `root`, without following symlinks, skipping `skip`. */
export function socketFiles(root: string, skip: readonly string[]): { sockets: string[]; walked: number } {
  const skipped = new Set(skip);
  const sockets: string[] = [];
  const pending = [root];
  let walked = 0;
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const entries = listed(dir);
    if (entries === undefined) continue;
    walked += 1;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (skipped.has(path)) continue;
      if (entry.isSocket()) sockets.push(path);
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return { sockets: sockets.sort(), walked };
}

/** The sandbox's problems; none means it has only what the harness put in it. */
export function inventory(input: InventoryInput): Inventory {
  const problems: string[] = [];
  const isLoopbackOnly = input.interfaces.length === 1 && input.interfaces[0] === 'lo';
  if (!isLoopbackOnly) problems.push(`interfaces besides loopback: ${input.interfaces.join(', ') || 'none'}`);
  const resolvConf = join(input.root, 'etc/resolv.conf');
  const servers = exists(resolvConf) ? nameservers(readFileSync(resolvConf, 'utf8')) : [];
  const namesOnlyLoopback = servers.length === 1 && servers[0] === '127.0.0.1';
  if (!namesOnlyLoopback) problems.push(`/etc/resolv.conf names ${servers.join(', ') || 'no nameserver'}, not only 127.0.0.1`);
  for (const path of ABSENT_PATHS) {
    if (exists(join(input.root, path))) problems.push(`${path} exists`);
  }
  const skip = [...PSEUDO_DIRS, ...input.ownDirs].map((dir) => join(input.root, dir));
  const { sockets, walked } = socketFiles(input.root, skip);
  if (sockets.length > 0) problems.push(`socket files outside the run's own directories: ${sockets.join(', ')}`);
  return { problems, walked };
}

/** The inventory of the sandbox this process runs in. */
export function sandboxInventory(ownDirs: readonly string[]): Inventory {
  return inventory({ root: '/', ownDirs, interfaces: Object.keys(networkInterfaces()) });
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const result = sandboxInventory(process.argv.slice(2));
  console.log(JSON.stringify(result));
  process.exit(result.problems.length === 0 ? 0 : 1);
}
