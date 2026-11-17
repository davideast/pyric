/**
 * Executes a `Sequence` against a single plane (`sandbox` or `hosted`) and
 * records every observable outcome: per-step return value or error code,
 * ordered live-listener snapshots (including `docChanges()`), quiescent client
 * state across default/named database handles, Admin cross-read state, and
 * bundle round-trip state.
 */

import { mintCustomToken } from 'pyric/sandbox/internal';
import type { StepOutcome, Trace } from './compare.js';
import {
  buildQuery,
  serializeDocSnapshot,
  serializeQuerySnapshot,
} from './query-builder.js';
import {
  DATABASE_IDS,
  KNOWN_COLLECTION_PATHS,
  RULES_POOL,
  type BatchMutation,
  type Sequence,
  type SetMode,
  type Step,
  type TxnScript,
  type UpdateEntry,
} from './sequence.js';
import {
  canonicalizeReadValue,
  materializeFieldPath,
  materializeValue,
  type ValueBuilders,
} from './value-serialize.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

export interface FirestoreSurface {
  getFirestore: AnyFn;
  initializeFirestore: AnyFn;
  doc: AnyFn;
  collection: AnyFn;
  collectionGroup: AnyFn;
  setDoc: AnyFn;
  updateDoc: AnyFn;
  deleteDoc: AnyFn;
  addDoc: AnyFn;
  getDoc: AnyFn;
  getDocs: AnyFn;
  onSnapshot: AnyFn;
  writeBatch: AnyFn;
  runTransaction: AnyFn;
  query: AnyFn;
  where: AnyFn;
  and: AnyFn;
  or: AnyFn;
  orderBy: AnyFn;
  limit: AnyFn;
  limitToLast: AnyFn;
  startAt: AnyFn;
  startAfter: AnyFn;
  endAt: AnyFn;
  endBefore: AnyFn;
  documentId: AnyFn;
  FieldPath: new (...segments: string[]) => unknown;
  Bytes: { fromUint8Array(bytes: Uint8Array): unknown };
  GeoPoint: new (latitude: number, longitude: number) => unknown;
  Timestamp: new (seconds: number, nanoseconds: number) => unknown;
  deleteField: AnyFn;
  serverTimestamp: AnyFn;
  increment: AnyFn;
  arrayUnion: AnyFn;
  arrayRemove: AnyFn;
}

