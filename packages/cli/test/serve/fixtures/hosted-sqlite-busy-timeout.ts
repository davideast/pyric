import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const directory = process.argv[2];
const database = await openHostedDatabase(directory);
const locker = new DatabaseSync(join(directory, 'state.sqlite'));
try {
  await database.records.putRecords('test', new Map([['value', 'durable']]));
  locker.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  await assert.rejects(database.records.putRecords('test', new Map([['value', 'uncommitted']])), /persistence transaction failed/);
  assert.ok(performance.now() - started < 1500, 'busy refusal must remain bounded');
  assert.equal(await database.records.getRecord('test', 'value'), 'durable');
  assert.equal(database.status().state, 'unhealthy', 'exhausted persistence failures remain fail-closed');
} finally {
  locker.close();
  database.close();
}
console.log('Busy timeout passed');
