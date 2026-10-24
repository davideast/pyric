import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  equalTo,
  getAdminDatabase,
  getDatabase,
  limitToFirst,
  orderByChild,
  query,
  ref,
  get,
  onChildAdded,
  onValue,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  setPriority,
  setWithPriority,
  update,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';
import { replay } from '../../src/rules/internal/rtdb.js';

const ALLOW_ALL = { rules: { '.read': true, '.write': true } };
const DENY_ALL = { rules: { '.read': false, '.write': false } };
const MEMBER_RULES = {
  rules: {
    rooms: {
      '$roomId': {
        messages: {
          '$messageId': {
            '.write': "root.child('members').child($roomId).child(auth.uid).exists()",
            '.read': false,
          },
        },
      },
    },
    members: {
      '.read': false,
      '.write': false,
    },
  },
};

async function captureJourney() {
  const sandbox = initializeSandbox();
  const adminDb = getDatabase(sandbox);
  rtdbSandbox.setRules(adminDb, ALLOW_ALL);
  rtdbSandbox.setData(adminDb, {
    '/counters/c1': 1,
    '/gone/x': true,
  });

  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  await set(ref(db, '/profiles/alice'), { name: 'Alice' });
  await update(ref(db, '/profiles/alice'), { active: true });
  await remove(ref(db, '/gone/x'));
  await runTransaction<number>(ref(db, '/counters/c1'), (current) => (current ?? 0) + 1, {
    applyLocally: false,
  });

  return {
    events: sandbox.history(),
    state: rtdbSandbox.snapshotState(adminDb),
  };
}

