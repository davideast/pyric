import { describe, expect, test } from 'bun:test';
import {
  DocumentLifecycleTracker,
  classifyDocumentTransition,
  triggerMatchesTransitionKind,
} from '../../src/functions/firestore/document-change.js';

describe('document-change lifecycle classification & timestamp continuity', () => {
  test('classifies created, updated, deleted, and no-op transitions cleanly', () => {
    expect(classifyDocumentTransition(null, null)).toEqual({ kind: 'noop' });
    expect(classifyDocumentTransition(null, { name: 'Alice' })).toEqual({
      kind: 'created',
      before: null,
      after: { name: 'Alice' },
    });
    expect(classifyDocumentTransition({ name: 'Alice' }, null)).toEqual({
      kind: 'deleted',
      before: { name: 'Alice' },
      after: null,
    });
    expect(
      classifyDocumentTransition(
        { name: 'Alice', tags: ['a', 'b'] },
        { tags: ['a', 'b'], name: 'Alice' },
      ),
    ).toEqual({ kind: 'noop' });
    expect(
      classifyDocumentTransition(
        { name: 'Alice', count: 1 },
        { name: 'Alice', count: 2 },
      ),
    ).toEqual({
      kind: 'updated',
      before: { name: 'Alice', count: 1 },
      after: { name: 'Alice', count: 2 },
      updateMask: ['count'],
    });
  });

  test('preserves createTime across updates and resets createTime after delete + re-create', () => {
    const tracker = new DocumentLifecycleTracker();
    const t1 = { seconds: 100, nanoseconds: 0 };
    const t2 = { seconds: 200, nanoseconds: 500 };
    const t2Noop = { seconds: 250, nanoseconds: 0 };
    const t3 = { seconds: 300, nanoseconds: 0 };
    const t4 = { seconds: 400, nanoseconds: 0 };

    const created = tracker.applyWrite('(default)', 'users/u1', null, { v: 1 }, t1);
    expect(created).toEqual({
      kind: 'created',
      database: '(default)',
      document: 'users/u1',
      before: null,
      after: { fields: { v: 1 }, createTime: t1, updateTime: t1 },
      updateMask: [],
      time: t1,
    });

    expect(tracker.applyWrite('(default)', 'users/u1', { v: 1 }, { v: 1 }, t2Noop)).toBeNull();

    const updated = tracker.applyWrite('(default)', 'users/u1', { v: 1 }, { v: 2 }, t2);
    expect(updated).toEqual({
      kind: 'updated',
      database: '(default)',
      document: 'users/u1',
      before: { fields: { v: 1 }, createTime: t1, updateTime: t1 },
      after: { fields: { v: 2 }, createTime: t1, updateTime: t2 },
      updateMask: ['v'],
      time: t2,
    });

    const deleted = tracker.applyWrite('(default)', 'users/u1', { v: 2 }, null, t3);
    expect(deleted).toEqual({
      kind: 'deleted',
      database: '(default)',
      document: 'users/u1',
      before: { fields: { v: 2 }, createTime: t1, updateTime: t2 },
      after: null,
      updateMask: [],
      time: t3,
    });

    expect(tracker.applyWrite('(default)', 'users/u1', null, null, t3)).toBeNull();

    const recreated = tracker.applyWrite('(default)', 'users/u1', null, { v: 3 }, t4);
    expect(recreated).toEqual({
      kind: 'created',
      database: '(default)',
      document: 'users/u1',
      before: null,
      after: { fields: { v: 3 }, createTime: t4, updateTime: t4 },
      updateMask: [],
      time: t4,
    });
  });

  test('seeds historical writes without firing and isolates named databases', () => {
    const tracker = new DocumentLifecycleTracker();
    const tSeedCreate = { seconds: 10, nanoseconds: 0 };
    const tSeedUpdate = { seconds: 20, nanoseconds: 0 };
    const tLiveUpdate = { seconds: 30, nanoseconds: 0 };

    tracker.seedFromWrite('(default)', 'cfg/app', null, { v: 1 }, tSeedCreate);
    tracker.seedFromWrite('(default)', 'cfg/app', { v: 1 }, { v: 2 }, tSeedUpdate);
    tracker.seedFromWrite('analytics', 'cfg/app', null, { v: 1 }, { seconds: 99, nanoseconds: 0 });

    const defaultUpdate = tracker.applyWrite('(default)', 'cfg/app', { v: 2 }, { v: 3 }, tLiveUpdate);
    expect(defaultUpdate).toEqual({
      kind: 'updated',
      database: '(default)',
      document: 'cfg/app',
      before: { fields: { v: 2 }, createTime: tSeedCreate, updateTime: tSeedUpdate },
      after: { fields: { v: 3 }, createTime: tSeedCreate, updateTime: tLiveUpdate },
      updateMask: ['v'],
      time: tLiveUpdate,
    });
  });

  test('routes transition kinds to the matching v2 Firestore event types', () => {
    expect(
      triggerMatchesTransitionKind('google.cloud.firestore.document.v1.created', 'created'),
    ).toBe(true);
    expect(
      triggerMatchesTransitionKind('google.cloud.firestore.document.v1.created', 'updated'),
    ).toBe(false);
    expect(
      triggerMatchesTransitionKind('google.cloud.firestore.document.v1.updated', 'updated'),
    ).toBe(true);
    expect(
      triggerMatchesTransitionKind(
        'google.cloud.firestore.document.v1.updated.withAuthContext',
        'deleted',
      ),
    ).toBe(false);
    expect(
      triggerMatchesTransitionKind('google.cloud.firestore.document.v1.deleted', 'deleted'),
    ).toBe(true);
    for (const kind of ['created', 'updated', 'deleted'] as const) {
      expect(
        triggerMatchesTransitionKind('google.cloud.firestore.document.v1.written', kind),
      ).toBe(true);
      expect(
        triggerMatchesTransitionKind(
          'google.cloud.firestore.document.v1.written.withAuthContext',
          kind,
        ),
      ).toBe(true);
    }
  });
});
