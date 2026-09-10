/**
 * `surfaceMethodCommand`, the thin registry entry a generated `pyric <tool>
 * <method>` command wraps: it returns a handler that lazily imports the
 * runner (so `pyric --help` never pays for the sandbox import graph) and
 * delegates to `runSurfaceMethod` with the key it was built for.
 *
 * The runner's own behaviour (flags to arguments, validation, state
 * persistence) is `surface-method-runner.test.ts`'s subject; this file only
 * pins that the wrapper resolves to the right key and reports through the
 * process streams `runSurfaceMethod` defaults to when a caller supplies no
 * deps, which is what every generated command does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs } from '../../src/cli/parse-args.js';
import { surfaceMethodCommand } from '../../src/cli/surface-method-command.js';

const workDir = mkdtempSync(join(tmpdir(), 'pyric-surface-command-'));
const originalCwd = process.cwd();

beforeAll(() => process.chdir(workDir));
afterAll(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

/** Run one command handler, capturing what it wrote to stdout. */
async function run(handler: (parsed: ReturnType<typeof parseArgs>) => Promise<number>, argv: string[]) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await handler(parseArgs(argv));
    return { code, stdout: captured };
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe('surfaceMethodCommand', () => {
  it('builds a handler that runs the record the key names', async () => {
    const handler = surfaceMethodCommand('sandbox.inspect');
    const result = await run(handler, ['sandbox', 'inspect', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('ok', true);
  });

  it('gives two different keys two independently working handlers', async () => {
    const other = surfaceMethodCommand('auth.whoami');
    const result = await run(other, ['auth', 'whoami']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('The next call runs as');
  });
});
