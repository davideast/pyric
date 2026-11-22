/**
 * Keeps app-scenario process groups from outliving their scenario or runner (#1484).
 *
 * Every `AppProcess` starts with `detached: true`, so it leads its own process
 * group (`-pid`). That creates two escape paths when nothing else tracks it:
 *   1. If `bun test/apps/run.ts` (or a test process driving `AppProcess`) is
 *      ended by `SIGTERM`, `SIGINT`, or `SIGKILL`, detached groups survive as
 *      orphans. A small out-of-process Node reaper holds the read end of an
 *      unref'd pipe to this runner; when the runner exits for any reason
 *      (`SIGKILL` included), kernel pipe EOF wakes the reaper to terminate any
 *      still-registered groups and their descendant groups.
 *   2. A command such as `pyric sandbox -- next dev` spawns its own child with
 *      `detached: true`, placing `next dev` in a second process group. When
 *      `stop()` has to `SIGKILL` the outer group, snapshotting `/proc`
 *      descendant groups before the leader dies lets `stop()` reap the inner
 *      group too.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { liveGroupMembers, parseProcStat, type ReadStat } from './unreaped-exit.ts';

const hasProc = process.platform === 'linux' && existsSync('/proc/self/stat');
const POLL_ALIVE_MS = 25;

const defaultReadStat: ReadStat = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES' || code === 'EPERM') {
      return undefined;
    }
    throw error;
  }
};

function defaultListPids(): number[] {
  try {
    return readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') return [];
    throw error;
  }
}

function ownProcessGroup(readStat: ReadStat): number {
  const selfLine = readStat(process.pid);
  if (selfLine === undefined) return process.pid;
  const selfStat = parseProcStat(selfLine);
  return selfStat?.group ?? process.pid;
}

function signalGroupIfPresent(group: number, signal: NodeJS.Signals | 0): boolean {
  if (!Number.isInteger(group) || group <= 1) return false;
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Finds process groups started by `rootGroup` (or by groups already in `into`)
 * by walking `/proc` `parent -> child` links while the parent links still exist,
 * adding any descendant group other than init (`<= 1`), `rootGroup`, and this
 * runner's own group into `into`.
 */
export function collectDescendantGroups(
  rootGroup: number,
  into: Set<number>,
  readStat: ReadStat = defaultReadStat,
  listPids: () => number[] = defaultListPids,
): void {
  if (!Number.isInteger(rootGroup) || rootGroup <= 1) return;
  const usesCustomProc = readStat !== defaultReadStat || listPids !== defaultListPids;
  if (!hasProc && !usesCustomProc) return;

  const selfGroup = ownProcessGroup(readStat);
  const childrenByParent = new Map<number, number[]>();
  const groupByPid = new Map<number, number>();
  const seedPids = new Set<number>();

  for (const pid of listPids()) {
    const line = readStat(pid);
    if (line === undefined) continue;
    const stat = parseProcStat(line);
    if (stat === undefined || stat.state === 'X') continue;
    groupByPid.set(pid, stat.group);
    let siblings = childrenByParent.get(stat.parent);
    if (siblings === undefined) {
      siblings = [];
      childrenByParent.set(stat.parent, siblings);
    }
    siblings.push(pid);
    if (pid === rootGroup || stat.group === rootGroup || into.has(stat.group)) {
      seedPids.add(pid);
    }
  }

  const queue = [...seedPids];
  const visited = new Set<number>(queue);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) continue;
    const children = childrenByParent.get(current);
    if (children === undefined) continue;
    for (const childPid of children) {
      if (!visited.has(childPid)) {
        visited.add(childPid);
        queue.push(childPid);
      }
      const childGroup = groupByPid.get(childPid);
      const isDistinctSubgroup =
        childGroup !== undefined &&
        childGroup > 1 &&
        childGroup !== rootGroup &&
        childGroup !== selfGroup;
      if (isDistinctSubgroup) {
        into.add(childGroup);
      }
    }
  }
}

