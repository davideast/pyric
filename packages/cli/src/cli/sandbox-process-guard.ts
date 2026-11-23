/**
 * Process-level output-pipe, uncaught-error, exit-flush, and parent-loss
 * guards for `pyric sandbox` (#1195, #1551, #1677).
 *
 * When the reader of `pyric sandbox`'s stdout or stderr exits (for example
 * `pyric sandbox --hosted 2>&1 | head -3`, or a scenario/tool parent closing
 * its pipes), writes to `process.stdout` or `process.stderr` emit `EPIPE` /
 * `ERR_STREAM_DESTROYED`. Without an `'error'` listener on both streams and a
 * broken-pipe filter in `installServeProcessGuard`, each `uncaughtException`
 * writes to `process.stderr` again, starving the libuv poll phase (`SIGINT`,
 * `SIGTERM`, and `SIGCHLD`) in a tight next-tick loop.
 */

/**
 * The parent PID at the moment the CLI process started. Captured before async
 * startup work so a parent that exits while `startServe` is still booting is
 * still detected as lost (#1551).
 */
export const INITIAL_PARENT_PID: number = process.ppid;

const BROKEN_OUTPUT_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'EIO',
  'EBADF',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'EOF',
]);

export interface GuardedWritableStream {
  writable?: boolean;
  destroyed?: boolean;
  writableEnded?: boolean;
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

const brokenStreams = new WeakSet<object>();

/**
 * Whether `reason` is an output-stream error caused by a closed pipe, closed
 * pseudo-terminal, or destroyed stdout/stderr handle.
 */
export function isBrokenOutputPipeError(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false;
  const code = (reason as { code?: unknown }).code;
  if (typeof code === 'string' && BROKEN_OUTPUT_CODES.has(code)) return true;
  if (reason instanceof Error) {
    return /\b(?:EPIPE|ERR_STREAM_DESTROYED|ERR_STREAM_WRITE_AFTER_END)\b/.test(reason.message);
  }
  return false;
}

function isStreamClosed(stream: GuardedWritableStream): boolean {
  if (brokenStreams.has(stream)) return true;
  if (stream.destroyed === true) return true;
  if (stream.writableEnded === true) return true;
  if (stream.writable === false) return true;
  return false;
}

/**
 * Write `text` to `stream` when it is still open, dropping writes once the
 * reader end of the pipe or terminal has closed.
 */
export function writeStreamQuietly(stream: GuardedWritableStream, text: string): void {
  if (isStreamClosed(stream)) return;
  try {
    stream.write(text);
  } catch (error) {
    if (isBrokenOutputPipeError(error)) {
      brokenStreams.add(stream);
      return;
    }
    throw error;
  }
}

/**
 * Attach `'error'` listeners to `streams` (defaulting to `process.stdout` and
 * `process.stderr`) that absorb broken-pipe errors and mark the stream closed
 * instead of raising `uncaughtException`. Returns the uninstaller.
 */
export function installOutputPipeGuard(
  streams: readonly GuardedWritableStream[] = [process.stdout, process.stderr],
): () => void {
  const cleanups: Array<() => void> = [];
  for (const stream of streams) {
    const onError = (error: unknown): void => {
      if (isBrokenOutputPipeError(error)) {
        brokenStreams.add(stream);
        return;
      }
      if (error instanceof Error) throw error;
      throw new Error(String(error));
    };
    stream.on('error', onError);
    cleanups.push(() => {
      stream.off('error', onError);
    });
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Process-level last line of defense for `pyric sandbox`: unhandled rejections
 * and uncaught exceptions are logged and the server stays alive, while broken
 * output-pipe errors and re-entrant logger failures are dropped so reporting
 * can never trigger a `process.stderr` feedback loop (#1195, #1677, #1551).
 */
export function installServeProcessGuard(
  log: (message: string) => void,
  proc: Pick<NodeJS.Process, 'on' | 'off'> = process,
): () => void {
  let reporting = false;
  const describe = (reason: unknown): string => {
    if (reason instanceof Error) {
      return reason.stack ?? reason.message;
    }
    return String(reason);
  };
  const reportSafely = (label: string, reason: unknown): void => {
    if (reporting || isBrokenOutputPipeError(reason)) return;
    reporting = true;
    try {
      log(
        `  \u2716 pyric sandbox: ${label}. The server was kept alive. Please report this:\n` +
          `    ${describe(reason).split('\n').join('\n    ')}`,
      );
    } catch (error) {
      if (!isBrokenOutputPipeError(error)) throw error;
    } finally {
      reporting = false;
    }
  };
  const onRejection = (reason: unknown): void => {
    reportSafely('unhandled rejection', reason);
  };
  const onException = (err: unknown): void => {
    reportSafely('uncaught exception', err);
  };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off('unhandledRejection', onRejection);
    proc.off('uncaughtException', onException);
  };
}

export interface WatchParentLossOptions {
  readonly initialPpid?: number;
  readonly readPpid?: () => number;
  readonly intervalMs?: number;
}

/**
 * Poll `process.ppid` and invoke `onOrphaned` once if this CLI process has
 * parent PID 1 or if the parent process that spawned it exits (reparenting
 * this process to PID 1 or a subreaper). Returns the stop function.
 */
export function watchParentLoss(
  onOrphaned: () => void,
  opts: WatchParentLossOptions = {},
): () => void {
  const spawnedBy = opts.initialPpid ?? INITIAL_PARENT_PID;
  if (!Number.isInteger(spawnedBy) || spawnedBy < 1) {
    return () => {};
  }
  const readPpid = opts.readPpid ?? (() => process.ppid);
  const intervalMs = opts.intervalMs ?? 500;
  const isOrphanedPpid = (currentPpid: number): boolean => {
    if (currentPpid === 1) return true;
    return spawnedBy > 1 && currentPpid !== spawnedBy;
  };
  let fired = false;
  const check = (): void => {
    if (fired) return;
    if (isOrphanedPpid(readPpid())) {
      fired = true;
      clearInterval(timer);
      onOrphaned();
    }
  };
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  if (isOrphanedPpid(readPpid())) {
    fired = true;
    clearInterval(timer);
    queueMicrotask(onOrphaned);
  }
  return () => {
    fired = true;
    clearInterval(timer);
  };
}

export interface ServeShutdownSignals {
  readonly signal: Promise<NodeJS.Signals>;
  dispose(): void;
}

/**
 * Listen for `SIGINT`, `SIGTERM`, and parent-process loss (`watchParentLoss`),
 * resolving `signal` on the first shutdown trigger while keeping signal
 * handlers installed until `dispose()` runs (#1195, #1551).
 */
export function installServeShutdownSignals(
  initialPpid: number = INITIAL_PARENT_PID,
): ServeShutdownSignals {
  const { promise: signal, resolve: resolveSignal } = Promise.withResolvers<NodeJS.Signals>();
  const onSigint = (): void => resolveSignal('SIGINT');
  const onSigterm = (): void => resolveSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const stopParentWatch = watchParentLoss(() => resolveSignal('SIGTERM'), { initialPpid });
  return {
    signal,
    dispose(): void {
      stopParentWatch();
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    },
  };
}

/**
 * Swallow teardown errors during process shutdown while explicitly binding the
 * error parameter so shutdown continues through remaining resources.
 */
export function ignoreShutdownError(error: unknown): void {
  void error;
}

/**
 * Default teardown deadline for `pyric sandbox` signal shutdown (#1543).
 * Must exceed `STOP_DEADLINE_MS` (2,000 ms) + WebSocket close fallback (500 ms)
 * while leaving >= 1,000 ms headroom for `flushStandardStreamsBeforeExit`
 * (500 ms) inside callers' 5,000 ms `SIGTERM` exit budget.
 */
export const DEFAULT_TEARDOWN_DEADLINE_MS = 3_500;

/**
 * Run `teardown()` bounded by an unref'd `deadlineMs` timer so a wedged socket
 * or close callback cannot keep `pyric sandbox` alive indefinitely after a
 * shutdown signal.
 */
export async function runBoundedTeardown(
  teardown: () => Promise<void>,
  deadlineMs = DEFAULT_TEARDOWN_DEADLINE_MS,
): Promise<void> {
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const deadlinePromise = new Promise<void>((resolveDeadline) => {
    deadlineTimer = setTimeout(resolveDeadline, deadlineMs);
    deadlineTimer.unref();
  });
  try {
    await Promise.race([teardown(), deadlinePromise]);
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

/**
 * Flush open standard streams before calling `exitImpl(code)`, skipping broken
 * or destroyed pipes and bounding total wait time so a closed or stalled pipe
 * can never prevent the CLI from exiting.
 */
export function flushStandardStreamsBeforeExit(
  code: number,
  exitImpl: (exitCode: number) => void = (exitCode) => process.exit(exitCode),
  streams: readonly GuardedWritableStream[] = [process.stdout, process.stderr],
  maxWaitMs = 500,
): void {
  let exited = false;
  const cleanups: Array<() => void> = [];
  const finishExit = (): void => {
    if (exited) return;
    exited = true;
    clearTimeout(deadlineTimer);
    for (const cleanup of cleanups) cleanup();
    exitImpl(code);
  };
  const deadlineTimer = setTimeout(finishExit, maxWaitMs);
  deadlineTimer.unref?.();

  let remaining = streams.length;
  if (remaining === 0) {
    finishExit();
    return;
  }

  for (const stream of streams) {
    let settled = false;
    const onError = (error: unknown): void => {
      if (isBrokenOutputPipeError(error)) {
        brokenStreams.add(stream);
      }
      settleStream();
    };
    const onClose = (): void => {
      settleStream();
    };
    const settleStream = (): void => {
      if (settled) return;
      settled = true;
      remaining -= 1;
      if (remaining === 0) finishExit();
    };
    stream.on('error', onError);
    stream.once('close', onClose);
    cleanups.push(() => {
      stream.off('error', onError);
      stream.off('close', onClose);
    });

    if (isStreamClosed(stream)) {
      settleStream();
      continue;
    }
    try {
      stream.write('', () => {
        settleStream();
      });
    } catch (error) {
      if (isBrokenOutputPipeError(error)) {
        brokenStreams.add(stream);
        settleStream();
        continue;
      }
      throw error;
    }
  }
}
