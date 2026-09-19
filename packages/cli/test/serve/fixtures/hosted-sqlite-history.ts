import assert from 'node:assert/strict';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
const directory = process.argv[2];
let database = await openHostedDatabase(directory);
try {
  database.history.observe({ kind: 'operation', id: 'read-1', at: 1, service: 'firestore', method: 'get', result: 'allow' });
  assert.equal(database.history.status().pendingEvents, 1);
  await database.records.applyChanges('hosted', new Map([['example', { value: 42 }]]), []);
  const page = database.history.list({ limit: 10 });
  assert.equal(page.records.some(record => record.kind === 'observation'), true);
  assert.equal(page.records.some(record => record.kind === 'mutation'), true);
  assert.equal(database.history.status().pendingEvents, 0);
  database.history.observe({ kind: 'operation', id: 'nested', at: 2, service: 'firestore' });
  database.commit(() => {
    database.commitChanges('hosted', new Map([['example', { value: 42 }]]), []);
    database.commitChanges('hosted', new Map([['other', { value: 1 }]]), []);
  });
  assert.equal(database.history.list().records.filter(record => record.payload?.id === 'nested').length, 1);

}
finally {
  database.close();
}
database = await openHostedDatabase(directory);
try {
  assert.throws(() => database.history.list({ service: 'missing', through: 1000000 }), /cursor/);
  const page = database.history.list({ limit: 1 });
  assert.equal(page.records.length, 1);
  const next = database.history.list({ after: page.next, limit: 100 });
  assert.ok(next.records.length > 0);
  assert.deepEqual(database.readRecord('hosted', 'example'), { value: 42 });
  assert.equal(database.history.status().pendingEvents, 0);
}
finally {
  database.close();
}
console.log('History restart passed');
