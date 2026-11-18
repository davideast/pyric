import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#107',
  rowIds: ['firestore#107', 'firestore#108'],
  description:
    'documentId() and FieldPath (multi-segment nested vs single-segment literal dot) filter and sort documents accurately in where() and orderBy() queries using built-in single-field indexes.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const {
        FieldPath,
        collection,
        doc,
        documentId,
        getDocs,
        orderBy,
        query,
        setDoc,
        where,
      } = firestoreSdk;

      const items = collection(db, collectionPath('docid-fieldpath-queries'));
      await setDoc(doc(items, 'doc-b'), { meta: { tier: 20 }, 'meta.tier': 88 });
      await setDoc(doc(items, 'doc-d'), { meta: { tier: 20 }, 'meta.tier': 66 });
      await setDoc(doc(items, 'doc-a'), { meta: { tier: 10 }, 'meta.tier': 99 });
      await setDoc(doc(items, 'doc-c'), { meta: { tier: 30 }, 'meta.tier': 77 });

      const byStringIdSnap = await getDocs(query(items, where(documentId(), '==', 'doc-b')));
      const byRefIdSnap = await getDocs(
        query(items, where(documentId(), '==', doc(items, 'doc-c'))),
      );
      const byInIdsSnap = await getDocs(
        query(items, where(documentId(), 'in', ['doc-a', 'doc-d'])),
      );
      const byRangeIdsSnap = await getDocs(
        query(items, where(documentId(), '>=', 'doc-b'), orderBy(documentId(), 'asc')),
      );
      const byAscIdsSnap = await getDocs(query(items, orderBy(documentId(), 'asc')));

      const nestedPath = new FieldPath('meta', 'tier');
      const literalDotPath = new FieldPath('meta.tier');

      const nestedEqualSnap = await getDocs(query(items, where(nestedPath, '==', 20)));
      const literalDotEqualSnap = await getDocs(
        query(items, where(literalDotPath, '==', 88)),
      );
      const nestedDescSnap = await getDocs(query(items, orderBy(nestedPath, 'desc')));
      const nestedDescDocIdDescSnap = await getDocs(
        query(items, orderBy(nestedPath, 'desc'), orderBy(documentId(), 'desc')),
      );

      return {
        documentIdQueries: {
          equalStringIds: byStringIdSnap.docs.map((entry) => entry.id),
          equalDocRefIds: byRefIdSnap.docs.map((entry) => entry.id),
          inIdsSorted: byInIdsSnap.docs.map((entry) => entry.id).sort(),
          rangeGteIds: byRangeIdsSnap.docs.map((entry) => entry.id),
          orderByAscIds: byAscIdsSnap.docs.map((entry) => entry.id),
          nestedDescWithDocIdDescIds: nestedDescDocIdDescSnap.docs.map(
            (entry) => entry.id,
          ),
        },
        fieldPathQueries: {
          nestedEqual20IdsSorted: nestedEqualSnap.docs.map((entry) => entry.id).sort(),
          literalDotEqual88Ids: literalDotEqualSnap.docs.map((entry) => entry.id),
          nestedOrderByDescIds: nestedDescSnap.docs.map((entry) => entry.id),
          nestedOrderByDescTiers: nestedDescSnap.docs.map((entry) => {
            const meta = entry.data().meta as { tier: number };
            return meta.tier;
          }),
        },
      };
    });
  },
};
