import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHostedPersistence, hostedStateDirectory, loadHostedSnapshot } from '../../../src/serve/hosted/persistence.js';
import { MAX_INLINE_EXPORT_STORAGE_BYTES, StateExportTooLargeError } from '../../../src/serve/hosted/persistence/export-limit.js';

const MiB = 1024 * 1024;
const project = mkdtempSync(join(process.argv[2], 'export-'));
(await createHostedPersistence(project)).close();

// Two objects that together pass the limit. zeroblob writes them without this
// process ever holding their bytes.
const each = Math.ceil((MAX_INLINE_EXPORT_STORAGE_BYTES + MiB) / 2);
const database = new DatabaseSync(join(hostedStateDirectory(project), 'state.sqlite'));
const insert = database.prepare('INSERT INTO storage_objects VALUES (?, ?, ?, ?, zeroblob(?))');
for (const name of ['a.wav', 'b.wav']) {
  const path = `narrations/${name}`;
  const metadata = {
    bucket: 'pyric-default', fullPath: path, name, size: each, generation: '1', metageneration: '1',
    timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType: 'audio/wav',
  };
  insert.run('pyric-default', path, JSON.stringify(metadata), 'audio/wav', each);
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

console.log('Export ceiling passed');
