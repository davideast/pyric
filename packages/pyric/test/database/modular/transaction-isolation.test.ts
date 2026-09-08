import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  onValue,
  runTransaction,
  sandbox as rtdbSandbox,
} from '../../../src/database/index.js';

describe('Realtime Database Transaction Isolation (Security Rules Pre-Evaluation)', () => {
  it('never broadcasts speculative updates to active listeners when security rules reject a transaction', async () => {
    const sandbox = initializeSandbox();
    const adminDb = getDatabase(sandbox.withAuth({ uid: 'admin' }));
    const intruderDb = getDatabase(sandbox.withAuth({ uid: 'intruder' }));

    rtdbSandbox.setRules(adminDb, {
      rules: {
        counter: {
          '.read': true,
          '.write': "auth != null && auth.uid == 'admin'",
        },
      },
    });

    await runTransaction(ref(adminDb, 'counter'), () => 10);

    const observedValues: number[] = [];
    const unsub = onValue(ref(adminDb, 'counter'), (snap) => {
      observedValues.push(snap.val());
    });
    observedValues.length = 0;

    let rejected = false;
    try {
      await runTransaction(ref(intruderDb, 'counter'), (curr) => (curr ?? 0) + 999);
    } catch {
      rejected = true;
    }

    unsub();
    expect(rejected).toBe(true);
    expect(observedValues).toEqual([]);
  });
});
