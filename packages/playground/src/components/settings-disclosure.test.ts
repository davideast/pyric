import { describe, expect, test } from 'bun:test';
import {
  countEnabled,
  isDisclosureExpanded,
  summarizeOnCount,
  toggleDisclosure,
  type DisclosureState,
} from './settings-disclosure';

describe('isDisclosureExpanded', () => {
  test('an id absent from the map reads as collapsed', () => {
    expect(isDisclosureExpanded({}, 'diagnostics')).toBe(false);
  });

  test('an id explicitly set to false reads as collapsed', () => {
    expect(isDisclosureExpanded({ diagnostics: false }, 'diagnostics')).toBe(false);
  });

  test('an id explicitly set to true reads as expanded', () => {
    expect(isDisclosureExpanded({ diagnostics: true }, 'diagnostics')).toBe(true);
  });

  test('unrelated ids in the map do not affect the queried id', () => {
    expect(isDisclosureExpanded({ other: true }, 'diagnostics')).toBe(false);
  });
});

describe('toggleDisclosure', () => {
  test('flips a collapsed (absent) id to expanded', () => {
    const next = toggleDisclosure({}, 'diagnostics');
    expect(next).toEqual({ diagnostics: true });
  });

  test('flips an expanded id back to collapsed', () => {
    const next = toggleDisclosure({ diagnostics: true }, 'diagnostics');
    expect(next).toEqual({ diagnostics: false });
  });

  test('does not mutate the input state', () => {
    const state: DisclosureState = { diagnostics: false };
    const next = toggleDisclosure(state, 'diagnostics');
    expect(state).toEqual({ diagnostics: false });
    expect(next).not.toBe(state);
  });

  test('preserves other sections when toggling one', () => {
    const state: DisclosureState = { diagnostics: true, autoFold: false };
    const next = toggleDisclosure(state, 'autoFold');
    expect(next).toEqual({ diagnostics: true, autoFold: true });
  });
});

describe('countEnabled', () => {
  test('counts items matching the predicate', () => {
    const items = [{ on: true }, { on: false }, { on: true }, { on: true }];
    expect(countEnabled(items, (i) => i.on)).toBe(3);
  });

  test('returns 0 for an empty list', () => {
    expect(countEnabled([], () => true)).toBe(0);
  });

  test('returns 0 when nothing matches', () => {
    const items = [{ on: false }, { on: false }];
    expect(countEnabled(items, (i) => i.on)).toBe(0);
  });

  test('returns the full length when everything matches', () => {
    const items = [{ on: true }, { on: true }];
    expect(countEnabled(items, (i) => i.on)).toBe(2);
  });
});

describe('summarizeOnCount', () => {
  test('derives the collapsed-row summary from counts, not a hardcoded string', () => {
    expect(summarizeOnCount(6, 5, 'tools')).toBe('5 of 6 tools on');
  });

  test('handles all-on', () => {
    expect(summarizeOnCount(6, 6, 'tools')).toBe('6 of 6 tools on');
  });

  test('handles all-off', () => {
    expect(summarizeOnCount(6, 0, 'tools')).toBe('0 of 6 tools on');
  });

  test('respects a different noun for a non-tools parent setting', () => {
    expect(summarizeOnCount(3, 1, 'options')).toBe('1 of 3 options on');
  });
});
