import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runNodeFixture(name: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'pyric-node-sqlite-test-'));
  try {
    symlinkSync(new URL('../../../../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir');
    const fixture = readFileSync(new URL(`./fixtures/hosted-sqlite-${name}.ts`, import.meta.url), 'utf8');
    const source = fixture.replaceAll('../../../src/', new URL('../../dist/', import.meta.url).href);
    const entry = join(directory, 'fixture.ts');
    writeFileSync(entry, source);
    const build = await Bun.build({
      entrypoints: [entry],
      outdir: directory,
      target: 'node',
      packages: 'external',
      naming: 'scenario.mjs',
    });
    expect(build.success).toBe(true);
    const result = spawnSync(process.env.PYRIC_TEST_NODE ?? 'node', [join(directory, 'scenario.mjs'), directory], {
      encoding: 'utf8', timeout: 15_000,
    });
    const failed = result.status !== 0;
    if (failed) throw new Error(`Node fixture failed (${result.status}): ${result.stderr}`);
    return result.stdout.trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('Storage stages chunked uploads and supports ranged reads', async () => {
  expect(await runNodeFixture('storage-chunked')).toBe('Storage chunked passed');
});
