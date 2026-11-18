import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';

interface SentinelDocRefLike {
  readonly id: string;
  readonly path: string;
  set(data: Record<string, unknown>): Promise<unknown>;
  update(...args: unknown[]): Promise<unknown>;
  get(): Promise<{ readonly exists: boolean; readonly data: () => Record<string, unknown> | undefined }>;
}

interface SentinelCollectionRefLike {
  doc(docPath: string): SentinelDocRefLike;
  where(
    fieldPath: unknown,
    opStr: '==',
    value: unknown,
  ): {
    get(): Promise<{ readonly docs: readonly { readonly id: string }[] }>;
  };
}

interface TimestampLike {
  readonly seconds: number;
  readonly nanoseconds: number;
  toMillis(): number;
}

export interface FirestoreAdminSentinelsSubject {
  collection(collectionPath: string): SentinelCollectionRefLike;
  serverTimestamp(): unknown;
  increment(delta: number): unknown;
  arrayUnion(...elements: unknown[]): unknown;
  arrayRemove(...elements: unknown[]): unknown;
  deleteField(): unknown;
  createFieldPath(...fieldNames: string[]): unknown;
  documentIdFieldPath(): unknown;
  createTimestamp(seconds: number, nanoseconds: number): TimestampLike;
  isTimestamp(value: unknown): value is TimestampLike;
  readBytes(value: unknown): readonly number[] | null;
  readDocRefPath(value: unknown): { readonly id: string; readonly path: string } | null;
}

function threwSynchronously(operation: () => unknown): boolean {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
}

