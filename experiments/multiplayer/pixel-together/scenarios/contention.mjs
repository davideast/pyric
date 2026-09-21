import { acquireClaim } from '../architecture/claims.mjs';
import { drawClaimedPixel } from '../architecture/pixels.mjs';

export const contentionAssertions = {
  'competing-reacquisition': ['exactly one winner and one epoch increment', 'loser retries with current owner'],
  'ownership-during-draw': ['old drawing does not commit', 'pixel unchanged after denied drawing', 'retry observes new owner'],
  'delayed-release': ['delayed release denied', 'new ownership survives delayed release'],
  'multiple-colors': ['both transactions read vacant claims', 'one user owns at most one color'],
  'concurrent-pixel': ['both contenders read the same pixel', 'later committed color is saved', 'both listeners converge to saved winner'],
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const wait = async (promise, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Schedule timeout: ${label}`)), 5000); })]); }
  finally { clearTimeout(timer); }
};
const settled = promise => promise.then(value => ({ value }), error => ({ error }));
const unwrap = async promise => { const result = await wait(promise, 'transaction completion'); if (result.error) throw result.error; return result.value; };

export async function runContention({ sdk, backend, runCase, operation, record, assert }) {
  const { doc, getDoc, setDoc, onSnapshot } = sdk;
  const setup = async caseId => {
    const db = await backend();
    const reads = [];
    const read = (actor, path) => operation(caseId, actor, 'get', path, async () => (await getDoc(doc(db(actor), path))).data());
    const write = (actor, path, data) => {
      record('observations', { caseId, actor, kind: 'submitted-payload', path, value: data });
      return operation(caseId, actor, 'set', path, () => setDoc(doc(db(actor), path), data));
    };
    const txRead = actor => async (path, action) => {
      const data = await operation(caseId, actor, 'transaction-read', path, async () => (await action()).data());
      reads.push({ actor, path, data });
      return data;
    };
    const claim = (actor, color, afterRead) => operation(caseId, actor, 'transaction', `fencedClaims/${color}`, () => acquireClaim(sdk, db(actor), {
      path: `fencedClaims/${color}`, uid: actor, fenced: true,
      read: action => txRead(actor)(`fencedClaims/${color}`, action), afterRead,
      stage: value => record('operations', { caseId, actor, kind: 'transaction-stage-set', path: `fencedClaims/${color}`, status: 'staged', value }),
    }));
    const draw = (actor, color, epoch, afterRead) => operation(caseId, actor, 'transaction', 'fencedPixels/0', () => drawClaimedPixel(sdk, db(actor), { color, epoch }, {
      read: txRead(actor), afterRead,
      stage: value => record('operations', { caseId, actor, kind: 'transaction-stage-set', path: 'fencedPixels/0', status: 'staged', value }),
    }));
    return { db, reads, read, write, claim, draw };
  };

  await runCase('competing-reacquisition', async () => {
    const s = await setup('competing-reacquisition');
    await s.claim('alice', 'red');
    await s.write('alice', 'fencedClaims/red', { uid: null, epoch: 1 });
    const ready = deferred(), release = deferred(); let first = true;
    const bob = settled(s.claim('bob', 'red', async () => { if (first) { first = false; ready.resolve(); await wait(release.promise, 'alice acquisition'); } }));
    let alice;
    try { await wait(ready.promise, 'bob read'); alice = await s.claim('alice', 'red'); }
    finally { release.resolve(); }
    const loser = await unwrap(bob);
    assert('competing-reacquisition', 'exactly one winner and one epoch increment', [2, false, { uid: 'alice', epoch: 2 }], [alice, loser, await s.read('alice', 'fencedClaims/red')]);
    assert('competing-reacquisition', 'loser retries with current owner', [null, 'alice'], s.reads.filter(r => r.actor === 'bob').map(r => r.data.uid));
  });

  await runCase('ownership-during-draw', async () => {
    const s = await setup('ownership-during-draw');
    await s.claim('alice', 'red'); await s.draw('alice', 'red', 1);
    const ready = deferred(), release = deferred(); let first = true;
    const drawing = settled(s.draw('alice', 'red', 1, async () => { if (first) { first = false; ready.resolve(); await wait(release.promise, 'ownership transfer'); } }));
    try {
      await wait(ready.promise, 'drawing reads');
      await s.write('alice', 'fencedClaims/red', { uid: null, epoch: 1 });
      await s.claim('bob', 'red');
    } finally { release.resolve(); }
    const outcome = await wait(drawing, 'stale drawing finishes');
    assert('ownership-during-draw', 'old drawing does not commit', 'permission-denied', outcome.error?.code ?? 'acknowledged');
    assert('ownership-during-draw', 'pixel unchanged after denied drawing', { color: 'red', epoch: 1 }, await s.read('bob', 'fencedPixels/0'));
    assert('ownership-during-draw', 'retry observes new owner', 'bob', s.reads.filter(r => r.actor === 'alice' && r.path === 'fencedClaims/red').at(-1)?.data?.uid);
  });

  await runCase('delayed-release', async () => {
    const s = await setup('delayed-release');
    await s.claim('alice', 'red');
    const delayed = { uid: null, epoch: 1 };
    await s.write('alice', 'fencedClaims/red', delayed); await s.claim('bob', 'red');
    const outcome = await settled(s.write('alice', 'fencedClaims/red', delayed));
    assert('delayed-release', 'delayed release denied', 'permission-denied', outcome.error?.code ?? 'acknowledged');
    assert('delayed-release', 'new ownership survives delayed release', { uid: 'bob', epoch: 2 }, await s.read('bob', 'fencedClaims/red'));
  });

  await runCase('multiple-colors', async () => {
    const s = await setup('multiple-colors');
    const redReady = deferred(), blueReady = deferred(), release = deferred();
    const red = settled(s.claim('alice', 'red', async () => { redReady.resolve(); await wait(release.promise, 'both color reads'); }));
    const blue = settled(s.claim('alice', 'blue', async () => { blueReady.resolve(); await wait(release.promise, 'both color reads'); }));
    try { await wait(Promise.all([redReady.promise, blueReady.promise]), 'parallel claim reads'); }
    finally { release.resolve(); }
    await Promise.all([unwrap(red), unwrap(blue)]);
    assert('multiple-colors', 'both transactions read vacant claims', [null, null], s.reads.map(r => r.data ?? null));
    const owners = await Promise.all(['red', 'blue'].map(color => s.read('alice', `fencedClaims/${color}`)));
    assert('multiple-colors', 'one user owns at most one color', true, owners.filter(claim => claim?.uid === 'alice').length <= 1);
    record('observations', { caseId: 'multiple-colors', kind: 'owned-colors', value: owners });
  });

  await runCase('concurrent-pixel', async () => {
    const s = await setup('concurrent-pixel');
    await s.claim('alice', 'red'); await s.claim('bob', 'blue');
    const latest = {}, subscriptions = [], initial = [], delivered = [];
    for (const actor of ['alice', 'bob']) {
      const ready = deferred(), blue = deferred(); initial.push(ready.promise); delivered.push(blue.promise);
      subscriptions.push(onSnapshot(doc(s.db(actor), 'fencedPixels/0'), snapshot => {
        latest[actor] = snapshot.data()?.color ?? null;
        record('observations', { caseId: 'concurrent-pixel', actor, kind: 'listener-delivery', value: latest[actor] });
        ready.resolve(); if (latest[actor] === 'blue') blue.resolve();
      }, error => record('observations', { caseId: 'concurrent-pixel', actor, kind: 'listener-error', value: error.message })));
    }
    const ready = deferred(), release = deferred(); let first = true;
    try {
      await wait(Promise.all(initial), 'listeners attach');
      const bob = settled(s.draw('bob', 'blue', 1, async () => { if (first) { first = false; ready.resolve(); await wait(release.promise, 'red commit'); } }));
      try { await wait(ready.promise, 'bob initial pixel read'); await s.draw('alice', 'red', 1); }
      finally { release.resolve(); }
      await unwrap(bob);
      const firstRead = actor => s.reads.find(r => r.actor === actor && r.path === 'fencedPixels/0')?.data ?? null;
      assert('concurrent-pixel', 'both contenders read the same pixel', [null, null], [firstRead('alice'), firstRead('bob')]);
      const saved = await s.read('alice', 'fencedPixels/0');
      assert('concurrent-pixel', 'later committed color is saved', { color: 'blue', epoch: 1 }, saved);
      await wait(Promise.all(delivered), 'blue listener delivery');
      assert('concurrent-pixel', 'both listeners converge to saved winner', ['blue', 'blue'], [latest.alice, latest.bob]);
    } finally { release.resolve(); subscriptions.forEach(stop => stop()); }
  });
}
