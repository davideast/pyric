import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  equalTo,
  getAdminDatabase,
  getDatabase,
  limitToFirst,
  orderByChild,
  query,
  ref,
  get,
  remove,
  runTransaction,
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

  describe('captured query reads', () => {
    const CAPTURE = { rules: { '.read': true, '.write': true, items: { '.indexOn': ['owner'] } } };

    async function captureQueryRead() {
      const sandbox = initializeSandbox();
      const adminDb = getDatabase(sandbox);
      rtdbSandbox.setRules(adminDb, CAPTURE);
      rtdbSandbox.setData(adminDb, { '/items/a': { owner: 'alice' } });
      const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
      await get(query(ref(db, 'items'), orderByChild('owner'), equalTo('alice'), limitToFirst(5)));
      await get(ref(db, 'items'));
      return { events: sandbox.history(), state: rtdbSandbox.snapshotState(adminDb) };
    }

    it('checks each captured query read, and not the read that carried no query', async () => {
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
