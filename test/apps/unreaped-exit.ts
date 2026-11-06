/**
 * The exit of a child that has exited but was never reaped (#1274).
 *
 * Under load, Bun (the runner) can miss a child's exit when several children
 * exit at once: the child stays a zombie, Bun never calls waitpid for it, and
 * the `exit` and `close` events never come. A scenario then waits on a
 * process that finished long ago ("did not exit within 60s", "did not close
 * within 5s of SIGKILL").
 *
 * Linux keeps a zombie's exit status in /proc/<pid>/stat (field 52,
 * `exit_code`, in waitpid's format), so the driver can read it and treat the
 * child as exited. Elsewhere there is no /proc, and watching is a no-op.
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/**
 * How a child ended: its exit code, or the signal that ended it. `unknown`
 * when /proc would not show the status (no ptrace access to the child), which
 * the kernel prints as 0 and must not be read as success.
 */
export interface ChildExit {
  code: number | null;
  signal: number | null;
  unknown?: true;
}

/** The fields of one /proc/<pid>/stat line the driver reads. */
export interface ProcStat {
  comm: string;
  state: string;
  parent: number;
  group: number;
  /** Field 35. A process that is not running shows 1 only to a reader with ptrace access. */
  wchan: number;
  exitStatus: number;
}

export function parseProcStat(line: string): ProcStat | undefined {
  // `pid (comm) state …`: comm can hold spaces and parentheses, so split after the last `)`.
  const comm = line.slice(line.indexOf('(') + 1, line.lastIndexOf(')'));
  const afterComm = line.slice(line.lastIndexOf(')') + 2).trim().split(/\s+/);
  // afterComm[0] is field 3, so field N is afterComm[N - 3].
  const state = afterComm[0];
  const parent = Number(afterComm[1]);
  const group = Number(afterComm[2]);
  const wchan = Number(afterComm[32]);
  const exitStatus = Number(afterComm[49]);
  const isComplete = state !== undefined && [parent, group, wchan, exitStatus].every(Number.isInteger);
  return isComplete ? { comm, state, parent, group, wchan, exitStatus } : undefined;
}

/** Decode a waitpid status: an exit code when the child exited, a signal when one ended it. */
export function decodeExitStatus(status: number): ChildExit {
  const signal = status & 0x7f;
  const hasExited = signal === 0;
  return hasExited ? { code: (status >> 8) & 0xff, signal: null } : { code: null, signal };
}

/**
 * How long the driver waits, after a child's `exit`, for its output pipes to
 * close. A process the child started can inherit them and hold them open
 * long after the child is gone, and then `close` never comes.
 */
export const OUTPUT_CLOSE_GRACE_MS = 5000;

function ending(code: number | null, signal: NodeJS.Signals | number | null): string {
  return code === null ? `was ended by ${signal === null ? 'a signal' : `signal ${signal}`}` : `exited with code ${code}`;
}

/** A process found in /proc: its pid and command name. */
export interface LiveProcess {
  pid: number;
  comm: string;
}

/**
 * The line a log gets when a child exited and `close` never came. With
 * processes still running in its group, they are named: one of them holds
 * the pipes, and the app fails unless its scenario expects them. With none,
 * the runner lost `close`, and the exit counts.
 */
export function describeHeldPipes(name: string, code: number | null, signal: NodeJS.Signals | null, leftovers: readonly LiveProcess[], graceMs = OUTPUT_CLOSE_GRACE_MS): string {
  const wait = `${graceMs / 1000}s`;
  if (leftovers.length === 0) {
    return `\n[driver] ${name} ${ending(code, signal)}; its output pipes did not report closing ${wait} later, and no process is left in its group, so the runner lost \`close\`; the driver records the exit (#1274)\n`;
  }
  const named = leftovers.map((leftover) => `pid ${leftover.pid} (${leftover.comm})`).join(', ');
  return `\n[driver] ${name} ${ending(code, signal)}, and ${wait} later processes it started still run in its group, holding its output pipes: ${named}; the app fails unless its scenario expects them (#1274)\n`;
}

/** The line a log gets when a child's exit came from /proc, not from the runner. */
export function describeUnreapedExit(name: string, exit: ChildExit): string {
  if (exit.unknown) return `\n[driver] ${name} exited, and the runner never reaped it; /proc would not show its exit status (no ptrace access), so it counts as failed (#1274)\n`;
  return `\n[driver] ${name} ${ending(exit.code, exit.signal)}, and the runner never reaped it; read from /proc (#1274)\n`;
}

