import { acquireClaim } from '../architecture/claims.mjs';
import { writePixel } from '../architecture/pixels.mjs';
/** Deterministic application-level scheduling; does not simulate offline SDK queues. */
export const lifecycleAssertions = {
  'claim-aba-control': ['old claim write rejected after reacquisition'],
  'fenced-claims': ['fresh owner can draw', 'released claim cannot draw', 'epoch advances on reacquisition', 'old claim write rejected after reacquisition', 'stale release rejected', 'rejected write leaves pixel unchanged', 'claim cannot be deleted', 'epoch cannot be reset', 'other member cannot use current epoch'],
  'same-pixel': ['later serialized commit wins', 'other pixel unchanged'],
  'listener-resubscribe': ['resubscription observes missed write'],
};

export async function runClaimLifecycle({ sdk, backend, runCase, operation, assert, record }) {
  const { doc, getDoc, setDoc, deleteDoc, runTransaction, onSnapshot } = sdk;
  for (const fenced of [false, true]) {
    const caseId = fenced ? 'fenced-claims' : 'claim-aba-control';
    await runCase(caseId, async () => {
      const db = await backend();
      const claims = fenced ? 'fencedClaims/red' : 'claims/red';
      const pixels = fenced ? 'fencedPixels/0' : 'claimedPixels/0';
      const read = path => operation(caseId, 'alice', 'get', path, async () => (await getDoc(doc(db('alice'), path))).data());
      const write = (actor, path, data) => {
        record('observations', { caseId, actor, kind: 'submitted-payload', path, value: data });
        return operation(caseId, actor, 'set', path, () => setDoc(doc(db(actor), path), data));
      };
      const acquire = () => operation(caseId, 'alice', 'transaction', claims, () => acquireClaim(sdk, db('alice'), {
        path: claims, uid: 'alice', fenced,
        read: action => operation(caseId, 'alice', 'transaction-read', claims, async () => (await action()).data()),
        stage: data => record('operations', { caseId, actor: 'alice', kind: 'transaction-stage-set', path: claims, status: 'staged', value: data }),
      }));
      const expectDenied = async (name, action) => {
        let outcome = 'acknowledged';
        try { await action(); } catch (error) { outcome = error.code ?? error.message; }
        assert(caseId, name, 'permission-denied', outcome);
      };
      const epoch = await acquire();
      const oldPayload = fenced ? { color: 'red', epoch } : { color: 'red' };
      await write('alice', pixels, oldPayload);
      if (fenced) assert(caseId, 'fresh owner can draw', { color: 'red', epoch: 1 }, await read(pixels));
      if (fenced) await write('alice', claims, { uid: null, epoch });
      else await operation(caseId, 'alice', 'delete', claims, () => deleteDoc(doc(db('alice'), claims)));
      if (fenced) await expectDenied('released claim cannot draw', () => write('alice', pixels, oldPayload));
      const nextEpoch = await acquire();
      if (fenced) {
        assert(caseId, 'epoch advances on reacquisition', 2, nextEpoch);
        await write('alice', pixels, { color: 'red', epoch: nextEpoch });
      }
      // Release/reacquire returns to the same UID: a UID-only policy misses staleness.
      await expectDenied('old claim write rejected after reacquisition', () => write('alice', pixels, oldPayload));
      if (fenced) {
        await expectDenied('stale release rejected', () => write('alice', claims, { uid: null, epoch }));
        assert(caseId, 'rejected write leaves pixel unchanged', { color: 'red', epoch: 2 }, await read(pixels));
        await expectDenied('claim cannot be deleted', () => operation(caseId, 'alice', 'delete', claims, () => deleteDoc(doc(db('alice'), claims))));
        await expectDenied('epoch cannot be reset', () => write('alice', claims, { uid: 'alice', epoch: 1 }));
        await expectDenied('other member cannot use current epoch', () => write('bob', pixels, { color: 'red', epoch: 2 }));
      }
    });
  }
  await runCase('same-pixel', async () => {
    const db = await backend();
    const paint = (actor, path, color) => operation('same-pixel', actor, 'set', path, () => writePixel(sdk, db(actor), path, color));
    // Both are legitimate members. This policy intentionally permits overwrite.
    await paint('alice', 'pixels/1', 'green');
    await paint('alice', 'pixels/0', 'red');
    await paint('bob', 'pixels/0', 'blue');
    for (const [path, name, expected] of [['pixels/0', 'later serialized commit wins', 'blue'], ['pixels/1', 'other pixel unchanged', 'green']]) {
      const actual = await operation('same-pixel', 'alice', 'get', path, async () => (await getDoc(doc(db('alice'), path))).data().color);
      assert('same-pixel', name, expected, actual);
    }
  });
  await runCase('listener-resubscribe', async () => {
    const db = await backend();
    const path = 'pixels/0';
    const paint = color => operation('listener-resubscribe', 'alice', 'set', path, () => writePixel(sdk, db('alice'), path, color));
    const observe = async () => {
      let unsubscribe;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Resubscription snapshot timeout')), 5000);
          unsubscribe = onSnapshot(doc(db('bob'), path), snapshot => {
            const value = snapshot.data()?.color;
            record('observations', { caseId: 'listener-resubscribe', actor: 'bob', kind: 'listener-delivery', path, value });
            resolve(value);
          }, reject);
        });
      } finally { clearTimeout(timer); unsubscribe?.(); }
    };
    await paint('red');
    await observe(); // Unsubscribes before the next write; no offline transport claim.
    await paint('blue');
    assert('listener-resubscribe', 'resubscription observes missed write', 'blue', await observe());
  });
}
