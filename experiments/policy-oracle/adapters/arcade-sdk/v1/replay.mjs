import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadFixture, materialize } from './fixture.mjs';

export async function replay(root, probe, mutation) {
  const require = createRequire(new URL('arcade/runtime/package.json', root));
  const packageDir = join(require.resolve('@pyric/rules/package.json'), '..');
  const { firestoreRules, serverTimestamp, timestamp } = await import(pathToFileURL(join(packageDir, 'dist/index.js')));
  const stock = readFileSync(new URL('arcade/v1/rules/stock.rules', root), 'utf8');
  assert.equal(stock.split(mutation.from).length, 2, 'mutation must match exactly one stock expression');
  const wrong = stock.replace(mutation.from, mutation.to);
  const fixture = loadFixture(probe);
  const inputs = fixture.cases.map(({ id }) => {
    const { actor, path, before, data, expected, operation, requestTime } = materialize(
      fixture, id, { actor: 'oracle-writer', reader: 'oracle-reader', runId: 'offline' },
    );
    const resource = { ...before, createdAt: timestamp(before.createdAt) };
    const writeMode = operation === 'transaction-update' ? { kind: 'update' } : { kind: 'set', merge: false };
    if (data.createdAt === '$serverTimestamp') data.createdAt = serverTimestamp();
    return { description: id, method: 'update', auth: { uid: actor }, path, resource, data, writeMode, requestTime, expectation: expected };
  });

  function decisions(source) {
    const { cases } = firestoreRules(source).simulate(inputs);
    assert.equal(cases.length, inputs.length);
    return Object.fromEntries(cases.map(result => {
      assert.ok(!result.unsupported && !result.resourceLimit && ['ALLOW', 'DENY'].includes(result.decision), result.description);
      return [result.description, result.decision];
    }));
  }
  return { candidate: decisions(stock), mutant: decisions(wrong) };
}
