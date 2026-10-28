import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runNodeHuntFixture(name: string, timeoutMs = 30_000): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'pyric-hosted-persistence-hunt-'));
  try {
    symlinkSync(new URL('../../../../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir');
    const fixture = readFileSync(new URL(`./fixtures/hosted-persistence-hunt-${name}.ts`, import.meta.url), 'utf8');
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
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    const failed = result.status !== 0;
    if (failed) throw new Error(`Node fixture '${name}' failed (${result.status}): ${result.stderr}`);
    return result.stdout.trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('writeSection("storage", ...) replaces existing Storage rows across buckets and rolls back on failure', async () => {
  expect(await runNodeHuntFixture('storage-section')).toBe('Storage section replacement passed');
});

test('writeSection("firestore", ...) preserves Auth and non-Firestore services when clearing or replacing documents', async () => {
  expect(await runNodeHuntFixture('firestore-section')).toBe('Firestore section isolation passed');
});

test('salvageHostedState recovers valid checkpoints and verified object blobs while quarantining corrupt checkpoint blobs', async () => {
  expect(await runNodeHuntFixture('salvage-checkpoints')).toBe('Checkpoint salvage passed');
});

test('SQLite chunked upload errors match worker Storage FirebaseError codes and messages without plane divergence', async () => {
  expect(await runNodeHuntFixture('upload-errors')).toBe('Upload error parity passed');
});
