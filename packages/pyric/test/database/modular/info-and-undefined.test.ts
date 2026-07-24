/**
 * Characterization tests for RTDB `.info/connected` and `.info/serverTimeOffset` system path simulation.
 */

import { describe, expect, it } from 'bun:test';
import { getDatabase, onValue, ref } from '../../../src/database/index.js';
import { initializeSandbox } from 'pyric/sandbox';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'test-user' }));
  return { sandbox, db };
}

describe('RTDB system status paths', () => {
  it('allows references to .info/connected without throwing invalid path errors', async () => {
    const { db } = setup();
    const infoRef = ref(db, '.info/connected');

    let isConnected: unknown = false;
    onValue(infoRef, (snap) => {
      isConnected = snap.val();
    });

    expect(isConnected).toBe(true);
  });

  it('allows references to .info/serverTimeOffset returning 0 in local sandboxes', async () => {
    const { db } = setup();
    const offsetRef = ref(db, '.info/serverTimeOffset');

    let offset: unknown = null;
    onValue(offsetRef, (snap) => {
      offset = snap.val();
    });

    expect(offset).toBe(0);
  });
});
