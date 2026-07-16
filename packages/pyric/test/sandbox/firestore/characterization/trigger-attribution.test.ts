/**
 * Characterization pins — `triggeredBy` attribution on events.
 *
 * Pins what LocalEnvironment DOES today through the public event channels
 * (onSnapshotDelivery / onSnapshotSuppressed / onRequest). The ADR-0009
 * refactor replaces the internal `currentTrigger` baton with TriggerScope;
 * these event sequences are the contract that swap must preserve.
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

interface Trigger {
  method: string;
  path: string;
}

interface DeliveryPin {
  listenerId: string;
  target: { kind: 'doc'; path: string } | { kind: 'query'; collection: string };
  triggeredBy?: Trigger;
}

describe('characterization: triggeredBy attribution', () => {
  test('initial fire carries NO triggeredBy; a write-driven delivery carries the write’s {method, path}', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const deliveries: DeliveryPin[] = [];
    const off = env.onSnapshotDelivery((e) =>
      deliveries.push({ listenerId: e.listenerId, target: e.target, triggeredBy: e.triggeredBy }),
    );
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => {},
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.triggeredBy).toBeUndefined();

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    expect(deliveries.length).toBe(2);
    expect(deliveries[1]!.triggeredBy).toEqual({ method: 'update', path: 'rooms/r1' });
    off();
    unsub();
  });

  test('suppressed re-evals carry the same triggeredBy as deliveries would', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const suppressed: Array<{ reason: string; triggeredBy?: Trigger }> = [];
    const off = env.onSnapshotSuppressed((e) =>
      suppressed.push({ reason: e.reason, triggeredBy: e.triggeredBy }),
    );
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => {},
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    // No-op write: same post-image.
    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 0 } });
    env.flushListeners();
    expect(suppressed).toEqual([
      { reason: 'no-op', triggeredBy: { method: 'update', path: 'rooms/r1' } },
    ]);
    off();
    unsub();
  });

  test('batch-driven deliveries attribute to {method: "batch", path: <first sub-op path>}', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: OPEN_RULES,
      documents: { 'rooms/r1': { v: 0 }, 'rooms/r2': { v: 0 } },
    });
    const triggers: Array<Trigger | undefined> = [];
    const off = env.onSnapshotDelivery((e) => triggers.push(e.triggeredBy));
    const u1 = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r2' },
      () => {},
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    triggers.length = 0;

    env.batch(
      [
        { method: 'update', path: 'rooms/r1', data: { v: 1 } },
        { method: 'update', path: 'rooms/r2', data: { v: 1 } },
      ],
      { uid: 'alice' },
    );
    env.flushListeners();
    // PIN: attribution names the batch's FIRST sub-op path (rooms/r1), even
    // for the listener that fired because of the SECOND sub-op (rooms/r2).
    expect(triggers).toEqual([{ method: 'batch', path: 'rooms/r1' }]);
    off();
    u1();
  });

  test('transaction-driven deliveries attribute to {method: "transaction", path: <first sub-op path>}', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: OPEN_RULES,
      documents: { 'rooms/r1': { v: 0 }, 'rooms/r2': { v: 0 } },
    });
    const triggers: Array<Trigger | undefined> = [];
    const off = env.onSnapshotDelivery((e) => triggers.push(e.triggeredBy));
    const u1 = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r2' },
      () => {},
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    triggers.length = 0;

    const r = env.transaction(
      (tx) => {
        tx.update('rooms/r1', { v: 1 });
        tx.update('rooms/r2', { v: 1 });
      },
      { auth: { uid: 'alice' } },
    );
    expect(r.allowed).toBe(true);
    env.flushListeners();
    expect(triggers).toEqual([{ method: 'transaction', path: 'rooms/r1' }]);
    off();
    u1();
  });

  test('save/restore: a nested write inside a listener callback attributes ITS deliveries to itself, and the outer trigger is restored for the remaining outer deliveries', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: OPEN_RULES,
      documents: { 'rooms/r1': { v: 0 }, 'logs/l1': { n: 0 } },
    });
    const seen: Array<{ path: string; triggeredBy?: Trigger }> = [];
    const off = env.onSnapshotDelivery((e) => {
      const path = e.target.kind === 'doc' ? e.target.path : e.target.collection;
      seen.push({ path, triggeredBy: e.triggeredBy });
    });
    let reacted = false;
    // A (rooms/r1) writes logs/l1 when it sees v=1.
    const uA = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (snap) => {
        const s = snap as { data(): Record<string, unknown> | undefined };
        if (!reacted && s.data()?.v === 1) {
          reacted = true;
          env.execute({ method: 'update', path: 'logs/l1', auth: { uid: 'alice' }, data: { n: 1 } });
        }
      },
      undefined,
      { uid: 'alice' },
    );
    // B (rooms/r1), registered after A — its delivery drains AFTER the
    // nested write happened, and must still attribute to the OUTER write.
    const uB = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => {},
      undefined,
      { uid: 'alice' },
    );
    // C (logs/l1) — attributes to the nested write.
    const uC = env.addSnapshotListener(
      { kind: 'doc', path: 'logs/l1' },
      () => {},
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    seen.length = 0;

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    // PIN: capture-at-schedule + save/restore. A and B attribute to the
    // outer write even though B drains after the nested write; C attributes
    // to the nested write.
    expect(seen).toEqual([
      { path: 'rooms/r1', triggeredBy: { method: 'update', path: 'rooms/r1' } },
      { path: 'rooms/r1', triggeredBy: { method: 'update', path: 'rooms/r1' } },
      { path: 'logs/l1', triggeredBy: { method: 'update', path: 'logs/l1' } },
    ]);
    off();
    uA();
    uB();
    uC();
  });

  test('listener-origin RequestEvents (query re-read on a write) carry the write as triggeredBy', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const requests: Array<{ method: string; path: string; triggeredBy?: Trigger }> = [];
    const off = env.onRequest((e) => {
      // RequestEvent carries triggeredBy for listener-origin re-reads;
      // narrow structurally to avoid depending on internal type exports.
      const t = (e as { triggeredBy?: Trigger }).triggeredBy;
      requests.push({ method: e.method, path: e.path, triggeredBy: t });
    });
    const unsub = env.addSnapshotListener(
      { kind: 'query', collection: 'rooms' },
      () => {},
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    // The initial-fire list read carries no triggeredBy.
    expect(requests).toEqual([{ method: 'list', path: 'rooms', triggeredBy: undefined }]);
    requests.length = 0;

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    // PIN: the user write's own RequestEvent has no triggeredBy; the
    // listener's re-read list event attributes to the write.
    expect(requests).toEqual([
      { method: 'update', path: 'rooms/r1', triggeredBy: undefined },
      { method: 'list', path: 'rooms', triggeredBy: { method: 'update', path: 'rooms/r1' } },
    ]);
    off();
    unsub();
  });

  test('WriteSandboxEvent carries no triggeredBy field even for a nested write made inside a listener callback', () => {
    // The triggeredBy baton feeds delivery/suppression/request events;
    // committed-write events do not carry attribution today. PIN.
    const env = new LocalEnvironment();
    env.seed({
      rules: OPEN_RULES,
      documents: { 'rooms/r1': { v: 0 }, 'logs/l1': { n: 0 } },
    });
    const writes: Array<{ path: string; triggeredBy: unknown }> = [];
    const off = env.onWrite((e) =>
      writes.push({ path: e.path, triggeredBy: (e as { triggeredBy?: unknown }).triggeredBy }),
    );
    let reacted = false;
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (snap) => {
        const s = snap as { data(): Record<string, unknown> | undefined };
        if (!reacted && s.data()?.v === 1) {
          reacted = true;
          env.execute({ method: 'update', path: 'logs/l1', auth: { uid: 'alice' }, data: { n: 1 } });
        }
      },
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    expect(writes).toEqual([
      { path: 'rooms/r1', triggeredBy: undefined },
      { path: 'logs/l1', triggeredBy: undefined },
    ]);
    off();
    unsub();
  });

  test('deployRules re-evaluation: listener re-reads carry NO triggeredBy and emit NO snapshot_delivery events', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const deliveries: DeliveryPin[] = [];
    const requests: Array<{ method: string; path: string; triggeredBy?: Trigger }> = [];
    const offD = env.onSnapshotDelivery((e) =>
      deliveries.push({ listenerId: e.listenerId, target: e.target, triggeredBy: e.triggeredBy }),
    );
    const offR = env.onRequest((e) =>
      requests.push({
        method: e.method,
        path: e.path,
        triggeredBy: (e as { triggeredBy?: Trigger }).triggeredBy,
      }),
    );
    const fired: unknown[] = [];
    const unsub = env.addSnapshotListener(
      { kind: 'query', collection: 'rooms' },
      (s) => fired.push(s),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    deliveries.length = 0;
    requests.length = 0;
    const firesBefore = fired.length;

    // Same-permission redeploy with a textual change: listener re-reads,
    // membership unchanged → suppressed (no user callback), but the re-read
    // list RequestEvent is emitted, unattributed.
    env.deployRules(`${OPEN_RULES}\n// redeployed`);
    env.flushListeners();
    expect(fired.length).toBe(firesBefore); // no re-fire on identical view
    expect(deliveries).toEqual([]); // PIN: re-eval path emits no delivery events
    expect(requests).toEqual([{ method: 'list', path: 'rooms', triggeredBy: undefined }]);
    offD();
    offR();
    unsub();
  });
});
