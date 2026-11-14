/**
 * Execution-time `0700` `PATH` shim directory for `spawnSandboxChild` on POSIX.
 *
 * Bounds child-command execution regardless of nested shell expansions or
 * `package.json` script bodies by:
 *   1. Installing `bun` / `bunx` / `deno` stubs (only for binaries that exist on
 *      the pre-shim `PATH`, preserving `command -v` answers when absent) that
 *      print `formatUnsupportedRuntimeStop` and exit `1`.
 *   2. Installing a `node` wrapper that re-asserts `PROTECTED_LAUNCHER_ENV_KEYS`
 *      and merges `--import <registerUrl>` into `NODE_OPTIONS` before `exec`ing
 *      the real `node` binary resolved from the pre-shim `PATH`.
 */
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROTECTED_LAUNCHER_ENV_KEYS } from './sandbox-env-sanitizer.js';
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

function resolveRealNodeBinary(preShimPath: string | undefined, shimDir: string): string | null {
  const fromPath = findExecutableOnPath('node', preShimPath, shimDir);
  if (fromPath !== null) return fromPath;
  const currentExecBase = path.basename(process.execPath).toLowerCase();
  if ((currentExecBase === 'node' || currentExecBase === 'node.exe') && isExecutableFile(process.execPath)) {
    return process.execPath;
  }
  return null;
}

export interface LauncherShimHandle {
  readonly shimDir: string | null;
  readonly bashEnvPath: string | null;
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
  readonly env: NodeJS.ProcessEnv;
  readonly registerUrl: string;
  readonly label?: string;
  readonly commandName?: string;
}): LauncherShimHandle {
  if (process.platform === 'win32') {
    return { shimDir: null, bashEnvPath: null, cleanup: () => {} };
  }

  const shimDir = mkdtempSync(path.join(tmpdir(), 'pyric-launch-shim-'));
  const bashEnvPath = `${shimDir}.bash-env`;
  chmodSync(shimDir, 0o700);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(shimDir, { recursive: true, force: true });
      rmSync(bashEnvPath, { force: true });
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

    const realNode = resolveRealNodeBinary(input.preShimPath, shimDir);
    if (realNode !== null) {
      const lines = ['#!/bin/sh'];
      if (input.env.PYRIC_SANDBOX) {
        for (const key of PROTECTED_LAUNCHER_ENV_KEYS) {
          const val = input.env[key];
          if (val !== undefined) {
            lines.push(`export ${key}=${posixSingleQuote(val)}`);
          }
        }
        const quotedUrl = posixSingleQuote(input.registerUrl);
        lines.push(
          `case " \${NODE_OPTIONS-} " in`,
          `  *" --import "${quotedUrl}" "*|*" --import="${quotedUrl}" "*|*" "${quotedUrl}" "*) ;;`,
          `  *) export NODE_OPTIONS="\${NODE_OPTIONS:+\${NODE_OPTIONS} }--import "${quotedUrl} ;;`,
          `esac`,
        );
      }
      lines.push(`exec ${posixSingleQuote(realNode)} "$@"\n`);
      const nodeShimPath = path.join(shimDir, 'node');
      writeFileSync(nodeShimPath, lines.join('\n'), { mode: 0o700 });
      chmodSync(nodeShimPath, 0o700);
    }

    const quotedShim = posixSingleQuote(shimDir);
    const quotedRc = posixSingleQuote(bashEnvPath);
    const bashEnvLines = [
      `if [ -n "\${__PYRIC_ORIG_BASH_ENV:-}" ] && [ "\${__PYRIC_ORIG_BASH_ENV}" != ${quotedRc} ] && [ -f "\${__PYRIC_ORIG_BASH_ENV}" ]; then`,
      '  . "${__PYRIC_ORIG_BASH_ENV}"',
      'fi',
      'case "${PATH:-}" in',
      `  ${quotedShim}|${quotedShim}:*) ;;`,
      `  *) export PATH=${quotedShim}\${PATH:+":\${PATH}"} ;;`,
      'esac\n',
    ];
    writeFileSync(bashEnvPath, bashEnvLines.join('\n'), { mode: 0o600 });
    chmodSync(bashEnvPath, 0o600);
  } catch (err) {
    cleanup();
    throw err;
  }

  return { shimDir, bashEnvPath, cleanup };
}
