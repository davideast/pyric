import assert from 'node:assert/strict';
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHostedPersistence, hostedStateDirectory, loadHostedSnapshot } from '../../../src/serve/hosted/persistence.js';
import { MAX_INLINE_EXPORT_STORAGE_BYTES, StateExportTooLargeError } from '../../../src/serve/hosted/persistence/export-limit.js';
import { createSandboxSession } from '../../../src/serve/sandbox-session.js';
import { mkdirSync } from 'node:fs';

const MiB = 1024 * 1024;
const project = mkdtempSync(join(process.argv[2], 'export-'));
(await createHostedPersistence(project)).close();

// Two objects that together pass the limit. Their files are sparse, so they are
// written without this process ever holding their bytes.
const each = Math.ceil((MAX_INLINE_EXPORT_STORAGE_BYTES + MiB) / 2);
const database = new DatabaseSync(join(hostedStateDirectory(project), 'state.sqlite'));
const insert = database.prepare('INSERT INTO storage_objects (bucket, path, metadata, mime, sha256, size) VALUES (?, ?, ?, ?, ?, ?)');
for (const [name, sha256] of [['a.wav', 'a'.repeat(64)], ['b.wav', 'b'.repeat(64)]]) {
  const path = `narrations/${name}`;
  const shard = join(hostedStateDirectory(project), 'objects', sha256.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  writeFileSync(join(shard, sha256), '');
  truncateSync(join(shard, sha256), each);
  const metadata = {
    bucket: 'pyric-default', fullPath: path, name, size: each, generation: '1', metageneration: '1',
    timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType: 'audio/wav',
  };
  insert.run('pyric-default', path, JSON.stringify(metadata), 'audio/wav', sha256, each);
}
database.close();

const rssBefore = process.memoryUsage().rss;
await assert.rejects(loadHostedSnapshot(project), (error: unknown) => {
  assert.ok(error instanceof StateExportTooLargeError);
  assert.match(String((error as Error).message), /Storage objects total [0-9.]+ MiB/);
  return true;
});
const rssGrowth = process.memoryUsage().rss - rssBefore;
assert.ok(rssGrowth < 64 * MiB, `the refusal read no object bytes (rss grew ${(rssGrowth / MiB).toFixed(1)} MiB)`);

// The host still starts, and the sections that carry no object bytes still read.
const persistence = await createHostedPersistence(project);
try {
  assert.doesNotThrow(() => persistence.state.readSection('auth'));
  assert.throws(() => persistence.state.readSection('storage'), StateExportTooLargeError);
} finally { persistence.close(); }

// A hosted session starts on the same store: startup counts documents and users
// and never reads the objects the export refuses.
mkdirSync(join(project, 'sdk'), { recursive: true });
const sessionRssBefore = process.memoryUsage().rss;
const session = await createSandboxSession({ projectDir: project, firebaseConfig: null, sdk: { dir: join(project, 'sdk') }, hosted: true, capture: false });
try {
  assert.equal(session.summary.persistence?.restored, true);
} finally { await session.close(); }
const sessionRssGrowth = process.memoryUsage().rss - sessionRssBefore;
assert.ok(sessionRssGrowth < 64 * MiB, `session start read no object bytes (rss grew ${(sessionRssGrowth / MiB).toFixed(1)} MiB)`);

console.log('Export ceiling passed');
