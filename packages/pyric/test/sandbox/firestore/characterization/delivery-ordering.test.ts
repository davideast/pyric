/**
 * Characterization pins — snapshot delivery FIFO ordering.
 *
 * These tests pin what LocalEnvironment DOES today through its public
 * interface only. They are the audit contract for the ADR-0009 mechanical
 * split and must survive the file move and later internal restructuring
 * unchanged. Do not "fix" an ordering here without a deliberate,
 * separately-reviewed behavior change.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

describe('characterization: delivery ordering', () => {
  test('two doc listeners on the same path receive a write in registration order', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const order: string[] = [];
    const unsubA = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => order.push('A'),
      undefined,
      { uid: 'alice' },
    );
    const unsubB = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => order.push('B'),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    // Initial fires drain in registration order.
    expect(order).toEqual(['A', 'B']);

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    // Write-driven fires also drain in registration order.
    expect(order).toEqual(['A', 'B', 'A', 'B']);
    unsubA();
    unsubB();
  });

  test('doc and query listeners interleave in registration order, not grouped by kind', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const order: string[] = [];
    const u1 = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => order.push('doc1'),
      undefined,
      { uid: 'alice' },
    );
    const u2 = env.addSnapshotListener(
      { kind: 'query', collection: 'rooms' },
      () => order.push('query'),
      undefined,
      { uid: 'alice' },
    );
    const u3 = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => order.push('doc2'),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    order.length = 0;

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    expect(order).toEqual(['doc1', 'query', 'doc2']);
    u1();
    u2();
    u3();
  });

  test('deliveries are off-stack: nothing fires synchronously during execute; one microtask pass drains all', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const order: string[] = [];
    const u1 = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => order.push('A'),
      undefined,
      { uid: 'alice' },
    );
    const u2 = env.addSnapshotListener(
      { kind: 'query', collection: 'rooms' },
      () => order.push('Q'),
      undefined,
      { uid: 'alice' },
    );
    // Nothing fires synchronously on register.
    expect(order).toEqual([]);
    // The registered drain runs on a microtask — no flushListeners needed.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(order).toEqual(['A', 'Q']);

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    expect(order).toEqual(['A', 'Q']); // still nothing on the writing stack
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(order).toEqual(['A', 'Q', 'A', 'Q']);
    u1();
    u2();
  });

  test('a batch fans out once per listener and drains in one flush pass', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: OPEN_RULES,
      documents: { 'rooms/r1': { v: 0 }, 'rooms/r2': { v: 0 } },
    });
    const order: string[] = [];
    const u1 = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => order.push('d1'),
      undefined,
      { uid: 'alice' },
    );
    const u2 = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r2' },
      () => order.push('d2'),
      undefined,
      { uid: 'alice' },
    );
    const u3 = env.addSnapshotListener(
      { kind: 'query', collection: 'rooms' },
      () => order.push('q'),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    order.length = 0;

    const r = env.batch(
      [
        { method: 'update', path: 'rooms/r1', data: { v: 1 } },
        { method: 'update', path: 'rooms/r2', data: { v: 1 } },
      ],
      { uid: 'alice' },
    );
    expect(r.allowed).toBe(true);
    expect(order).toEqual([]); // off-stack
    env.flushListeners();
    // One fire per listener for the whole batch (query listener fires once,
    // not once per sub-op), all in registration order, one pass.
    expect(order).toEqual(['d1', 'd2', 'q']);
    u1();
    u2();
    u3();
  });

  test('a write performed inside a listener callback: its deliveries append to the same drain pass, after the outer write finishes fanning out', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: OPEN_RULES,
      documents: { 'rooms/r1': { v: 0 }, 'logs/l1': { n: 0 } },
    });
    const order: string[] = [];
    let reacted = false;
    // Listener A on rooms/r1 writes logs/l1 the first time it sees a change.
    const uA = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (snap) => {
        const s = snap as { data(): Record<string, unknown> | undefined };
        order.push(`A:v=${String(s.data()?.v)}`);
        if (!reacted && s.data()?.v === 1) {
          reacted = true;
          env.execute({ method: 'update', path: 'logs/l1', auth: { uid: 'alice' }, data: { n: 1 } });
        }
      },
      undefined,
      { uid: 'alice' },
    );
    // Listener B on rooms/r1 registered AFTER A.
    const uB = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => order.push('B'),
      undefined,
      { uid: 'alice' },
    );
    // Listener C on logs/l1.
    const uC = env.addSnapshotListener(
      { kind: 'doc', path: 'logs/l1' },
      (snap) => {
        const s = snap as { data(): Record<string, unknown> | undefined };
        order.push(`C:n=${String(s.data()?.n)}`);
      },
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    expect(order).toEqual(['A:v=0', 'B', 'C:n=0']);
    order.length = 0;

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    // PIN: A's callback runs first and performs the nested write inline
    // (synchronously inside A's delivery). The nested write's fan-out is
    // APPENDED to the queue, so B (already queued by the outer write)
    // fires before C sees the nested write. All in one flush pass.
    expect(order).toEqual(['A:v=1', 'B', 'C:n=1']);
    uA();
    uB();
    uC();
  });

  test('a write performed inside an onWrite handler schedules its deliveries BEFORE the outer write’s deliveries', () => {
    // onWrite subscribers fire synchronously inside execute(), before the
    // outer write's listener fan-out is scheduled. A nested execute() in the
    // handler therefore enqueues ITS deliveries first — the observable
    // delivery order inverts causality. PIN of current behavior.
    const env = new LocalEnvironment();
    env.seed({
      rules: OPEN_RULES,
      documents: { 'rooms/r1': { v: 0 }, 'logs/l1': { n: 0 } },
    });
    const order: string[] = [];
    const uR = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => order.push('room'),
      undefined,
      { uid: 'alice' },
    );
    const uL = env.addSnapshotListener(
      { kind: 'doc', path: 'logs/l1' },
      () => order.push('log'),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    order.length = 0;

    let reacted = false;
    const offWrite = env.onWrite((event) => {
      if (!reacted && event.path === 'rooms/r1') {
        reacted = true;
        env.execute({ method: 'update', path: 'logs/l1', auth: { uid: 'alice' }, data: { n: 1 } });
      }
    });
    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    // The log delivery (caused by the nested write) lands before the room
    // delivery (the write that caused it).
    expect(order).toEqual(['log', 'room']);
    offWrite();
    uR();
    uL();
  });

  test('initial snapshot fires before change snapshots when a write lands before the first drain', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const fired: Array<unknown> = [];
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (snap) => {
        const s = snap as { data(): Record<string, unknown> | undefined };
        fired.push(s.data()?.v);
      },
      undefined,
      { uid: 'alice' },
    );
    // Write BEFORE the initial fire has drained.
    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    // PIN: the initial fire is still first in the queue — but by the time it
    // runs, it reads v=1 (post-write state). The write-driven re-eval then
    // suppresses as a no-op, so exactly ONE snapshot is delivered.
    expect(fired).toEqual([1]);
    unsub();
  });

  test('unsubscribe between write and drain suppresses the pending delivery', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const fired: unknown[] = [];
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (snap) => fired.push(snap),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    expect(fired.length).toBe(1);
    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    unsub(); // detach while the delivery is still queued
    env.flushListeners();
    expect(fired.length).toBe(1); // pending delivery never ran
  });
});