export type ReadStat = (pid: number) => string | undefined;

const readProcStat: ReadStat = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
};

const hasProc = process.platform === 'linux' && existsSync('/proc/self/stat');

/** How many threads /proc/<pid>/status lists; a leader thread can be a zombie while others run. */
export type ReadThreads = (pid: number) => number | undefined;

const readProcThreads: ReadThreads = (pid) => {
  try {
    const match = /^Threads:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The exit of `pid` if the whole process has exited and nobody reaped it;
 * undefined while it runs. A zombie leader thread whose other threads still
 * run has not exited.
 */
export function unreapedExit(pid: number, readStat: ReadStat = readProcStat, readThreads: ReadThreads = readProcThreads): ChildExit | undefined {
  const line = readStat(pid);
  const stat = line === undefined ? undefined : parseProcStat(line);
  const isZombie = stat?.state === 'Z';
  if (!isZombie) return undefined;
  const hasLiveThreads = (readThreads(pid) ?? 1) > 1;
  if (hasLiveThreads) return undefined;
  // Without ptrace access the kernel prints 0 for both wchan and exit_code.
  const isStatusVisible = stat.wchan === 1;
  return isStatusVisible ? decodeExitStatus(stat.exitStatus) : { code: null, signal: null, unknown: true };
}

/**
 * The processes still running in process group `group`, other than zombies.
 * An app process is its own group's leader, so after it exits these are the
 * processes it started that outlived it.
 */
export function liveGroupMembers(group: number, readStat: ReadStat = readProcStat, listPids: () => number[] = listProcPids): LiveProcess[] {
  if (!hasProc) return [];
  const members: LiveProcess[] = [];
  for (const pid of listPids()) {
    const line = readStat(pid);
    const stat = line === undefined ? undefined : parseProcStat(line);
    const isLiveMember = stat !== undefined && stat.group === group && stat.state !== 'Z' && stat.state !== 'X';
    if (isLiveMember) members.push({ pid, comm: stat.comm });
  }
  return members;
}

/** A process's command line, its arguments joined by spaces. */
export type ReadCmdline = (pid: number) => string | undefined;

const readProcCmdline: ReadCmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+$/, '').replaceAll('\0', ' ');
  } catch {
    return undefined;
  }
};

/**
 * One line per live process in `group`: pid, parent, state and command line.
 * For a command stopped at its time limit, it names what was still running,
 * such as an install script npm started and is waiting on (#1476).
 */
