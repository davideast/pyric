import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const directory = process.argv[2];
let database = await openHostedDatabase(directory);
await database.records.putRecords('test', new Map([['one', 1], ['two', 2]]));
database.close();
const script = join(directory, 'interrupted.mjs');
writeFileSync(script, `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
db.prepare('UPDATE records SET payload=? WHERE id=?').run('99', 'one');
process.stdout.write('transaction-open');
setInterval(() => {}, 1000);
`);
const child = spawn(process.execPath, [script, join(directory, 'state.sqlite')], { stdio: ['ignore', 'pipe', 'ignore'] });
const closed = once(child, 'exit');
const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
try {
  await Promise.race([
    once(child.stdout, 'data'),
    closed.then(() => { throw new Error('Child exited before opening its transaction.'); }),
  ]);
  child.kill('SIGKILL');
  await closed;
} finally {
  child.kill('SIGKILL');
  clearTimeout(timeout);
}
database = await openHostedDatabase(directory);
try {
  assert.equal(await database.records.getRecord('test', 'one'), 1);
  assert.equal(await database.records.getRecord('test', 'two'), 2);
} finally { database.close(); }
console.log('Interrupted commit passed');
