import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { archiveHostedDirectory } from '../../../src/serve/hosted/persistence/archive.js';

const directory = join(process.argv[2], 'hosted');
fs.mkdirSync(directory);
fs.writeFileSync(join(directory, 'state.sqlite'), 'preserve damaged state');
const rename = fs.renameSync;
let attempts = 0;
const transient = mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
  attempts++;
  const temporarilyLocked = attempts < 3;
  if (temporarilyLocked) throw Object.assign(new Error('File is in use'), { code: 'EBUSY' });
  return rename(...args);
});
syncBuiltinESMExports();
try {
  const archive = await archiveHostedDirectory(directory);
  assert.equal(attempts, 3);
  assert.ok(archive);
  assert.equal(fs.readFileSync(join(archive, 'state.sqlite'), 'utf8'), 'preserve damaged state');
} finally { transient.mock.restore(); syncBuiltinESMExports(); }
fs.mkdirSync(directory);
fs.writeFileSync(join(directory, 'state.sqlite'), 'preserve after retries');
const blocked = mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('File is in use'), { code: 'EPERM' }); });
syncBuiltinESMExports();
try {
  await assert.rejects(archiveHostedDirectory(directory), /original was preserved/);
  assert.equal(blocked.mock.callCount(), 4);
  assert.equal(fs.readFileSync(join(directory, 'state.sqlite'), 'utf8'), 'preserve after retries');
} finally { blocked.mock.restore(); syncBuiltinESMExports(); }
console.log('Archive retries passed');
