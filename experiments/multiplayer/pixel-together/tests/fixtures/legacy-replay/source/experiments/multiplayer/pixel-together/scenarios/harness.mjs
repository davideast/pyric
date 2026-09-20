import { paintGridTransaction, writePixel } from '../architecture/pixels.mjs';
import { acquireClaim } from '../architecture/claims.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pyricBackend } from '../../../shared/backends/pyric.mjs';
import { compareEvidence } from '../../../shared/evidence/compare.mjs';
import { runClaimLifecycle, lifecycleAssertions } from './claim-lifecycle.mjs';
import { workload, rules } from '../fixtures/workload.mjs';
export { workload, rules } from '../fixtures/workload.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const bounded = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Harness timeout: ${label}`)), 5000); })]).finally(() => clearTimeout(timer));
};

/** Driver operations use the modular Firestore Web SDK contract. */
export async function runExperiment(driver = pyricBackend) {
  const { doc, getDoc, setDoc, deleteDoc, runTransaction, onSnapshot } = driver.sdk;
  const resources = [];
  const backend = async () => {
    const resource = await driver.create({ rules, fixture: workload.fixture });
    resources.push(resource);
    return resource.client;
  };
  const id = process.env.PYRIC_EXPERIMENT_RUN_ID ?? randomUUID();
  const result = {
    schemaVersion: 1,
    run: {
      id, startedAt: new Date().toISOString(), workloadHash: hash(workload), rulesHash: hash(rules),
      implementationHash: hash(['./harness.mjs', './claim-lifecycle.mjs', '../architecture/pixels.mjs', '../architecture/claims.mjs', '../architecture/firestore.rules', '../fixtures/workload.mjs', '../../../shared/evidence/compare.mjs'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))),
      environment: { ...driver.environment, runtime: `bun ${Bun.version}` },
      gitRevision: process.env.PYRIC_EXPERIMENT_REVISION ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('../../../..', import.meta.url), encoding: 'utf8' }).trim(),
      limits: ['No hosted latency, billing, quotas, offline delivery, TTL or load measured', 'Two synthetic identities share an in-process backend, not independent network clients', 'Claim ownership uses backend Rules; no local Kin policy gate', 'Delayed payloads are scheduled by the harness, not a real offline queue; listener recovery uses unsubscribe/resubscribe' ],
    },
    cases: [], operations: [], observations: [], assertions: [],
  };
  let sequence = 0;
  const record = (table, row) => { const entry = { id: `${table}-${++sequence}`, runId: id, sequence, ...JSON.parse(JSON.stringify(row)) }; result[table].push(entry); return entry; };
  const assert = (caseId, name, expected, actual) => record('assertions', { caseId, name, expected, actual, passed: JSON.stringify(expected) === JSON.stringify(actual) });
  const operation = async (caseId, actor, kind, path, action, attempt = null) => {
    const event = record('operations', { caseId, actor, kind, path, attempt, status: 'pending', startSequence: sequence + 1 });
    try { const value = await action(); event.status = 'acknowledged';
      if (kind === 'get' || kind === 'transaction-read') event.observed = JSON.parse(JSON.stringify(value?.data instanceof Function ? value.data() ?? null : value ?? null));
      if (kind === 'transaction' && typeof value === 'boolean') event.returned = value;
      event.endSequence = ++sequence; return value; }
    catch (error) { event.status = 'error'; event.error = { code: error.code ?? null, message: error.message }; event.endSequence = ++sequence; throw error; }
  };
  const runCase = async (caseId, action) => {
    const row = { id: caseId, runId: id, status: 'running' }; result.cases.push(row);
    try { await action(); row.status = 'complete'; }
    catch (error) { row.status = 'error'; row.error = { message: error.message, code: error.code ?? null }; }
  };
  for (const variant of ['stale-grid', 'transaction-grid', 'pixel-records']) {
    await runCase(variant, async () => {
      const db = await backend();
      const alice = db('alice'), bob = db('bob');
      const read = (actor, handle, path) => operation(variant, actor, 'get', path, async () => (await getDoc(doc(handle, path))).data());
      if (variant === 'stale-grid') {
        const a = await read('alice', alice, 'boards/main');
        const b = await read('bob', bob, 'boards/main');
        a.grid[0] = 'red'; b.grid[1] = 'blue';
        await operation(variant, 'alice', 'set', 'boards/main', () => setDoc(doc(alice, 'boards/main'), a));
        await operation(variant, 'bob', 'set', 'boards/main', () => setDoc(doc(bob, 'boards/main'), b));
      } else if (variant === 'transaction-grid') {
        const readDone = deferred(), aliceDone = deferred();
        let attempt = 0;
        const pending = operation(variant, 'bob', 'transaction', 'boards/main', () => paintGridTransaction(driver.sdk, bob, 1, 'blue', {
          read: action => operation(variant, 'bob', 'transaction-read', 'boards/main', async () => (await action()).data(), ++attempt),
          afterRead: async () => { if (attempt === 1) { readDone.resolve(); await bounded(aliceDone.promise, 'alice commit'); } },
          stage: data => record('operations', { caseId: variant, actor: 'bob', kind: 'transaction-stage-set', path: 'boards/main', status: 'staged', attempt, value: data }),
        }));
        // Attach rejection immediately, so failed barriers do not leave unhandled promises.
        const settled = pending.then(() => null, error => error);
        await bounded(readDone.promise, 'bob initial read');
        try {
          await operation(variant, 'alice', 'transaction', 'boards/main', () => paintGridTransaction(driver.sdk, alice, 0, 'red', {
            read: action => operation(variant, 'alice', 'transaction-read', 'boards/main', async () => (await action()).data(), 1),
            stage: data => record('operations', { caseId: variant, actor: 'alice', kind: 'transaction-stage-set', path: 'boards/main', status: 'staged', attempt: 1, value: data }),
          }));
        } finally { aliceDone.resolve(); }
        const error = await bounded(settled, 'bob retry'); if (error) throw error;
      } else {
        await read('alice', alice, 'pixels/0'); await read('bob', bob, 'pixels/1');
        await operation(variant, 'alice', 'set', 'pixels/0', () => writePixel(driver.sdk, alice, 'pixels/0', 'red'));
        await operation(variant, 'bob', 'set', 'pixels/1', () => writePixel(driver.sdk, bob, 'pixels/1', 'blue'));
      }
      const grid = variant === 'pixel-records' ? [(await read('alice', alice, 'pixels/0')).color, (await read('alice', alice, 'pixels/1')).color] : (await read('alice', alice, 'boards/main')).grid;
      record('observations', { caseId: variant, kind: 'final-grid', value: grid });
      assert(variant, 'distinct edits survive', ['red', 'blue'], grid);
      // Subscribe before an additional write to test actual update delivery,
      // not merely the final state from getDoc. This is a separate schedule.
      const path = variant === 'pixel-records' ? 'pixels/0' : 'boards/main';
      const subscriptions = [];
      const ready = [];
      const arrived = [];
      for (const [actor, handle] of [['alice', alice], ['bob', bob]]) {
        const initial = deferred(), updated = deferred(); ready.push(initial.promise); arrived.push(updated.promise);
        subscriptions.push(onSnapshot(doc(handle, path), snapshot => {
          const data = snapshot.data();
          record('observations', { caseId: variant, actor, kind: 'listener-delivery', path, value: data });
          initial.resolve();
          if (data?.marker === 'convergence') updated.resolve();
        }, error => { record('observations', { caseId: variant, actor, kind: 'listener-error', value: error.message }); }));
      }
      try {
        await bounded(Promise.all(ready), 'initial listener snapshots');
        const data = await read('alice', alice, path);
        await operation(variant, 'alice', 'set', path, () => setDoc(doc(alice, path), { ...data, marker: 'convergence' }));
        await bounded(Promise.all(arrived), 'listener update convergence');
        assert(variant, 'both listeners receive subsequent write', true, true);
      } finally { subscriptions.forEach(unsubscribe => unsubscribe()); }

    });
  }
  await runCase('claims', async () => {
    const db = await backend();
    const claim = (actor, wait) => operation('claims', actor, 'transaction', 'claims/red', () => acquireClaim(driver.sdk, db(actor), {
      path: 'claims/red', uid: actor,
      read: action => operation('claims', actor, 'transaction-read', 'claims/red', async () => {
        const snap = await action();
        record('observations', { caseId: 'claims', kind: 'transaction-snapshot-exists-type', value: typeof snap.exists });
        return snap.data();
      }),
      afterRead: wait,
      stage: data => record('operations', { caseId: 'claims', actor, kind: 'transaction-stage-set', path: 'claims/red', status: 'staged', value: data }),
    }));
    const readDone = deferred(), claimed = deferred(); let first = true;
    const pending = claim('bob', async () => { if (first) { first = false; readDone.resolve(); await bounded(claimed.promise, 'claim alice'); } });
    const settled = pending.then(value => ({ value }), error => ({ error }));
    await bounded(readDone.promise, 'claim bob read');
    let aliceWon;
    try { aliceWon = await claim('alice'); } finally { claimed.resolve(); }
    const bobResult = await bounded(settled, 'claim bob retry'); if (bobResult.error) throw bobResult.error;
    assert('claims', 'exactly one claimant', [true, false], [aliceWon, bobResult.value]);
    const draw = actor => operation('claims', actor, 'set', 'claimedPixels/0', () => setDoc(doc(db(actor), 'claimedPixels/0'), { color: 'red' }));
    const release = actor => operation('claims', actor, 'delete', 'claims/red', () => deleteDoc(doc(db(actor), 'claims/red')));
    const denied = async (name, action) => {
      let code = null; try { await action(); } catch (error) { code = error.code ?? error.message; }
      assert('claims', name, 'permission-denied', code);
    };
    await draw('alice'); assert('claims', 'owner can draw', true, true);
    await denied('other member cannot draw', () => draw('bob'));
    await denied('outsider cannot draw', () => draw('outsider'));
    await denied('signed out cannot draw', () => draw(null));
    await denied('other member cannot release', () => release('bob'));
    await denied('forged claimant rejected', () => operation('claims', 'bob', 'set', 'claims/blue', () => setDoc(doc(db('bob'), 'claims/blue'), { uid: 'alice' })));
    await release('alice'); assert('claims', 'released color claimable', true, await claim('bob'));
    await denied('former owner cannot draw', () => draw('alice'));
    await draw('bob'); assert('claims', 'new owner can draw', true, true);
  });
  await runClaimLifecycle({ sdk: driver.sdk, backend, runCase, operation, assert, record });
  await Promise.all(resources.map(resource => resource.close()));
  result.run.finishedAt = new Date().toISOString();
  return result;
}

