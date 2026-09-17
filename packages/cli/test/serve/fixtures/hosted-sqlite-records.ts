import assert from 'node:assert/strict';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const directory = process.argv[2];
let database = await openHostedDatabase(directory);
try {
  await database.records.putRecords('first', new Map([['a', { answer: 42 }], ['gone', { answer: 1 }]]));
  await database.records.putRecords('second', new Map([['a', { answer: 7 }]]));
  await database.records.applyChanges('first', new Map([['b', { answer: 11 }]]), ['gone']);
} finally { database.close(); }
database = await openHostedDatabase(directory);
try {
  assert.deepEqual(await database.records.getRecord('first', 'a'), { answer: 42 });
  assert.deepEqual(await database.records.getRecord('second', 'a'), { answer: 7 });
  assert.deepEqual((await database.records.listRecords('first')).sort(), ['a', 'b']);
  assert.equal(await database.records.getRecord('first', 'gone'), null);
  await database.records.clear('first');
  assert.deepEqual(await database.records.getRecord('second', 'a'), { answer: 7 });
} finally { database.close(); }
console.log('Record restart passed');
