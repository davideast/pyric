/**
 * The session-data sidecar and delta assembly (`session-data.ts`): a delta
 * leaves out empty op lists and zero skip counts, as the host reads them,
 * and a record carries its delta only through `sessionDataOf`.
 */
import { describe, expect, test } from 'bun:test';
import type { LiveCallRecord } from '../src/observe.js';
import {
  attachSessionData,
  mergeSessionData,
  sessionDataOf,
  sessionDeltaOf,
  skipCountsOf,
  skipDeltaOf,
} from '../src/session-data.js';

const SET_ITEM = { kind: 'set', path: 'items/a', data: { n: 1 } } as const;
const REMOVE_ROOM = { kind: 'remove', instance: 'demo-default-rtdb', path: '/rooms/r1' } as const;
const DELETE_BLOB = { kind: 'delete', bucket: 'demo.firebasestorage.app', fullPath: 'items/a.png' } as const;

describe('skipCountsOf', () => {
  test('is undefined when every count is zero', () => {
    expect(skipCountsOf(0, 0, 0)).toBeUndefined();
  });

  test('leaves out each zero count', () => {
    expect(skipCountsOf(2, 0, 1)).toEqual({ oversized: 2, truncated: 1 });
    expect(Object.keys(skipCountsOf(0, 3, 0) ?? {})).toEqual(['unsupported']);
  });
});

describe('sessionDeltaOf', () => {
  test('is undefined when it has no ops and no skips', () => {
    expect(sessionDeltaOf({})).toBeUndefined();
    expect(sessionDeltaOf({ firestore: [], rtdb: [], skipped: undefined })).toBeUndefined();
  });

  test('leaves out empty op lists and absent skips', () => {
    const delta = sessionDeltaOf({ firestore: [SET_ITEM], rtdb: [], skipped: undefined });
    expect(delta).toEqual({ firestore: [SET_ITEM] });
    expect(Object.keys(delta ?? {})).toEqual(['firestore']);
  });

  test('keeps every part it has', () => {
    expect(sessionDeltaOf({ firestore: [SET_ITEM], rtdb: [REMOVE_ROOM], skipped: { truncated: 1 } })).toEqual({
      firestore: [SET_ITEM],
      rtdb: [REMOVE_ROOM],
      skipped: { truncated: 1 },
    });
  });
});

describe('skipDeltaOf', () => {
  test('counts one value left out for its reason', () => {
    expect(skipDeltaOf('oversized')).toEqual({ skipped: { oversized: 1 } });
  });
});

describe('mergeSessionData', () => {
  test('keeps the one side that has anything', () => {
    const only = { firestore: [SET_ITEM] };
    expect(mergeSessionData(undefined, only)).toBe(only);
    expect(mergeSessionData(only, {})).toBe(only);
    expect(mergeSessionData(undefined, undefined)).toBeUndefined();
  });

  test('concatenates ops and sums skip counts', () => {
    const merged = mergeSessionData(
      { firestore: [SET_ITEM], storage: [DELETE_BLOB], skipped: { oversized: 1 } },
      { rtdb: [REMOVE_ROOM], skipped: { oversized: 1, truncated: 2 } },
    );
    expect(merged).toEqual({
      firestore: [SET_ITEM],
      rtdb: [REMOVE_ROOM],
      storage: [DELETE_BLOB],
      skipped: { oversized: 2, truncated: 2 },
    });
  });
});

describe('attachSessionData', () => {
  test('a record carries its delta only through sessionDataOf, never as a property', () => {
    const record = { module: 'firebase/firestore', name: 'getDoc', outcome: 'resolved' } as LiveCallRecord;
    attachSessionData(record, { firestore: [SET_ITEM] });
    expect(sessionDataOf(record)).toEqual({ firestore: [SET_ITEM] });
    expect(JSON.stringify(record)).not.toContain('items/a');
  });

  test('an empty delta attaches nothing', () => {
    const record = { module: 'firebase/firestore', name: 'getDoc', outcome: 'resolved' } as LiveCallRecord;
    attachSessionData(record, { firestore: [], skipped: {} });
    expect(sessionDataOf(record)).toBeUndefined();
  });
});