export function describeGroupProcesses(
  group: number,
  readStat: ReadStat = readProcStat,
  listPids: () => number[] = listProcPids,
  readCmdline: ReadCmdline = readProcCmdline,
): string {
  if (!hasProc) return '(no /proc on this platform)';
  const lines: string[] = [];
  for (const pid of listPids()) {
    const line = readStat(pid);
    const stat = line === undefined ? undefined : parseProcStat(line);
    const isMember = stat !== undefined && stat.group === group;
    if (!isMember) continue;
    const command = readCmdline(pid) || `(${stat.comm})`;
    lines.push(`pid ${pid} parent ${stat.parent} state ${stat.state}: ${command}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

function listProcPids(): number[] {
  return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).map(Number);
}


/**
 * What /proc says about `pid` right now, for a log line when the driver gives
 * up on a child: its state letter (R running, S sleeping, D uninterruptible,
 * Z zombie, T stopped), its thread count, and its parent. Empty off Linux.
 */
export function describeProcState(pid: number, readStat: ReadStat = readProcStat, readThreads: ReadThreads = readProcThreads): string {
  if (!hasProc) return '';
  const line = readStat(pid);
  if (line === undefined) return `; /proc has no ${pid}, so something reaped it`;
  const stat = parseProcStat(line);
  return `; /proc/${pid}: state ${stat?.state ?? '?'}, ${readThreads(pid) ?? '?'} threads, parent ${stat?.parent ?? '?'}`;
}

/** How the watcher polls. Every child is a zombie for a moment before it is reaped. */
export interface WatchTiming {
  intervalMs: number;
  /**
   * How long a child must stay an unreaped zombie before it counts as missed.
   * A normal exit is reaped, and its output drained, within milliseconds, so
   * this only ever fires for an exit the runner really lost.
   */
  graceMs: number;
}

const DEFAULT_TIMING: WatchTiming = { intervalMs: 500, graceMs: 3000 };

/** The waits `watchChildExit` uses. Tests pass short ones; the runner uses the defaults. */
export interface ExitTiming {
  /** How long after `exit` to wait for `close` (`OUTPUT_CLOSE_GRACE_MS` by default). */
  outputCloseGraceMs: number;
  /** How the unreaped-zombie watcher polls. */
  zombie: WatchTiming;
}

export const DEFAULT_EXIT_TIMING: ExitTiming = { outputCloseGraceMs: OUTPUT_CLOSE_GRACE_MS, zombie: DEFAULT_TIMING };

/**
 * Check `pid` every `intervalMs` and call `onExit` once if it has stayed an
 * unreaped zombie for `graceMs`. Returns the function that stops watching. A
 * no-op where there is no /proc.
 */
export function watchUnreapedExit(pid: number, onExit: (exit: ChildExit) => void, timing: WatchTiming = DEFAULT_TIMING, readStat: ReadStat = readProcStat): () => void {
  if (!hasProc) return () => {};
  let zombieSince: number | undefined;
  const timer = setInterval(() => {
    const exit = unreapedExit(pid, readStat);
    if (exit === undefined) {
      zombieSince = undefined;
      return;
    }
    zombieSince ??= performance.now();
    const hasOutlastedGrace = performance.now() - zombieSince >= timing.graceMs;
    if (!hasOutlastedGrace) return;
    clearInterval(timer);
    onExit(exit);
  }, timing.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** How a watched child's exit was learned. */
export type ExitSource = 'close' | 'held-pipes' | 'lost-close' | 'unreaped';

/** What the watcher learned about a child's exit. */
export interface WatchedExit {
  code: number | null;
  source: ExitSource;
  /** The line the log should carry; empty for a plain `close`. */
  note: string;
  /** Processes the child started that outlived it in its group (`held-pipes` only). */
  leftovers: LiveProcess[];
}

/**
 * Settle once on whichever comes first: `close`; `exit` followed by
 * `timing.outputCloseGraceMs` with no `close`; or the child staying an
 * unreaped zombie for `timing.zombie.graceMs`. On the second, /proc says which it was: live
 * processes in the child's group (`held-pipes`, a process it started holds
 * the pipes) or none (`lost-close`, the runner lost the event). An unknown
 * zombie status settles with code null. Returns the function that stops
 * watching. `child` must lead its own process group (spawned detached).
 */
export function watchChildExit(child: ChildProcess, name: string, onExit: (exit: WatchedExit) => void, timing: ExitTiming = DEFAULT_EXIT_TIMING): () => void {
  let settled = false;
  let pipeTimer: ReturnType<typeof setTimeout> | undefined;
  let stopZombieWatch: () => void = () => {};
  const stop = () => {
    settled = true;
    if (pipeTimer !== undefined) clearTimeout(pipeTimer);
    stopZombieWatch();
  };
  const settle = (exit: WatchedExit) => {
    if (settled) return;
    stop();
    onExit(exit);
  };
  child.on('close', (code) => settle({ code, source: 'close', note: '', leftovers: [] }));
  child.on('exit', (code, signal) => {
    // Reaped: the pid is free from here on, so /proc no longer describes this child.
    stopZombieWatch();
    pipeTimer = setTimeout(() => {
      const leftovers = child.pid === undefined ? [] : liveGroupMembers(child.pid);
      const source = leftovers.length > 0 ? 'held-pipes' : 'lost-close';
      settle({ code, source, note: describeHeldPipes(name, code, signal, leftovers, timing.outputCloseGraceMs), leftovers });
    }, timing.outputCloseGraceMs);
    pipeTimer.unref();
  });
  if (child.pid !== undefined) {
    stopZombieWatch = watchUnreapedExit(child.pid, (exit) => settle({ code: exit.code, source: 'unreaped', note: describeUnreapedExit(name, exit), leftovers: [] }), timing.zombie);
  }
  return stop;
}

/**
 * End what is left of process group `group`: SIGTERM, then SIGKILL after
 * `termMs`. Signals reach only that group's members. A group id stays
 * reserved while any member lives, so this cannot reach another group.
 */
export async function endGroup(group: number, termMs: number): Promise<void> {
  try { process.kill(-group, 'SIGTERM'); } catch { return; /* the group is gone */ }
  await new Promise((resolve) => setTimeout(resolve, termMs));
  try { process.kill(-group, 'SIGKILL'); } catch { /* the group is gone */ }
}
