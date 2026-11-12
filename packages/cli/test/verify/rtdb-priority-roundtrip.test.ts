import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAdminDatabase,
  getDatabase,
  get,
  ref,
  set,
  sandbox as rtdbSandbox,
} from 'pyric/database';
import { snapshotState } from 'pyric/sandbox/database';
import { buildVerifyFixture, verifyFixture } from '../../src/verify/index.js';
import { captureRtdbInstances } from '../../src/verify/rtdb-instance-capture.js';

describe('verifyFixture RTDB .priority state roundtrip', () => {
  const PRIORITY_GATED_RULES = {
    rules: {
      items: {
        $id: {
          '.read': 'data.getPriority() === 50',
        },
      },
      flags: {
        $flagId: {
          '.read': "data.getPriority() === 'high'",
        },
      },
      logs: {
        $logId: {
          '.write':
            "root.child('items/i1').getPriority() === 50 && root.child('flags/f1').getPriority() === 'high'",
        },
      },
    },
  };

  it('preserves untouched object and primitive .priority metadata across snapshotState(db, { includePriorities: true }) and buildVerifyFixture', async () => {
    const sb = initializeSandbox();
    const userDb = getDatabase(sb.withAuth({ uid: 'u1', token: {} }));
    const adminDb = getAdminDatabase(sb);
    rtdbSandbox.setRules(userDb, PRIORITY_GATED_RULES);
    rtdbSandbox.setData(adminDb, {
      'items/i1': { owner: 'u1', title: 'alpha', '.priority': 50 },
      'flags/f1': { '.value': 'active', '.priority': 'high' },
    });

    const itemSnap = await get(ref(userDb, 'items/i1'));
    const flagSnap = await get(ref(userDb, 'flags/f1'));
    expect(itemSnap.priority).toBe(50);
    expect(flagSnap.priority).toBe('high');
    await set(ref(userDb, 'logs/l1'), { action: 'read-item' });

    // Default 1-arg snapshotState keeps plain JSON data shape:
    expect(rtdbSandbox.snapshotState(userDb)).toEqual({
      items: { i1: { owner: 'u1', title: 'alpha' } },
      flags: { f1: 'active' },
      logs: { l1: { action: 'read-item' } },
    });

    // Explicit includePriorities option exports REST-shaped .priority / .value metadata:
    expect(rtdbSandbox.snapshotState(userDb, { includePriorities: true })).toEqual({
      items: { i1: { owner: 'u1', title: 'alpha', '.priority': 50 } },
      flags: { f1: { '.value': 'active', '.priority': 'high' } },
      logs: { l1: { action: 'read-item' } },
    });
    expect(snapshotState(sb, { includePriorities: true })).toEqual({
      items: { i1: { owner: 'u1', title: 'alpha', '.priority': 50 } },
      flags: { f1: { '.value': 'active', '.priority': 'high' } },
      logs: { l1: { action: 'read-item' } },
    });

    // Both buildVerifyFixture with plain snapshotState(db) and with includePriorities round-trip cleanly:
    const fixtureFromPlain = JSON.parse(
      JSON.stringify(
        buildVerifyFixture({
          sandbox: sb,
          rtdbRules: PRIORITY_GATED_RULES,
          rtdbState: rtdbSandbox.snapshotState(userDb),
        }),
      ),
    );
    const sameRes = await verifyFixture(fixtureFromPlain, {
      rules: { rtdb: PRIORITY_GATED_RULES },
    });
    expect(sameRes.services.rtdb?.divergences).toEqual([]);
    expect(sameRes.ok).toBe(true);

    const fixtureWithExplicitPriorities = JSON.parse(
      JSON.stringify(
        buildVerifyFixture({
          sandbox: sb,
          rtdbRules: PRIORITY_GATED_RULES,
          rtdbState: rtdbSandbox.snapshotState(userDb, { includePriorities: true }),
        }),
      ),
    );
    const explicitRes = await verifyFixture(fixtureWithExplicitPriorities, {
      rules: { rtdb: PRIORITY_GATED_RULES },
    });
    expect(explicitRes.services.rtdb?.divergences).toEqual([]);
    expect(explicitRes.ok).toBe(true);

    // Tightening priority rule reports real now-denied divergence:
    const tightenedRules = {
      rules: {
        ...PRIORITY_GATED_RULES.rules,
        items: { $id: { '.read': 'data.getPriority() === 99' } },
      },
    };
    const tightenedRes = await verifyFixture(fixtureFromPlain, {
      rules: { rtdb: tightenedRules },
    });
    expect(tightenedRes.ok).toBe(false);
    expect(tightenedRes.services.rtdb?.divergences).toEqual([
      expect.objectContaining({ kind: 'now-denied', method: 'get', path: '/items/i1' }),
    ]);

    // Intentionally tampered rtdbState on a committed path still surfaces state-drift:
    const tamperedFixture = buildVerifyFixture({
      sandbox: sb,
      rtdbRules: PRIORITY_GATED_RULES,
      rtdbState: {
        items: { i1: { owner: 'u1', title: 'alpha', '.priority': 50 } },
        flags: { f1: { '.value': 'active', '.priority': 'high' } },
        logs: { l1: { action: 'tampered' } },
      },
    });
    const tamperedRes = await verifyFixture(tamperedFixture, {
      rules: { rtdb: PRIORITY_GATED_RULES },
    });
    expect(tamperedRes.ok).toBe(false);
    expect(tamperedRes.services.rtdb?.divergences).toContainEqual(
      expect.objectContaining({ kind: 'state-drift', path: '/logs/l1/action' }),
    );
  });

  it('preserves untouched .priority metadata on named RTDB instances via captureRtdbInstances', async () => {
    const namedRules = {
      rules: {
        metrics: {
          $id: {
            '.read': 'data.getPriority() === 10',
          },
        },
      },
    };
    const sb = initializeSandbox();
    const namedUrl = 'https://metrics-shard.firebaseio.com';
    const namedAdmin = getAdminDatabase(sb, namedUrl);
    const namedUser = getDatabase(sb.withAuth({ uid: 'u1', token: {} }), namedUrl);
    rtdbSandbox.setRules(namedUser, namedRules);
    rtdbSandbox.setData(namedAdmin, {
      'metrics/m1': { count: 42, '.priority': 10 },
    });

    await get(ref(namedUser, 'metrics/m1'));

    const fixture = JSON.parse(
      JSON.stringify(
        buildVerifyFixture({
          sandbox: sb,
          rtdbInstances: captureRtdbInstances(sb),
        }),
      ),
    );
    const res = await verifyFixture(fixture, {
      rules: {
        rtdbInstances: {
          'metrics-shard': namedRules,
        },
      },
    });
    expect(res.services.rtdb?.divergences).toEqual([]);
    expect(res.ok).toBe(true);
  });
});
