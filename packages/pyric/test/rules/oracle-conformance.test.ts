/**
 * The package-level oracle gate delegates to the same replay assertion used by
 * score and report computation. Keeping one implementation prevents the test
 * command and published trust number from disagreeing about replay semantics.
 */
import { describe, expect, it } from 'bun:test';
import { replayFirestoreRulesObservations } from '../../../../packages/conformance/src/firestore-rules-oracle-replay.ts';

const replays = await replayFirestoreRulesObservations();

describe('oracle conformance (rules-firestore)', () => {
  for (const replay of replays) {
    it(`${replay.rowId}: ${replay.name}: replays the captured production verdict contract`, () => {
      expect(replay.problems).toEqual([]);
    });
  }

  it('every captured rules-firestore observation maps to one registry row', () => {
    expect(replays).toHaveLength(29);
    expect(replays.every(({ rowId }) => /^firestore-rules#\d+$/.test(rowId))).toBe(true);
  });
});
