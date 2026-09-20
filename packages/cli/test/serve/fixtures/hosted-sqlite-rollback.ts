import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const directory = process.argv[2];
const database = await openHostedDatabase(directory);
try {
  await database.records.putRecords('sandbox', new Map([['keep', 1], ['gone', 2]]));
  // Inject a failure at the database boundary after a preceding update executes.
  const fault = new DatabaseSync(join(directory, 'state.sqlite'));
  try {
    fault.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  } finally { fault.close(); }
  await assert.rejects(database.records.applyChanges('sandbox', new Map([['keep', 3], ['new', 4]]), ['gone']), /persistence transaction failed/);
  assert.equal(await database.records.getRecord('sandbox', 'keep'), 1);
  assert.equal(await database.records.getRecord('sandbox', 'gone'), 2);
  assert.equal(await database.records.getRecord('sandbox', 'new'), null);
} finally { database.close(); }
console.log('Rollback passed');
