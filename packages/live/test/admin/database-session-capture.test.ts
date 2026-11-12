/**
 * Unit tests for `admin/database-session-capture.ts`: bounded session delta
 * assembly across Admin RTDB `Query` (`get`, `once`, `on` value + child events,
 * filtered queries) and `Reference` (`set`, `setWithPriority`, `update`,
 * `remove`, `push`, committed vs aborted `transaction`, `.sv` sentinels, and
 * 256 KiB item bounds).
 */
import { describe, expect, test } from 'bun:test';
import {
  adminDatabaseDelivery,
  adminDatabaseResult,
  adminDatabaseSessionContext,
} from '../../src/admin/database-session-capture.js';

const INSTANCE = 'demo-rtdb-default-rtdb';

function makeCompatRef(path: string, key?: string) {
  const parts = path.split('/').filter((seg) => seg.length > 0);
  return {
    key: key ?? parts[parts.length - 1] ?? null,
    _delegate: {
      _path: { toString: () => path },
      _queryIdentifier: 'default',
    },
  };
}

function makeCompatSnap(path: string, val: unknown, key?: string) {
  return {
    key: key ?? (path.split('/').filter((s) => s.length > 0).pop() ?? null),
    ref: makeCompatRef(path, key),
    val: () => val,
  };
}

function makeSite(
  name: string,
  extra: {
    path?: string;
    subject?: unknown;
    rtdbFilteredQuery?: boolean;
  } = {},
) {
  return {
    module: '@firebase/database-compat/standalone',
    name,
    sdk: 'admin' as const,
    instance: INSTANCE,
    observer: () => undefined,
    ...extra,
  };
}