/** Whether any non-zombie process still runs in any of `groups`. */
export function hasLiveGroupProcesses(
  groups: ReadonlySet<number>,
  readStat: ReadStat = defaultReadStat,
  listPids: () => number[] = defaultListPids,
): boolean {
  const usesCustomProc = readStat !== defaultReadStat || listPids !== defaultListPids;
  if (hasProc || usesCustomProc) {
    for (const group of groups) {
      if (group <= 1) continue;
      if (liveGroupMembers(group, readStat, listPids).length > 0) return true;
    }
    return false;
  }
  for (const group of groups) {
    if (signalGroupIfPresent(group, 0)) return true;
  }
  return false;
}

/** Sends `SIGKILL` at once to every group in `groups` other than this runner's own. */
export function killProcessGroupsNow(groups: ReadonlySet<number>): void {
  let selfGroup = process.pid;
  if (hasProc) selfGroup = ownProcessGroup(defaultReadStat);
  for (const group of groups) {
    if (group <= 1 || group === selfGroup) continue;
    signalGroupIfPresent(group, 'SIGCONT');
    signalGroupIfPresent(group, 'SIGKILL');
  }
}

/**
 * Terminates any live members of `groups` (`SIGTERM`, then `SIGKILL` after up to
 * `graceMs`), returning at once when every group in `groups` is already empty.
 */
