import type { Probe } from '../../rigs/types.ts';
import {
  type ConvertedItem,
  createRecordedItemConverter,
  observeInitialQuerySnapshot,
} from '../../src/firestore-withconverter-probe-model.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#53a',
  rowIds: ['firestore#53a'],
  description:
    'CollectionReference.withConverter(c) is an instance method on collection() and collectionGroup() values and propagates across doc(typedColl, id), doc(typedColl), query(), addDoc, getDocs, and onSnapshot.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const {
        addDoc,
        collection,
        collectionGroup,
        doc,
        getDoc,
        getDocs,
        onSnapshot,
        orderBy,
        query,
        queryEqual,
        setDoc,
        where,
      } = firestoreSdk;
      const rawColl = collection(db, collectionPath('wc-coll-method'));
      const rawGroup = collectionGroup(db, 'wc_group_items');
      const { converter, toFirestoreCalls } = createRecordedItemConverter();

      const typedColl = rawColl.withConverter(converter);
      const typedGroup = rawGroup.withConverter(converter);
      const typedGroupFiltered = query(typedGroup, where('dbCount', '==', 10));

      const fixedDoc = doc(typedColl, 'a_fixed');
      await setDoc(fixedDoc, { title: 'Fixed', count: 1, tag: 'doc-id' });

      const autoDoc = doc(typedColl);
      await setDoc(autoDoc, { title: 'AutoDoc', count: 2, tag: 'doc-auto' });

      const toCallsBeforeAddDoc = toFirestoreCalls.length;
      const addedRef = await addDoc(typedColl, { title: 'Added', count: 3, tag: 'add-doc' });
      const toCallsDuringAddDoc = toFirestoreCalls.length - toCallsBeforeAddDoc;
      const addedReadSnap = await getDoc(addedRef);

      const orderedSnap = await getDocs(query(typedColl, orderBy('dbCount', 'asc')));
      const getDocsItems = orderedSnap.docs.map((docSnap) => ({
        data: docSnap.data(),
        refConverterMatches: docSnap.ref.converter === converter,
      }));

      const snapshotRows = await observeInitialQuerySnapshot<ConvertedItem>(
        (onNext, onError) => onSnapshot(typedColl, onNext, onError),
        3,
      );
      const onSnapshotItems = snapshotRows
        .map((row) => ({
          data: row.data,
          refHasConverter: row.refHasConverter,
        }))
        .sort((left, right) => left.data.count - right.data.count);

      return {
        hasCollectionMethod: typeof rawColl.withConverter === 'function',
        hasCollectionGroupMethod: typeof rawGroup.withConverter === 'function',
        rawGroupType: rawGroup.type,
        typedGroupType: typedGroup.type,
        rawGroupConverterIsNull: rawGroup.converter === null,
        typedGroupConverterMatches: typedGroup.converter === converter,
        typedGroupFilteredConverterMatches: typedGroupFiltered.converter === converter,
        typedGroupNullStripsConverter: typedGroup.withConverter(null).converter === null,
        groupQueryEqualUntypedVsTyped: queryEqual(rawGroup, typedGroup),
        groupQueryEqualUntypedVsStripped: queryEqual(rawGroup, typedGroup.withConverter(null)),
        fixedDocConverterMatches: fixedDoc.converter === converter,
        autoDocConverterMatches: autoDoc.converter === converter,
        autoDocIdLength: autoDoc.id.length,
        addedRefConverterMatches: addedRef.converter === converter,
        addedRefIdLength: addedRef.id.length,
        toCallsDuringAddDoc,
        addedReadData: addedReadSnap.data() ?? null,
        getDocsItems,
        onSnapshotItems,
      };
    });
  },
};
