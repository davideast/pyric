/**
 * Writes under `/.info` replay the production capture
 * rtdb-modular-info-write-validation: each write API throws synchronously
 * with the SDK's message, an update from the root names `.info` as an
 * invalid key, and an update on a `.info` reference is rejected by the
 * database as an invalid path. No write under `/.info` changes data.
 */
import { describe, expect, test } from 'bun:test';
import * as api from '../../../src/database/index.js';
import { sandbox } from '../../../src/database/index.js';
import { initializeSandbox } from 'pyric/sandbox';
import { load } from './oracle-conformance.support.js';
import { INFO_WRITES, captureInvocation, infoWriteDb } from '../cdd/info-write-contracts.js';

const behavior = load('rtdb-modular-info-write-validation.json') as Record<string, unknown>;

describe('RTDB writes under /.info', () => {
  test('the capture records every write the replay runs', () => {
    expect(Object.keys(behavior).filter((key) => key !== 'repeatCount' && key !== 'getConnected').sort())
      .toEqual(Object.keys(INFO_WRITES).sort());
  });

  for (const [name, write] of Object.entries(INFO_WRITES)) {
    test(`${name} fails as production does and writes nothing`, async () => {
      const db = infoWriteDb();
      const before = sandbox.snapshotState(db);
      expect(await captureInvocation(() => write(db))).toEqual(behavior[name]);
      expect(sandbox.snapshotState(db)).toEqual(before);
    });
  }

  describe('get() of a location under /.info', () => {
    // behavior.getConnected: the SDK sends a one-shot read to the database,
    // which refuses the `.info` token. A listener on the path still works.
    test('rejects as production does under open rules, deny-all rules and the admin handle', async () => {
      expect(behavior.getConnected).toEqual({
        timing: 'asynchronous-reject', name: 'Error', code: null, message: 'Invalid token in path',
      });
      const open = infoWriteDb();
      expect(await captureInvocation(() => api.get(api.ref(open, '.info/connected')))).toEqual(behavior.getConnected);

      const closed = infoWriteDb();
      sandbox.setRules(closed, { rules: { '.read': false, '.write': false } });
      expect(await captureInvocation(() => api.get(api.ref(closed, '.info/connected')))).toEqual(behavior.getConnected);

      const box = initializeSandbox();
      const admin = api.getAdminDatabase(box);
      expect(await captureInvocation(() => api.get(api.ref(admin, '.info/connected')))).toEqual(behavior.getConnected);
    });

    test('rejects a query read of the same location', async () => {
      const db = infoWriteDb();
      const query = api.query(api.ref(db, '.info'), api.limitToFirst(1));
      expect(await captureInvocation(() => api.get(query))).toEqual(behavior.getConnected);
    });

    test('keeps delivering .info/connected to a listener', async () => {
      const db = infoWriteDb();
      const seen: unknown[] = [];
      const stop = api.onValue(api.ref(db, '.info/connected'), (snap) => { seen.push(snap.val()); });
      await new Promise((resolve) => setTimeout(resolve, 0));
      stop();
      expect(seen).toEqual([true]);
    });
  });
});
