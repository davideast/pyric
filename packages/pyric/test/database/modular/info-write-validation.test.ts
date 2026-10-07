/**
 * Writes under `/.info` replay the production capture
 * rtdb-modular-info-write-validation: each write API throws synchronously
 * with the SDK's message, an update from the root names `.info` as an
 * invalid key, and an update on a `.info` reference is rejected by the
 * database as an invalid path. No write under `/.info` changes data.
 */
import { describe, expect, test } from 'bun:test';
import { sandbox } from '../../../src/database/index.js';
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
});
