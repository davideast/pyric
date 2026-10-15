// A backend deletes a user's Storage objects by prefix with firebase-admin's
// bucket.deleteFiles({ prefix }), after listing them with getFiles({ prefix }),
// running under `pyric sandbox --hosted` as the user ran it (#964). The objects
// under the prefix are gone; objects under other prefixes, including one that
// shares the prefix's leading characters, remain.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface Report {
  listedUnderPrefix?: string[];
  listedAfterDelete?: string[];
  existsAfterDelete?: Record<string, boolean>;
  error?: string;
}

const UNDER = ['users/123/avatar.png', 'users/123/uploads/a.txt', 'users/123/uploads/b.txt'];
const OUTSIDE = ['public/logo.png', 'users/1234/avatar.png', 'users/124/avatar.png'];

export default scenario(async (app) => {
  const report = await app.step('the backend runs under pyric sandbox --hosted and deletes users/123/', async () => {
    const port = await app.freePort();
    const result = await app.serverScript(
      'pyric.mjs',
      ['sandbox', '--hosted', '--no-open', '--port', String(port), '--', 'node', 'backend.mjs'],
      { timeoutMs: 120_000 },
    );
    // `pyric sandbox` prints its command's output with a `[dev] ` prefix.
    const line = result.output.split('\n').map((text) => text.replace(/^\[dev\] /, '')).findLast((text) => text.startsWith('{'));
    assert.ok(line, 'backend.mjs printed no JSON report');
    return JSON.parse(line) as Report;
  });

  await app.step('getFiles and deleteFiles do not throw', () => {
    assert.equal(report.error, undefined);
  });

  await app.step('getFiles({ prefix }) lists the objects under the prefix', () => {
    assert.deepEqual(report.listedUnderPrefix, UNDER);
  });

  await app.step('deleteFiles({ prefix }) removed them and left the others', () => {
    assert.deepEqual(report.listedAfterDelete, OUTSIDE);
    for (const name of UNDER) assert.equal(report.existsAfterDelete?.[name], false, `${name} still exists`);
    for (const name of OUTSIDE) assert.equal(report.existsAfterDelete?.[name], true, `${name} was deleted`);
  });
});
