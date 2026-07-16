/**
 * Characterization pins — listener re-evaluation on rules changes
 * (deployRules) and session-auth changes (reevaluateLiveListeners).
 *
 * Key pinned facts of the CURRENT implementation:
 *  - deployRules re-evaluates every active listener SYNCHRONOUSLY (no
 *    flushListeners needed for the resulting callbacks).
 *  - allow→deny surfaces through the listener's errorCallback AND the
 *    env-level onSnapshotError channel; onListenerLifecycle never emits a
 *    `listener_errored` event (only attach/detach).
 *  - deny→allow resumes the listener with a fresh snapshot, but that
 *    resume emits NO snapshot_delivery event.
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

const DENY_READ_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if false;
      allow write: if true;
    }
  }
}`;

const AUTH_READ_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if request.auth != null;
      allow write: if true;
    }
  }
}`;

describe('characterization: rules-flip listener re-evaluation', () => {
  test('allow→deny: errorCallback and onSnapshotError both fire, synchronously during deployRules; env-level channel fires FIRST', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const sequence: string[] = [];
    const offErr = env.onSnapshotError((err, target, listenerId) => {
      sequence.push(
        `env-error:${err.code}:${target.kind === 'doc' ? target.path : target.collection}:${listenerId}`,
      );
    });
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => sequence.push('data'),
      undefined,
      { uid: 'alice' },
      (err) => sequence.push(`listener-error:${(err as { code: string }).code}`),
    );
    env.flushListeners();
    expect(sequence).toEqual(['data']);
    sequence.length = 0;

    env.deployRules(DENY_READ_RULES);
    // PIN: synchronous — no flushListeners before asserting.
    expect(sequence).toEqual([
      'env-error:permission-denied:rooms/r1:0',
      'listener-error:permission-denied',
    ]);
    // PIN: the errored listener stays registered (errored, not detached).
    expect(env.getSnapshotListenerCount()).toBe(1);
    offErr();
    unsub();
  });

  test('onListenerLifecycle never emits listener_errored on a rules flip — only attach/detach exist in practice', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const phases: string[] = [];
    const offLc = env.onListenerLifecycle((e) => phases.push(e.kind));
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => {},
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    env.deployRules(DENY_READ_RULES); // errors the listener
    env.deployRules(OPEN_RULES); // recovers it
    env.flushListeners();
    unsub();
    // PIN: no `listener_errored` phase is ever emitted by LocalEnvironment.
    expect(phases).toEqual(['listener_attach', 'listener_detach']);
    offLc();
  });

  test('errored listener stops receiving write-driven snapshots', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const fired: unknown[] = [];
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (s) => fired.push(s),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    expect(fired.length).toBe(1);
    env.deployRules(DENY_READ_RULES);
    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    expect(fired.length).toBe(1); // stream is dead
    unsub();
  });

  test('deny→allow: the errored doc listener RESUMES with a fresh settled snapshot, synchronously, with NO snapshot_delivery event and no repeat error', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: DENY_READ_RULES, documents: { 'rooms/r1': { v: 7 } } });
    const fires: Array<{ v: unknown; pending: boolean }> = [];
    const errors: unknown[] = [];
    const deliveries: unknown[] = [];
    const offD = env.onSnapshotDelivery((e) => deliveries.push(e));
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (snap) => {
        const s = snap as {
          data(): Record<string, unknown> | undefined;
          metadata: { hasPendingWrites: boolean };
        };
        fires.push({ v: s.data()?.v, pending: s.metadata.hasPendingWrites });
      },
      undefined,
      { uid: 'alice' },
      (err) => errors.push(err),
    );
    env.flushListeners();
    expect(fires).toEqual([]);
    expect(errors.length).toBe(1);
    expect(deliveries.length).toBe(0);

    env.deployRules(OPEN_RULES);
    // PIN: resume fires synchronously with settled metadata…
    expect(fires).toEqual([{ v: 7, pending: false }]);
    // …but does NOT emit a snapshot_delivery event, and the error is not
    // re-delivered.
    expect(deliveries.length).toBe(0);
    expect(errors.length).toBe(1);

    // The resumed stream receives subsequent writes normally.
    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 8 } });
    env.flushListeners();
    expect(fires).toEqual([
      { v: 7, pending: false },
      { v: 8, pending: true },
    ]);
    expect(deliveries.length).toBe(1); // write-driven delivery IS evented
    offD();
    unsub();
  });

  test('re-deploying a denying ruleset on an already-errored listener does NOT re-deliver the error', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: DENY_READ_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const errors: unknown[] = [];
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => {},
      undefined,
      { uid: 'alice' },
      (err) => errors.push(err),
    );
    env.flushListeners();
    expect(errors.length).toBe(1);
    env.deployRules(`${DENY_READ_RULES}\n// still denying`);
    expect(errors.length).toBe(1); // once-per-stream error contract
    unsub();
  });

  test('query listener: allow→deny errors the stream; deny→allow resumes with every doc `added` (fresh baseline)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: OPEN_RULES,
      documents: { 'rooms/r1': { v: 1 }, 'rooms/r2': { v: 2 } },
    });
    const fires: Array<{ size: number; types: string[] }> = [];
    const errors: Array<{ code: string }> = [];
    const unsub = env.addSnapshotListener(
      { kind: 'query', collection: 'rooms' },
      (snap) => {
        const s = snap as {
          size: number;
          docChanges(): Array<{ type: string }>;
        };
        fires.push({ size: s.size, types: s.docChanges().map((c) => c.type) });
      },
      undefined,
      { uid: 'alice' },
      (err) => errors.push(err as { code: string }),
    );
    env.flushListeners();
    expect(fires).toEqual([{ size: 2, types: ['added', 'added'] }]);

    env.deployRules(DENY_READ_RULES);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe('permission-denied');

    env.deployRules(OPEN_RULES);
    // PIN: recovery re-fires with initial-fire semantics — both docs `added`.
    expect(fires).toEqual([
      { size: 2, types: ['added', 'added'] },
      { size: 2, types: ['added', 'added'] },
    ]);
    unsub();
  });

  test('deployRules with unchanged permissions and unchanged data does not fire listeners (suppressed re-eval, no suppressed event)', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const fired: unknown[] = [];
    const suppressed: unknown[] = [];
    const offS = env.onSnapshotSuppressed((e) => suppressed.push(e));
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (s) => fired.push(s),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    expect(fired.length).toBe(1);
    env.deployRules(`${OPEN_RULES}\n// cosmetic change`);
    env.flushListeners();
    expect(fired.length).toBe(1);
    // PIN: the rules-driven suppressed re-eval emits NO snapshot_suppressed
    // event (unlike a write-driven no-op, which does).
    expect(suppressed).toEqual([]);
    offS();
    unsub();
  });

  test('reevaluateLiveListeners: a live listener follows the session auth — sign-out errors it, sign-in resumes it; frozen listeners are untouched', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: AUTH_READ_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const liveEvents: string[] = [];
    const frozenEvents: string[] = [];
    // Live listener (followsCurrentUser = true), initially signed in.
    const uLive = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => liveEvents.push('data'),
      undefined,
      { uid: 'alice' },
      (err) => liveEvents.push(`error:${(err as { code: string }).code}`),
      true,
    );
    // Frozen listener pinned to alice.
    const uFrozen = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => frozenEvents.push('data'),
      undefined,
      { uid: 'alice' },
      (err) => frozenEvents.push(`error:${(err as { code: string }).code}`),
      false,
    );
    env.flushListeners();
    expect(liveEvents).toEqual(['data']);
    expect(frozenEvents).toEqual(['data']);

    // Sign out: live listener re-reads as null auth → permission-denied.
    env.reevaluateLiveListeners(null);
    expect(liveEvents).toEqual(['data', 'error:permission-denied']);
    expect(frozenEvents).toEqual(['data']); // untouched

    // Sign back in as bob: live listener resumes with a fresh snapshot,
    // synchronously.
    env.reevaluateLiveListeners({ uid: 'bob' });
    expect(liveEvents).toEqual(['data', 'error:permission-denied', 'data']);
    expect(frozenEvents).toEqual(['data']);
    uLive();
    uFrozen();
  });
});
