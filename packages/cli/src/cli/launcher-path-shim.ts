/**
 * Execution-time `0700` `PATH` shim directory for `spawnSandboxChild` on POSIX.
 *
 * Bounds child-command runtime selection across nested shell expansions and
 * `package.json` script bodies by installing `bun` / `bunx` / `deno` stubs
 * (only for binaries that exist on the pre-shim `PATH`, preserving `command -v`
 * answers when absent) that print `formatUnsupportedRuntimeStop` and exit `1`.
 */
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatUnsupportedRuntimeStop } from './unsupported-runtime.js';

const UNSUPPORTED_CANDIDATES: ReadonlyArray<readonly [binary: string, runtime: 'bun' | 'deno']> = [
  ['bun', 'bun'],
  ['bunx', 'bun'],
  ['deno', 'deno'],
];

/** Quote a string as a single-quoted POSIX `/bin/sh` literal. */
function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Resolve an executable binary name along `searchPath`, ignoring empty entries and `excludeDir`. */
export function findExecutableOnPath(
  binaryName: string,
  searchPath: string | undefined,
  excludeDir?: string,
): string | null {
  if (!searchPath) return null;
  for (const rawEntry of searchPath.split(path.delimiter)) {
    if (rawEntry.length === 0) continue;
    const dir = path.resolve(rawEntry);
    if (excludeDir !== undefined && dir === path.resolve(excludeDir)) continue;
    const candidate = path.join(dir, binaryName);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export interface LauncherShimHandle {
  readonly shimDir: string | null;
  cleanup(): void;
}

/** Prepend `shimDir` to a `PATH` string without duplicating a leading entry. */
export function prependShimToPath(currentPath: string | undefined, shimDir: string | null): string | undefined {
  if (shimDir === null) return currentPath;
  if (!currentPath || currentPath.length === 0) return shimDir;
  const parts = currentPath.split(path.delimiter);
  if (parts[0] === shimDir) return currentPath;
  const rest = parts.filter((entry) => entry !== shimDir);
  return [shimDir, ...rest].join(path.delimiter);
}

/**
 * Create the per-child `0700` POSIX shim directory for `spawnSandboxChild`.
 * On Windows (`win32`), returns a no-op handle and leaves `win32` spawning as-is.
 */
export function createLauncherShimDir(input: {
  readonly preShimPath: string | undefined;
  readonly label?: string;
  readonly commandName?: string;
}): LauncherShimHandle {
  if (process.platform === 'win32') {
    return { shimDir: null, cleanup: () => {} };
  }

  const shimDir = mkdtempSync(path.join(tmpdir(), 'pyric-launch-shim-'));
  chmodSync(shimDir, 0o700);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(shimDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  };

  try {
    const cmdLabel = input.commandName ?? 'pyric sandbox';
    for (const [binary, runtime] of UNSUPPORTED_CANDIDATES) {
      if (findExecutableOnPath(binary, input.preShimPath, shimDir) === null) {
        continue;
      }
      const message = formatUnsupportedRuntimeStop(runtime, input.label, cmdLabel);
      const stubPath = path.join(shimDir, binary);
      const stubSource = `#!/bin/sh\nprintf '%s' ${posixSingleQuote(message)} >&2\nexit 1\n`;
      writeFileSync(stubPath, stubSource, { mode: 0o700 });
      chmodSync(stubPath, 0o700);
    }
  } catch (err) {
    cleanup();
    throw err;
  }

  return { shimDir, cleanup };
}
