import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NODE_FIXTURE_TIMEOUT_MS = 30_000;
/**
 * Each test runs `Bun.build` and spawns a fresh `node` process that loads the
 * unbundled `dist/` ESM graph and opens SQLite WAL stores. Under 2-core CI
 * contention that exceeds Bun's 5 s default test timeout, so keep the test
 * budget above the subprocess timeout (`NODE_FIXTURE_TIMEOUT_MS`) to match
 * `hosted-runtime-hunt.test.ts` (#2922).
 */
const NODE_FIXTURE_TEST_TIMEOUT_MS = 45_000;

async function runNodeHuntFixture(name: string, timeoutMs = NODE_FIXTURE_TIMEOUT_MS): Promise<string> {
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
    const failed = result.status !== 0 || result.error !== undefined;
    if (failed) {
      const reason = result.error?.message ?? (result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
      throw new Error(`Node fixture '${name}' failed (${reason}): ${result.stderr}`);
    }
    return result.stdout.trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('writeSection("storage", ...) replaces existing Storage rows across buckets and rolls back on failure', async () => {
  expect(await runNodeHuntFixture('storage-section')).toBe('Storage section replacement passed');
}, NODE_FIXTURE_TEST_TIMEOUT_MS);

test('writeSection("firestore", ...) preserves Auth and non-Firestore services when clearing or replacing documents', async () => {
  expect(await runNodeHuntFixture('firestore-section')).toBe('Firestore section isolation passed');
}, NODE_FIXTURE_TEST_TIMEOUT_MS);

test('salvageHostedState recovers valid checkpoints and verified object blobs while quarantining corrupt checkpoint blobs', async () => {
  expect(await runNodeHuntFixture('salvage-checkpoints')).toBe('Checkpoint salvage passed');
}, NODE_FIXTURE_TEST_TIMEOUT_MS);

test('SQLite chunked upload errors match worker Storage FirebaseError codes and messages without plane divergence', async () => {
  expect(await runNodeHuntFixture('upload-errors')).toBe('Upload error parity passed');
}, NODE_FIXTURE_TEST_TIMEOUT_MS);

test('maximal hosted state roundtrip preserves scalar roots, promoted named RTDB rules, and checkpoints while quarantining corrupt rules and checkpoints on salvage', async () => {
  expect(await runNodeHuntFixture('state-roundtrip')).toBe('Maximal hosted state roundtrip passed');
}, NODE_FIXTURE_TEST_TIMEOUT_MS);
