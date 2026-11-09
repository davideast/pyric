import { describe, expect, it } from 'bun:test';
import { createObservedSessionCoverage } from '../../../src/serve/observed-session/coverage.js';

describe('createObservedSessionCoverage', () => {
  it('tracks complete, partial, absent, evicted, and invalidated Firestore documents', () => {
    const coverage = createObservedSessionCoverage({ maxDocs: 2, maxRtdbInstances: 2 });

    expect(coverage.lookupFirestoreDoc('items/i-1', undefined)).toEqual({ status: 'unobserved' });
    // Even if storedData were passed without recorded docState, lookup never fabricates coverage.
    expect(coverage.lookupFirestoreDoc('items/i-1', { title: 'Ghost' })).toEqual({ status: 'unobserved' });

    coverage.recordFirestoreDelete('/items/absent-1');
    expect(coverage.lookupFirestoreDoc('items/absent-1', undefined)).toEqual({ status: 'absent' });

    // Merge onto a known-absent document without omitted sentinels is complete.
    coverage.recordFirestoreWrite(
      'items/absent-1',
      { kind: 'set', path: 'items/absent-1', data: { owner: 'u-1' }, merge: true },
      true,
    );
    const mergedLookup = coverage.lookupFirestoreDoc('items/absent-1', { owner: 'u-1' });
    expect(mergedLookup).toEqual({ status: 'complete', data: { owner: 'u-1' } });
    if (mergedLookup.status === 'complete') mergedLookup.data.owner = 'mutated';
    expect(coverage.lookupFirestoreDoc('items/absent-1', { owner: 'u-1' })).toEqual({
      status: 'complete',
      data: { owner: 'u-1' },
    });

    // Any write carrying `partial: true` (omitted sentinel) downgrades coverage to partial (#2540 F4).
    coverage.recordFirestoreWrite(
      'items/absent-1',
      { kind: 'update', path: 'items/absent-1', data: { updatedBy: 'u-1' }, partial: true },
      true,
    );
    expect(coverage.lookupFirestoreDoc('items/absent-1', { owner: 'u-1', updatedBy: 'u-1' })).toEqual({
      status: 'partial',
      data: { owner: 'u-1', updatedBy: 'u-1' },
    });

    // Unmerged set with partial: true is also partial.
    coverage.recordFirestoreWrite(
      'items/sentinel-set',
      { kind: 'set', path: 'items/sentinel-set', data: { title: 'Hi' }, partial: true },
      true,
    );
    expect(coverage.lookupFirestoreDoc('items/sentinel-set', { title: 'Hi' })).toEqual({
      status: 'partial',
      data: { title: 'Hi' },
    });

    // Failed store write (`wrote === false`) clears prior coverage.
    coverage.recordFirestoreWrite(
      'items/sentinel-set',
      { kind: 'set', path: 'items/sentinel-set', data: { title: 'Dropped' } },
      false,
    );
    expect(coverage.lookupFirestoreDoc('items/sentinel-set', undefined)).toEqual({
      status: 'unobserved',
    });

    coverage.evictFirestoreDoc('items/absent-1');
    expect(coverage.lookupFirestoreDoc('items/absent-1', undefined)).toEqual({ status: 'unobserved' });
  });

  it('bounds absent Firestore tombstones by maxDocs and supports targeted/collection/global invalidation', () => {
    const coverage = createObservedSessionCoverage({ maxDocs: 3, maxRtdbInstances: 2 });
    coverage.recordFirestoreDelete('rooms/r1');
    coverage.recordFirestoreDelete('rooms/r2');
    coverage.recordFirestoreDelete('rooms/r3');
    coverage.recordFirestoreDelete('rooms/r4');

    expect(coverage.lookupFirestoreDoc('rooms/r1', undefined)).toEqual({ status: 'unobserved' });
    expect(coverage.lookupFirestoreDoc('rooms/r2', undefined)).toEqual({ status: 'absent' });

    coverage.recordFirestoreDelete('rooms/r2/notes/n1');
    coverage.invalidateFirestoreCollection('rooms');
    expect(coverage.lookupFirestoreDoc('rooms/r2', undefined)).toEqual({ status: 'unobserved' });
    expect(coverage.lookupFirestoreDoc('rooms/r3', undefined)).toEqual({ status: 'unobserved' });
    // Direct collection invalidation leaves nested subcollections untouched.
    expect(coverage.lookupFirestoreDoc('rooms/r2/notes/n1', undefined)).toEqual({ status: 'absent' });

    coverage.invalidateFirestoreDoc('rooms/r2/notes/n1');
    expect(coverage.lookupFirestoreDoc('rooms/r2/notes/n1', undefined)).toEqual({ status: 'unobserved' });

    coverage.recordFirestoreWrite(
      'users/u1',
      { kind: 'set', path: 'users/u1', data: { name: 'Ada' } },
      true,
    );
    coverage.invalidateAllFirestore();
    expect(coverage.lookupFirestoreDoc('users/u1', { name: 'Ada' })).toEqual({ status: 'unobserved' });

    // Collection-group invalidation (`collectionId` single segment) clears matching nested subcollections.
    coverage.recordFirestoreWrite(
      'workspaces/w1',
      { kind: 'set', path: 'workspaces/w1', data: { name: 'Alpha' } },
      true,
    );
    coverage.recordFirestoreWrite(
      'workspaces/w1/tasks/t1',
      { kind: 'set', path: 'workspaces/w1/tasks/t1', data: { done: false } },
      true,
    );
    coverage.recordFirestoreDelete('workspaces/w2/tasks/t2');
    coverage.invalidateFirestoreCollection('tasks');
    expect(coverage.lookupFirestoreDoc('workspaces/w1/tasks/t1', { done: false })).toEqual({
      status: 'unobserved',
    });
    expect(coverage.lookupFirestoreDoc('workspaces/w2/tasks/t2', undefined)).toEqual({
      status: 'unobserved',
    });
    expect(coverage.lookupFirestoreDoc('workspaces/w1', { name: 'Alpha' })).toEqual({
      status: 'complete',
      data: { name: 'Alpha' },
    });
  });

  it('tracks RTDB subtree coverage, bidirectional prefix invalidation, and maxRtdbInstances LRU', () => {
    const coverage = createObservedSessionCoverage({ maxDocs: 4, maxRtdbInstances: 2 });

    expect(coverage.invalidateRtdbSegments('inst-a', [['groups', 'g1']])).toBe(false);
    coverage.recordRtdbCoveredSegments('inst-a', [['groups', 'g1', 'members', 'u1']]);
    expect(coverage.isRtdbPathKnown('inst-a', '/groups/g1/members/u1')).toBe(true);
    expect(coverage.isRtdbPathKnown('inst-a', '/groups/g1/members/u1/role')).toBe(true);
    expect(coverage.isRtdbPathKnown('inst-a', '/groups/g1')).toBe(false);

    // Covering ancestor subsumes child prefix.
    coverage.recordRtdbCoveredSegments('inst-a', [['groups', 'g1']]);
    expect(coverage.isRtdbPathKnown('inst-a', '/groups/g1')).toBe(true);
    expect(coverage.isRtdbPathKnown('inst-a', '/groups/g1/archived')).toBe(true);

    // Invalidating a child leaf invalidates overlapping ancestor coverage and reports whether anything changed.
    expect(coverage.invalidateRtdbSegments('inst-a', [['groups', 'g1', 'closedAt']])).toBe(true);
    expect(coverage.invalidateRtdbSegments('inst-a', [['groups', 'g1', 'closedAt']])).toBe(false);
    expect(coverage.isRtdbPathKnown('inst-a', '/groups/g1')).toBe(false);
    expect(coverage.isRtdbPathKnown('inst-a', '/groups/g1/closedAt')).toBe(false);

    coverage.recordRtdbCoveredSegments('inst-a', [['a']]);
    coverage.recordRtdbCoveredSegments('inst-b', [['b']]);
    coverage.recordRtdbCoveredSegments('inst-c', [['c']]);
    expect(coverage.isRtdbPathKnown('inst-a', '/a')).toBe(false);
    expect(coverage.isRtdbPathKnown('inst-b', '/b')).toBe(true);
    expect(coverage.isRtdbPathKnown('inst-c', '/c')).toBe(true);

    coverage.invalidateRtdbInstance('inst-b');
    expect(coverage.isRtdbPathKnown('inst-b', '/b')).toBe(false);
  });
});