const expectedAssertions = {
    ...lifecycleAssertions,
    'stale-grid': ['distinct edits survive', 'both listeners receive subsequent write'],
    'transaction-grid': ['distinct edits survive', 'both listeners receive subsequent write'],
    'pixel-records': ['distinct edits survive', 'both listeners receive subsequent write'],
    claims: ['exactly one claimant', 'owner can draw', 'other member cannot draw', 'outsider cannot draw', 'signed out cannot draw', 'other member cannot release', 'forged claimant rejected', 'released color claimable', 'former owner cannot draw', 'new owner can draw'],
  };

export function assessRun(result) {
  const expectedCases = Object.keys(expectedAssertions);

  const issues = [];
  for (const caseId of expectedCases) {
    if (result.cases.filter(c => c.id === caseId && c.status === 'complete').length !== 1) issues.push(`${caseId}: incomplete or duplicate case`);
    for (const name of expectedAssertions[caseId]) {
      const rows = result.assertions.filter(a => a.caseId === caseId && a.name === name);
      const expectedPass = !((caseId === 'stale-grid' && name === 'distinct edits survive') || (caseId === 'claim-aba-control' && name === 'old claim write rejected after reacquisition'));
      if (rows.length !== 1 || rows[0].passed !== expectedPass) issues.push(`${caseId}: ${name}`);
    }
  }
  return { successfulExperiment: issues.length === 0, issues, expectedNegativeControls: ['stale-grid: distinct edits survive', 'claim-aba-control: old claim write rejected after reacquisition'] };
}

export const compareRuns = (left, right) => compareEvidence(left, right, expectedAssertions);
