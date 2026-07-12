/**
 * Browser-bundle probe entry — imports the SDK's package-root surface
 * the way a browser app would, then runs the same assertion sequence
 * as `examples/admin-compat/sample.ts`. The file is bundled by Vite
 * with `target: 'es2022'` and `platform: browser` (default). If the
 * bundler can produce a Node-built-in-free bundle and the bundle's
 * assertions pass when imported as ESM, Slice A's gate A5 is green.
 */
import {
  LocalEnvironment,
  createCompatFirestore,
  FirestoreCompatError,
  FieldValue,
  Timestamp,
} from 'pyric/sandbox/admin-compat';
declare global {
  // The probe runner sets this; we publish into it so the bundle can
  // report per-step status back to the harness.
  // eslint-disable-next-line no-var
  var __probeReport: (line: string) => void;
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
function assertTrue(cond: unknown, label: string): void {
  if (!cond) throw new Error(label);
}

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tickets/{id} {
      allow read: if request.auth != null
        && (request.auth.uid == resource.data.assigneeId
            || request.auth.uid == resource.data.reporterId);
      allow create: if request.auth != null
        && request.auth.uid == request.resource.data.reporterId;
      allow update, delete: if request.auth != null
        && request.auth.uid == resource.data.assigneeId;
    }
  }
}`;

export async function runProbe(): Promise<void> {
  const log = globalThis.__probeReport ?? (() => {});

  const env = new LocalEnvironment();
  env.seed({
    rules: RULES,
    documents: {
      'tickets/T-1': { title: 'Set up CI', reporterId: 'alice', assigneeId: 'bob',   status: 'open', priority: 1 },
      'tickets/T-2': { title: 'Fix login', reporterId: 'alice', assigneeId: 'alice', status: 'open', priority: 2 },
    },
  });
  const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
  const asBob = { auth: { uid: 'bob' } };

  // 1. Single-doc reads + per-op auth + typed denial.
  const t1 = await db.doc('tickets/T-1').get();
  assertEq(t1.data()!.title, 'Set up CI', '1a alice reads T-1');
  const t1ByBob = await db.doc('tickets/T-1').get(asBob);
  assertEq(t1ByBob.data()!.title, 'Set up CI', '1b bob reads T-1');
  let denied: unknown;
  try { await db.doc('tickets/T-1').get({ auth: { uid: 'carol' } }); } catch (e) { denied = e; }
  assertTrue(denied instanceof FirestoreCompatError, '1c denied is FirestoreCompatError');
  assertEq((denied as FirestoreCompatError).code, 'permission-denied', '1c code');
  log('1. single-doc reads + denial — ok');

  // 2. Auto-id add.
  const newRef = await db.collection('tickets').add(
    { title: 'Q', reporterId: 'bob', assigneeId: 'bob', status: 'open', priority: 3 },
    asBob,
  );
  assertTrue(/^[A-Za-z0-9]+$/.test(newRef.id), '2 auto-id shape');
  log('2. collection.add (auto-id) — ok');

  // 3. Query.
  const open = await db.collection('tickets').where('status', '==', 'open').orderBy('priority').limit(5).get();
  assertEq(open.size, 3, '3 open tickets count');
  log('3. query where/orderBy/limit — ok');

  // 4. Batch.
  const b = db.batch();
  b.update(db.doc('tickets/T-1'), { status: 'in-progress' });
  b.update(db.doc(newRef.path),    { status: 'in-progress' });
  await b.commit(asBob);
  log('4. WriteBatch — ok');

  // 5. Transaction.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(db.doc('tickets/T-1'));
    tx.update(db.doc('tickets/T-1'), { priority: (snap.data()!.priority as number) + 1 });
  }, asBob);
  const bumped = await db.doc('tickets/T-1').get(asBob);
  assertEq(bumped.data()!.priority, 2, '5 tx bumped priority');
  log('5. runTransaction — ok');

  // 6. Sentinel → Timestamp.
  await db.doc('tickets/T-2').update({ touchedAt: FieldValue.serverTimestamp() });
  const t2 = await db.doc('tickets/T-2').get();
  assertTrue(t2.data()!.touchedAt instanceof Timestamp, '6 Timestamp instance');
  log('6. serverTimestamp → Timestamp — ok');

  // 7. Atomic batch denial + rollback.
  let batchErr: unknown;
  const bad = db.batch();
  bad.update(db.doc('tickets/T-1'), { priority: 99 });
  bad.update(db.doc('tickets/T-2'), { priority: 99 });
  try { await bad.commit(asBob); } catch (e) { batchErr = e; }
  assertTrue(batchErr instanceof FirestoreCompatError, '7a batch err shape');
  const t1Final = await db.doc('tickets/T-1').get(asBob);
  assertEq(t1Final.data()!.priority, 2, '7b rollback verified');
  log('7. atomic batch denial + rollback — ok');
}
