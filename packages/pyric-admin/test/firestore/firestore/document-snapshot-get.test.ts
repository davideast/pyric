import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import {
  FieldPath,
  getAdminFirestore,
  onSnapshot,
  type AdminDocumentSnapshot,
  type AdminQueryDocumentSnapshot,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from '../../../src/firestore/index.js';

const observation = (
  JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        '..',
        '..',
        'conformance',
        'observations',
        'firestore',
        'admin-firestore-document-snapshot-get.json',
      ),
      'utf8',
    ),
  ) as { behavior: Record<string, Record<string, unknown>> }
).behavior;

type SnapshotWithGet =
  | AdminDocumentSnapshot
  | AdminQueryDocumentSnapshot
  | DocumentSnapshot
  | QueryDocumentSnapshot;

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

describe('firebase-admin DocumentSnapshot.get(fieldPath) oracle parity — local arm', () => {
  it('replays one-shot, query, transaction, and listener snapshot behavior', async () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);
    const doc = db.doc('snapshot-get/present');
    await doc.set({
      topLevel: 'top-level',
      nested: { value: 'nested-value' },
      literal: { with: { dot: 'nested-dot-value' } },
      'literal.with.dot': 'literal-dot-value',
      probeKind: 'document-snapshot-get',
    });

    const oneShotDocument = await doc.get();
    const oneShotQuery = await db
      .collection('snapshot-get')
      .where('probeKind', '==', 'document-snapshot-get')
      .get();
    expect(view(oneShotDocument)).toEqual(observation.oneShotDocument);
    expect(view(oneShotQuery.docs[0]!)).toEqual(observation.oneShotQueryDocument);

    await db.runTransaction(async (tx) => {
      const transactionDocument = await tx.get(doc);
      const transactionQuery = await tx.get(
        db.collection('snapshot-get').where('probeKind', '==', 'document-snapshot-get'),
      );
      expect(view(transactionDocument)).toEqual(observation.transactionDocument);
      expect(view(transactionQuery.docs[0]!)).toEqual(observation.transactionQueryDocument);
    });

    const documentFires: DocumentSnapshot[] = [];
    const queryFires: QueryDocumentSnapshot[] = [];
    const unsubscribeDocument = onSnapshot(doc, (snapshot) => documentFires.push(snapshot));
    const unsubscribeQuery = onSnapshot(
      db.collection('snapshot-get').where('probeKind', '==', 'document-snapshot-get'),
      (snapshot) => queryFires.push(snapshot.docs[0]!),
    );
    getInternalEnv(sandbox).flushListeners();
    unsubscribeDocument();
    unsubscribeQuery();
    expect(view(documentFires[0]!)).toEqual(observation.listenerDocument);
    expect(view(queryFires[0]!)).toEqual(observation.listenerQueryDocument);
  });

  it('returns undefined for missing documents and replays path validation', async () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);
    const missing = await db.doc('snapshot-get/missing').get();
    expect({
      exists: missing.exists,
      dataIsUndefined: missing.data() === undefined,
      getIsUndefined: missing.get('anything') === undefined,
    }).toEqual(observation.missingDocument);

    await db.doc('snapshot-get/present').set({ nested: { value: 1 } });
    const present = await db.doc('snapshot-get/present').get();
    const invalid = observation.invalidPaths as Record<
      string,
      { threw: boolean; name: string; code: null; message: string }
    >;
    const cases: Record<string, () => unknown> = {
      empty: () => present.get(''),
      leadingDot: () => present.get('.nested'),
      trailingDot: () => present.get('nested.'),
      doubleDot: () => present.get('nested..value'),
      forbiddenCharacter: () => present.get('nested[value]'),
      omitted: () => present.get(undefined as never),
      wrongType: () => present.get(42 as never),
    };
    for (const [name, call] of Object.entries(cases)) {
      expect(call).toThrow(invalid[name]!.message);
    }
  });
});
