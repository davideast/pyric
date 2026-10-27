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

/** The exit of `pid` if it is a zombie, an exited child nobody reaped; undefined while it runs. */
export function unreapedExit(pid: number, readStat: ReadStat = readProcStat): ChildExit | undefined {
  const line = readStat(pid);
  const stat = line === undefined ? undefined : parseProcStat(line);
  const isZombie = stat?.state === 'Z';
  return isZombie ? decodeExitStatus(stat.exitStatus) : undefined;
}

const hasProc = process.platform === 'linux' && existsSync('/proc/self/stat');

/**
 * Check `pid` every `intervalMs` and call `onExit` once if it turns out to
 * have exited unreaped. Returns the function that stops watching. A no-op
 * where there is no /proc.
 */
export function watchUnreapedExit(pid: number, onExit: (exit: ChildExit) => void, intervalMs = 500, readStat: ReadStat = readProcStat): () => void {
  if (!hasProc) return () => {};
  const timer = setInterval(() => {
    const exit = unreapedExit(pid, readStat);
    if (exit === undefined) return;
    clearInterval(timer);
    onExit(exit);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