export async function observeFirestoreAdminSentinelsAndValues(
  subject: FirestoreAdminSentinelsSubject,
  baseDocPath: string,
): Promise<Record<string, unknown>> {
  const col = subject.collection(`${baseDocPath}/values`);
  const targetRef = col.doc('ref-target');
  await targetRef.set({ kind: 'target' });

  const fixedTs = subject.createTimestamp(1_700_000_123, 456_000_000);
  const rawBytes = Uint8Array.from([0, 1, 127, 255]);

  const docRef = col.doc('sentinel-doc');
  await docRef.set({
    createdAt: subject.serverTimestamp(),
    counter: subject.increment(5),
    tags: subject.arrayUnion('alpha', 'beta'),
    obsolete: 'remove-me',
    pinnedAt: fixedTs,
    payloadBytes: rawBytes,
    pointer: targetRef,
    'literal.dot': 'initial',
  });

  const initialSnap = await docRef.get();
  const initialData = initialSnap.data() ?? {};

  await docRef.update(
    'counter',
    subject.increment(-2),
    'tags',
    subject.arrayUnion('beta', 'gamma'),
    'obsolete',
    subject.deleteField(),
    subject.createFieldPath('literal.dot'),
    'updated-literal',
  );
  await docRef.update({
    tags: subject.arrayRemove('alpha'),
  });

  const updatedSnap = await docRef.get();
  const updatedData = updatedSnap.data() ?? {};

  const docIdQuerySnap = await col
    .where(subject.documentIdFieldPath(), '==', 'sentinel-doc')
    .get();

  const serverCreatedAt = initialData.createdAt;
  const serverTimestampResolved =
    subject.isTimestamp(serverCreatedAt) &&
    Number.isInteger(serverCreatedAt.seconds) &&
    serverCreatedAt.seconds > 0 &&
    Number.isInteger(serverCreatedAt.nanoseconds) &&
    serverCreatedAt.nanoseconds >= 0 &&
    serverCreatedAt.nanoseconds < 1_000_000_000;

  const pinnedRoundTrip = updatedData.pinnedAt;
  let timestampRoundTrip: Record<string, unknown> = { isTimestamp: false };
  if (subject.isTimestamp(pinnedRoundTrip)) {
    timestampRoundTrip = {
      isTimestamp: true,
      seconds: pinnedRoundTrip.seconds,
      nanoseconds: pinnedRoundTrip.nanoseconds,
      toMillis: pinnedRoundTrip.toMillis(),
    };
  }

  const storedBytes = subject.readBytes(updatedData.payloadBytes);
  const storedPointer = subject.readDocRefPath(updatedData.pointer);

  return {
    serverTimestampResolved,
    initialCounter: initialData.counter,
    updatedCounter: updatedData.counter,
    initialTags: initialData.tags,
    updatedTags: updatedData.tags,
    obsoletePresentInitially: 'obsolete' in initialData,
    obsoletePresentAfterDelete: 'obsolete' in updatedData,
    literalDotInitial: initialData['literal.dot'],
    literalDotUpdated: updatedData['literal.dot'],
    documentIdQueryIds: docIdQuerySnap.docs.map((doc) => doc.id),
    timestampRoundTrip,
    bytesRoundTrip: storedBytes,
    refRoundTrip: {
      isRef: storedPointer !== null,
      idMatches: storedPointer?.id === 'ref-target',
      pathMatchesTarget: storedPointer?.path === targetRef.path,
    },
    validation: {
      emptyFieldPathArgsThrows: threwSynchronously(() => subject.createFieldPath()),
      emptySegmentFieldPathThrows: threwSynchronously(() => subject.createFieldPath('')),
      negativeNanosThrows: threwSynchronously(() => subject.createTimestamp(0, -1)),
      billionNanosThrows: threwSynchronously(() => subject.createTimestamp(0, 1_000_000_000)),
      emptyIncrementArgsThrows: threwSynchronously(() =>
        (subject.increment as (...args: unknown[]) => unknown)(),
      ),
      emptyArrayUnionArgsThrows: threwSynchronously(() => subject.arrayUnion()),
      emptyArrayRemoveArgsThrows: threwSynchronously(() => subject.arrayRemove()),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['admin-firestore'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/firestore FieldValue.{serverTimestamp, increment, arrayUnion, arrayRemove, delete}, FieldPath and FieldPath.documentId(), Timestamp range validation and round-trip, Uint8Array byte buffers, and DocumentReference field values.',
  async observe(): Promise<Record<string, unknown>> {
    const [adminAppMod, fsMod] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
    ]);
    const sa = await loadOracleServiceAccount();
    const runId = `fs_admin_vals_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const app = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-${runId}`);
    const db = fsMod.getFirestore(app);
    const baseDocPath = `pyric_oracle/${runId}`;

    const subject: FirestoreAdminSentinelsSubject = {
      collection: (path) => db.collection(path) as unknown as SentinelCollectionRefLike,
      serverTimestamp: () => fsMod.FieldValue.serverTimestamp(),
      increment: (delta) => fsMod.FieldValue.increment(delta),
      arrayUnion: (...elements) => fsMod.FieldValue.arrayUnion(...elements),
      arrayRemove: (...elements) => fsMod.FieldValue.arrayRemove(...elements),
      deleteField: () => fsMod.FieldValue.delete(),
      createFieldPath: (...names) => new fsMod.FieldPath(...names),
      documentIdFieldPath: () => fsMod.FieldPath.documentId(),
      createTimestamp: (seconds, nanoseconds) => new fsMod.Timestamp(seconds, nanoseconds),
      isTimestamp: (value): value is TimestampLike => value instanceof fsMod.Timestamp,
      readBytes(value: unknown): readonly number[] | null {
        if (value instanceof Uint8Array) {
          return Array.from(value);
        }
        return null;
      },
      readDocRefPath(value: unknown) {
        if (
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { id?: unknown }).id === 'string' &&
          typeof (value as { path?: unknown }).path === 'string'
        ) {
          return {
            id: (value as { id: string }).id,
            path: (value as { path: string }).path,
          };
        }
        return null;
      },
    };

    try {
      return await observeFirestoreAdminSentinelsAndValues(subject, baseDocPath);
    } finally {
      await db.recursiveDelete(db.doc(baseDocPath)).catch(() => undefined);
      await adminAppMod.deleteApp(app).catch(() => undefined);
    }
  },
};
