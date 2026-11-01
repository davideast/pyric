// A machine-wide limit on heavy test runs: full suites (`bun run test`) and
// app scenario runs (`bun test/apps/run.ts`). Each heavy run takes one of a
// few slots before it samples the machine and starts its jobs; a run that
// finds every slot taken waits, and names who holds each one, until a slot
// frees. Targeted `bun test <file>` runs never take a slot.
//
// Slots are files `slot-<i>.lock` in ~/.cache/pyric/heavy-runs/, under the
// home directory rather than the temp directory, because agent sessions can
// set different temp directories and the limit must be one for all of them.
// A slot is taken by an exclusive create: the holder's record is written to a
// private file first and then hard-linked to the slot's name, which fails if
// the slot exists, so no reader ever sees a half-written slot.
//
// A slot is stale when its holder's pid is gone, or is alive with a different
// process start time (a reused pid). A waiter moves a stale slot aside to a
// unique name before removing it, and checks that what it moved is the record
// it judged stale, so two waiters cannot both take it over. The rules follow
// the SharedWorker build lock in #1217, adapted for slots.
//
// A waiter wakes on `fs.watch` when a slot is removed, and every 5 s, which
// catches a holder killed with SIGKILL (that removes nothing). There is no
// deadline: heavy runs start in the background, so a long wait costs nothing.
//
// A process started under a run that holds a slot (the test-all jobs, a test
// that spawns test-all) inherits PYRIC_HEAVY_RUN_SLOT and runs inside its
// parent's slot instead of waiting for a second one.
//
// Settings: PYRIC_HEAVY_RUN_SLOTS (default 2) and PYRIC_HEAVY_RUN_DIR (the
// slot directory, for tests). There is no setting that skips the limit.

import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

export const DEFAULT_SLOTS = 2;
export const RECHECK_MS = 5000;
/** Set in a slot holder's environment, so the processes it starts run inside its slot. */
export const HELD_SLOT_ENV = 'PYRIC_HEAVY_RUN_SLOT';
const STOP_SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
type StopSignal = keyof typeof STOP_SIGNALS;

export interface SlotHolder {
  pid: number;
  /** The holder's start time in clock ticks since boot, from /proc; null where /proc is missing. */
  processStart: string | null;
  host: string;
  cwd: string;
  command: string;
  /** When the holder took the slot, in ms since the epoch. */
  takenAt: number;
  token: string;
}

export interface HeavyRunSlotOptions {
  /** What the holder runs, as people type it. Defaults to this process's command line. */
  command?: string;
  env?: NodeJS.ProcessEnv;
  /** Where the waiting lines go. */
  log?: (line: string) => void;
}

export interface HeavyRunSlot {
  /** The slot file, or the parent's when this run is inside a parent's slot. */
  path: string;
  release(): void;
}

export function slotDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.PYRIC_HEAVY_RUN_DIR ?? join(homedir(), '.cache', 'pyric', 'heavy-runs');
}

export function slotCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PYRIC_HEAVY_RUN_SLOTS;
  if (raw === undefined || raw === '') return DEFAULT_SLOTS;
  const parsed = Number(raw);
  const isPositiveInteger = Number.isInteger(parsed) && parsed >= 1;
  if (!isPositiveInteger) throw new Error(`PYRIC_HEAVY_RUN_SLOTS takes a whole number of at least 1, received "${raw}"`);
  return parsed;
}

