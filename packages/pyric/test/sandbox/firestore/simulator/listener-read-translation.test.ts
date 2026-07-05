/**
 * FS-B10 — read-path translation on the `onSnapshot` listener path.
 *
 * The single-doc `getDoc` / query `getDocs` paths translate stored values
 * to the compat shape (`Timestamp` `{seconds, nanoseconds}`). The listener
 * snapshot builders did NOT, so a listener's `snap.data().createdAt` leaked
 * the rules-internal `Timestamp` (`{seconds, nanos}`, a `typeName` field,
 * no `nanoseconds`) — a drop-in consumer reading `.nanoseconds` off a
 * listener doc got `undefined` where `getDoc` worked.
 *
 * These probes assert the listener `.data()` shape now matches `getDoc`.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { Timestamp as CompatTimestamp } from 'pyric/sandbox/admin-compat';

const OPEN =
  "rules_version = '2'; service cloud.firestore {" +
  '  match /databases/{db}/documents {' +
  '    match /{document=**} { allow read, write: if true; }' +
  '  }' +
  '}';

function envWith(documents: Record<string, Record<string, unknown>>) {
  const env = new LocalEnvironment();
  env.seed({ rules: OPEN, documents });
  return env;
}

describe('FS-B10 — doc listener .data() uses the compat Timestamp shape', () => {
  test('serverTimestamp-resolved field reads back as {seconds, nanoseconds}', () => {
    const env = envWith({});
    env.execute({
      method: 'create', path: 'logs/l1', auth: { uid: 'u' },
      data: { at: { __type: 'serverTimestamp' } },
    });
    let snap: { data(): Record<string, unknown> | undefined } | undefined;
    env.addSnapshotListener(
      { kind: 'doc', path: 'logs/l1' },
      (s) => { snap = s as typeof snap; },
      {},
      { uid: 'u' },
    );
    const at = snap!.data()!.at as { seconds: number; nanoseconds: number };
    expect(at).toBeInstanceOf(CompatTimestamp);
    expect(typeof at.nanoseconds).toBe('number'); // pre-fix: undefined
    // The rules-internal leak fields are gone.
    expect((at as Record<string, unknown>).nanos).toBeUndefined();
    expect((at as Record<string, unknown>).typeName).toBeUndefined();
  });

  test('matches the single-doc getDoc shape exactly', () => {
    const env = envWith({});
    env.execute({
      method: 'create', path: 'logs/l1', auth: { uid: 'u' },
      data: { at: { __type: 'serverTimestamp' } },
    });
    // getDoc-equivalent: silent read + compat snapshot via the doc-ref path.
    const direct = env.getDocument('logs/l1')!.at; // raw internal
    let snap: { data(): Record<string, unknown> | undefined } | undefined;
    env.addSnapshotListener(
      { kind: 'doc', path: 'logs/l1' },
      (s) => { snap = s as typeof snap; },
      {},
      { uid: 'u' },
    );
    const listenerAt = snap!.data()!.at as CompatTimestamp;
    // The listener value carries the same instant as the stored value, in
    // the compat class.
    expect(listenerAt).toBeInstanceOf(CompatTimestamp);
    expect(listenerAt.toMillis()).toBe(
      (direct as { toMillis(): number }).toMillis(),
    );
  });
});

describe('FS-B10 — query listener docs translate too', () => {
  test('each doc in a query snapshot exposes the compat Timestamp shape', () => {
    const env = envWith({});
    env.execute({
      method: 'create', path: 'events/e1', auth: { uid: 'u' },
      data: { at: { __type: 'serverTimestamp' } },
    });
    let snap: { docs: Array<{ data(): Record<string, unknown> }> } | undefined;
    env.addSnapshotListener(
      { kind: 'query', collection: 'events' },
      (s) => { snap = s as typeof snap; },
      {},
      { uid: 'u' },
    );
    const at = snap!.docs[0].data().at as { nanoseconds: number };
    expect(at).toBeInstanceOf(CompatTimestamp);
    expect(typeof at.nanoseconds).toBe('number');
  });
});
