import { describe, expect, it } from 'bun:test';
import { loadFirestoreRulesExceptions } from '../../src/firestore-rules-exceptions.ts';

describe('Firestore Rules exception index', () => {
  it('loads an empty index when a clean checkout has no exception directory', () => {
    expect(loadFirestoreRulesExceptions()).toEqual(new Map());
  });
});