describe('database replay()', () => {
  it('replays set, update, remove, and transaction commits through RTDB rules', async () => {
    const captured = await captureJourney();
    const result = await replay(captured.events, {
      rules: ALLOW_ALL,
      capturedState: captured.state,
    });

    expect(result.ok).toBe(true);
    expect(result.checkedEvents).toBe(4);
    expect(result.replayedState).toEqual(captured.state);
  });

  it('reports now-denied when candidate rules reject captured commits', async () => {
    const captured = await captureJourney();
    const result = await replay(captured.events, {
      rules: DENY_ALL,
      capturedState: captured.state,
    });

    expect(result.ok).toBe(false);
    expect(result.divergences.some((d) => d.kind === 'now-denied')).toBe(true);
  });

  it('replays admin setup commits as context without checking them against rules', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    const adminDb = getAdminDatabase(sandbox);
    rtdbSandbox.setRules(db, MEMBER_RULES);

    await set(ref(adminDb, '/members/r1/alice'), true);
    await set(ref(db, '/rooms/r1/messages/m1'), { author: 'alice', text: 'hello' });

    const result = await replay(sandbox.history(), {
      rules: MEMBER_RULES,
      capturedState: rtdbSandbox.snapshotState(adminDb),
    });

    expect(result.ok).toBe(true);
    expect(result.checkedEvents).toBe(1);
  });

  it('treats an explicit undefined capturedState as absent', async () => {
    const captured = await captureJourney();
    const result = await replay(captured.events, {
      rules: ALLOW_ALL,
      capturedState: undefined,
    });

    expect(result.checkedEvents).toBe(4);
    expect(result.divergences.filter((d) => d.kind === 'state-drift')).toHaveLength(0);
  });

  it('compares final state with order-insensitive object equality', async () => {
    const captured = await captureJourney();
    const result = await replay(captured.events, {
      rules: ALLOW_ALL,
      capturedState: {
        profiles: { alice: { active: true, name: 'Alice' } },
        counters: { c1: 2 },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.divergences).toHaveLength(0);
  });

  it('records and replays priority metadata', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    rtdbSandbox.setRules(db, ALLOW_ALL);
    const target = ref(db, '/ranked/item');

    await setWithPriority(target, { label: 'item' }, 7);
    await setPriority(target, 3);

    const commits = sandbox.history().filter((event) => event.kind === 'commit');
    expect(commits.map(({ method, detail }) => ({ method, detail }))).toEqual([
      { method: 'set', detail: { priority: 7, priorPriority: null } },
      { method: 'setPriority', detail: { priority: 3, priorPriority: 7 } },
    ]);

    const result = await replay(sandbox.history(), { rules: ALLOW_ALL });
    expect(result.ok).toBe(true);
    expect((await get(ref(getDatabase(result.sandbox), '/ranked/item'))).priority).toBe(3);
  });

  it('replays commits at their recorded requestTime for serverTimestamp() and now rules (MET-5a)', async () => {
    const rulesTs = {
      rules: { ts: { '.write': 'newData.val() === 1700000000000 && now === 1700000000000' } },
    };
    const sbTs = initializeSandbox();
    getClock(sbTs).set(1700000000000);
    const dbTs = getDatabase(sbTs.withAuth({ uid: 'u1' }));
    rtdbSandbox.setRules(dbTs, rulesTs);
    await set(ref(dbTs, 'ts'), serverTimestamp());

    const result = await replay(sbTs.history(), {
      rules: rulesTs,
      capturedState: rtdbSandbox.snapshotState(dbTs),
    });
    expect(result.divergences).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.replayedState).toEqual({ ts: 1700000000000 });
  });

  it('restores priorPriority when rewinding a plain set() or remove() over a prioritized node (MET-5b)', async () => {
    const rulesPrio = {
      rules: {
        item: { '.write': 'data.getPriority() === 5' },
        removed: { '.write': 'data.getPriority() === 9' },
      },
    };
    const sbPrio = initializeSandbox();
    const dbPrio = getDatabase(sbPrio.withAuth({ uid: 'u1' }));
    rtdbSandbox.setData(dbPrio, {
      '/item': { '.value': 'v1', '.priority': 5 },
      '/removed': { '.value': 'r1', '.priority': 9 },
    });
    rtdbSandbox.setRules(dbPrio, rulesPrio);
    await set(ref(dbPrio, 'item'), 'v2');
    await remove(ref(dbPrio, 'removed'));

    const result = await replay(sbPrio.history(), {
      rules: rulesPrio,
      capturedState: rtdbSandbox.snapshotState(dbPrio),
    });
    expect(result.divergences).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.replayedState).toEqual({ item: 'v2' });
  });

  it('replays admin runTransaction and admin setPriority as setup context without rule evaluation', async () => {
    const rules = {
      rules: {
        counters: {
          $id: {
            '.read': "auth != null && auth.uid === 'alice'",
            '.write': "auth != null && auth.uid === 'alice'",
          },
        },
        ranked: {
          $id: {
            '.read': true,
            '.write': "auth != null && auth.uid === 'alice' && data.getPriority() === 10",
          },
        },
      },
    };
    const sandbox = initializeSandbox();
    const adminDb = getAdminDatabase(sandbox);
    const aliceDb = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(aliceDb, rules);

    await runTransaction(ref(adminDb, 'counters/c1'), (cur) => (cur ?? 0) + 10);
    await set(ref(adminDb, 'ranked/item'), 'initial');
    await setPriority(ref(adminDb, 'ranked/item'), 10);
    await runTransaction(ref(aliceDb, 'counters/c1'), (cur) => (cur ?? 0) + 1);
    await set(ref(aliceDb, 'ranked/item'), 'updated-by-alice');

    const result = await replay(sandbox.history(), {
      rules,
      capturedState: rtdbSandbox.snapshotState(adminDb),
    });

    expect(result.divergences).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkedEvents).toBe(2);
    expect(result.replayedState).toEqual({
      counters: { c1: 11 },
      ranked: { item: 'updated-by-alice' },
    });
  });

  it('restores priorities and overwritten ancestor scalars when rewinding transaction, update, ancestor remove, and child set', async () => {
    const rules = {
      rules: {
        item: {
          '.read': true,
          '.write': 'data.getPriority() === 5',
        },
        group: {
          $key: {
            '.read': true,
            '.write': "data.parent().child('a').getPriority() === 5",
          },
        },
        parent: {
          '.read': true,
          '.write': "data.child('child').getPriority() === 5",
        },
        a: {
          b: {
            '.read': true,
            '.write': "data.parent().val() === 'scalar'",
          },
        },
      },
    };

    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'u1' }));
    rtdbSandbox.setData(db, {
      '/item': { '.value': 'v1', '.priority': 5 },
      '/group': {
        a: { '.value': 'v1', '.priority': 5 },
        b: 'v0',
      },
      '/parent': {
        child: { '.value': 'v1', '.priority': 5 },
      },
      '/a': 'scalar',
    });
    rtdbSandbox.setRules(db, rules);

    await runTransaction(ref(db, 'item'), () => 'v2');
    await update(ref(db, 'group'), { a: 'v2' });
    await remove(ref(db, 'parent'));
    await set(ref(db, 'a/b'), 'nested');

    const result = await replay(sandbox.history(), {
      rules,
      capturedState: rtdbSandbox.snapshotState(db),
    });

    expect(result.divergences).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkedEvents).toBe(4);
    expect(result.replayedState).toEqual({
      item: 'v2',
      group: { a: 'v2', b: 'v0' },
      a: { b: 'nested' },
    });
  });

  it('checks unchanged setPriority commits against candidate rules and treats null capturedState as an empty root', async () => {
    const allowAlice = {
      rules: {
        item: {
          '.read': true,
          '.write': "auth != null && auth.uid === 'alice'",
        },
      },
    };
    const denyAll = {
      rules: {
        item: {
          '.read': true,
          '.write': false,
        },
      },
    };

    const sbPrio = initializeSandbox();
    const adminDb = getAdminDatabase(sbPrio);
    const aliceDb = getDatabase(sbPrio.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(aliceDb, allowAlice);
    await setWithPriority(ref(adminDb, 'item'), 'v1', 5);
    await setPriority(ref(aliceDb, 'item'), 5);

    const deniedReplay = await replay(sbPrio.history(), {
      rules: denyAll,
      capturedState: rtdbSandbox.snapshotState(adminDb),
    });
    expect(deniedReplay.ok).toBe(false);
    expect(deniedReplay.checkedEvents).toBe(1);
    expect(deniedReplay.divergences).toEqual([
      expect.objectContaining({ kind: 'now-denied', method: 'setPriority', path: '/item' }),
    ]);

    const sbEmpty = initializeSandbox();
    const emptyDb = getDatabase(sbEmpty.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(emptyDb, allowAlice);

    const emptyReplay = await replay(sbEmpty.history(), {
      rules: allowAlice,
      capturedState: null,
    });
    expect(emptyReplay.divergences).toEqual([]);
    expect(emptyReplay.ok).toBe(true);
  });

  describe('captured query reads', () => {
    const CAPTURE = { rules: { '.read': true, '.write': true, items: { '.indexOn': ['owner'] } } };

    async function captureQueryRead() {
      const sandbox = initializeSandbox();
      const adminDb = getDatabase(sandbox);
      rtdbSandbox.setRules(adminDb, CAPTURE);
      rtdbSandbox.setData(adminDb, { '/items/a': { owner: 'alice' } });
      const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
      await get(query(ref(db, 'items'), orderByChild('owner'), equalTo('alice'), limitToFirst(5)));
      return { events: sandbox.history(), state: rtdbSandbox.snapshotState(adminDb) };
    }

    it('checks each captured query read', async () => {
      const { events, state } = await captureQueryRead();
      const rules = {
        rules: {
          '.read': false,
          items: {
            '.indexOn': ['owner'],
            '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid && query.limitToFirst <= 5",
          },
        },
      };
      const result = await replay(events, { rules, capturedState: state });
      expect(result.divergences).toEqual([]);
      expect(result.checkedEvents).toBe(1);
    });

    it('reports now-denied when the candidate rules reject the captured query', async () => {
      const { events, state } = await captureQueryRead();
      const rules = {
        rules: { '.read': false, items: { '.indexOn': ['owner'], '.read': 'query.limitToFirst <= 4' } },
      };
      const result = await replay(events, { rules, capturedState: state });
      expect(result.divergences).toEqual([expect.objectContaining({ kind: 'now-denied', method: 'get', path: '/items' })]);
    });
  });

  describe('captured reads without a query', () => {
    const CAPTURE = { rules: { '.read': true, '.write': true } };

    async function capturePlainRead() {
      const sandbox = initializeSandbox();
      const adminDb = getDatabase(sandbox);
      rtdbSandbox.setRules(adminDb, CAPTURE);
      rtdbSandbox.setData(adminDb, { '/profiles/alice': { name: 'Alice' } });
      await get(ref(getDatabase(sandbox.withAuth({ uid: 'alice' })), 'profiles/alice'));
      return { events: sandbox.history(), state: rtdbSandbox.snapshotState(adminDb) };
    }

    it('reports now-denied when the candidate rules stop allowing a captured get', async () => {
      const { events, state } = await capturePlainRead();
      const rules = { rules: { '.read': false, '.write': false } };
      const result = await replay(events, { rules, capturedState: state });
      expect(result.divergences).toEqual([
        expect.objectContaining({ kind: 'now-denied', method: 'get', path: '/profiles/alice' }),
      ]);
      expect(result.checkedEvents).toBe(1);
    });

    it('passes a captured get the candidate rules still allow', async () => {
      const { events, state } = await capturePlainRead();
      const rules = { rules: { profiles: { $uid: { '.read': 'auth.uid === $uid' } } } };
      const result = await replay(events, { rules, capturedState: state });
      expect(result.divergences).toEqual([]);
      expect(result.checkedEvents).toBe(1);
    });
  });

  describe('captured listener attaches', () => {
    const CAPTURE = { rules: { '.read': true, '.write': true, items: { '.indexOn': ['owner'] } } };
    const QUERY_GATED = {
      rules: {
        items: { '.indexOn': ['owner'], '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid" },
      },
    };

    async function captureListeners(attach: (db: ReturnType<typeof getDatabase>) => () => void) {
      const sandbox = initializeSandbox();
      const adminDb = getDatabase(sandbox);
      rtdbSandbox.setRules(adminDb, CAPTURE);
      rtdbSandbox.setData(adminDb, { '/items/a': { owner: 'alice' } });
      const off = attach(getDatabase(sandbox.withAuth({ uid: 'alice' })));
      await new Promise((resolve) => setTimeout(resolve, 0));
      off();
      return { events: sandbox.history(), state: rtdbSandbox.snapshotState(adminDb) };
    }

    it('reports now-denied when the candidate rules stop allowing a captured onValue', async () => {
      const { events, state } = await captureListeners((db) => onValue(ref(db, 'items'), () => {}));
      const result = await replay(events, { rules: DENY_ALL, capturedState: state });
      expect(result.divergences).toEqual([
        expect.objectContaining({ kind: 'now-denied', method: 'listen', path: '/items' }),
      ]);
      expect(result.checkedEvents).toBe(1);
    });

    it('checks a value listener with its query', async () => {
      const { events, state } = await captureListeners((db) =>
        onValue(query(ref(db, 'items'), orderByChild('owner'), equalTo('alice')), () => {}));
      const result = await replay(events, { rules: QUERY_GATED, capturedState: state });
      expect(result.divergences).toEqual([]);
      expect(result.checkedEvents).toBe(1);
    });

    it('checks a child listener with its query', async () => {
      const { events, state } = await captureListeners((db) =>
        onChildAdded(query(ref(db, 'items'), orderByChild('owner'), equalTo('alice')), () => {}));
      const result = await replay(events, { rules: QUERY_GATED, capturedState: state });
      expect(result.divergences).toEqual([]);
      expect(result.checkedEvents).toBe(1);
    });

    it('reports now-denied when the candidate rules stop allowing a captured child listener', async () => {
      const { events, state } = await captureListeners((db) => onChildAdded(ref(db, 'items'), () => {}));
      const result = await replay(events, { rules: QUERY_GATED, capturedState: state });
      expect(result.divergences).toEqual([
        expect.objectContaining({ kind: 'now-denied', method: 'listen', path: '/items' }),
      ]);
    });
  });

  describe('captured denials', () => {
    const OWNER_ONLY = {
      rules: {
        profiles: { $uid: { '.read': 'auth.uid === $uid', '.write': 'auth.uid === $uid' } },
        items: { '.indexOn': ['owner'] },
      },
    };

    async function captureDenials(run: (db: ReturnType<typeof getDatabase>) => Promise<unknown>) {
      const sandbox = initializeSandbox();
      const adminDb = getDatabase(sandbox);
      rtdbSandbox.setRules(adminDb, OWNER_ONLY);
      rtdbSandbox.setData(adminDb, { '/profiles/bob': { name: 'Bob' } });
      await run(getDatabase(sandbox.withAuth({ uid: 'alice' }))).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { events: sandbox.history(), state: rtdbSandbox.snapshotState(adminDb) };
    }

    it('reports now-allowed when the candidate rules allow a captured denied set', async () => {
      const { events, state } = await captureDenials((db) => set(ref(db, 'profiles/bob/name'), 'Mallory'));
      const result = await replay(events, { rules: ALLOW_ALL, capturedState: state });
      expect(result.divergences).toEqual([
        expect.objectContaining({ kind: 'now-allowed', method: 'set', path: '/profiles/bob/name' }),
      ]);
      expect(result.checkedEvents).toBe(1);
    });

    it('reports now-allowed for a captured denied remove', async () => {
      const { events, state } = await captureDenials((db) => remove(ref(db, 'profiles/bob')));
      const result = await replay(events, { rules: ALLOW_ALL, capturedState: state });
      expect(result.divergences).toEqual([
        expect.objectContaining({ kind: 'now-allowed', method: 'remove', path: '/profiles/bob' }),
      ]);
    });

    it('reports now-allowed for a captured denied transaction', async () => {
      const { events, state } = await captureDenials((db) =>
        runTransaction(ref(db, 'profiles/bob/name'), () => 'Mallory', { applyLocally: false }));
      const result = await replay(events, { rules: ALLOW_ALL, capturedState: state });
      expect(result.divergences).toEqual([
        expect.objectContaining({ kind: 'now-allowed', method: 'transaction', path: '/profiles/bob/name' }),
      ]);
    });

    it('reports now-allowed for a captured denied get and onValue', async () => {
      const { events, state } = await captureDenials(async (db) => {
        await get(ref(db, 'profiles/bob')).catch(() => {});
        onValue(ref(db, 'profiles/bob'), () => {}, () => {});
      });
      const result = await replay(events, { rules: ALLOW_ALL, capturedState: state });
      expect(result.divergences).toEqual([
        expect.objectContaining({ kind: 'now-allowed', method: 'get', path: '/profiles/bob' }),
        expect.objectContaining({ kind: 'now-allowed', method: 'listen', path: '/profiles/bob' }),
      ]);
      expect(result.checkedEvents).toBe(2);
    });

    it('checks a captured denied query read with its query', async () => {
      const { events, state } = await captureDenials((db) =>
        get(query(ref(db, 'items'), orderByChild('owner'), equalTo('alice'))));
      const queryGated = {
        rules: { items: { '.indexOn': ['owner'], '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid" } },
      };
      const stillDenying = {
        rules: { items: { '.indexOn': ['owner'], '.read': "query.orderByChild == 'owner' && query.equalTo == 'bob'" } },
      };
      expect((await replay(events, { rules: queryGated, capturedState: state })).divergences).toEqual([
        expect.objectContaining({ kind: 'now-allowed', method: 'get', path: '/items' }),
      ]);
      expect((await replay(events, { rules: stillDenying, capturedState: state })).divergences).toEqual([]);
    });

    it('reports nothing when the candidate rules still deny', async () => {
      const { events, state } = await captureDenials(async (db) => {
        await set(ref(db, 'profiles/bob/name'), 'Mallory').catch(() => {});
        await get(ref(db, 'profiles/bob')).catch(() => {});
      });
      const result = await replay(events, { rules: OWNER_ONLY, capturedState: state });
      expect(result.divergences).toEqual([]);
      expect(result.checkedEvents).toBe(2);
    });

    it('judges a denial against the data at that moment, not the end state', async () => {
      const CREATE_ONLY = { rules: { locks: { $id: { '.write': '!data.exists()' } } } };
      const sandbox = initializeSandbox();
      const adminDb = getDatabase(sandbox);
      rtdbSandbox.setRules(adminDb, CREATE_ONLY);
      rtdbSandbox.setData(adminDb, { '/locks/x': 'held' });
      await set(ref(getDatabase(sandbox.withAuth({ uid: 'alice' })), 'locks/x'), 'mine').catch(() => {});
      await remove(ref(getAdminDatabase(sandbox), 'locks/x'));
      const events = sandbox.history();
      const state = rtdbSandbox.snapshotState(adminDb);
      const result = await replay(events, { rules: CREATE_ONLY, capturedState: state });
      expect(result.divergences).toEqual([]);
      expect(result.checkedEvents).toBe(1);
    });

    it('reports a captured denied update as unsupported, as the capture holds only its denied path', async () => {
      const { events, state } = await captureDenials((db) =>
        update(ref(db), { 'profiles/alice/name': 'Alice', 'profiles/bob/name': 'Mallory' }));
      const result = await replay(events, { rules: ALLOW_ALL, capturedState: state });
      expect(result.divergences).toEqual([
        expect.objectContaining({ kind: 'unsupported', method: 'update', path: '/profiles/bob/name' }),
      ]);
    });
  });

  describe('replaying under the rules a session was captured with', () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    async function cleanUnder(rules: { rules: Record<string, unknown> }, run: (sandbox: ReturnType<typeof initializeSandbox>) => Promise<void>) {
      const sandbox = initializeSandbox();
      rtdbSandbox.setRules(getDatabase(sandbox), rules);
      await run(sandbox);
      await tick();
      return replay(sandbox.history(), { rules, capturedState: rtdbSandbox.snapshotState(getAdminDatabase(sandbox)) });
    }

    it('reports nothing for a listener a later write revoked', async () => {
      const rules = { rules: { docs: { $id: { '.read': "data.child('public').val() === true", '.write': true } } } };
      const result = await cleanUnder(rules, async (sandbox) => {
        rtdbSandbox.setData(getAdminDatabase(sandbox), { '/docs/a': { public: true } });
        const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
        onValue(ref(db, 'docs/a'), () => {}, () => {});
        await tick();
        await set(ref(db, 'docs/a/public'), false);
      });
      expect(result.divergences).toEqual([]);
    });

    it('reports nothing for a listener a rules change revoked', async () => {
      const rules = { rules: { '.read': true, '.write': true } };
      const sandbox = initializeSandbox();
      rtdbSandbox.setRules(getDatabase(sandbox), rules);
      onValue(ref(getDatabase(sandbox.withAuth({ uid: 'alice' })), 'a'), () => {}, () => {});
      await tick();
      rtdbSandbox.setRules(getDatabase(sandbox), { rules: { '.read': false, '.write': true } });
      await tick();
      const result = await replay(sandbox.history(), { rules, capturedState: rtdbSandbox.snapshotState(getAdminDatabase(sandbox)) });
      expect(result.divergences).toEqual([]);
    });

    it('reports nothing for a query listener on a path with no index', async () => {
      const rules = { rules: { '.read': true, '.write': true } };
      const result = await cleanUnder(rules, async (sandbox) => {
        rtdbSandbox.setData(getAdminDatabase(sandbox), { '/items/a': { owner: 'alice' } });
        const off = onValue(query(ref(getDatabase(sandbox.withAuth({ uid: 'alice' })), 'items'), orderByChild('owner'), equalTo('alice')), () => {});
        await tick();
        off();
      });
      expect(result.divergences).toEqual([]);
      expect(result.checkedEvents).toBe(1);
    });

    it('reports nothing for a denied child listener with a query, and keeps its query', async () => {
      const rules = { rules: { items: { '.read': 'query.limitToFirst <= 10' } } };
      const result = await cleanUnder(rules, async (sandbox) => {
        onChildAdded(query(ref(getDatabase(sandbox.withAuth({ uid: 'alice' })), 'items'), limitToFirst(50)), () => {}, () => {});
      });
      expect(result.divergences).toEqual([]);
      // A candidate that opens unqueried reads but still denies limitToFirst(50) still denies it.
      const candidate = { rules: { items: { '.read': 'query.limitToFirst == null || query.limitToFirst <= 10' } } };
      const sandbox = initializeSandbox();
      rtdbSandbox.setRules(getDatabase(sandbox), rules);
      onChildAdded(query(ref(getDatabase(sandbox.withAuth({ uid: 'alice' })), 'items'), limitToFirst(50)), () => {}, () => {});
      await tick();
      expect((await replay(sandbox.history(), { rules: candidate })).divergences).toEqual([]);
    });

    it('reports nothing for a denied setWithPriority, and decides it with its priority', async () => {
      const rules = { rules: { x: { '.write': 'newData.getPriority() == null' } } };
      const result = await cleanUnder(rules, async (sandbox) => {
        await setWithPriority(ref(getDatabase(sandbox.withAuth({ uid: 'alice' })), 'x'), 'v', 5).catch(() => {});
      });
      expect(result.divergences).toEqual([]);
      const anyPriority = { rules: { x: { '.write': true } } };
      const sandbox = initializeSandbox();
      rtdbSandbox.setRules(getDatabase(sandbox), rules);
      await setWithPriority(ref(getDatabase(sandbox.withAuth({ uid: 'alice' })), 'x'), 'v', 5).catch(() => {});
      expect((await replay(sandbox.history(), { rules: anyPriority })).divergences).toEqual([
        expect.objectContaining({ kind: 'now-allowed', method: 'set', path: '/x' }),
      ]);
    });
  });

  describe('per instance', () => {
    const SHARD = 'shard-00';
    const SHARD_URL = `https://${SHARD}.firebaseio.com`;
    const INDEXED = { rules: { '.read': true, '.write': true, items: { '.indexOn': ['owner'] } } };

    /** One session that writes and queries the default instance and a named one. */
    async function captureTwoInstances() {
      const sandbox = initializeSandbox();
      const defaultAdmin = getAdminDatabase(sandbox);
      const shardAdmin = getAdminDatabase(sandbox, SHARD_URL);
      rtdbSandbox.setRules(getDatabase(sandbox), INDEXED);
      rtdbSandbox.setRules(getDatabase(sandbox, SHARD_URL), INDEXED);
      await set(ref(defaultAdmin, '/items/seed'), { owner: 'alice' });
      await set(ref(shardAdmin, '/items/seed'), { owner: 'alice' });

      const alice = sandbox.withAuth({ uid: 'alice' });
      await set(ref(getDatabase(alice), '/profiles/alice'), { name: 'Alice' });
      await set(ref(getDatabase(alice, SHARD_URL), '/messages/m1'), { text: 'on the shard' });
      await update(ref(getDatabase(alice, SHARD_URL), '/messages/m1'), { edited: true });
      await get(query(ref(getDatabase(alice, SHARD_URL), 'items'), orderByChild('owner'), equalTo('alice')));

      return {
        events: sandbox.history(),
        defaultState: rtdbSandbox.snapshotState(defaultAdmin),
        shardState: rtdbSandbox.snapshotState(shardAdmin),
      };
    }

    it('replays only the default instance\'s events when no instance is named', async () => {
      const captured = await captureTwoInstances();
      const result = await replay(captured.events, { rules: INDEXED, capturedState: captured.defaultState });
      expect(result.divergences).toEqual([]);
      expect(result.checkedEvents).toBe(1);
      expect(result.replayedState).toEqual(captured.defaultState);
    });

    it('replays only the named instance\'s events into that instance', async () => {
      const captured = await captureTwoInstances();
      const result = await replay(captured.events, {
        rules: INDEXED,
        capturedState: captured.shardState,
        instance: SHARD,
      });
      expect(result.divergences).toEqual([]);
      expect(result.checkedEvents).toBe(3);
      expect(result.replayedState).toEqual(captured.shardState);
      const shardRead = await get(ref(getAdminDatabase(result.sandbox, SHARD_URL), '/messages/m1'));
      expect(shardRead.val()).toEqual({ text: 'on the shard', edited: true });
      expect((await get(ref(getAdminDatabase(result.sandbox), '/messages'))).exists()).toBe(false);
    });

    it('accepts the instance as a database URL', async () => {
      const captured = await captureTwoInstances();
      const result = await replay(captured.events, {
        rules: INDEXED,
        capturedState: captured.shardState,
        instance: SHARD_URL,
      });
      expect(result.divergences).toEqual([]);
      expect(result.checkedEvents).toBe(3);
    });

    it('reports now-denied only for the commits of the instance it checks', async () => {
      const captured = await captureTwoInstances();
      // Only profiles stay writable: the default instance's writes pass, the shard's messages do not.
      const strict = { rules: { '.read': true, items: { '.indexOn': ['owner'] }, profiles: { '.write': true } } };
      const onDefault = await replay(captured.events, { rules: strict, capturedState: captured.defaultState });
      expect(onDefault.divergences).toEqual([]);
      const onShard = await replay(captured.events, { rules: strict, capturedState: captured.shardState, instance: SHARD });
      expect(onShard.divergences.filter((d) => d.kind === 'now-denied')).toEqual([
        expect.objectContaining({ kind: 'now-denied', method: 'set', path: '/messages/m1' }),
        expect.objectContaining({ kind: 'now-denied', method: 'update', path: '/messages/m1' }),
      ]);
    });

    it('matches a project default name literally, so the caller maps it to the default instance', async () => {
      const captured = await captureTwoInstances();
      const byName = await replay(captured.events, { rules: INDEXED, instance: 'demo-default-rtdb' });
      expect(byName.checkedEvents).toBe(0);
      const byDefault = await replay(captured.events, { rules: INDEXED, instance: 'default' });
      expect(byDefault.checkedEvents).toBe(1);
    });

    it('replays a capture whose events carry no instance as the default instance, as before', async () => {
      const captured = await captureJourney();
      expect(captured.events.some((event) => Object.hasOwn(event, 'instance'))).toBe(false);
      const unnamed = await replay(captured.events, { rules: ALLOW_ALL, capturedState: captured.state });
      expect(unnamed.ok).toBe(true);
      expect(unnamed.checkedEvents).toBe(4);
      expect(unnamed.replayedState).toEqual(captured.state);
      const onShard = await replay(captured.events, { rules: ALLOW_ALL, instance: SHARD });
      expect(onShard.checkedEvents).toBe(0);
      expect(onShard.replayedState).toEqual({});
    });
  });
});
