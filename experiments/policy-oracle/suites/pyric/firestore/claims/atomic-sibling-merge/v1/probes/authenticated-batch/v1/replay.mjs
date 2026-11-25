import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const runtime = pathToFileURL(join(process.env.ORACLE_ROOT, 'arcade/runtime/package.json')).href;
const { SimulateFirestoreRulesHandler, projectAfterState } = await import(import.meta.resolve('@pyric/rules/internal', runtime));
const simulator = new SimulateFirestoreRulesHandler();
const source = readFileSync(new URL('firestore.rules', import.meta.url), 'utf8');
const plan = JSON.parse(readFileSync(new URL('plan.json', import.meta.url), 'utf8'));

function replay(projectUpdate) {
  const documents = new Map(Object.entries(plan.seed));
  function decide(writes) {
    const projection = new Map();
    const requests = writes.map(({ method, data, path }) => {
      const stored = documents.get(path) ?? null;
      if (method === 'update') {
        assert.ok(stored, 'update requires a seeded companion');
        projection.set(path, projectUpdate(stored, data));
      } else {
        assert.equal(method, 'set');
        assert.equal(stored, null, 'the plan creates a fresh primary');
        projection.set(path, data);
      }
      return {
        description: path,
        method: method === 'set' ? 'create' : 'update',
        auth: { uid: 'pyric-browser-local-replay' },
        path, data,
        ...(stored && { resource: stored }),
        expectation: 'ALLOW', // The simulator returns the absolute decision separately.
      };
    });
    const result = simulator.simulate(source, requests, {
      getDoc: path => documents.get(path) ?? null,
      batchProjection: writes.length > 1 ? projection : undefined,
    });
    assert.ok(result.success, JSON.stringify(result.error));
    assert.equal(result.data.results.length, requests.length);
    for (const row of result.data.results) {
      assert.ok(['ALLOW', 'DENY'].includes(row.decision) && row.trace.length > 0, row.description);
    }
    if (result.data.results.some(row => row.decision === 'DENY')) return 'DENY';
    for (const [path, value] of projection) documents.set(path, value);
    return 'ALLOW';
  }
  return {
    'solo-primary': decide([plan.soloPrimary]),
    'partial-batch': decide(plan.batch),
    'full-batch': decide(plan.fullBatch),
  };
}

const candidate = replay((stored, patch) => projectAfterState({ kind: 'update' }, stored, patch));
const mutant = replay((_stored, patch) => patch);
console.log(JSON.stringify({ candidate, mutant }));
