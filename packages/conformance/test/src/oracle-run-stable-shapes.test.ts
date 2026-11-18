import { describe, expect, test } from 'bun:test';
import {
  createAuthUserSlotTracker,
  describeAuthFireSequence,
  describeAuthUid,
  describeFencedAuthFireSequence,
  describeUserUid,
  isFirebaseAuthUid,
  isOracleProbeEmail,
} from '../../src/oracle-run-stable-shapes.ts';

describe('oracle-run-stable-shapes (Auth)', () => {
  test('describes 28-char Firebase Auth UIDs deterministically across distinct runs', () => {
    const runAUid = 'muqpqfndMZYInBNdfS6T5GNpStz1';
    const runBUid = 'doTpMeHIwmXngXmB73jf1Ccql083';

    expect(isFirebaseAuthUid(runAUid)).toBe(true);
    expect(isFirebaseAuthUid(runBUid)).toBe(true);
    expect(isFirebaseAuthUid(null)).toBe(false);
    expect(isFirebaseAuthUid('short')).toBe(false);

    expect(describeAuthUid(runAUid)).toEqual({
      present: true,
      uidLength: 28,
      uidMatchesPattern: true,
    });
    expect(describeAuthUid(runBUid)).toEqual(describeAuthUid(runAUid));
    expect(describeUserUid({ uid: runBUid })).toEqual(describeAuthUid(runAUid));
    expect(describeUserUid(null)).toEqual({
      present: false,
      uidLength: null,
      uidMatchesPattern: false,
    });
  });

  test('validates throwaway oracle probe email pattern without recording timestamp nonces', () => {
    expect(isOracleProbeEmail('oracle-create-1793357167206-7hlsdi@oracle.test')).toBe(true);
    expect(isOracleProbeEmail('oracle-never-registered-1794968068213-ef1tqq@oracle.test')).toBe(true);
    expect(isOracleProbeEmail('not-an-email')).toBe(false);
    expect(isOracleProbeEmail(null)).toBe(false);
  });

  test('preserves same-user vs distinct-user transitions and strips wall-clock fire latencies', () => {
    const run1 = [
      { uid: null, ts: 1 },
      { uid: 'OYGvvsqzHZRgrRyiwVYPgD7T2dz1', ts: 678 },
      { uid: null, ts: 1082 },
      { uid: 'OYGvvsqzHZRgrRyiwVYPgD7T2dz1', ts: 1410 },
      { uid: 'Wd76FkTp21RnmJP57L1Fum8ADH32', ts: 1853 },
    ];
    const run2 = [
      { uid: null, ts: 0 },
      { uid: '4KsvrZZj0vZNJGYMQBmYQtA0RKr2', ts: 657 },
      { uid: null, ts: 1058 },
      { uid: '4KsvrZZj0vZNJGYMQBmYQtA0RKr2', ts: 1399 },
      { uid: 'BjbMcv8f0ANCz8QlauOl6gwg8cj1', ts: 1807 },
    ];

    const shape1 = describeAuthFireSequence(run1);
    const shape2 = describeAuthFireSequence(run2);
    expect(shape2).toEqual(shape1);
    expect(shape1.map((entry) => entry.userSlot)).toEqual([null, 1, null, 1, 2]);
  });

  test('tracks shared user slots across multi-subscriber and fenced Auth fire sequences', () => {
    const slots = createAuthUserSlotTracker();
    const uid = 'PnU2ChRKatSX6lfMkUuUq3qTvTw1';
    const seqA = slots.describeSequence([
      { uid: null },
      { uid },
      { uid: null },
    ]);
    const seqB = slots.describeSequence([
      { uid: null },
      { uid },
      { uid: null },
    ]);
    expect(seqA).toEqual(seqB);
    expect(seqA[1]).toEqual({
      userSlot: 1,
      uidLength: 28,
      uidMatchesPattern: true,
    });

    expect(
      describeFencedAuthFireSequence([{ uid: 'L8SZfsLuotU1cUeSXElPSzNIqjl2', fence: 'microtask' }]),
    ).toEqual([
      {
        userSlot: 1,
        uidLength: 28,
        uidMatchesPattern: true,
        fence: 'microtask',
      },
    ]);
  });
});
