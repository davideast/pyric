import assert from 'node:assert/strict';
import { initializeSandbox } from 'pyric/sandbox';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const directory = process.argv[2];
let database = await openHostedDatabase(directory);
try {
  await database.records.putRecords('first', new Map([['a', { answer: 42 }], ['gone', { answer: 1 }]]));
  await database.records.putRecords('second', new Map([['a', { answer: 7 }]]));
  await database.records.applyChanges('first', new Map([['b', { answer: 11 }]]), ['gone']);

  let snapshotPropertyReads = 0;
  const sandbox = initializeSandbox();
  try {
    sandbox.registerPersistableService('auth', {
      snapshot: () => ({
        users: [],
        get providers() {
          snapshotPropertyReads += 1;
          return { password: true };
        },
      }),
      restore: () => {},
      subscribe: () => () => {},
    });
    await sandbox.enablePersistence({ key: 'hosted', injectedBackend: database.records, flushIntervalMs: 60_000 });
    snapshotPropertyReads = 0;
    await sandbox.flush();
    assert.equal(snapshotPropertyReads, 1, 'flush must serialize each changed record once across hash and SQLite store');
  } finally {
    sandbox.dispose();
  }
} finally { database.close(); }
database = await openHostedDatabase(directory);
try {
  assert.deepEqual(await database.records.getRecord('first', 'a'), { answer: 42 });
  assert.deepEqual(await database.records.getRecord('second', 'a'), { answer: 7 });
  assert.deepEqual((await database.records.listRecords('first')).sort(), ['a', 'b']);
  assert.equal(await database.records.getRecord('first', 'gone'), null);
  const restoredSandbox = initializeSandbox();
  try {
    let restoredAuth: unknown = null;
    restoredSandbox.registerPersistableService('auth', {
      snapshot: () => restoredAuth,
      restore: (data) => { restoredAuth = data; },
    });
    await restoredSandbox.enablePersistence({ key: 'hosted', injectedBackend: database.records });
    assert.deepEqual(restoredAuth, { users: [], providers: { password: true } });
  } finally {
    restoredSandbox.dispose();
  }
  await database.records.clear('first');
  assert.deepEqual(await database.records.getRecord('second', 'a'), { answer: 7 });
} finally { database.close(); }
console.log('Record restart passed');
