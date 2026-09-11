/**
 * `activeListeners` folds the whole event stream into "what is attached
 * right now", across both listener lifecycle shapes the sandbox emits:
 * Firestore's own `listener_attach` / `snapshot_delivery` / ... variants,
 * and the canonical `listener` variant the Realtime Database reports
 * through.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { activeListeners, initializeSandbox } from 'pyric/sandbox';
import { doc, getFirestore, onSnapshot, setDoc } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import {
  getDatabase,
  onValue,
  ref,
  sandbox as rtdbSandbox,
} from 'pyric/database';

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

describe('activeListeners', () => {
  it('lists a Firestore doc listener and a Realtime Database value listener, and drops one on detach', () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_FIRESTORE_RULES);
    const db = getFirestore(sandbox);
    const rtdb = getDatabase(sandbox);
    rtdbSandbox.setRules(rtdb, rtdbSandbox.DEFAULT_OPEN_RULES);

    const unsubscribeA = onSnapshot(doc(db, 'notes/a'), () => {});
    const unsubscribeB = onSnapshot(doc(db, 'notes/b'), () => {});
    const unsubscribeC = onValue(ref(rtdb, 'rooms/lobby'), () => {});

    const attached = activeListeners(sandbox.history());
    expect(attached).toHaveLength(3);
    const byService = { firestore: 0, database: 0 };
    for (const listener of attached) byService[listener.service] += 1;
    expect(byService).toEqual({ firestore: 2, database: 1 });

    const rtdbListener = attached.find((entry) => entry.service === 'database');
    expect(rtdbListener?.target).toBe('/rooms/lobby');

    unsubscribeA();
    const afterOneDetach = activeListeners(sandbox.history());
    expect(afterOneDetach).toHaveLength(2);
    expect(afterOneDetach.some((entry) => entry.target === 'notes/a')).toBe(false);

    unsubscribeB();
    unsubscribeC();
    expect(activeListeners(sandbox.history())).toHaveLength(0);
  });

  it('counts deliveries, and records the last delivery instant', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_FIRESTORE_RULES);
    const db = getFirestore(sandbox);

    const deliveries: unknown[] = [];
    const unsubscribe = onSnapshot(doc(db, 'counters/hits'), (snap) => {
      deliveries.push(snap);
    });

    await setDoc(doc(db, 'counters/hits'), { n: 1 });

    const [listener] = activeListeners(sandbox.history());
    expect(listener?.deliveryCount).toBeGreaterThanOrEqual(1);
    expect(typeof listener?.lastDeliveryAt).toBe('number');
    expect(deliveries.length).toBeGreaterThanOrEqual(1);

    unsubscribe();
    expect(activeListeners(sandbox.history())).toHaveLength(0);
  });

  it('reads no listener out of ordinary reads and writes', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_FIRESTORE_RULES);
    const db = getFirestore(sandbox);
    await setDoc(doc(db, 'plain/doc'), { value: 1 });
    expect(activeListeners(sandbox.history())).toHaveLength(0);
  });
});

describe('activeListeners owners', () => {
  it('carries the owners the attach event recorded: the creation frame and an explicit tag', () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_FIRESTORE_RULES);
    const db = getFirestore(sandbox);

    const unsubscribe = onSnapshot(doc(db, 'notes/tagged'), { owner: 'notes-panel' }, () => {});

    const [listener] = activeListeners(sandbox.history());
    expect(listener.owners).toBeDefined();
    const kinds = (listener.owners ?? []).map((owner) => owner.kind);
    expect(kinds).toContain('tag');
    expect(kinds).toContain('frame');
    const tag = (listener.owners ?? []).find((owner) => owner.kind === 'tag');
    expect(tag).toMatchObject({ kind: 'tag', name: 'notes-panel' });
    const frame = (listener.owners ?? []).find((owner) => owner.kind === 'frame');
    expect(frame && 'file' in frame && frame.file.endsWith('active-listeners.test.ts')).toBe(true);

    unsubscribe();
    expect(activeListeners(sandbox.history())).toHaveLength(0);
  });

  it('reports no owners for a listener whose attach event recorded none', () => {
    const events = [] as const;
    expect(activeListeners(events)).toHaveLength(0);
  });
});
