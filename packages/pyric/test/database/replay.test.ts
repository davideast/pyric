import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAdminDatabase,
  getDatabase,
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
});
