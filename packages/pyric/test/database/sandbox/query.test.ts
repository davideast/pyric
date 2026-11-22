import { describe, expect, it } from 'bun:test';
import { END_ALREADY_SET, START_ALREADY_SET } from '@pyric/rules/internal/rtdb';
import { applyConstraint, emptySpec } from '../../../src/database/sandbox/query.js';

describe('database/sandbox/query applyConstraint (#1411)', () => {
  it('throws the shared START_ALREADY_SET messages from @pyric/rules/internal/rtdb', () => {
    const withStart = applyConstraint(emptySpec(), {
      kind: 'bound',
      bound: { kind: 'startAt', value: 'a' },
    });
    for (const kind of ['startAt', 'startAfter', 'equalTo'] as const) {
      expect(() =>
        applyConstraint(withStart, { kind: 'bound', bound: { kind, value: 'b' } }),
      ).toThrow(START_ALREADY_SET[kind]);
    }
  });

  it('throws the shared END_ALREADY_SET messages from @pyric/rules/internal/rtdb', () => {
    const withEnd = applyConstraint(emptySpec(), {
      kind: 'bound',
      bound: { kind: 'endAt', value: 'z' },
    });
    for (const kind of ['endAt', 'endBefore', 'equalTo'] as const) {
      expect(() =>
        applyConstraint(withEnd, { kind: 'bound', bound: { kind, value: 'y' } }),
      ).toThrow(END_ALREADY_SET[kind]);
    }
  });
});
