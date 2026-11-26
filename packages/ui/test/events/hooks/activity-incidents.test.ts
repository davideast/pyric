import { describe, expect, it } from 'bun:test';
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  query,
  setDoc,
  where,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  assertActiveListeners,
  assertNoActivityIncidents,
  collectActivityIncidents,
  decodeActivityIncidentTarget,
  expectSandboxActivity,
  formatActivityIncidentTargetLabel,
} from '../../../src/events/index.js';

const OPEN_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} { allow read, write: if true; }
    }
  }
`;

describe('subscription incident assertions (@pyric/ui/events)', () => {
  it('fails on unpooled duplicate document listeners and passes when pooled into one subscription', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const db = getFirestore(sandbox);
    await setDoc(doc(db, 'todos/t1'), { title: 'Ship #681' });

    const unsub1 = onSnapshot(doc(db, 'todos/t1'), () => {});
    const unsub2 = onSnapshot(doc(db, 'todos/t1'), () => {});
    const unsub3 = onSnapshot(doc(db, 'todos/t1'), () => {});

    expect(() => {
      expectSandboxActivity(sandbox).toHaveNoIncidents({ pattern: 'duplicate-listener' });
    }).toThrow(/\[duplicate-listener\] target='todos\/t1' source='app'/);

    const incidents = collectActivityIncidents(sandbox, { pattern: 'duplicate-listener' });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.count).toBe(3);

    unsub1();
    unsub2();
    unsub3();

    const cleanSandbox = initializeSandbox();
    setRules(cleanSandbox, OPEN_RULES);
    const cleanDb = getFirestore(cleanSandbox);
    await setDoc(doc(cleanDb, 'todos/t1'), { title: 'Pooled' });

    const subscribers = new Set<(title: unknown) => void>();
    const stopShared = onSnapshot(doc(cleanDb, 'todos/t1'), (snap) => {
      const title = snap.data()?.title;
      for (const listener of subscribers) {
        listener(title);
      }
    });
    subscribers.add(() => {});
    subscribers.add(() => {});
    subscribers.add(() => {});

    expectSandboxActivity(cleanSandbox).toHaveActiveListeners('todos/t1', 1);
    expectSandboxActivity(cleanSandbox).toHaveNoIncidents({
      pattern: ['duplicate-listener', 'listener-churn'],
    });

    stopShared();
    assertActiveListeners(cleanSandbox, 'todos/t1', 0);
  });

  it('detects listener-churn bursts and supports `since` cursor boundaries', () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const db = getFirestore(sandbox);

    for (let index = 0; index < 4; index += 1) {
      const stop = onSnapshot(doc(db, 'todos/t1'), () => {});
      if (index < 3) {
        stop();
      }
    }

    expect(() => {
      assertNoActivityIncidents(sandbox, { pattern: 'listener-churn' });
    }).toThrow(/\[listener-churn\] target='todos\/t1'.*attaches=4, detaches=3, active=1/);

    const historyAfterChurn = sandbox.history();
    const lastEvent = historyAfterChurn[historyAfterChurn.length - 1];
    expect(lastEvent).toBeDefined();
    const cursorId = lastEvent ? lastEvent.id : '';

    expect(() => {
      assertNoActivityIncidents(sandbox, {
        pattern: ['duplicate-listener', 'listener-churn'],
        since: cursorId,
      });
    }).not.toThrow();

    expect(() => {
      collectActivityIncidents(sandbox, { since: 'missing-event-id' });
    }).toThrow(/does not contain cursor event 'missing-event-id'/);
  });

  it('decodes query listener incident targets and asserts active query listeners', () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const db = getFirestore(sandbox);
    const openTodos = query(collection(db, 'todos'), where('done', '==', false));

    const stop1 = onSnapshot(openTodos, () => {});
    const stop2 = onSnapshot(openTodos, () => {});
    const stop3 = onSnapshot(openTodos, () => {});

    expectSandboxActivity(sandbox).toHaveActiveListeners(
      { collection: 'todos', query: true },
      3,
      { service: 'firestore' },
    );

    const incidents = collectActivityIncidents(sandbox.history(), { pattern: 'duplicate-listener' });
    expect(incidents).toHaveLength(1);
    const first = incidents[0];
    expect(first).toBeDefined();
    if (first) {
      expect(decodeActivityIncidentTarget(first.targetFingerprint)).toEqual({
        collection: 'todos',
        query: true,
      });
      expect(formatActivityIncidentTargetLabel(first.targetFingerprint)).toBe('todos (query #1)');
    }

    expect(() => {
      assertActiveListeners(sandbox, { collection: 'todos', query: true }, 1);
    }).toThrow(/Expected 1 active listener\(s\) on 'todos \(query\)', found 3/);

    stop1();
    stop2();
    stop3();
  });
});
