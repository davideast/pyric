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
import { existsSync, readFileSync } from 'node:fs';

/** How a child ended: its exit code, or the signal that ended it. */
export interface ChildExit {
  code: number | null;
  signal: number | null;
}

/** A child's state letter and waitpid-style exit status, from one /proc/<pid>/stat line. */
export function parseProcStat(line: string): { state: string; exitStatus: number } | undefined {
  // `pid (comm) state …`: comm can hold spaces and parentheses, so split after the last `)`.
  const afterComm = line.slice(line.lastIndexOf(')') + 2).trim().split(/\s+/);
  const state = afterComm[0];
  // Field 3 is the state, so field 52, exit_code, is 49 places after it.
  const exitStatus = Number(afterComm[49]);
  const isComplete = state !== undefined && Number.isInteger(exitStatus);
  return isComplete ? { state, exitStatus } : undefined;
}

/** Decode a waitpid status: an exit code when the child exited, a signal when one ended it. */
export function decodeExitStatus(status: number): ChildExit {
  const signal = status & 0x7f;
  const hasExited = signal === 0;
  return hasExited ? { code: (status >> 8) & 0xff, signal: null } : { code: null, signal };
}

/** The line a log gets when a child's exit came from /proc, not from the runner. */
export function describeUnreapedExit(name: string, exit: ChildExit): string {
  const ending = exit.code === null ? `was ended by signal ${exit.signal}` : `exited with code ${exit.code}`;
  return `\n[driver] ${name} ${ending}, and the runner never reaped it; read from /proc (#1274)\n`;
}

export type ReadStat = (pid: number) => string | undefined;

const readProcStat: ReadStat = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
};

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
  return hasLiveThreads ? undefined : decodeExitStatus(stat.exitStatus);
}

const hasProc = process.platform === 'linux' && existsSync('/proc/self/stat');

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