describe('admin/database-session-capture', () => {
  test('captures Reference set, setWithPriority, multi-path update, remove, and push at resolved child path', () => {
    const setCtx = adminDatabaseSessionContext(
      'Reference.set',
      [{ title: 'alpha', count: 1 }],
      INSTANCE,
      '/queues/q1',
    );
    expect(setCtx.sessionData).toEqual({
      rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/q1', value: { title: 'alpha', count: 1 } }],
    });
    expect(typeof setCtx.onCallStart).toBe('function');

    expect(
      adminDatabaseSessionContext('Reference.setWithPriority', [{ rank: 2 }, 10], INSTANCE, '/queues/q1').sessionData,
    ).toEqual({
      rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/q1', value: { rank: 2, '.priority': 10 } }],
    });

    expect(
      adminDatabaseSessionContext('Reference.setWithPriority', [true, 'high'], INSTANCE, '/flags/f1').sessionData,
    ).toEqual({
      rtdb: [
        {
          kind: 'set',
          instance: INSTANCE,
          path: '/flags/f1',
          value: { '.value': true, '.priority': 'high' },
        },
      ],
    });

    expect(
      adminDatabaseSessionContext('Reference.setPriority', [10], INSTANCE, '/queues/q1').sessionData,
    ).toEqual({
      rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/queues/q1' }],
    });

    expect(
      adminDatabaseSessionContext(
        'Reference.update',
        [{ 'q1/count': 3, 'q2/label': 'ready' }],
        INSTANCE,
        '/queues',
      ).sessionData,
    ).toEqual({
      rtdb: [{ kind: 'update', instance: INSTANCE, path: '/queues', value: { 'q1/count': 3, 'q2/label': 'ready' } }],
    });

    expect(adminDatabaseSessionContext('Reference.remove', [], INSTANCE, '/queues/q1').sessionData).toEqual({
      rtdb: [{ kind: 'remove', instance: INSTANCE, path: '/queues/q1' }],
    });

    const childRef = makeCompatRef('/queues/pushed-99', 'pushed-99');
    expect(
      adminDatabaseSessionContext('Reference.push', [childRef, { label: 'queued' }], INSTANCE, '/queues').sessionData,
    ).toEqual({
      rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/pushed-99', value: { label: 'queued' } }],
    });
  });

  test('marks ServerValue .sv sentinels, forbidden RTDB keys, and oversized 256 KiB payloads as skipped', () => {
    expect(
      adminDatabaseSessionContext(
        'Reference.set',
        [{ title: 'alpha', updatedAt: { '.sv': 'timestamp' } }],
        INSTANCE,
        '/queues/q1',
      ).sessionData,
    ).toEqual({ skipped: { unsupported: 1 } });

    expect(
      adminDatabaseSessionContext(
        'Reference.update',
        [{ 'q1/count': 3, 'q2/count': { '.sv': { increment: 1 } } }],
        INSTANCE,
        '/queues',
      ).sessionData,
    ).toEqual({ skipped: { unsupported: 1 } });

    const childRef = makeCompatRef('/queues/pushed-sv', 'pushed-sv');
    expect(
      adminDatabaseSessionContext(
        'Reference.push',
        [childRef, { createdAt: { '.sv': 'timestamp' } }],
        INSTANCE,
        '/queues',
      ).sessionData,
    ).toEqual({ skipped: { unsupported: 1 } });

    expect(
      adminDatabaseSessionContext('Reference.set', [{ 'bad.key': 1 }], INSTANCE, '/queues/q1').sessionData,
    ).toEqual({ skipped: { unsupported: 1 } });

    expect(
      adminDatabaseSessionContext(
        'Reference.set',
        [{ huge: 'x'.repeat(270 * 1024) }],
        INSTANCE,
        '/queues/q1',
      ).sessionData,
    ).toEqual({ skipped: { oversized: 1 } });
  });

  test('captures Query.get and Query.once for bare value, filtered query update, and child_* events', () => {
    expect(
      adminDatabaseResult(
        makeSite('Query.get', { path: '/queues/q1' }),
        makeCompatSnap('/queues/q1', { ok: true }),
      ),
    ).toEqual({
      sessionData: {
        rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/q1', value: { ok: true } }],
      },
    });

    expect(
      adminDatabaseResult(
        makeSite('Query.get', { path: '/queues', rtdbFilteredQuery: true }),
        makeCompatSnap('/queues', { q1: { ok: true } }),
      ),
    ).toEqual({
      sessionData: {
        rtdb: [
          { kind: 'invalidate', instance: INSTANCE, path: '/queues' },
          { kind: 'update', instance: INSTANCE, path: '/queues', value: { q1: { ok: true } } },
        ],
      },
    });

    expect(
      adminDatabaseResult(
        makeSite('Query.get', { path: '/queues', rtdbFilteredQuery: true }),
        makeCompatSnap('/queues', null),
      ),
    ).toEqual({
      sessionData: {
        rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/queues' }],
      },
    });

    const onceValueCtx = adminDatabaseSessionContext('Query.once', ['value'], INSTANCE, '/queues/q1');
    expect(
      adminDatabaseResult(
        makeSite('Query.once', { path: '/queues/q1', subject: onceValueCtx.subject }),
        makeCompatSnap('/queues/q1', 42),
      ),
    ).toEqual({
      sessionData: {
        rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/q1', value: 42 }],
      },
    });

    const onceChildAddedCtx = adminDatabaseSessionContext('Query.once', ['child_added'], INSTANCE, '/queues');
    expect(
      adminDatabaseResult(
        makeSite('Query.once', { path: '/queues', subject: onceChildAddedCtx.subject }),
        makeCompatSnap('/queues/q2', { step: 1 }, 'q2'),
      ),
    ).toEqual({
      sessionData: {
        rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/q2', value: { step: 1 } }],
      },
    });

    const onceChildRemovedCtx = adminDatabaseSessionContext('Query.once', ['child_removed'], INSTANCE, '/queues');
    expect(
      adminDatabaseResult(
        makeSite('Query.once', { path: '/queues', subject: onceChildRemovedCtx.subject }),
        makeCompatSnap('/queues/q2', { step: 1 }, 'q2'),
      ),
    ).toEqual({
      sessionData: {
        rtdb: [{ kind: 'remove', instance: INSTANCE, path: '/queues/q2' }],
      },
    });
  });

  test('captures Query.on value and child_* deliveries, and Reference.transaction only when committed === true', () => {
    expect(
      adminDatabaseDelivery(
        makeSite('Query.on', { path: '/queues', rtdbFilteredQuery: true }),
        'value',
        makeCompatSnap('/queues', { q1: { active: true } }),
      ),
    ).toEqual({
      rtdb: [
        { kind: 'invalidate', instance: INSTANCE, path: '/queues' },
        { kind: 'update', instance: INSTANCE, path: '/queues', value: { q1: { active: true } } },
      ],
    });

    expect(
      adminDatabaseDelivery(
        makeSite('Query.on', { path: '/queues' }),
        'child_changed',
        makeCompatSnap('/queues/q1', { active: false }, 'q1'),
      ),
    ).toEqual({
      rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/q1', value: { active: false } }],
    });

    expect(
      adminDatabaseDelivery(
        makeSite('Query.on', { path: '/queues' }),
        'child_moved',
        makeCompatSnap('/queues/q1', { active: false }, 'q1'),
      ),
    ).toEqual({
      rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/q1', value: { active: false } }],
    });

    expect(
      adminDatabaseDelivery(
        makeSite('Query.on', { path: '/queues' }),
        'child_removed',
        makeCompatSnap('/queues/q1', { active: false }, 'q1'),
      ),
    ).toEqual({
      rtdb: [{ kind: 'remove', instance: INSTANCE, path: '/queues/q1' }],
    });

    expect(
      adminDatabaseDelivery(
        makeSite('Query.on', { path: '/queues', rtdbFilteredQuery: true }),
        'child_removed',
        makeCompatSnap('/queues/q1', { active: false }, 'q1'),
      ),
    ).toEqual({
      rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/queues/q1' }],
    });

    const onceFilteredRemoved = adminDatabaseSessionContext('Query.once', ['child_removed'], INSTANCE, '/queues');
    expect(
      adminDatabaseResult(
        makeSite('Query.once', { path: '/queues', subject: onceFilteredRemoved.subject, rtdbFilteredQuery: true }),
        makeCompatSnap('/queues/q1', { active: false }, 'q1'),
      ),
    ).toEqual({
      sessionData: {
        rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/queues/q1' }],
      },
    });

    // In-flight Admin write converts overlapping listener deliveries AND one-shot Query.get / Query.once reads into `invalidate` (#2540 F6, H-A, M9).
    const inflightCtx = adminDatabaseSessionContext('Reference.set', [{ active: true }], INSTANCE, '/queues/q1');
    const lease = inflightCtx.onCallStart!();
    try {
      expect(
        adminDatabaseDelivery(
          makeSite('Query.on', { path: '/queues/q1' }),
          'value',
          makeCompatSnap('/queues/q1', { active: true }),
        ),
      ).toEqual({
        rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/queues/q1' }],
      });

      expect(
        adminDatabaseResult(
          makeSite('Query.get', { path: '/queues/q1' }),
          makeCompatSnap('/queues/q1', { active: true }),
        ),
      ).toEqual({
        sessionData: {
          rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/queues/q1' }],
        },
      });

      const onceValCtx = adminDatabaseSessionContext('Query.once', ['value'], INSTANCE, '/queues/q1');
      expect(
        adminDatabaseResult(
          makeSite('Query.once', { path: '/queues/q1', subject: onceValCtx.subject }),
          makeCompatSnap('/queues/q1', { active: true }),
        ),
      ).toEqual({
        sessionData: {
          rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/queues/q1' }],
        },
      });

      const onceChildCtx = adminDatabaseSessionContext('Query.once', ['child_added'], INSTANCE, '/queues');
      expect(
        adminDatabaseResult(
          makeSite('Query.once', { path: '/queues', subject: onceChildCtx.subject }),
          makeCompatSnap('/queues/q1', { active: true }, 'q1'),
        ),
      ).toEqual({
        sessionData: {
          rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/queues/q1' }],
        },
      });
    } finally {
      lease.release();
    }

    // M9: Admin `Reference.update` holds a patch-scoped lease while pending.
    const updateLeaseCtx = adminDatabaseSessionContext(
      'Reference.update',
      [{ 'q1/active': true }],
      INSTANCE,
      '/queues',
    );
    const updateLease = updateLeaseCtx.onCallStart!();
    try {
      expect(
        adminDatabaseResult(
          makeSite('Query.get', { path: '/queues/q1/active' }),
          makeCompatSnap('/queues/q1/active', true),
        ),
      ).toEqual({
        sessionData: {
          rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/queues/q1/active' }],
        },
      });
      expect(
        adminDatabaseResult(
          makeSite('Query.get', { path: '/queues/q2/active' }),
          makeCompatSnap('/queues/q2/active', false),
        ),
      ).toEqual({
        sessionData: {
          rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/q2/active', value: false }],
        },
      });
    } finally {
      updateLease.release();
    }

    expect(
      adminDatabaseResult(makeSite('Reference.transaction', { path: '/counters/processed' }), {
        committed: true,
        snapshot: { key: 'processed', val: () => 9 },
      }),
    ).toEqual({
      sessionData: {
        rtdb: [{ kind: 'set', instance: INSTANCE, path: '/counters/processed', value: 9 }],
      },
    });

    expect(
      adminDatabaseResult(makeSite('Reference.transaction', { path: '/counter' }), {
        committed: false,
        snapshot: makeCompatSnap('/counter', 8),
      }),
    ).toEqual({});

    expect(
      adminDatabaseResult(makeSite('Query.get', { path: '/docs/doc-1' }), {
        ...makeCompatSnap('/docs/doc-1', { title: 'v1' }),
        exportVal: () => ({ title: 'v1', '.priority': 10 }),
      }),
    ).toEqual({
      sessionData: {
        rtdb: [
          {
            kind: 'set',
            instance: INSTANCE,
            path: '/docs/doc-1',
            value: { title: 'v1', '.priority': 10 },
          },
        ],
      },
    });
  });
});
