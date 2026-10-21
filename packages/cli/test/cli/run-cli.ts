import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { dispatch, parseArgs } from '../../src/cli/index.js';

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
export const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');

/** Runs the real CLI entry in a child `bun` process. Each call costs a cold
 * start (about 0.4 s at idle, over 1 s under load), so a test that checks
 * many inputs runs one here as integration evidence and the rest through
 * {@link runDispatch}. */
export function runCli(args: string[], input?: string): CliRun {
  const result = spawnSync('bun', [CLI_ENTRY, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    input,
    timeout: 30_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Runs the same argument parser and dispatcher the CLI entry runs, in this
 * process, capturing what the command writes. The returned code is the one
 * the entry passes to `process.exit`. It captures only `process.stdout.write`
 * and `process.stderr.write`, not `console.*`. */
export async function runDispatch(args: string[]): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await dispatch(parseArgs(args)), stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}
