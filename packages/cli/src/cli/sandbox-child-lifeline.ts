/**
 * Parent-death lifeline for detached `spawnSandboxChild` process groups (#1775).
 *
 * `SIGKILL` cannot be caught by `pyric sandbox`. To ensure the spawned child
 * command (and its process group) exits within a couple of seconds when the
 * host dies abruptly (`SIGKILL`, crash, OOM), the host holds the write end of a
 * pipe to a tiny detached POSIX `/bin/sh` watcher.
 *
 * - Normal child exit: `disarm()` writes `"disarm\n"` and closes the pipe, so
 *   the watcher exits `0` immediately without signalling anything.
 * - Abrupt host death (`SIGKILL`): the OS kernel closes the write end with EOF;
 *   the watcher verifies the process-group leader's `/proc/<pid>/stat` start
 *   time when `/proc` is present (guarding against PID reuse), sends `SIGTERM`
 *   to `-<childPid>`, and escalates to `SIGKILL` if the group is still alive
 *   after ~1.5 s.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isBrokenOutputPipeError } from './sandbox-process-guard.js';

export interface ChildLifeline {
  disarm(): void;
}

const POSIX_LIFELINE_SCRIPT = [
  'pgid="$1"',
  'expected_start="$2"',
  'IFS= read -r token || token=""',
  'if [ "$token" = "disarm" ]; then',
  '  exit 0',
  'fi',
  'if [ -n "$expected_start" ] && [ -r "/proc/$pgid/stat" ]; then',
  '  stat_line=$(cat "/proc/$pgid/stat" 2>/dev/null || true)',
  '  after_comm="${stat_line##*) }"',
  '  set -- $after_comm',
  '  actual_start="${20:-}"',
  '  if [ -n "$actual_start" ] && [ "$actual_start" != "$expected_start" ]; then',
  '    exit 0',
  '  fi',
  'fi',
  'kill -TERM "-$pgid" 2>/dev/null || exit 0',
  'i=0',
  'while [ "$i" -lt 15 ]; do',
  '  if ! kill -0 "-$pgid" 2>/dev/null; then',
  '    exit 0',
  '  fi',
  '  sleep 0.1 2>/dev/null || sleep 1',
  '  i=$((i + 1))',
  'done',
  'kill -KILL "-$pgid" 2>/dev/null || true',
  'exit 0',
].join('\n');

function isMissingProcError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES' || code === 'EPERM';
}

/**
 * Read field 22 (`starttime`) of `/proc/<pid>/stat` on Linux, or `null` when
 * `/proc` is unavailable or the process has already exited.
 */
export function readLinuxProcessStartTime(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen === -1) return null;
    const afterComm = raw.slice(closeParen + 2).trim().split(/\s+/);
    const startTime = afterComm[19];
    if (startTime !== undefined && /^\d+$/.test(startTime)) return startTime;
    return null;
  } catch (error) {
    if (isMissingProcError(error)) return null;
    throw error;
  }
}

/**
 * Start a kernel-pipe lifeline tied to this parent process's file descriptor
 * table so `childPid`'s detached process group is terminated if this parent
 * dies without calling `disarm()`.
 */
export function startChildLifeline(childPid: number | undefined): ChildLifeline {
  const noop: ChildLifeline = { disarm: () => {} };
  if (process.platform === 'win32') return noop;
  if (childPid === undefined || !Number.isInteger(childPid) || childPid <= 1) return noop;

  const expectedStart = readLinuxProcessStartTime(childPid) ?? '';
  let watcher;
  try {
    watcher = spawn(
      '/bin/sh',
      ['-c', POSIX_LIFELINE_SCRIPT, 'pyric-lifeline', String(childPid), expectedStart],
      {
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
        env: { PATH: '/usr/bin:/bin' },
      },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EAGAIN') return noop;
    throw error;
  }

  watcher.on('error', () => {});
  const stdin = watcher.stdin;
  stdin?.on('error', () => {});
  watcher.unref();
  (stdin as unknown as { unref?: () => void } | null)?.unref?.();

  let disarmed = false;
  return {
    disarm(): void {
      if (disarmed) return;
      disarmed = true;
      if (stdin === null || stdin.destroyed || stdin.writableEnded) return;
      try {
        stdin.end('disarm\n');
      } catch (error) {
        if (!isBrokenOutputPipeError(error)) throw error;
      }
    },
  };
}