export interface AuthSurface {
  getAuth: AnyFn;
  signInWithCustomToken: AnyFn;
  signInAnonymously: AnyFn;
  signOut: AnyFn;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface PlaneSession {
  firestore: FirestoreSurface;
  auth: AuthSurface;
  app: unknown;
  setRules(rulesSource: string): Promise<void>;
  readAdminState(extraPaths: readonly string[]): Promise<Record<string, unknown>>;
  verifyBundleRoundTrip(extraPaths: readonly string[]): Promise<Record<string, unknown>>;
  settle(hasActiveListeners?: boolean): Promise<void>;
  close(): Promise<void>;
}

const INTENTIONAL_TX_ABORT = 'DIFF_INTENTIONAL_TX_ABORT';

export function formatErrorOutcome(error: unknown): string {
  if (error instanceof Error && error.message === INTENTIONAL_TX_ABORT) {
    return 'user-abort';
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) {
    return `code=${code}`;
  }
  if (error instanceof TypeError) {
    return 'TypeError';
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name === 'string' && name.length > 0) {
    return `name=${name}`;
  }
  return `error=${String(error).slice(0, 80)}`;
}

function makeSetOptions(builders: ValueBuilders, mode: SetMode): Record<string, unknown> | undefined {
  if (mode.kind === 'replace') {
    return undefined;
  }
  if (mode.kind === 'merge') {
    return { merge: true };
  }
  return {
    mergeFields: mode.fields.map((field) => materializeFieldPath(builders, field)) as Array<string | object>,
  };
}

function buildUpdateObject(builders: ValueBuilders, updates: readonly UpdateEntry[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const entry of updates) {
    let key: string;
    if (typeof entry.field === 'string') {
      key = entry.field;
    } else {
      key = entry.field.segments.join('.');
    }
    payload[key] = materializeValue(builders, entry.value);
  }
  return payload;
}

function buildUpdatePairArgs(builders: ValueBuilders, updates: readonly UpdateEntry[]): unknown[] {
  const args: unknown[] = [];
  for (const entry of updates) {
    args.push(materializeFieldPath(builders, entry.field));
    args.push(materializeValue(builders, entry.value));
  }
  return args;
}

async function applyBatchMutation(
  batch: { set: AnyFn; update: AnyFn; delete: AnyFn },
  fs: FirestoreSurface,
  builders: ValueBuilders,
  dbHandle: unknown,
  mutation: BatchMutation,
): Promise<void> {
  const ref = fs.doc(dbHandle, mutation.path);
  if (mutation.kind === 'set') {
    const data = materializeValue(builders, mutation.data);
    const opts = makeSetOptions(builders, mutation.mode);
    if (opts === undefined) {
      batch.set(ref, data);
    } else {
      batch.set(ref, data, opts);
    }
    return;
  }
  if (mutation.kind === 'update') {
    if (mutation.style === 'object') {
      batch.update(ref, buildUpdateObject(builders, mutation.updates));
    } else {
      const pairArgs = buildUpdatePairArgs(builders, mutation.updates);
      batch.update(ref, ...pairArgs);
    }
    return;
  }
  batch.delete(ref);
}

async function runTxnScript(
  fs: FirestoreSurface,
  builders: ValueBuilders,
  dbHandle: unknown,
  paths: readonly string[],
  script: TxnScript,
  auxData: unknown,
  auxUpdates: readonly UpdateEntry[],
): Promise<unknown> {
  const primaryPath = paths[0] ?? 'items/i1';
  const secondaryPath = paths[1] ?? 'items/i2';
  const primaryRef = fs.doc(dbHandle, primaryPath);
  const secondaryRef = fs.doc(dbHandle, secondaryPath);

  return fs.runTransaction(dbHandle, async (tx: {
    get: AnyFn;
    set: AnyFn;
    update: AnyFn;
    delete: AnyFn;
  }) => {
    if (script === 'conditionalIncrement') {
      const snap = await tx.get(primaryRef);
      if (snap.exists()) {
        const prev = snap.data()?.n;
        let nextN = 1;
        if (typeof prev === 'number' && Number.isFinite(prev)) {
          nextN = prev + 1;
        }
        tx.update(primaryRef, { n: nextN, touchedByTx: true });
        return { mode: 'updated', nextN };
      }
      tx.set(primaryRef, { n: 1, label: 'tx-created', flag: true });
      return { mode: 'created', nextN: 1 };
    }

    if (script === 'readTwoSwap') {
      const firstSnap = await tx.get(primaryRef);
      const secondSnap = await tx.get(secondaryRef);
      let firstN = 0;
      if (firstSnap.exists() && typeof firstSnap.data()?.n === 'number') {
        firstN = firstSnap.data().n;
      }
      let secondN = 0;
      if (secondSnap.exists() && typeof secondSnap.data()?.n === 'number') {
        secondN = secondSnap.data().n;
      }
      tx.set(primaryRef, { n: secondN, swapped: true }, { merge: true });
      if (secondSnap.exists()) {
        tx.update(secondaryRef, 'n', firstN);
      } else {
        tx.set(secondaryRef, { n: firstN, flag: false });
      }
      return { firstN, secondN };
    }

    if (script === 'deleteThenSet') {
      const before = await tx.get(primaryRef);
      const existed = before.exists();
      tx.delete(primaryRef);
      tx.set(primaryRef, auxData);
      return { existed };
    }

    if (script === 'setThenUpdate') {
      await tx.get(primaryRef);
      tx.set(primaryRef, auxData);
      const pairArgs = buildUpdatePairArgs(builders, auxUpdates);
      tx.update(primaryRef, ...pairArgs);
      return { updated: auxUpdates.length };
    }

    if (script === 'abortAfterWrites') {
      await tx.get(primaryRef);
      tx.set(primaryRef, auxData);
      throw new Error(INTENTIONAL_TX_ABORT);
    }

    tx.set(primaryRef, auxData);
    await tx.get(secondaryRef);
    return { unexpected: true };
  });
}

export async function runSequence(sequence: Sequence, session: PlaneSession): Promise<Trace> {
  const fs = session.firestore;
  const auth = session.auth;
  const handles = DATABASE_IDS.map((databaseId, idx) => {
    if (idx === 0) {
      return fs.getFirestore(session.app);
    }
    if (idx === 1) {
      return fs.getFirestore(session.app, databaseId);
    }
    return fs.initializeFirestore(session.app, {}, databaseId);
  });

  const handleAt = (dbIndex: number): unknown => handles[dbIndex] ?? handles[0];
  const authHandle = auth.getAuth(session.app);

  const builders: ValueBuilders = {
    makeBytes: (bytes) => fs.Bytes.fromUint8Array(bytes),
    makeGeoPoint: (lat, lng) => new fs.GeoPoint(lat, lng),
    makeTimestamp: (sec, nano) => new fs.Timestamp(sec, nano),
    makeDocRef: (dbIdx, path) => fs.doc(handleAt(dbIdx), path),
    makeFieldPath: (segments) => new fs.FieldPath(...segments),
    makeDocumentId: () => fs.documentId(),
    deleteField: () => fs.deleteField(),
    serverTimestamp: () => fs.serverTimestamp(),
    increment: (delta) => fs.increment(delta),
    arrayUnion: (...elements) => fs.arrayUnion(...elements),
    arrayRemove: (...elements) => fs.arrayRemove(...elements),
  };

  const initialRuleSource = RULES_POOL[sequence.initialRules] ?? RULES_POOL[0] ?? '';
  await session.setRules(initialRuleSource);

  const steps: StepOutcome[] = [];
  const events: Record<string, unknown[]> = {};
  const listeners = new Map<number, () => void>();
  const anonymousUids: string[] = [];
  const autoIds: string[] = [];
  const autoDocPaths: string[] = [];

  for (const step of sequence.steps) {
    const hadListenersBefore = listeners.size > 0;
    try {
      const outcome = await executeStep(
        step,
        session,
        handleAt,
        authHandle,
        builders,
        events,
        listeners,
        anonymousUids,
        autoIds,
        autoDocPaths,
      );
      steps.push({ ok: outcome });
    } catch (error) {
      steps.push({ error: formatErrorOutcome(error) });
    }
    if (hadListenersBefore || listeners.size > 0) {
      await session.settle(true);
    }
  }

  const hadEndListeners = listeners.size > 0;
  for (const unsubscribe of listeners.values()) {
    unsubscribe();
  }
  listeners.clear();
  if (hadEndListeners) {
    await session.settle(true);
  }

  const openRules = RULES_POOL[0] ?? '';
  await session.setRules(openRules);

  const allCollections = [...KNOWN_COLLECTION_PATHS, 'orgs/o1/logs', 'orgs/o2/logs'];
  const clientData = await Promise.all(
    handles.map(async (_unused, dbIdx) => {
      const dbHandle = handleAt(dbIdx);
      const collectionsToScan = dbIdx === 0 ? allCollections : ['items', 'orgs/o1/docs'];
      const snaps = await Promise.all(
        collectionsToScan.map((collectionPath) => fs.getDocs(fs.collection(dbHandle, collectionPath))),
      );
      const byPath: Record<string, unknown> = {};
      for (const snap of snaps) {
        for (const docSnap of snap.docs) {
          byPath[docSnap.ref.path] = canonicalizeReadValue(docSnap.data());
        }
      }
      return byPath;
    }),
  );

  const adminData = await session.readAdminState(autoDocPaths);
  const bundleData = await session.verifyBundleRoundTrip(autoDocPaths);

  return {
    seed: sequence.seed,
    steps,
    events,
    clientData,
    adminData,
    bundleData,
    anonymousUids,
    autoIds,
  };
}

async function executeStep(
  step: Step,
  session: PlaneSession,
  handleAt: (dbIndex: number) => unknown,
  authHandle: unknown,
  builders: ValueBuilders,
  events: Record<string, unknown[]>,
  listeners: Map<number, () => void>,
  anonymousUids: string[],
  autoIds: string[],
  autoDocPaths: string[],
): Promise<unknown> {
  const fs = session.firestore;
  const auth = session.auth;

  switch (step.op) {
    case 'setDoc': {
      const ref = fs.doc(handleAt(step.db), step.path);
      const data = materializeValue(builders, step.data);
      const opts = makeSetOptions(builders, step.mode);
      if (opts === undefined) {
        await fs.setDoc(ref, data);
      } else {
        await fs.setDoc(ref, data, opts);
      }
      return null;
    }

    case 'updateDoc': {
      const ref = fs.doc(handleAt(step.db), step.path);
      if (step.style === 'object') {
        await fs.updateDoc(ref, buildUpdateObject(builders, step.updates));
      } else {
        const pairArgs = buildUpdatePairArgs(builders, step.updates);
        await fs.updateDoc(ref, ...pairArgs);
      }
      return null;
    }

    case 'deleteDoc': {
      await fs.deleteDoc(fs.doc(handleAt(step.db), step.path));
      return null;
    }

    case 'addDoc': {
      const colRef = fs.collection(handleAt(step.db), step.collectionPath);
      const data = materializeValue(builders, step.data);
      const created = await fs.addDoc(colRef, data);
      autoIds.push(String(created.id));
      autoDocPaths.push(String(created.path));
      return { id: String(created.id), path: String(created.path) };
    }

    case 'writeBatch': {
      const batch = fs.writeBatch(handleAt(step.db));
      for (const mutation of step.mutations) {
        await applyBatchMutation(batch, fs, builders, handleAt(step.db), mutation);
      }
      await batch.commit();
      if (step.postCommitWrite === true) {
        let postCommitError = 'allowed';
        try {
          batch.delete(fs.doc(handleAt(step.db), 'items/i1'));
        } catch (err) {
          postCommitError = formatErrorOutcome(err);
        }
        return { committed: true, postCommitError };
      }
      return { committed: true };
    }

    case 'runTransaction': {
      const auxData = materializeValue(builders, step.auxData);
      return runTxnScript(
        fs,
        builders,
        handleAt(step.db),
        step.paths,
        step.script,
        auxData,
        step.auxUpdates,
      );
    }

    case 'getDoc': {
      const snap = await fs.getDoc(fs.doc(handleAt(step.db), step.path));
      return serializeDocSnapshot(snap);
    }

    case 'getDocs': {
      const builtQuery = await buildQuery(fs, builders, handleAt(step.db), step.query);
      const snap = await fs.getDocs(builtQuery);
      return serializeQuerySnapshot(snap);
    }

    case 'listenDoc': {
      const key = `L${step.id} doc db${step.db} ${step.path}`;
      const log: unknown[] = [];
      events[key] = log;
      const unsub = fs.onSnapshot(
        fs.doc(handleAt(step.db), step.path),
        (snap: Parameters<typeof serializeDocSnapshot>[0]) => {
          log.push({ kind: 'doc', snap: serializeDocSnapshot(snap) });
        },
        (err: unknown) => {
          log.push({ kind: 'error', error: formatErrorOutcome(err) });
        },
      );
      listeners.set(step.id, unsub);
      return null;
    }

    case 'listenQuery': {
      let sourceLabel = '';
      if (step.query.source.kind === 'collection') {
        sourceLabel = step.query.source.path;
      } else {
        sourceLabel = `group:${step.query.source.collectionId}`;
      }
      const key = `L${step.id} query db${step.db} ${sourceLabel}`;
      const log: unknown[] = [];
      events[key] = log;
      const builtQuery = await buildQuery(fs, builders, handleAt(step.db), step.query);
      const unsub = fs.onSnapshot(
        builtQuery,
        (snap: Parameters<typeof serializeQuerySnapshot>[0]) => {
          log.push({ kind: 'query', snap: serializeQuerySnapshot(snap) });
        },
        (err: unknown) => {
          log.push({ kind: 'error', error: formatErrorOutcome(err) });
        },
      );
      listeners.set(step.id, unsub);
      return null;
    }

    case 'unlisten': {
      const unsub = listeners.get(step.id);
      if (unsub !== undefined) {
        unsub();
        listeners.delete(step.id);
      }
      return null;
    }

    case 'signIn': {
      const tokenInput: { uid: string; claims?: Record<string, unknown> } = { uid: step.uid };
      if (step.claims !== undefined) {
        tokenInput.claims = step.claims;
      }
      const cred = await auth.signInWithCustomToken(authHandle, mintCustomToken(tokenInput));
      return cred.user.uid;
    }

    case 'signInAnonymously': {
      const cred = await auth.signInAnonymously(authHandle);
      const uid = String(cred.user.uid);
      anonymousUids.push(uid);
      return uid;
    }

    case 'signOut': {
      await auth.signOut(authHandle);
      return null;
    }

    case 'refreshToken': {
      const user = (authHandle as { currentUser: { getIdToken(force: boolean): Promise<string> } | null }).currentUser;
      if (user === null) {
        return 'no-user';
      }
      await user.getIdToken(true);
      return 'refreshed';
    }

    case 'rules': {
      const ruleSource = RULES_POOL[step.rules] ?? RULES_POOL[0] ?? '';
      await session.setRules(ruleSource);
      return null;
    }
  }
}
