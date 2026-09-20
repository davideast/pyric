import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runNodeFixture(name: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'pyric-node-sqlite-test-'));
  try {
    symlinkSync(new URL('../../../../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir');
    // Exercise the built Node artifact; Bun only strips the fixture's types.
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

test('Node persists isolated record namespaces across a database restart', async () => {
  expect(await runNodeFixture('records')).toBe('Record restart passed');
});

test('a failed batch rolls back updates and deletions together', async () => {
  expect(await runNodeFixture('rollback')).toBe('Rollback passed');
});

test('Storage retains binary bytes, metadata and bucket isolation after restart', async () => {
  expect(await runNodeFixture('storage')).toBe('Storage restart passed');
});

test('unsupported database versions refuse startup without replacing data', async () => {
  expect(await runNodeFixture('version')).toBe('Version refusal passed');
});

test('the Node host recovers acknowledged writes without modifying legacy JSON', async () => {
  expect(await runNodeFixture('runtime')).toBe('Hosted restart passed');
});

test('malformed Auth state refuses hosted startup instead of losing accounts', async () => {
  expect(await runNodeFixture('malformed')).toBe('Malformed state refused');
});

test('salvage retains readable documents without changing the damaged source', async () => {
  expect(await runNodeFixture('salvage')).toBe('Salvage passed');
});

// Runtime support is checked before --fresh is allowed to move user data.
test('Bun rejects hosted fresh without archiving the existing directory', async () => {
  const { mkdirSync, writeFileSync, readFileSync, readdirSync } = await import('node:fs');
  const { createHostedPersistence } = await import('../../src/serve/hosted/persistence.js');
  const directory = mkdtempSync(join(tmpdir(), 'pyric-bun-refusal-'));
  const hosted = join(directory, '.pyric', 'state', 'hosted');
  mkdirSync(hosted, { recursive: true });
  writeFileSync(join(hosted, 'state.sqlite'), 'preserve me');
  try {
    await expect(createHostedPersistence(directory, { fresh: true })).rejects.toThrow('Node');
    expect(readFileSync(join(hosted, 'state.sqlite'), 'utf8')).toBe('preserve me');
    expect(readdirSync(join(directory, '.pyric', 'state'))).toEqual(['hosted']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('offline snapshots export hosted SQLite and redact every password copy', async () => {
  expect(await runNodeFixture('snapshot')).toBe('Snapshot passed');
});

test('a Storage commit failure blocks further structured mutations and remains inspectable', async () => {
  expect(await runNodeFixture('health')).toBe('Health passed');
});

test('seeds are atomic and fresh preserves healthy or corrupt hosted directories', async () => {
  expect(await runNodeFixture('lifecycle')).toBe('Lifecycle passed');
});

test('a process killed inside a transaction reopens at the previous complete state', async () => {
  expect(await runNodeFixture('crash')).toBe('Interrupted commit passed');
});

test('archive retries temporary file locks and preserves the source when retries exhaust', async () => {
  expect(await runNodeFixture('archive')).toBe('Archive retries passed');
});

test('stale metadata cannot overwrite a newer object and does not poison persistence', async () => {
  expect(await runNodeFixture('metadata')).toBe('Metadata concurrency passed');
});

test('a concurrent reader and transient SQLite busy do not latch persistence unhealthy', async () => {
  expect(await runNodeFixture('busy')).toBe('Busy recovery passed');
});

test('SQLite busy beyond the retry window fails without acknowledging a write', async () => {
  expect(await runNodeFixture('busy-timeout')).toBe('Busy timeout passed');
});

test('salvage and archive recover committed WAL without a shared-memory file', async () => {
  expect(await runNodeFixture('wal-recovery')).toBe('WAL recovery passed');
});

test('Storage reads await queued uploads, deletions and resets across bucket views', async () => {
  expect(await runNodeFixture('storage-read-order')).toBe('Storage read order passed');
});

test('hosted CLI preserves the production flag without bypassing confirmation', async () => {
  expect(await runNodeFixture('cli-production')).toBe('Hosted CLI production flag passed');
});

test('hosted close drains accepted method, tool and page calls before disposal', async () => {
  expect(await runNodeFixture('close-drain')).toBe('Hosted close drain passed');
});

test('hosted start rejects when its mount closes during startup', async () => {
  expect(await runNodeFixture('close-startup')).toBe('Closed startup rejected');
});
