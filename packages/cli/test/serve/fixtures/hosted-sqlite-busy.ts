import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const directory = process.argv[2];
const database = await openHostedDatabase(directory);
const path = join(directory, 'state.sqlite');
let locker: Worker | undefined;
try {
  await database.records.putRecords('test', new Map([['value', 1]]));
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    reader.exec('BEGIN');
    const read = reader.prepare("SELECT payload FROM records WHERE namespace='test' AND id='value'");
    assert.equal(read.get()?.payload, '1');
    await database.records.putRecords('test', new Map([['value', 2]]));
    assert.equal(database.status().state, 'healthy');
    assert.equal(read.get()?.payload, '1', 'the reader retains its snapshot during the commit');
  } finally { reader.close(); }

  // A separate thread can release SQLite's writer lock while DatabaseSync waits.
  locker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const connection = new DatabaseSync(workerData);
    connection.exec('BEGIN IMMEDIATE');
    parentPort.once('message', () => setTimeout(() => {
      connection.exec('ROLLBACK');
      connection.close();
      parentPort.close();
    }, 75));
    parentPort.postMessage('locked');
  `, { eval: true, workerData: path });
  await once(locker, 'message');
  locker.postMessage('release');
  await database.records.putRecords('test', new Map([['value', 3]]));
  assert.equal(database.status().state, 'healthy');
  assert.equal(await database.records.getRecord('test', 'value'), 3);
} finally {
  await locker?.terminate();
  database.close();
}
console.log('Busy recovery passed');
