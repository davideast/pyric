import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, type ObservedCall, type SandboxEvent } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { adminDatabaseDelivery } from '../../../../../live/src/admin/database-session-capture.js';
import {
  DEFAULT_INFLIGHT_LEASE_TTL_MS,
  MAX_ACTIVE_INFLIGHT_WRITES,
} from '../../../../../live/src/database-inflight-writes.js';
import {
  databaseDelivery,
  databaseResult,
  databaseWriteSession,
} from '../../../../../live/src/database-session-capture.js';
import type { ObservedSite } from '../../../../../live/src/observe.js';
import { readObservedSessionDelta } from '../../../../src/serve/observed-session/delta-validation.js';
import { createObservedSessionDataStore } from '../../../../src/serve/observed-session/store.js';
import type { ObservedSessionDelta } from '../../../../src/serve/observed-session/wire.js';
import { createLiveHostState } from '../../../../src/serve/live-host-state.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { rtdbVerdict } from '../../../../src/serve/worker/host/observe-local-rtdb.js';
import { setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';
import type { InboundMessage } from '../../../../src/serve/worker/protocol.js';

const OK = { status: 'ok' } as const;
const DENIED = { status: 'error', code: 'permission-denied' } as const;

describe('observe-local-rtdb with observedSession (#2540)', () => {
  it('abstains fail-closed with missingPaths on partial RTDB observations and evaluates allow/deny once dereferenced paths are known', () => {
    const sandbox = initializeSandbox();
    const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'rtdb-obs-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession,
    };
    expect(
      setDatabaseRules(ctx, undefined, {
        rules: {
          groups: {
            $groupId: {
              items: {
                $itemId: {
                  '.read':
                    "auth != null && root.child('groups/' + $groupId + '/members/' + auth.uid).val() === true && !root.child('groups/' + $groupId + '/archived').exists()",
                  '.write': 'auth != null',
                  '.validate':
                    "newData.hasChildren(['title']) && !newData.parent().parent().child('archived').exists()",
                },
              },
            },
          },
        },
      }).ok,
    ).toBe(true);

    const readCall: ObservedCall = {
      service: 'rtdb',
      method: 'get',
      path: '/groups/g-1/items/item-1',
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      at: 1_700_000_000_000,
      outcome: OK,
      account: { uid: 'u-1' },
    };

    expect(rtdbVerdict(ctx, { ...readCall, outcome: DENIED, account: undefined }, 'get')).toMatchObject({
      result: 'deny',
    });

    observedSession.apply({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-project-default-rtdb',
          path: '/groups/g-1/members/u-1',
          value: true,
        },
      ],
    });

    expect(rtdbVerdict(ctx, readCall, 'get')).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/groups/g-1/archived'],
      rtdb: {
        matchedPath: '/groups/$groupId/items/$itemId',
        pathVariableBindings: { $groupId: 'g-1', $itemId: 'item-1' },
      },
    });

    expect(
      rtdbVerdict(ctx, { ...readCall, method: 'set', writeData: { wrongKey: 1 }, outcome: DENIED }, 'set'),
    ).toMatchObject({ result: 'deny' });

    expect(
      rtdbVerdict(ctx, { ...readCall, method: 'set', writeData: { title: 'Draft' }, outcome: OK }, 'set'),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/groups/g-1/archived'],
    });

    observedSession.apply({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-project-default-rtdb',
          path: '/groups/g-1/archived',
          value: null,
        },
      ],
    });

    expect(rtdbVerdict(ctx, readCall, 'get')).toMatchObject({
      result: 'allow',
      rule: { path: '/groups/$groupId/items/$itemId' },
    });
    expect(
      rtdbVerdict(ctx, { ...readCall, method: 'set', writeData: { title: 'Draft' }, outcome: OK }, 'set'),
    ).toMatchObject({ result: 'allow' });

    observedSession.apply({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-project-default-rtdb',
          path: '/groups/g-1',
          value: { members: { 'u-1': true }, archived: true },
        },
      ],
    });

    expect(rtdbVerdict(ctx, readCall, 'get')).toMatchObject({
      result: 'deny',
      drift: true,
    });
  });

  it('isolates RTDB cascade grants from earlier uncaptured ancestor rules while unioning missingPaths when no rule grants', () => {
    const sandbox = initializeSandbox();
    const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'rtdb-cascade-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession,
    };
    expect(
      setDatabaseRules(ctx, undefined, {
        rules: {
          items: {
            '.read': "auth != null && root.child('admins/' + auth.uid).val() === true",
            $itemId: {
              '.read': 'auth != null && auth.uid === $itemId',
            },
          },
        },
      }).ok,
    ).toBe(true);

    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'get',
          path: '/items/u-1',
          instance: 'demo-project-default-rtdb',
          projectId: 'demo-project',
          at: 1,
          outcome: OK,
          account: { uid: 'u-1' },
        },
        'get',
      ),
    ).toMatchObject({
      result: 'allow',
      rule: { path: '/items/$itemId', expression: 'auth != null && auth.uid === $itemId' },
    });

    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'get',
          path: '/items/other',
          instance: 'demo-project-default-rtdb',
          projectId: 'demo-project',
          at: 2,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'get',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/admins/u-1'],
    });
  });

  it('evaluates Live Mode observed writes against pre-operation observedSession state before liveHost applies the write delta', async () => {
    const liveHost = createLiveHostState({
      configProjectId: 'demo-project',
      configSource: 'option',
      optionName: '--project',
      warn: () => {},
      unobserved: () => [],
    });
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'pre-op-order-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession: liveHost.sessionData,
    };
    expect(
      setDatabaseRules(ctx, undefined, {
        rules: {
          locks: {
            $lockId: {
              '.write': 'auth != null && !data.exists()',
            },
          },
        },
      }).ok,
    ).toBe(true);

    liveHost.sessionData.apply({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-project-default-rtdb',
          path: '/locks/l-1',
          value: null,
        },
      ],
    });

    const clientSessionId = 'client-1';
    async function dispatchLiveObserve(
      id: string,
      call: ObservedCall,
      sessionData: ObservedSessionDelta | undefined,
    ): Promise<SandboxEvent | undefined> {
      const inner = { t: 'observe', id, call, sessionData } as InboundMessage;
      liveHost.inbound({ type: 'worker-message', clientSessionId, message: inner });
      const port: PortLike = {
        postMessage(reply) {
          liveHost.outbound({ type: 'worker-message-result', clientSessionId, message: reply });
        },
      };
      await handleMessage(ctx, port, inner);
      return ctx.sandbox.history().at(-1);
    }

    const firstWrite = await dispatchLiveObserve(
      'obs-lock-1',
      {
        service: 'rtdb',
        method: 'set',
        path: '/locks/l-1',
        instance: 'demo-project-default-rtdb',
        projectId: 'demo-project',
        writeData: 'held',
        at: 100,
        outcome: OK,
        account: { uid: 'u-1' },
      },
      {
        rtdb: [
          {
            kind: 'set',
            instance: 'demo-project-default-rtdb',
            path: '/locks/l-1',
            value: 'held',
          },
        ],
      },
    );
    expect(firstWrite?.production?.local).toMatchObject({ result: 'allow' });

    const secondWrite = await dispatchLiveObserve(
      'obs-lock-2',
      {
        service: 'rtdb',
        method: 'set',
        path: '/locks/l-1',
        instance: 'demo-project-default-rtdb',
        projectId: 'demo-project',
        writeData: 'overwrite',
        at: 101,
        outcome: DENIED,
        account: { uid: 'u-1' },
      },
      undefined,
    );
    expect(secondWrite?.production?.local).toMatchObject({ result: 'deny' });
  });

  it('abstains instead of failing open after skipped writes, .sv updates, or filtered onChildRemoved, and fails closed on listener pre-delivery (#2540 F1, F2, F3, F6)', async () => {
    const liveHost = createLiveHostState({
      configProjectId: 'demo-project',
      configSource: 'option',
      optionName: '--project',
      warn: () => {},
      unobserved: () => [],
    });
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'rtdb-soundness-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession: liveHost.sessionData,
    };
    const instance = 'demo-project-default-rtdb';
    expect(
      setDatabaseRules(ctx, undefined, {
        rules: {
          items: {
            $id: {
              '.read': "auth != null && root.child('banned/' + auth.uid).val() !== true",
            },
          },
          rooms: {
            $r: {
              msgs: {
                $m: {
                  '.write': "auth != null && !root.child('rooms/' + $r + '/closedAt').exists()",
                },
              },
            },
          },
          slots: {
            $s: {
              '.write': 'auth != null && !data.exists()',
            },
          },
        },
      }).ok,
    ).toBe(true);

    // F1: prior miss at /banned/u-1 invalidated by a skipped write (runTransaction / all-sentinel write).
    liveHost.sessionData.apply({ rtdb: [{ kind: 'set', instance, path: '/banned/u-1', value: null }] });
    const skipMsg = {
      t: 'observe',
      id: 'f1-skip',
      call: {
        service: 'rtdb',
        method: 'set',
        path: '/banned/u-1',
        instance,
        projectId: 'demo-project',
        writeData: true,
        at: 1,
        outcome: OK,
        account: { uid: 'admin' },
      },
      sessionData: { skipped: { unsupported: 1 } } as ObservedSessionDelta,
    } as InboundMessage;
    liveHost.inbound({ type: 'worker-message', clientSessionId: 'c', message: skipMsg });
    const port: PortLike = {
      postMessage(reply) {
        liveHost.outbound({ type: 'worker-message-result', clientSessionId: 'c', message: reply });
      },
    };
    await handleMessage(ctx, port, skipMsg);
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'get',
          path: '/items/i1',
          instance,
          projectId: 'demo-project',
          at: 2,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'get',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/banned/u-1'],
    });

    // F2: update carrying an omitted `.sv` leaf emits `invalidate` for `closedAt`.
    liveHost.sessionData.apply({
      rtdb: [
        { kind: 'set', instance, path: '/rooms/r1', value: { name: 'x' } },
        { kind: 'invalidate', instance, path: '/rooms/r1/closedAt' },
        { kind: 'update', instance, path: '/rooms/r1', value: { name: 'y' } },
      ],
    });
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: '/rooms/r1/msgs/m1',
          instance,
          projectId: 'demo-project',
          writeData: 'hi',
          at: 3,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'set',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/rooms/r1/closedAt'],
    });

    // F3: filtered onChildRemoved emits `invalidate`, never authoritative `remove`.
    liveHost.sessionData.apply({
      rtdb: [{ kind: 'invalidate', instance, path: '/slots/s1' }],
    });
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: '/slots/s1',
          instance,
          projectId: 'demo-project',
          writeData: 'mine',
          at: 4,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'set',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/slots/s1'],
    });

    // F6: an optimistic listener delivery during an in-flight write emits `invalidate` (not `set`),
    // so an ownership-claim rule (`!data.exists() || data.child('owner').val() === auth.uid`) abstains
    // as `unevaluated` instead of failing open as `allow`.
    setDatabaseRules(ctx, undefined, {
      rules: {
        claims: {
          $s: {
            '.write': "auth != null && (!data.exists() || data.child('owner').val() === auth.uid)",
          },
        },
        tasks: {
          $t: {
            '.write': "auth != null && data.child('owner').val() === auth.uid",
          },
        },
      },
    });
    liveHost.sessionData.apply({
      rtdb: [{ kind: 'set', instance, path: '/claims/c1', value: { owner: 'u-9' } }],
    });
    liveHost.sessionData.apply({
      rtdb: [{ kind: 'invalidate', instance, path: '/claims/c1' }],
    });
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: '/claims/c1',
          instance,
          projectId: 'demo-project',
          writeData: { owner: 'u-1' },
          at: 5,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'set',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/claims/c1', '/claims/c1/owner'],
    });

    // N1: a filtered `onValue` re-delivery emits `[invalidate, update]`, clearing children that left the query window.
    liveHost.sessionData.apply({
      rtdb: [
        { kind: 'invalidate', instance, path: '/tasks' },
        { kind: 'update', instance, path: '/tasks', value: { t1: { owner: 'u-1' }, t2: { owner: 'u-1' } } },
      ],
    });
    liveHost.sessionData.apply({
      rtdb: [
        { kind: 'invalidate', instance, path: '/tasks' },
        { kind: 'update', instance, path: '/tasks', value: { t1: { owner: 'u-1' } } },
      ],
    });
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: '/tasks/t2',
          instance,
          projectId: 'demo-project',
          writeData: { owner: 'u-1' },
          at: 6,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'set',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/tasks/t2/owner'],
    });
  });

  it('abstains after one-shot get during an in-flight write, filtered one-shot get departure, or null-leaf multi-path update under ancestor .validate (#2540 H-A, H-B)', async () => {
    const liveHost = createLiveHostState({
      configProjectId: 'demo-project',
      configSource: 'option',
      optionName: '--project',
      warn: () => {},
      unobserved: () => [],
    });
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'rtdb-one-shot-and-null-update-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession: liveHost.sessionData,
    };
    const instance = 'demo-project-default-rtdb';
    expect(
      setDatabaseRules(ctx, undefined, {
        rules: {
          claims: {
            $c: {
              '.read': 'auth != null',
              '.write': "auth != null && (!data.exists() || data.child('owner').val() === auth.uid)",
            },
          },
          queues: {
            $q: {
              '.read': 'auth != null',
              '.write': "auth != null && data.child('owner').val() === auth.uid",
            },
          },
          orders: {
            $o: {
              '.write': 'auth != null',
              '.validate': "newData.hasChildren(['customerId', 'total'])",
            },
          },
        },
      }).ok,
    ).toBe(true);

    const port: PortLike = {
      postMessage(reply) {
        liveHost.outbound({ type: 'worker-message-result', clientSessionId: 'c', message: reply });
      },
    };
    async function acceptObserve(id: string, call: ObservedCall, sessionData: ObservedSessionDelta): Promise<void> {
      const msg = { t: 'observe', id, call, sessionData } as InboundMessage;
      liveHost.inbound({ type: 'worker-message', clientSessionId: 'c', message: msg });
      await handleMessage(ctx, port, msg);
    }

    // H-A: one-shot `get` resolved while a write overlaps `/claims/c1` emits `invalidate` instead of `set`,
    // clearing prior authoritative state so subsequent `.write` abstains instead of trusting optimistic data.
    liveHost.sessionData.apply({
      rtdb: [{ kind: 'set', instance, path: '/claims/c1', value: { owner: 'u-9' } }],
    });
    await acceptObserve(
      'ha-get-1',
      {
        service: 'rtdb',
        method: 'get',
        path: '/claims/c1',
        instance,
        projectId: 'demo-project',
        at: 10,
        outcome: OK,
        account: { uid: 'u-1' },
      },
      { rtdb: [{ kind: 'invalidate', instance, path: '/claims/c1' }] },
    );
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: '/claims/c1',
          instance,
          projectId: 'demo-project',
          writeData: { owner: 'u-1' },
          at: 11,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'set',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/claims/c1', '/claims/c1/owner'],
    });

    // H-B: filtered one-shot `get` emits `[invalidate, update]`, clearing rules coverage for departed `/queues/east`
    // while keeping returned `/queues/west` covered AND retaining unfiltered siblings in `snapshot().rtdb`.
    liveHost.sessionData.apply({
      rtdb: [
        {
          kind: 'set',
          instance,
          path: '/queues',
          value: { east: { owner: 'u-1' }, west: { owner: 'u-1' } },
        },
      ],
    });
    await acceptObserve(
      'hb-get-1',
      {
        service: 'rtdb',
        method: 'get',
        path: '/queues',
        instance,
        projectId: 'demo-project',
        at: 12,
        outcome: OK,
        account: { uid: 'u-1' },
      },
      {
        rtdb: [
          { kind: 'invalidate', instance, path: '/queues' },
          { kind: 'update', instance, path: '/queues', value: { west: { owner: 'u-1' } } },
        ],
      },
    );
    expect(liveHost.sessionData.snapshot().rtdb[instance]).toMatchObject({
      queues: { east: { owner: 'u-1' }, west: { owner: 'u-1' } },
    });
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: '/queues/west',
          instance,
          projectId: 'demo-project',
          writeData: { owner: 'u-1' },
          at: 13,
          outcome: OK,
          account: { uid: 'u-1' },
        },
        'set',
      ),
    ).toMatchObject({ result: 'allow' });
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: '/queues/east',
          instance,
          projectId: 'demo-project',
          writeData: { owner: 'u-1' },
          at: 14,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'set',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/queues/east/owner'],
    });

    // Multi-path `update` deleting a required child via `null` under uncaptured `/orders/o-1` abstains for ancestor `.validate`.
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'update',
          path: '/orders/o-1',
          instance,
          projectId: 'demo-project',
          writeData: { total: null },
          at: 15,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'update',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/orders/o-1'],
    });
  });

  it('fails closed (unevaluated, never allow) when an unsettled write exceeds lease TTL or the 256-lease cap (W4-1, W4-2)', () => {
    const instance = 'demo-project-default-rtdb';
    const ownerRules = {
      rules: {
        slots: {
          $s: {
            '.write': "auth != null && (!data.exists() || data.child('owner').val() === auth.uid)",
          },
        },
      },
    };
    const siteOf = (overrides: Partial<ObservedSite>): ObservedSite =>
      ({
        module: 'firebase/database',
        name: 'onValue',
        observer: () => {},
        ...overrides,
      }) as ObservedSite;
    const rtdbSnap = (path: string, val: unknown) => ({
      val: () => val,
      ref: { _path: { toString: () => path } },
    });
    const ownerWrite = (): ObservedCall => ({
      service: 'rtdb',
      method: 'set',
      path: '/slots/s1',
      instance,
      projectId: 'demo-project',
      writeData: { owner: 'u-1' },
      at: 20,
      outcome: DENIED,
      account: { uid: 'u-1' },
    });

    // W4-1: unsettled write past 30s TTL taints instance until release() instead of dropping the guard.
    {
      const sandbox = initializeSandbox();
      const store = createObservedSessionDataStore({ projectId: 'demo-project' });
      const ctx: HostCtx = {
        db: getFirestore(sandbox),
        sandbox,
        instanceId: 'rtdb-w4-ttl',
        subs: new Map(),
        rtdbProjectId: 'demo-project',
        observedSession: store,
      };
      setDatabaseRules(ctx, undefined, ownerRules);
      store.apply({ rtdb: [{ kind: 'set', instance, path: '/slots/s1', value: { owner: 'u-9' } }] });

      const realNow = Date.now;
      const t0 = realNow();
      const lease = databaseWriteSession('set', [null, { owner: 'u-1' }], instance, '/slots/s1').onCallStart!();
      try {
        Date.now = () => t0 + DEFAULT_INFLIGHT_LEASE_TTL_MS + 1;
        const delivery = databaseDelivery(
          siteOf({ name: 'onValue', instance, path: '/slots/s1' }),
          rtdbSnap('/slots/s1', { owner: 'u-1' }),
        )!;
        const oneShot = databaseResult(
          siteOf({ name: 'get', instance, path: '/slots/s1' }),
          rtdbSnap('/slots/s1', { owner: 'u-1' }),
        );
        const adminDelivery = adminDatabaseDelivery(
          siteOf({ name: 'Query.on', instance, path: '/slots/s1' }),
          'value',
          rtdbSnap('/slots/s1', { owner: 'u-1' }),
        );
        expect(delivery.rtdb?.[0]?.kind).toBe('invalidate');
        expect(oneShot.sessionData?.rtdb?.[0]?.kind).toBe('invalidate');
        expect(adminDelivery?.rtdb?.[0]?.kind).toBe('invalidate');

        store.apply(readObservedSessionDelta(delivery)!);
        expect(rtdbVerdict(ctx, ownerWrite(), 'set')).toMatchObject({
          result: 'unevaluated',
          needs: ['stored-document'],
          missingPaths: ['/slots/s1', '/slots/s1/owner'],
        });
      } finally {
        Date.now = realNow;
        lease.release();
      }
    }

    // W4-2: >256 concurrent unsettled writes evict the oldest lease into fail-closed taint until release().
    {
      const sandbox = initializeSandbox();
      const store = createObservedSessionDataStore({ projectId: 'demo-project' });
      const ctx: HostCtx = {
        db: getFirestore(sandbox),
        sandbox,
        instanceId: 'rtdb-w4-cap',
        subs: new Map(),
        rtdbProjectId: 'demo-project',
        observedSession: store,
      };
      setDatabaseRules(ctx, undefined, ownerRules);
      store.apply({ rtdb: [{ kind: 'set', instance, path: '/slots/s1', value: { owner: 'u-9' } }] });

      const lease = databaseWriteSession('set', [null, { owner: 'u-1' }], instance, '/slots/s1').onCallStart!();
      const bulkLeases: Array<{ release(): void }> = [];
      try {
        for (let i = 0; i < MAX_ACTIVE_INFLIGHT_WRITES; i += 1) {
          bulkLeases.push(databaseWriteSession('set', [null, i], instance, `/bulk/b${i}`).onCallStart!());
        }
        const delivery = databaseDelivery(
          siteOf({ name: 'onValue', instance, path: '/slots/s1' }),
          rtdbSnap('/slots/s1', { owner: 'u-1' }),
        )!;
        expect(delivery.rtdb?.[0]?.kind).toBe('invalidate');
        store.apply(readObservedSessionDelta(delivery)!);
        expect(rtdbVerdict(ctx, ownerWrite(), 'set')).toMatchObject({
          result: 'unevaluated',
          needs: ['stored-document'],
          missingPaths: ['/slots/s1', '/slots/s1/owner'],
        });
      } finally {
        lease.release();
        for (const bulk of bulkLeases) bulk.release();
      }
    }
  });
});
