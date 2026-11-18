import type { Probe } from '../../rigs/types.ts';
import { createRecordedItemConverter } from '../../src/firestore-withconverter-probe-model.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Query.withConverter(c) is an instance method on query() values; withConverter(null) on a collection or query removes the converter, and collection(typedDocRef, id) stays untyped.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const {
        collection,
        doc,
        getDoc,
        getDocs,
        orderBy,
        query,
        queryEqual,
        refEqual,
        setDoc,
        where,
      } = firestoreSdk;
      const rawColl = collection(db, collectionPath('wc-query-method'));
      const { converter, toFirestoreCalls, fromFirestoreCalls, resetCalls } =
        createRecordedItemConverter();
      const typedColl = rawColl.withConverter(converter);

      await setDoc(doc(typedColl, 'd1'), { title: 'Low', count: 1 });
      await setDoc(doc(typedColl, 'd2'), { title: 'High', count: 4, tag: 'q' });

      const baseQuery = query(rawColl, where('dbCount', '>=', 20), orderBy('dbCount', 'asc'));
      const typedQuery = baseQuery.withConverter(converter);
      resetCalls();
      const typedQuerySnap = await getDocs(typedQuery);
      const typedQueryDocs = typedQuerySnap.docs.map((docSnap) => ({
        id: docSnap.id,
        data: docSnap.data(),
        refConverterMatches: docSnap.ref.converter === converter,
      }));
      const fromCallsDuringTypedQuery = fromFirestoreCalls.length;

      resetCalls();
      const untypedQuery = typedQuery.withConverter(null);
      const untypedQuerySnap = await getDocs(untypedQuery);
      const untypedQueryDocs = untypedQuerySnap.docs.map((docSnap) => ({
        id: docSnap.id,
        data: docSnap.data(),
        refConverterIsNull: docSnap.ref.converter === null,
      }));
      const fromCallsDuringUntypedQuery = fromFirestoreCalls.length;

      resetCalls();
      const untypedColl = typedColl.withConverter(null);
      const untypedCollSnap = await getDocs(query(untypedColl, orderBy('dbCount', 'asc')));
      const untypedCollDocs = untypedCollSnap.docs.map((docSnap) => ({
        id: docSnap.id,
        data: docSnap.data(),
        refConverterIsNull: docSnap.ref.converter === null,
      }));
      const fromCallsDuringUntypedColl = fromFirestoreCalls.length;

      resetCalls();
      const typedParentDoc = doc(typedColl, 'd1');
      const subColl = collection(typedParentDoc, 'notes');
      const subDoc = doc(subColl, 'n1');
      await setDoc(subDoc, { noteText: 'raw-subcollection-doc' });
      const subDocSnap = await getDoc(subDoc);
      const toCallsDuringSubcollectionWrite = toFirestoreCalls.length;
      const fromCallsDuringSubcollectionRead = fromFirestoreCalls.length;

      return {
        hasQueryWithConverterMethod: typeof baseQuery.withConverter === 'function',
        baseQueryConverterIsNull: baseQuery.converter === null,
        typedQueryConverterMatches: typedQuery.converter === converter,
        untypedQueryConverterIsNull: untypedQuery.converter === null,
        queryEqualBaseAndStripped: queryEqual(baseQuery, untypedQuery),
        queryEqualBaseAndTyped: queryEqual(baseQuery, typedQuery),
        untypedCollConverterIsNull: untypedColl.converter === null,
        refEqualBaseCollAndStripped: refEqual(rawColl, untypedColl),
        typedQueryDocs,
        fromCallsDuringTypedQuery,
        untypedQueryDocs,
        fromCallsDuringUntypedQuery,
        untypedCollDocs,
        fromCallsDuringUntypedColl,
        subCollType: subColl.type,
        subCollConverterIsNull: subColl.converter === null,
        subDocConverterIsNull: subDoc.converter === null,
        subDocStoredData: subDocSnap.data() ?? null,
        toCallsDuringSubcollectionWrite,
        fromCallsDuringSubcollectionRead,
      };
    });
  },
};