/** Field 22 of /proc/<pid>/stat: when the process started, in clock ticks since boot. */
export function processStartOf(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // The command name (field 2) is in parentheses and may hold spaces.
  const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return afterName[19] ?? null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function readHolder(path: string): SlotHolder | null | 'missing' {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
  try {
    return JSON.parse(text) as SlotHolder;
  } catch {
    return null;
  }
}

/** A holder on another host is never judged here; its pid means nothing on this one. */
export function isStale(holder: SlotHolder | null): boolean {
  if (holder === null) return true;
  const isOtherHost = holder.host !== hostname();
  if (isOtherHost) return false;
  if (!isProcessAlive(holder.pid)) return true;
  const startNow = processStartOf(holder.pid);
  const canCompareStart = holder.processStart !== null && startNow !== null;
  return canCompareStart && startNow !== holder.processStart;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function describeHolder(holder: SlotHolder, now: number): string {
  return `${holder.command} in ${holder.cwd}, pid ${holder.pid}, ${formatDuration(now - holder.takenAt)}`;
}

export function waitingLine(holders: readonly SlotHolder[], slots: number, now: number): string {
  const named = holders.map((holder) => describeHolder(holder, now)).join('; ');
  return `waiting for a heavy-run slot (${holders.length} of ${slots} in use): ${named}`;
}

function defaultCommand(env: NodeJS.ProcessEnv): string {
  const script = env.npm_lifecycle_event;
  if (script !== undefined && script !== '') return `bun run ${script}`;
  const [entry, ...args] = process.argv.slice(1);
  return ['bun', entry === undefined ? '' : shortPath(entry), ...args].join(' ').trim();
}

/** A script path relative to the working directory when it is inside it, absolute otherwise. */
function shortPath(path: string): string {
  const fromCwd = relative(process.cwd(), path);
  const isInsideCwd = !fromCwd.startsWith('..') && !isAbsolute(fromCwd);
  return isInsideCwd ? fromCwd : path;
}

function newHolder(command: string): SlotHolder {
  return {
    pid: process.pid,
    processStart: processStartOf(process.pid),
    host: hostname(),
    cwd: process.cwd(),
    command,
    takenAt: Date.now(),
    token: randomBytes(8).toString('hex'),
  };
}

/** Link a fully written record to the slot's name; the link fails if the slot is held. */
function tryTake(dir: string, path: string, holder: SlotHolder): boolean {
  const pending = join(dir, `.pending-${holder.token}`);
  writeFileSync(pending, JSON.stringify(holder));
  try {
    linkSync(pending, path);
    return true;
  } catch (error) {
    if (isCode(error, 'EEXIST')) return false;
    throw error;
  } finally {
    unlinkSync(pending);
  }
}

/**
 * Move a stale slot aside and remove it. If what was moved is not the record
 * judged stale (a waiter took the slot over in between), put it back.
 */
function breakStale(path: string, judged: SlotHolder | null): boolean {
  const aside = `${path}.stale-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
  const moved = readHolder(aside);
  const movedTheStaleRecord = moved !== 'missing' && moved?.token === judged?.token;
  if (!movedTheStaleRecord) restore(aside, path);
  unlinkSync(aside);
  return movedTheStaleRecord;
}

function restore(aside: string, path: string): void {
  try {
    linkSync(aside, path);
  } catch (error) {
    // A third waiter took the empty slot first; the live holder keeps running
    // and its release leaves the newer record alone.
    if (!isCode(error, 'EEXIST')) throw error;
  }
}

const SLOT_FILE = /^slot-\d+\.lock$/;

/**
 * Wakes a waiter when a slot file is created or removed, or after a timeout.
 * Changes to the private pending files waiters write are ignored, or every
 * waiter's own scan would wake it again.
 */
class Wakeup {
  private changed = false;
  private wake: (() => void) | undefined;
  private readonly watcher: FSWatcher;

  constructor(dir: string) {
    this.watcher = watch(dir, (_event, filename) => {
      const isSlotChange = filename === null || SLOT_FILE.test(String(filename));
      if (!isSlotChange) return;
      this.changed = true;
      this.wake?.();
    });
  }

  /** Clears the change mark before a scan, so a change during the scan wakes the next wait at once. */
  beforeScan(): void {
    this.changed = false;
  }

  wait(ms: number): Promise<void> {
    if (this.changed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  close(): void {
    this.watcher.close();
  }
}

function slotPaths(dir: string, slots: number): string[] {
  return Array.from({ length: slots }, (_, index) => join(dir, `slot-${index}.lock`));
}

/** The live holders, after removing any stale slot. Returns null when a stale slot was removed. */
function liveHolders(paths: readonly string[]): SlotHolder[] | null {
  const holders: SlotHolder[] = [];
  for (const path of paths) {
    const holder = readHolder(path);
    if (holder === 'missing') return null;
    if (isStale(holder) && breakStale(path, holder)) return null;
    if (holder !== null) holders.push(holder);
  }
  return holders;
}

function holdersKey(holders: readonly SlotHolder[]): string {
  return holders.map((holder) => holder.token).sort().join(',');
}

/** True when this process runs under a parent that holds a slot, as a test-all job does. */
function inheritedSlot(env: NodeJS.ProcessEnv): string | undefined {
  const path = env[HELD_SLOT_ENV];
  if (path === undefined || path === '') return undefined;
  const holder = readHolder(path);
  const isHeld = holder !== 'missing' && !isStale(holder);
  return isHeld ? path : undefined;
}

function releaseOnExit(path: string, token: string): () => void {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const holder = readHolder(path);
    const isOurs = holder !== 'missing' && holder?.token === token;
    if (isOurs) unlinkSync(path);
  };
  process.on('exit', release);
  for (const signal of Object.keys(STOP_SIGNALS) as StopSignal[]) {
    process.on(signal, () => {
      release();
      // A run with its own handler (test-all stops its jobs first) exits there.
      const isOnlyHandler = process.listenerCount(signal) === 1;
      if (isOnlyHandler) process.exit(STOP_SIGNALS[signal]);
    });
  }
  return release;
}

/**
 * Take a heavy-run slot, waiting as long as it takes. The slot is released
 * when the process exits or is stopped by SIGINT, SIGTERM or SIGHUP.
 */
export async function takeHeavyRunSlot(options: HeavyRunSlotOptions = {}): Promise<HeavyRunSlot> {
  const env = options.env ?? process.env;
  const inherited = inheritedSlot(env);
  if (inherited !== undefined) return { path: inherited, release: () => {} };
  const dir = slotDirectory(env);
  const slots = slotCount(env);
  const log = options.log ?? ((line: string) => console.log(line));
  mkdirSync(dir, { recursive: true });
  const holder = newHolder(options.command ?? defaultCommand(env));
  const paths = slotPaths(dir, slots);
  const wakeup = new Wakeup(dir);
  let lastPrinted = '';
  try {
    for (;;) {
      wakeup.beforeScan();
      const taken = paths.find((path) => tryTake(dir, path, holder));
      if (taken !== undefined) {
        env[HELD_SLOT_ENV] = taken;
        return { path: taken, release: releaseOnExit(taken, holder.token) };
      }
      const holders = liveHolders(paths);
      if (holders === null) continue;
      const key = holdersKey(holders);
      if (key !== lastPrinted) log(waitingLine(holders, slots, Date.now()));
      lastPrinted = key;
      await wakeup.wait(RECHECK_MS);
    }
  } finally {
    wakeup.close();
  }
}
