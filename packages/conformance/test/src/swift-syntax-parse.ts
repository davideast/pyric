import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'bun:test';

export const SWIFT_SYNTAX_PARSE_TEST_TIMEOUT_MS = 90_000;
const DEFAULT_PARSE_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const POST_EXIT_CLOSE_GRACE_MS = 1_000;

export interface SwiftFrontendParseCommand {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
}

export interface SwiftFrontendResolveDeps {
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fileExists?: (path: string) => boolean;
  readonly which?: (binary: string) => string | null;
  readonly realpath?: (path: string) => string;
}

export interface SwiftSyntaxParseOptions {
  readonly command?: SwiftFrontendParseCommand | null;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
}

export type SwiftSyntaxParseResult =
  | { readonly skipped: true }
  | {
      readonly skipped: false;
      readonly executable: string;
      readonly prefixArgs: readonly string[];
      readonly args: readonly string[];
      readonly status: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly timedOut: boolean;
      readonly elapsedMs: number;
      readonly stdout: string;
      readonly stderr: string;
    };

/**
 * Resolves a single-process Swift frontend parse command.
 *
 * Calling `swiftc -parse <files...>` without `-frontend` invokes `swift-driver`
 * in multi-file compilation mode, which spawns one `swift-frontend -primary-file`
 * process per input file (each reparsing every input file). On cold 2-core CI
 * runners where only `swift` and `swiftc` are symlinked into `/usr/local/bin`
 * (or on hosts whose `swiftc` is a non-symlink shim such as macOS `/usr/bin/swiftc`),
 * that fanout amplifies cold binary paging and CPU contention.
 *
 * This resolver prefers `swift-frontend` directly (checking `~/.local/swift`,
 * `$SWIFT_PATH`, `PATH`, and the realpath sibling of `swiftc`), and passes
 * `['-frontend', '-parse']` whenever it falls back to `swiftc`.
 */
export function resolveSwiftFrontendParseCommand(
  deps: SwiftFrontendResolveDeps = {},
): SwiftFrontendParseCommand | null {
  const homeDir = deps.homeDir ?? homedir();
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExists ?? existsSync;
  const which = deps.which ?? ((binary: string) => Bun.which(binary));
  const realpath = deps.realpath ?? realpathSync;

  const localFrontend = join(homeDir, '.local', 'swift', 'usr', 'bin', 'swift-frontend');
  if (fileExists(localFrontend)) {
    return { executable: localFrontend, prefixArgs: ['-parse'] };
  }

  const swiftPathEnv = env.SWIFT_PATH?.trim();
  if (swiftPathEnv) {
    const envFrontend = join(swiftPathEnv, 'swift-frontend');
    if (fileExists(envFrontend)) {
      return { executable: envFrontend, prefixArgs: ['-parse'] };
    }
  }

  const pathFrontend = which('swift-frontend');
  if (pathFrontend !== null) {
    return { executable: pathFrontend, prefixArgs: ['-parse'] };
  }

  const swiftc = which('swiftc');
  if (swiftc !== null) {
    let resolvedSwiftc = swiftc;
    try {
      resolvedSwiftc = realpath(swiftc);
    } catch {
      resolvedSwiftc = swiftc;
    }
    const siblingFrontend = join(dirname(resolvedSwiftc), 'swift-frontend');
    if (fileExists(siblingFrontend)) {
      return { executable: siblingFrontend, prefixArgs: ['-parse'] };
    }
    return { executable: swiftc, prefixArgs: ['-frontend', '-parse'] };
  }

  return null;
}

function terminateChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform !== 'win32' && typeof pid === 'number' && pid > 0) {
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

export async function parseSwiftFilesSyntax(
  files: readonly string[],
  options: SwiftSyntaxParseOptions = {},
): Promise<SwiftSyntaxParseResult> {
  const command =
    options.command !== undefined ? options.command : resolveSwiftFrontendParseCommand();
  if (command === null) {
    return { skipped: true };
  }

  const args = [...command.prefixArgs, ...files];
  const timeoutMs = options.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const startedAt = Date.now();
  const useProcessGroup = process.platform !== 'win32';

  return await new Promise<SwiftSyntaxParseResult>((resolveResult) => {
    const child = spawn(command.executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useProcessGroup,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let postExitCloseTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
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

    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolveResult({
        skipped: false,
        executable: command.executable,
        prefixArgs: command.prefixArgs,
        args,
        status,
        signal,
        timedOut,
        elapsedMs: Date.now() - startedAt,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrChunks.push(chunk);
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateChildProcess(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        terminateChildProcess(child, 'SIGKILL');
      }, killGraceMs);
    }, timeoutMs);

    child.once('error', (error: Error) => {
      stderrChunks.push(error.message);
      finish(null, null);
    });

    child.once('exit', (status, signal) => {
      postExitCloseTimer = setTimeout(() => {
        finish(status, signal);
      }, POST_EXIT_CLOSE_GRACE_MS);
    });

    child.once('close', (status, signal) => {
      finish(status, signal);
    });
  });
}

export async function expectSwiftFilesParseCleanly(
  files: readonly string[],
  options: SwiftSyntaxParseOptions = {},
): Promise<void> {
  const result = await parseSwiftFilesSyntax(files, options);
  if (result.skipped) {
    return;
  }
  const flagPreview = result.prefixArgs.join(' ');
  const diagnostic = [
    `Swift syntax parse failed via ${result.executable} ${flagPreview} (${files.length} file(s), ${result.elapsedMs}ms, timedOut=${result.timedOut}, status=${result.status}, signal=${result.signal})`,
    result.stdout.trim(),
    result.stderr.trim(),
  ]
    .filter((part) => part.length > 0)
    .join('\n');

  expect(result.timedOut, diagnostic).toBe(false);
  expect(result.status, diagnostic).toBe(0);
}