export async function endProcessGroups(groups: ReadonlySet<number>, graceMs: number): Promise<void> {
  let selfGroup = process.pid;
  if (hasProc) selfGroup = ownProcessGroup(defaultReadStat);
  const targets = new Set<number>();
  for (const group of groups) {
    if (group > 1 && group !== selfGroup) targets.add(group);
  }
  if (targets.size === 0 || !hasLiveGroupProcesses(targets)) return;

  for (const group of targets) {
    signalGroupIfPresent(group, 'SIGCONT');
    signalGroupIfPresent(group, 'SIGTERM');
  }
  const deadline = performance.now() + Math.max(0, graceMs);
  while (hasLiveGroupProcesses(targets) && performance.now() < deadline) {
    const waitMs = Math.min(POLL_ALIVE_MS, Math.max(1, deadline - performance.now()));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  if (hasLiveGroupProcesses(targets)) {
    killProcessGroupsNow(targets);
  }
}

const REAPER_SOURCE = `
const fs = require('node:fs');
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {});
}
const hasProc = process.platform === 'linux' && fs.existsSync('/proc/self/stat');
function parseStat(line) {
  const end = line.lastIndexOf(')');
  if (end === -1) return null;
  const fields = line.slice(end + 2).trim().split(/\\s+/);
  const state = fields[0];
  const parent = Number(fields[1]);
  const group = Number(fields[2]);
  if (!state || !Number.isInteger(parent) || !Number.isInteger(group)) return null;
  return { state, parent, group };
}
function isProcMiss(e) {
  const code = e && e.code;
  return code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES' || code === 'EPERM';
}
function readSelfGroup() {
  if (!hasProc) return process.pid;
  try {
    return parseStat(fs.readFileSync('/proc/self/stat', 'utf8'))?.group ?? process.pid;
  } catch (e) {
    if (isProcMiss(e)) return process.pid;
    throw e;
  }
}
const selfGroup = readSelfGroup();
const groups = new Set();
let buf = '';
function applyLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  const op = trimmed[0];
  const id = Number(trimmed.slice(1).trim());
  if (!Number.isInteger(id) || id <= 1 || id === selfGroup) return;
  if (op === '+') groups.add(id);
  else if (op === '-') groups.delete(id);
}
function expandWithProc(seed) {
  const all = new Set(seed);
  if (!hasProc || all.size === 0) return all;
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch (e) {
    if (isProcMiss(e)) return all;
    throw e;
  }
  const children = new Map();
  const pgidOf = new Map();
  const queue = [];
  const seen = new Set();
  for (const name of entries) {
    if (!/^\\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat = null;
    try {
      stat = parseStat(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'));
    } catch (e) {
      if (isProcMiss(e)) continue;
      throw e;
    }
    if (!stat || stat.state === 'X') continue;
    pgidOf.set(pid, stat.group);
    let list = children.get(stat.parent);
    if (!list) { list = []; children.set(stat.parent, list); }
    list.push(pid);
    if (all.has(pid) || all.has(stat.group)) {
      seen.add(pid);
      queue.push(pid);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const kids = children.get(queue[i]);
    if (!kids) continue;
    for (const k of kids) {
      if (!seen.has(k)) { seen.add(k); queue.push(k); }
      const g = pgidOf.get(k);
      if (g && g > 1 && g !== selfGroup) all.add(g);
    }
  }
  return all;
}
function groupAlive(g) {
  if (hasProc) {
    let entries = [];
    try {
      entries = fs.readdirSync('/proc');
    } catch (e) {
      if (isProcMiss(e)) return false;
      throw e;
    }
    for (const name of entries) {
      if (!/^\\d+$/.test(name)) continue;
      let stat = null;
      try {
        stat = parseStat(fs.readFileSync('/proc/' + name + '/stat', 'utf8'));
      } catch (e) {
        if (isProcMiss(e)) continue;
        throw e;
      }
      if (stat && stat.group === g && stat.state !== 'Z' && stat.state !== 'X') return true;
    }
    return false;
  }
  try {
    process.kill(-g, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}
function signalAll(targets, sig) {
  for (const g of targets) {
    try {
      process.kill(-g, sig);
    } catch (e) {
      const code = e && e.code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw e;
    }
  }
}
let reaping = false;
function reapAndExit() {
  if (reaping) return;
  reaping = true;
  if (buf.length > 0) applyLine(buf);
  if (groups.size === 0) process.exit(0);
  setTimeout(() => process.exit(0), 5000).unref();
  const targets = expandWithProc(groups);
  signalAll(targets, 'SIGCONT');
  signalAll(targets, 'SIGTERM');
  const deadline = Date.now() + 1000;
  const tick = () => {
    const expanded = expandWithProc(targets);
    for (const g of expanded) targets.add(g);
    const anyAlive = [...targets].some(groupAlive);
    if (!anyAlive) process.exit(0);
    if (Date.now() >= deadline) {
      signalAll(targets, 'SIGCONT');
      signalAll(targets, 'SIGKILL');
      process.exit(0);
    }
    setTimeout(tick, 50);
  };
  setTimeout(tick, 50);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    applyLine(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
  }
});
process.stdin.on('end', reapAndExit);
process.stdin.on('close', reapAndExit);
process.stdin.on('error', reapAndExit);
`;

let reaperChild: ChildProcess | null = null;

function ensureReaper(): ChildProcess | null {
  if (reaperChild !== null && reaperChild.exitCode === null && !reaperChild.killed) {
    return reaperChild;
  }
  try {
    const child = spawn('node', ['-e', REAPER_SOURCE], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    child.unref();
    child.on('error', () => {
      if (reaperChild === child) reaperChild = null;
    });
    child.on('exit', () => {
      if (reaperChild === child) reaperChild = null;
    });
    const stdin = child.stdin;
    if (stdin !== null) {
      stdin.on('error', () => {});
      const unrefable = stdin as unknown as { unref?: () => void };
      if (typeof unrefable.unref === 'function') unrefable.unref();
    }
    reaperChild = child;
    return child;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EAGAIN' || code === 'EMFILE') return null;
    throw error;
  }
}

function writeReaperCommand(line: string): void {
  const child = ensureReaper();
  const stdin = child?.stdin;
  if (stdin === undefined || stdin === null || stdin.destroyed || !stdin.writable) return;
  stdin.write(line);
}

/** Registers detached process group `group` to be terminated if this runner dies. */
export function trackGroupOnRunnerExit(group: number): void {
  if (!Number.isInteger(group) || group <= 1) return;
  writeReaperCommand(`+${group}\n`);
}

/** Unregisters `groups` once they have already stopped, so exited groups do not accumulate. */
export function untrackGroupsOnRunnerExit(groups: Iterable<number>): void {
  if (reaperChild === null) return;
  const stdin = reaperChild.stdin;
  if (stdin === null || stdin.destroyed || !stdin.writable) return;
  let batch = '';
  for (const group of groups) {
    if (Number.isInteger(group) && group > 1) batch += `-${group}\n`;
  }
  if (batch.length > 0) stdin.write(batch);
}
