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
      missingPaths: ['/claims/c1'],
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
      missingPaths: ['/claims/c1'],
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
          missingPaths: ['/slots/s1'],
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
          missingPaths: ['/slots/s1'],
        });
      } finally {
        lease.release();
        for (const bulk of bulkLeases) bulk.release();
      }
    }
  });

  function makeHost(instanceId = 'rtdb-obs-test') {
    const sandbox = initializeSandbox();
    const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId,
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession,
    };
    return { ctx, observedSession };
  }

  it('uses a 20-character Firebase push ID placeholder on push() and strips it from bindings and missingPaths', () => {
    const { ctx } = makeHost();
    const instance = 'demo-project-default-rtdb';
    expect(
      setDatabaseRules(ctx, undefined, {
        rules: {
          items: {
            $pushId: {
              '.write': 'auth != null && $pushId.length === 20',
            },
          },
          shortOnly: {
            $pushId: {
              '.write': 'auth != null && $pushId.length < 20',
            },
          },
          guarded: {
            $pushId: {
              '.write': "auth != null && $pushId.length === 20 && root.child('quotas').child($pushId).val() === null",
            },
          },
        },
      }).ok,
    ).toBe(true);

    const allowed = rtdbVerdict(
      ctx,
      {
        service: 'rtdb',
        method: 'push',
        path: 'items',
        instance,
        projectId: 'demo-project',
        account: { uid: 'u-1', claims: {} },
        writeData: { title: 'a' },
        at: 100,
        outcome: OK,
      },
      'create',
    );
    expect(allowed).toEqual({
      result: 'allow',
      rule: {
        path: '/items/$pushId',
        expression: 'auth != null && $pushId.length === 20',
      },
      rtdb: expect.objectContaining({
        matchedPath: '/items/$pushId',
        matchedRule: 'auth != null && $pushId.length === 20',
      }),
    });
    expect(allowed && 'rtdb' in allowed ? allowed.rtdb?.pathVariableBindings : undefined).toBeUndefined();

    const deniedShort = rtdbVerdict(
      ctx,
      {
        service: 'rtdb',
        method: 'push',
        path: 'shortOnly',
        instance,
        projectId: 'demo-project',
        account: { uid: 'u-1', claims: {} },
        writeData: { title: 'a' },
        at: 101,
        outcome: DENIED,
      },
      'create',
    );
    expect(deniedShort).toMatchObject({ result: 'deny' });

    const abstained = rtdbVerdict(
      ctx,
      {
        service: 'rtdb',
        method: 'push',
        path: 'guarded',
        instance,
        projectId: 'demo-project',
        account: { uid: 'u-1', claims: {} },
        writeData: { title: 'a' },
        at: 102,
        outcome: OK,
      },
      'create',
    );
    expect(abstained).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/quotas/$pushId'],
    });
    expect(JSON.stringify(abstained)).not.toContain('-O_pyric_push');
  });

  it('detects bracket-indexed and parenthesized auth.token, email claims, query constraints, and newData.parent() accesses', () => {
    const { ctx } = makeHost();
    const instance = 'demo-project-default-rtdb';
    expect(
      setDatabaseRules(ctx, undefined, {
        rules: {
          users: {
            $uid: {
              '.read': "auth != null && auth.token['email'] === 'member@example.com'",
            },
          },
          identitiesByBracket: {
            $uid: {
              '.read': "auth != null && auth['token']['firebase']['identities']['email'] != null",
            },
          },
          rolesByBracket: {
            $uid: {
              '.read': "auth != null && (auth)['token']['role'] === 'editor'",
            },
          },
          items: {
            '.read': "query['orderByChild'] === 'createdAt' && query['limitToFirst'] <= 20",
          },
          filteredByParen: {
            '.read': "(query).equalTo === auth.uid",
          },
          orgs: {
            $orgId: {
              docs: {
                $docId: {
                  '.write': "auth != null && (newData).parent().child('ownerId').val() === auth.uid",
                },
              },
            },
          },
        },
      }).ok,
    ).toBe(true);

    // 1. Redacted email claim accessed via `auth.token['email']` and `auth['token']['firebase']['identities']['email']`.
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'get',
          path: 'users/u-1',
          instance,
          projectId: 'demo-project',
          account: { uid: 'u-1', claimNames: ['email'], claims: {} },
          at: 200,
          outcome: OK,
        },
        'get',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['claim-values'],
    });
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'get',
          path: 'identitiesByBracket/u-1',
          instance,
          projectId: 'demo-project',
          account: { uid: 'u-1', claimNames: ['email', 'firebase'], claims: { firebase: { identities: {} } } },
          at: 201,
          outcome: OK,
        },
        'get',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['claim-values'],
    });

    // 2. Uncaptured claims accessed via `(auth)['token']['role']`.
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'get',
          path: 'rolesByBracket/u-1',
          instance,
          projectId: 'demo-project',
          account: { uid: 'u-1', claimNames: ['role'] },
          at: 202,
          outcome: OK,
        },
        'get',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['claim-values'],
    });

    // 3. Uncaptured RTDB query constraints accessed via `query['orderByChild']` and `(query).equalTo`.
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'get',
          path: 'items',
          instance,
          projectId: 'demo-project',
          at: 203,
          outcome: OK,
        },
        'get',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['query'],
    });
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'get',
          path: 'filteredByParen',
          instance,
          projectId: 'demo-project',
          account: { uid: 'u-1', claims: {} },
          at: 204,
          outcome: OK,
        },
        'get',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['query'],
    });

    // 4. Unobserved sibling `ownerId` accessed via `(newData).parent()`.
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: 'orgs/org-1/docs/doc-1',
          instance,
          projectId: 'demo-project',
          account: { uid: 'u-1', claims: {} },
          writeData: { title: 'draft' },
          at: 205,
          outcome: OK,
        },
        'set',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/orgs/org-1/docs/ownerId'],
    });
  });

  it('abstains on remove(), set(null), and null-child multi-path update() when unobserved siblings affect ancestor rules', () => {
    const { ctx } = makeHost();
    const instance = 'demo-project-default-rtdb';
    expect(
      setDatabaseRules(ctx, undefined, {
        rules: {
          orgs: {
            $orgId: {
              '.write': 'newData.exists()',
            },
          },
          teams: {
            $teamId: {
              items: {
                $itemId: {
                  '.write': "auth != null && newData.parent().child('ownerId').val() === auth.uid",
                },
              },
            },
          },
          docs: {
            $docId: {
              '.write': 'auth != null',
              '.validate': "newData.hasChildren(['title'])",
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
          method: 'remove',
          path: 'orgs/org-1/items/item-1',
          instance,
          projectId: 'demo-project',
          at: 300,
          outcome: OK,
        },
        'delete',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/orgs/org-1'],
    });

    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: 'teams/team-1/items/item-1',
          instance,
          projectId: 'demo-project',
          account: { uid: 'u-1', claims: {} },
          writeData: null,
          at: 301,
          outcome: OK,
        },
        'set',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/teams/team-1/items/ownerId'],
    });

    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'update',
          path: '/',
          instance,
          projectId: 'demo-project',
          account: { uid: 'u-1', claims: {} },
          writeData: { 'docs/doc-1/tags/t1': null },
          at: 302,
          outcome: DENIED,
        },
        'update',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/docs/doc-1'],
    });
  });

  it('evaluates setWithPriority priority metadata, abstains when priority was not captured, and isolates __proto__ keys', () => {
    const { ctx } = makeHost();
    const instance = 'demo-project-default-rtdb';
    expect(
      setDatabaseRules(ctx, undefined, {
        rules: {
          items: {
            $id: {
              '.write': 'newData.getPriority() === 10',
            },
          },
          scalars: {
            $id: {
              '.write': "newData.val() === 'pinned' && newData.getPriority() === 5",
            },
          },
          protoSafe: {
            $id: {
              '.write': "newData.child('title').val() === 'ok'",
            },
          },
        },
      }).ok,
    ).toBe(true);

    // Object write with `.priority` preserved.
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'setWithPriority',
          path: 'items/item-1',
          instance,
          projectId: 'demo-project',
          writeData: { title: 'a', '.priority': 10 },
          at: 400,
          outcome: OK,
        },
        'set',
      ),
    ).toMatchObject({ result: 'allow' });

    // Scalar write wrapped as `{ '.value', '.priority' }`.
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'setWithPriority',
          path: 'scalars/s-1',
          instance,
          projectId: 'demo-project',
          writeData: { '.value': 'pinned', '.priority': 5 },
          at: 401,
          outcome: OK,
        },
        'set',
      ),
    ).toMatchObject({ result: 'allow' });

    // `setWithPriority` arriving without `.priority` on `writeData` abstains on `write-data` rather than evaluating `getPriority() === null`.
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'setWithPriority',
          path: 'items/item-1',
          instance,
          projectId: 'demo-project',
          writeData: { title: 'a' },
          at: 402,
          outcome: OK,
        },
        'set',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['write-data'],
    });

    // Own `__proto__` key in `writeData` never mutates prototype or throws on coercion during `scrubRtdbWriteValue`.
    const protoPayload = JSON.parse('{"__proto__":{"toString":"broken"},"title":"ok",".priority":1}');
    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'setWithPriority',
          path: 'protoSafe/p-1',
          instance,
          projectId: 'demo-project',
          writeData: protoPayload,
          at: 403,
          outcome: OK,
        },
        'set',
      ),
    ).toMatchObject({ result: 'allow' });
  });

  it('validates and preserves RTDB .priority and scalar .value in observedSession and prunes invalidated subtrees from snapshot().rtdb', () => {
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
      instanceId: 'rtdb-priority-and-prune-test',
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
              '.read': 'true',
              '.write': '!data.exists() || data.getPriority() === null',
            },
          },
          docs: {
            $docId: {
              '.read': 'true',
              '.write': '!data.exists() || data.getPriority() === 10',
            },
          },
          scalars: {
            $s: {
              '.read': 'true',
              '.write': "!data.exists() || (data.val() === 'pinned' && data.getPriority() === 'high')",
            },
          },
        },
      }).ok,
    ).toBe(true);

    const validated = readObservedSessionDelta({
      rtdb: [
        { kind: 'set', instance, path: '/items/item-1', value: { title: 'v1', '.priority': 10 } },
        { kind: 'set', instance, path: '/docs/doc-1', value: { title: 'v1', '.priority': 10 } },
        { kind: 'set', instance, path: '/scalars/s-1', value: { '.value': 'pinned', '.priority': 'high' } },
      ],
    });
    liveHost.sessionData.apply(validated);

    // Arbitrary dotted keys or malformed `.value` / `.priority` envelopes still reject.
    expect(() =>
      readObservedSessionDelta({
        rtdb: [{ kind: 'set', instance, path: '/items/bad', value: { 'bad.key': 1 } }],
      }),
    ).toThrow();
    expect(() =>
      readObservedSessionDelta({
        rtdb: [{ kind: 'set', instance, path: '/items/bad', value: { '.value': 1, extra: 2 } }],
      }),
    ).toThrow();
    expect(() =>
      readObservedSessionDelta({
        rtdb: [{ kind: 'set', instance, path: '/items/bad', value: { a: 1, '.priority': { nested: 1 } } }],
      }),
    ).toThrow();

    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: '/items/item-1',
          instance,
          projectId: 'demo-project',
          writeData: { title: 'v2' },
          at: 500,
          outcome: DENIED,
        },
        'set',
      ),
    ).toMatchObject({ result: 'deny' });

    expect(
      rtdbVerdict(
        ctx,
        {
          service: 'rtdb',
          method: 'set',
          path: '/docs/doc-1',
          instance,
          projectId: 'demo-project',
          writeData: { title: 'v2' },
          at: 501,
          outcome: OK,
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
          path: '/scalars/s-1',
          instance,
          projectId: 'demo-project',
          writeData: 'updated',
          at: 502,
          outcome: OK,
        },
        'set',
      ),
    ).toMatchObject({ result: 'allow' });

    // `invalidate` prunes unconfirmed or stale values from `snapshot().rtdb`, not just coverage.
    liveHost.sessionData.apply({
      rtdb: [
        { kind: 'set', instance, path: '/orgs/org-1', value: { name: 'TeamOrg', role: 'admin' } },
        { kind: 'invalidate', instance, path: '/orgs/org-1/role' },
        { kind: 'set', instance, path: '/counters/c-1', value: { count: 5, label: 'v1' } },
        { kind: 'invalidate', instance, path: '/counters/c-1/count' },
        { kind: 'update', instance, path: '/counters/c-1', value: { label: 'v2' } },
      ],
    });

    const snap = liveHost.sessionData.snapshot();
    const tree = snap.rtdb[instance] as Record<string, Record<string, Record<string, unknown>>>;
    expect(tree.orgs?.['org-1']).toEqual({ name: 'TeamOrg' });
    expect(tree.counters?.['c-1']).toEqual({ label: 'v2' });
  });
});
