import { readFileSync } from 'node:fs';
import { cert, deleteApp, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import {
  FieldPath,
  getFirestore,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import type { Probe } from '../../rigs/types.ts';

type SnapshotWithGet = Pick<DocumentSnapshot, 'get'> | Pick<QueryDocumentSnapshot, 'get'>;

function view(snapshot: SnapshotWithGet): Record<string, unknown> {
  return {
    getType: typeof snapshot.get,
    topLevel: snapshot.get('topLevel'),
    dottedString: snapshot.get('nested.value'),
    dottedFieldPath: snapshot.get(new FieldPath('nested', 'value')),
    literalDotFieldPath: snapshot.get(new FieldPath('literal.with.dot')),
    literalDotAsStringTraverses: snapshot.get('literal.with.dot'),
    missingFieldIsUndefined: snapshot.get('nested.missing') === undefined,
    scalarIntermediateIsUndefined: snapshot.get('topLevel.child') === undefined,
  };
}

function captureThrow(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
    return { threw: false };
  } catch (error) {
    const value = error as { name?: unknown; code?: unknown; message?: unknown };
    return {
      threw: true,
      name: typeof value.name === 'string' ? value.name : null,
      code: typeof value.code === 'string' ? value.code : null,
      message: typeof value.message === 'string' ? value.message : String(error),
    };
  }
}

async function firstSnapshot<T>(
  subscribe: (
    next: (snapshot: T) => void,
    error: (error: unknown) => void,
  ) => () => void,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let unsubscribe = (): void => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for the initial Firestore listener snapshot'));
    }, 15_000);
    unsubscribe = subscribe(
      (snapshot) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(snapshot);
      },
      (error) => {
        clearTimeout(timeout);
        unsubscribe();
        reject(error);
      },
    );
  });
}

export const probe: Probe = {
  description:
    'firebase-admin DocumentSnapshot.get(fieldPath) behavior across one-shot document/query reads, transaction document/query reads, and document/query listeners, including missing fields/documents, dotted strings, literal-dot FieldPath segments, and invalid path validation.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    const serviceAccountPath = process.env.PYRIC_ORACLE_SA_PATH;
    if (!serviceAccountPath) {
      throw new Error('PYRIC_ORACLE_SA_PATH is required for the admin Firestore oracle probe');
    }
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8')) as ServiceAccount;
    const app = initializeApp(
      { credential: cert(serviceAccount) },
      `admin-firestore-get-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const db = getFirestore(app);
    const collection = db.collection(`pyric_oracle/admin_snapshot_get_${Date.now()}/documents`);
    const doc = collection.doc('present');
    const missing = collection.doc('missing');
    const data = {
      topLevel: 'top-level',
      nested: { value: 'nested-value' },
      literal: { with: { dot: 'nested-dot-value' } },
      'literal.with.dot': 'literal-dot-value',
      probeKind: 'document-snapshot-get',
    };

    try {
      await doc.set(data);

      const oneShotDocument = await doc.get();
      const oneShotQuery = await collection.where('probeKind', '==', data.probeKind).get();
      const transaction = await db.runTransaction(async (tx) => {
        const transactionDocument = await tx.get(doc);
        const transactionQuery = await tx.get(
          collection.where('probeKind', '==', data.probeKind),
        );
        return {
          document: view(transactionDocument),
          queryDocument: view(transactionQuery.docs[0]!),
        };
      });
      const listenerDocument = await firstSnapshot<DocumentSnapshot>((next, error) =>
        doc.onSnapshot(next, error),
      );
      const listenerQuery = await firstSnapshot<
        FirebaseFirestore.QuerySnapshot
      >((next, error) => collection.where('probeKind', '==', data.probeKind).onSnapshot(next, error));
      const missingDocument = await missing.get();

      return {
        oneShotDocument: view(oneShotDocument),
        oneShotQueryDocument: view(oneShotQuery.docs[0]!),
        transactionDocument: transaction.document,
        transactionQueryDocument: transaction.queryDocument,
        listenerDocument: view(listenerDocument),
        listenerQueryDocument: view(listenerQuery.docs[0]!),
        missingDocument: {
          exists: missingDocument.exists,
          dataIsUndefined: missingDocument.data() === undefined,
          getIsUndefined: missingDocument.get('anything') === undefined,
        },
        invalidPaths: {
          empty: captureThrow(() => oneShotDocument.get('')),
          leadingDot: captureThrow(() => oneShotDocument.get('.nested')),
          trailingDot: captureThrow(() => oneShotDocument.get('nested.')),
          doubleDot: captureThrow(() => oneShotDocument.get('nested..value')),
          forbiddenCharacter: captureThrow(() => oneShotDocument.get('nested[value]')),
          omitted: captureThrow(() => oneShotDocument.get(undefined as never)),
          wrongType: captureThrow(() => oneShotDocument.get(42 as never)),
        },
      };
    } finally {
      await doc.delete().catch(() => undefined);
      await missing.delete().catch(() => undefined);
      await deleteApp(app);
    }
  },
};
