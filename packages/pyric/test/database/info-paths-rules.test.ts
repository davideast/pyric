import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, onValue, ref as dbRef, sandbox as rtdbSandbox } from '../../src/database/index.js';

describe('RTDB system .info paths security rules bypass', () => {
  it('allows attaching a value listener to /.info/connected under strict deny-all rules', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'bob' }));
    rtdbSandbox.setRules(db, {
      rules: {
        '.read': 'false',
        '.write': 'false',
      },
    });

    let permissionError: Error | null = null;
    let receivedValue: unknown = undefined;
    try {
      const unsubscribe = onValue(
        dbRef(db, '/.info/connected'),
        (snap) => {
          receivedValue = snap.val();
        },
        (err) => {
          permissionError = err;
        },
      );
      unsubscribe();
    } catch (err) {
      permissionError = err instanceof Error ? err : new Error(String(err));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(permissionError).toBeNull();
  });
});
