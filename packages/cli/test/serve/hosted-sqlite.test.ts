import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runNodeFixture(name: string, timeoutMs = 15_000): Promise<string> {
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
      encoding: 'utf8', timeout: timeoutMs,
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

test('a database written by every earlier release opens, moves its bytes to files, and keeps its data', async () => {
  expect(await runNodeFixture('schema-upgrade', 60_000)).toBe('Schema upgrade passed');
}, 90_000);

test('Storage bytes live in files named by their hash, written before their row commits', async () => {
  expect(await runNodeFixture('blob-store', 60_000)).toBe('Blob store passed');
}, 90_000);

test('a background sweep removes object files no row names, and salvage quarantines files that fail their hash', async () => {
  expect(await runNodeFixture('object-sweep', 60_000)).toBe('Object sweep passed');
}, 90_000);

test('a hosted checkpoint records its objects by hash in SQLite, and the sweep keeps what it names', async () => {
  expect(await runNodeFixture('checkpoints', 60_000)).toBe('Checkpoints passed');
}, 90_000);

// Serves a 300 MiB object and receives a 256 MiB upload.
test('the byte route serves object ranges to either token and takes an upload with its own token', async () => {
  expect(await runNodeFixture('byte-route', 90_000)).toBe('Byte route passed');
}, 120_000);

// Uploads and reads 10 and 12 MiB objects through the web client.
test('the web client moves Storage bytes over the byte route, with real progress, pause, and download URLs', async () => {
  expect(await runNodeFixture('web-byte-route', 60_000)).toBe('Web byte route passed');
}, 90_000);

test('the hosted host serves its objects on the byte route and advertises it at attach', async () => {
  expect(await runNodeFixture('byte-route-mount', 30_000)).toBe('Byte route mount passed');
}, 60_000);

// Stages and finishes a 256 MiB upload.
test('a chunked upload stages in one file, finishes by moving it, and keeps host memory flat', async () => {
  expect(await runNodeFixture('upload-staging', 90_000)).toBe('Upload staging passed');
}, 120_000);

// Exports 400 MiB of sparse object files by reference.
test('a state export refers to Storage bytes by hash, and snapshots and seeds carry them as files', async () => {
  expect(await runNodeFixture('state-references', 90_000)).toBe('State references passed');
}, 120_000);

test('the Node host recovers acknowledged writes without modifying existing JSON', async () => {
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

test('Storage seeds await earlier uploads through fixture and section writes', async () => {
  expect(await runNodeFixture('seed-order')).toBe('Seed ordering passed');
});

test('a Storage size that disagrees with the stored bytes is repaired instead of refusing the store', async () => {
  expect(await runNodeFixture('storage-size-repair')).toBe('Storage size repair passed');
}, 15_000);

test('racing uploads to one path leave the recorded size equal to the stored bytes', async () => {
  expect(await runNodeFixture('storage-upload-race')).toBe('Storage upload race passed');
});

test('hosted startup names every Storage object repaired from its stored bytes', async () => {
  const { formatStorageRepairs } = await import('../../src/serve/hosted/persistence.js');
  expect(formatStorageRepairs([])).toEqual([]);
  expect(formatStorageRepairs([{ bucket: 'pyric-default', path: 'notes/timings.json', recordedSize: 18, actualSize: 11 }])).toEqual([
    '  ⚠ Repaired Storage metadata that disagreed with the stored bytes; the bytes are unchanged.',
    '    • pyric-default/notes/timings.json: recorded size 18, actual size 11',
  ]);
});
