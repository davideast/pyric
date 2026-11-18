import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';

interface CrudDocSnapshotLike {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface CrudDocRefLike {
  get(): Promise<CrudDocSnapshotLike>;
  create(data: Record<string, unknown>): Promise<unknown>;
  set(data: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  update(...args: unknown[]): Promise<unknown>;
  delete(): Promise<unknown>;
}

export type FirestoreCrudErrorCategory =
  | 'already-exists'
  | 'not-found'
  | 'invalid-argument'
  | 'other';

export interface FirestoreAdminCrudSubject {
  doc(docPath: string): CrudDocRefLike;
  createFieldPath(...fieldNames: string[]): unknown;
  classifyError(err: unknown): FirestoreCrudErrorCategory;
}

export function classifyGrpcOrStringFirestoreError(err: unknown): FirestoreCrudErrorCategory {
  if (typeof err !== 'object' || err === null) {
    return 'other';
  }
  const code = (err as { code?: unknown }).code;
  if (code === 6 || code === 'already-exists') {
    return 'already-exists';
  }
  if (code === 5 || code === 'not-found') {
    return 'not-found';
  }
  if (code === 3 || code === 'invalid-argument') {
    return 'invalid-argument';
  }
  return 'other';
}

async function captureRejectedCategory(
  subject: FirestoreAdminCrudSubject,
  operation: () => Promise<unknown>,
): Promise<{ readonly rejected: boolean; readonly category: FirestoreCrudErrorCategory | null }> {
  try {
    await operation();
    return { rejected: false, category: null };
  } catch (err) {
    return { rejected: true, category: subject.classifyError(err) };
  }
}

export async function observeFirestoreAdminCrud(
  subject: FirestoreAdminCrudSubject,
  baseDocPath: string,
): Promise<Record<string, unknown>> {
  const missingRef = subject.doc(`${baseDocPath}/items/never-created`);
  const missingInitial = await missingRef.get();

  const itemRef = subject.doc(`${baseDocPath}/items/item-1`);
  await itemRef.create({
    title: 'created',
    count: 1,
    keep: 'yes',
    'a.b': 'dot-1',
  });
  const afterCreateSnap = await itemRef.get();

  const duplicateCreate = await captureRejectedCategory(subject, () =>
    itemRef.create({ title: 'duplicate' }),
  );
  const afterDuplicateCreateSnap = await itemRef.get();
  const afterDuplicateData = afterDuplicateCreateSnap.data();

  await itemRef.set({
    title: 'replaced',
    extra: 'one',
    nested: { a: 1, b: 2 },
  });
  const afterReplaceSetSnap = await itemRef.get();

  await itemRef.set(
    {
      nested: { b: 20, c: 30 },
      mergedFlag: true,
    },
    { merge: true },
  );
  const afterMergeSetSnap = await itemRef.get();

  const literalKeyFieldPath = subject.createFieldPath('literal.key');
  await itemRef.set(
    {
      title: 'masked',
      extra: 'ignored-outside-mask',
      'literal.key': 'kept-mask',
    },
    { mergeFields: ['title', literalKeyFieldPath] },
  );
  const afterMergeFieldsSnap = await itemRef.get();

  await itemRef.update({ 'nested.a': 100 });
  const afterMapUpdateSnap = await itemRef.get();

  await itemRef.update('extra', 'two', literalKeyFieldPath, 'updated-literal');
  const afterVarargsUpdateSnap = await itemRef.get();

  const updateMissing = await captureRejectedCategory(subject, () =>
    missingRef.update({ title: 'nope' }),
  );

  await itemRef.delete();
  const afterDeleteSnap = await itemRef.get();

  const repeatDeleteExisting = await captureRejectedCategory(subject, () => itemRef.delete());
  const deleteNeverExisted = await captureRejectedCategory(subject, () => missingRef.delete());

  return {
    missingInitial: {
      exists: missingInitial.exists,
      dataIsUndefined: missingInitial.data() === undefined,
    },
    afterCreate: {
      exists: afterCreateSnap.exists,
      data: afterCreateSnap.data(),
    },
    duplicateCreate,
    unchangedAfterDuplicateCreate: afterDuplicateData?.title === 'created',
    afterReplaceSet: afterReplaceSetSnap.data(),
    afterMergeSet: afterMergeSetSnap.data(),
    afterMergeFields: afterMergeFieldsSnap.data(),
    afterMapUpdate: afterMapUpdateSnap.data(),
    afterVarargsUpdate: afterVarargsUpdateSnap.data(),
    updateMissing,
    afterDeleteExists: afterDeleteSnap.exists,
    idempotentDeleteAfterDelete: !repeatDeleteExisting.rejected,
    idempotentDeleteNeverExisted: !deleteNeverExisted.rejected,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['admin-firestore'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/firestore DocumentReference CRUD: get() on missing and existing docs, create() already-exists rejection, set() full replace vs merge vs mergeFields (including literal-dot FieldPath), update() map and variadic field/value pairs with missing-doc not-found rejection, and idempotent delete().',
  async observe(): Promise<Record<string, unknown>> {
    const [adminAppMod, fsMod] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
    ]);
    const sa = await loadOracleServiceAccount();
    const runId = `fs_admin_crud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const app = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-${runId}`);
    const db = fsMod.getFirestore(app);
    const baseDocPath = `pyric_oracle/${runId}`;

    const subject: FirestoreAdminCrudSubject = {
      doc: (path) => db.doc(path) as unknown as CrudDocRefLike,
      createFieldPath: (...names) => new fsMod.FieldPath(...names),
      classifyError: classifyGrpcOrStringFirestoreError,
    };

    try {
      return await observeFirestoreAdminCrud(subject, baseDocPath);
    } finally {
      await db.recursiveDelete(db.doc(baseDocPath)).catch(() => undefined);
      await adminAppMod.deleteApp(app).catch(() => undefined);
    }
  },
};
