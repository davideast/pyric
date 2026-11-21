/**
 * Managed subprocess execution for Swift live-host conformance suites.
 *
 * Separates cold SwiftPM compilation (`swift build --build-tests`) from live
 * bridge test execution (`swift test --skip-build`), streams stdout and stderr
 * incrementally to detect zero-output `swiftbuild` startup stalls on 2-core CI
 * runners, retries the build step once only on a zero-output startup stall, and
 * terminates the full POSIX process group on timeout so child compiler/test
 * workers cannot outlive the parent test.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export const SWIFT_LIVE_HOST_SCRATCH_SUBPATH = join('.build', 'live-host');
export const SWIFT_BUILD_STARTUP_STALL_TIMEOUT_MS = 60_000;
export const SWIFT_BUILD_TIMEOUT_MS = 240_000;
export const SWIFT_TEST_TIMEOUT_MS = 120_000;
export const SWIFT_LIVE_HOST_TEST_TIMEOUT_MS = 450_000;
export const SWIFT_BUILD_MAX_ATTEMPTS = 2;
const SUBPROCESS_KILL_GRACE_MS = 2_000;

export type SubprocessTimeoutReason = 'none' | 'startup-stall' | 'timeout';

export interface ManagedSubprocessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly startupStallTimeoutMs?: number;
  readonly killGraceMs?: number;
}

export interface ManagedSubprocessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
  readonly timeoutReason: SubprocessTimeoutReason;
  readonly receivedOutput: boolean;
}

export function collectProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function usesPosixProcessGroups(): boolean {
  return process.platform !== 'win32';
}

function hasStartupStallWindow(options: ManagedSubprocessOptions): boolean {
  if (options.startupStallTimeoutMs === undefined) {
    return false;
  }
  if (options.startupStallTimeoutMs <= 0) {
    return false;
  }
  return options.startupStallTimeoutMs < options.timeoutMs;
}

export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (usesPosixProcessGroups() && typeof pid === 'number' && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        return;
      }
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      throw error;
    }
  }
}

export async function runManagedSubprocess(
  options: ManagedSubprocessOptions,
): Promise<ManagedSubprocessResult> {
  const startedAt = Date.now();
  const useProcessGroup = usesPosixProcessGroups();
  let killGraceMs = SUBPROCESS_KILL_GRACE_MS;
  if (options.killGraceMs !== undefined) {
    killGraceMs = options.killGraceMs;
  }

  return await new Promise<ManagedSubprocessResult>((resolveResult, rejectResult) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useProcessGroup,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let receivedOutput = false;
    let timeoutReason: SubprocessTimeoutReason = 'none';
    let settled = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let postExitCloseTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (startupTimer !== undefined) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
      if (overallTimer !== undefined) {
        clearTimeout(overallTimer);
        overallTimer = undefined;
      }
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
      if (postExitCloseTimer !== undefined) {
        clearTimeout(postExitCloseTimer);
        postExitCloseTimer = undefined;
      }
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolveResult({
        exitCode,
        signal,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        elapsedMs: Date.now() - startedAt,
        timedOut: timeoutReason !== 'none',
        timeoutReason,
        receivedOutput,
      });
    };

    const triggerTimeout = (reason: Exclude<SubprocessTimeoutReason, 'none'>): void => {
      if (settled || timeoutReason !== 'none') {
        return;
      }
      timeoutReason = reason;
      if (startupTimer !== undefined) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
      if (overallTimer !== undefined) {
        clearTimeout(overallTimer);
        overallTimer = undefined;
      }
      terminateProcessTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        terminateProcessTree(child, 'SIGKILL');
      }, killGraceMs);
      forceKillTimer.unref();
    };

    const noteOutput = (chunk: string, target: string[]): void => {
      if (chunk.length === 0) {
        return;
      }
      target.push(chunk);
      if (!receivedOutput) {
        receivedOutput = true;
        if (startupTimer !== undefined) {
          clearTimeout(startupTimer);
          startupTimer = undefined;
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => noteOutput(chunk, stdoutChunks));
    child.stderr.on('data', (chunk: string) => noteOutput(chunk, stderrChunks));

    if (hasStartupStallWindow(options)) {
      startupTimer = setTimeout(() => {
        if (!receivedOutput) {
          triggerTimeout('startup-stall');
        }
      }, options.startupStallTimeoutMs);
      startupTimer.unref();
    }

    overallTimer = setTimeout(() => {
      triggerTimeout('timeout');
    }, options.timeoutMs);
    overallTimer.unref();

    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      rejectResult(error);
    });

    child.once('exit', (exitCode, signal) => {
      if (settled || timeoutReason === 'none') {
        return;
      }
      postExitCloseTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(exitCode, signal);
      }, 1_000);
      postExitCloseTimer.unref();
    });

    child.once('close', (exitCode, signal) => {
      finish(exitCode, signal);
    });
  });
}

export function formatSubprocessFailure(
  phase: string,
  attempt: number,
  result: ManagedSubprocessResult,
): string {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const status = [
    `phase=${phase}`,
    `attempt=${attempt}`,
    `exitCode=${String(result.exitCode)}`,
    `signal=${String(result.signal)}`,
    `elapsedMs=${result.elapsedMs}`,
    `timeoutReason=${result.timeoutReason}`,
    `receivedOutput=${result.receivedOutput}`,
  ].join(' ');
  if (combined.length === 0) {
    return `${status}\n(no stdout/stderr captured)`;
  }
  return `${status}\n${combined}`;
}

export interface SwiftBuildPhaseConfig {
  readonly swiftBinary: string;
  readonly repoRoot: string;
  readonly swiftPackageDir: string;
  readonly swiftScratchDir: string;
  readonly env: Record<string, string>;
  readonly runSubprocess?: (options: ManagedSubprocessOptions) => Promise<ManagedSubprocessResult>;
}

export async function buildSwiftLiveHostTests(
  config: SwiftBuildPhaseConfig,
): Promise<{ attempt: number; result: ManagedSubprocessResult }> {
  let runner = runManagedSubprocess;
  if (config.runSubprocess !== undefined) {
    runner = config.runSubprocess;
  }
  const buildArgs = [
    'build',
    '--build-tests',
    '--disable-index-store',
    '-Xswiftc',
    '-gnone',
    '--package-path',
    config.swiftPackageDir,
    '--scratch-path',
    config.swiftScratchDir,
  ];
  let lastAttempt = 1;
  let lastResult: ManagedSubprocessResult | undefined;
  for (let attempt = 1; attempt <= SWIFT_BUILD_MAX_ATTEMPTS; attempt += 1) {
    lastAttempt = attempt;
    const result = await runner({
      command: config.swiftBinary,
      args: buildArgs,
      cwd: config.repoRoot,
      env: config.env,
      timeoutMs: SWIFT_BUILD_TIMEOUT_MS,
      startupStallTimeoutMs: SWIFT_BUILD_STARTUP_STALL_TIMEOUT_MS,
    });
    lastResult = result;
    const isStartupStall = result.timeoutReason === 'startup-stall';
    if (!isStartupStall || attempt === SWIFT_BUILD_MAX_ATTEMPTS) {
      return { attempt, result };
    }
  }
  if (lastResult === undefined) {
    throw new Error('buildSwiftLiveHostTests finished without recording a subprocess result.');
  }
  return { attempt: lastAttempt, result: lastResult };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export async function waitForProcessExit(pid: number, maxWaitMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return !isProcessAlive(pid);
}
