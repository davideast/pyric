import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { exportHistory, verifyHistoryArchive } from '../../../src/serve/hosted/persistence/history-export.js';
const directory = process.argv[2];
const database = await openHostedDatabase(join(directory, 'database'));
const output = join(directory, 'export');
try {
  for (const index of Array(270).keys())
    database.history.observe({ kind: 'operation', id: `event-${index}`, at: index, service: 'ai', model: 'test' });
  const exported = await exportHistory(database.history, output, { maxBytes: 4096 });
  assert.equal(exported.sequence, 271);
  assert.equal(database.history.status().pendingEvents, 0);
  assert.ok(readdirSync(output).filter(name => name.endsWith('.jsonl')).length > 1);
  assert.equal((await verifyHistoryArchive(output)).records, 271);
  const filesBefore = readdirSync(output).filter(name => name.endsWith('.jsonl'));
  const bytesBefore = filesBefore.map(name => readFileSync(join(output, name), 'utf8'));
  // A finalized segment without a checkpoint must be recovered, never overwritten.
  unlinkSync(join(output, 'checkpoint.json'));
  const resumed = await exportHistory(database.history, output, { maxBytes: 4096 });
  assert.equal(resumed.sequence, 271);
  assert.deepEqual(readdirSync(output).filter(name => name.endsWith('.jsonl')), filesBefore);
  assert.deepEqual(filesBefore.map(name => readFileSync(join(output, name), 'utf8')), bytesBefore);
  database.history.observe({ kind: 'operation', id: 'next', at: 300, service: 'messaging' });
  await exportHistory(database.history, output);
  assert.equal((await verifyHistoryArchive(output)).records, 272);
  assert.equal(database.history.list({ limit: 1 }).records[0]?.sequence, 1);
  const first = join(output, filesBefore[0]);
  renameSync(first, `${first}.missing`);
  await assert.rejects(exportHistory(database.history, output), /ENOENT|gap/);
  renameSync(`${first}.missing`, first);
}
finally {
  database.close();
}
console.log('History export passed');
