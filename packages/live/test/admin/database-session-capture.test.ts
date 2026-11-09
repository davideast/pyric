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
    expect(
      adminDatabaseSessionContext(
        'Reference.set',
        [{ title: 'alpha', count: 1 }],
        INSTANCE,
        '/queues/q1',
      ),
    ).toEqual({
      sessionData: {
        rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/q1', value: { title: 'alpha', count: 1 } }],
      },
    });

    expect(
      adminDatabaseSessionContext('Reference.setWithPriority', [{ rank: 2 }, 10], INSTANCE, '/queues/q1'),
    ).toEqual({
      sessionData: {
        rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/q1', value: { rank: 2 } }],
      },
    });

    expect(
      adminDatabaseSessionContext(
        'Reference.update',
        [{ 'q1/count': 3, 'q2/label': 'ready' }],
        INSTANCE,
        '/queues',
      ),
    ).toEqual({
      sessionData: {
        rtdb: [{ kind: 'update', instance: INSTANCE, path: '/queues', value: { 'q1/count': 3, 'q2/label': 'ready' } }],
      },
    });

    expect(adminDatabaseSessionContext('Reference.remove', [], INSTANCE, '/queues/q1')).toEqual({
      sessionData: {
        rtdb: [{ kind: 'remove', instance: INSTANCE, path: '/queues/q1' }],
      },
    });

    const childRef = makeCompatRef('/queues/pushed-99', 'pushed-99');
    expect(
      adminDatabaseSessionContext('Reference.push', [childRef, { label: 'queued' }], INSTANCE, '/queues'),
    ).toEqual({
      sessionData: {
        rtdb: [{ kind: 'set', instance: INSTANCE, path: '/queues/pushed-99', value: { label: 'queued' } }],
      },
    });
  });

  test('marks ServerValue .sv sentinels, forbidden RTDB keys, and oversized 256 KiB payloads as skipped', () => {
    expect(
      adminDatabaseSessionContext(
        'Reference.set',
        [{ title: 'alpha', updatedAt: { '.sv': 'timestamp' } }],
        INSTANCE,
        '/queues/q1',
      ),
    ).toEqual({
      sessionData: { skipped: { unsupported: 1 } },
    });

    expect(
      adminDatabaseSessionContext(
        'Reference.update',
        [{ 'q1/count': 3, 'q2/count': { '.sv': { increment: 1 } } }],
        INSTANCE,
        '/queues',
      ),
    ).toEqual({
      sessionData: { skipped: { unsupported: 1 } },
    });

    const childRef = makeCompatRef('/queues/pushed-sv', 'pushed-sv');
    expect(
      adminDatabaseSessionContext(
        'Reference.push',
        [childRef, { createdAt: { '.sv': 'timestamp' } }],
        INSTANCE,
        '/queues',
      ),
    ).toEqual({
      sessionData: { skipped: { unsupported: 1 } },
    });

    expect(
      adminDatabaseSessionContext('Reference.set', [{ 'bad.key': 1 }], INSTANCE, '/queues/q1'),
    ).toEqual({
      sessionData: { skipped: { unsupported: 1 } },
    });

    expect(
      adminDatabaseSessionContext(
        'Reference.set',
        [{ huge: 'x'.repeat(270 * 1024) }],
        INSTANCE,
        '/queues/q1',
      ),
    ).toEqual({
      sessionData: { skipped: { oversized: 1 } },
    });
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
        rtdb: [{ kind: 'update', instance: INSTANCE, path: '/queues', value: { q1: { ok: true } } }],
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
      rtdb: [{ kind: 'update', instance: INSTANCE, path: '/queues', value: { q1: { active: true } } }],
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
    ).toBeUndefined();

    const onceFilteredRemoved = adminDatabaseSessionContext('Query.once', ['child_removed'], INSTANCE, '/queues');
    expect(
      adminDatabaseResult(
        makeSite('Query.once', { path: '/queues', subject: onceFilteredRemoved.subject, rtdbFilteredQuery: true }),
        makeCompatSnap('/queues/q1', { active: false }, 'q1'),
      ),
    ).toEqual({});

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
  });
});
