import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';
import type { FirestoreScenarioContext } from './capture/sdk-scenarios/scenario-types.ts';
import {
  createSetDocOptionsRecorder,
  observeFirestoreWriteAttempt,
} from './firestore-setdoc-probe-helpers.ts';

type ErrorConstructorLike = abstract new (...args: never[]) => Error;

export async function replaySetDocDefaultReplacesEntireDoc(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { collection, doc, getDoc, setDoc } = ctx.fs;
  const items = collection(ctx.db, `${ctx.base}/setdoc-replace`);

  const refA = doc(items, 'doc-no-opts');
  await setDoc(refA, {
    title: 'Initial',
    status: 'draft',
    nested: { a: 1, b: 2 },
    tags: ['v1', 'v2'],
  });
  await setDoc(refA, {
    title: 'Replaced',
    count: 10,
  });
  const snapA = await getDoc(refA);
  const dataA = snapA.data() ?? null;

  const refB = doc(items, 'doc-merge-false');
  await setDoc(refB, {
    keepAttempt: 'before',
    nested: { x: 1, y: 2 },
  });
  await setDoc(refB, { nested: { x: 9 } }, { merge: false });
  const snapB = await getDoc(refB);
  const dataB = snapB.data() ?? null;

  return {
    noOptionsExists: snapA.exists(),
    noOptionsData: dataA,
    noOptionsHasPriorStatus: dataA !== null && 'status' in dataA,
    noOptionsHasPriorNested: dataA !== null && 'nested' in dataA,
    noOptionsHasPriorTags: dataA !== null && 'tags' in dataA,
    mergeFalseData: dataB,
    mergeFalseHasPriorKeepAttempt: dataB !== null && 'keepAttempt' in dataB,
  };
}

export async function replaySetDocMergeTrueDeepMergesMaps(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { collection, doc, getDoc, setDoc } = ctx.fs;
  const items = collection(ctx.db, `${ctx.base}/setdoc-merge-true`);

  const existingRef = doc(items, 'existing-doc');
  await setDoc(existingRef, {
    topKeep: 'kept',
    meta: {
      a: 1,
      nested: { x: 10, y: 20 },
    },
    list: ['old-a', 'old-b'],
  });

  await setDoc(
    existingRef,
    {
      meta: {
        b: 2,
        nested: { y: 99, z: 30 },
      },
      list: ['new-only'],
    },
    { merge: true },
  );
  const mergedSnap = await getDoc(existingRef);

  const absentRef = doc(items, 'absent-doc');
  await setDoc(absentRef, { createdViaMerge: true, nested: { k: 'v' } }, { merge: true });
  const createdSnap = await getDoc(absentRef);

  return {
    mergedExists: mergedSnap.exists(),
    mergedData: mergedSnap.data() ?? null,
    createdFromAbsentExists: createdSnap.exists(),
    createdFromAbsentData: createdSnap.data() ?? null,
  };
}

export async function replaySetDocMergeFieldsDottedAndFieldPath(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { FieldPath, collection, doc, getDoc, setDoc } = ctx.fs;
  const items = collection(ctx.db, `${ctx.base}/setdoc-mergefields`);

  const maskedRef = doc(items, 'masked-doc');
  await setDoc(maskedRef, {
    keep: 'intact',
    ignoredTop: 'before',
    profile: {
      name: 'Ada',
      role: 'admin',
      prefs: { theme: 'light', lang: 'en' },
    },
  });

  await setDoc(
    maskedRef,
    {
      ignoredTop: 'after-ignored',
      extraIgnored: 123,
      profile: {
        name: 'Grace',
        role: 'owner-ignored',
        prefs: { theme: 'dark', lang: 'fr-ignored' },
      },
    },
    {
      mergeFields: ['profile.name', new FieldPath('profile', 'prefs', 'theme')],
    },
  );
  const maskedSnap = await getDoc(maskedRef);

  const emptyMaskExistingRef = doc(items, 'empty-mask-existing');
  await setDoc(emptyMaskExistingRef, { preserved: 'yes', count: 1 });
  await setDoc(emptyMaskExistingRef, { preserved: 'no', count: 99 }, { mergeFields: [] });
  const emptyMaskExistingSnap = await getDoc(emptyMaskExistingRef);

  const emptyMaskAbsentRef = doc(items, 'empty-mask-absent');
  await setDoc(emptyMaskAbsentRef, { ignoredField: 'ignored' }, { mergeFields: [] });
  const emptyMaskAbsentSnap = await getDoc(emptyMaskAbsentRef);

  return {
    maskedData: maskedSnap.data() ?? null,
    emptyMaskExistingData: emptyMaskExistingSnap.data() ?? null,
    emptyMaskAbsentExists: emptyMaskAbsentSnap.exists(),
    emptyMaskAbsentData: emptyMaskAbsentSnap.data() ?? null,
  };
}

export async function replaySetDocBothMergeAndMergeFields(
  ctx: FirestoreScenarioContext,
  firebaseErrorCtor: ErrorConstructorLike,
): Promise<Behavior> {
  const { collection, doc, getDoc, setDoc } = ctx.fs;
  const items = collection(ctx.db, `${ctx.base}/setdoc-both-flags`);

  const mergeTrueRef = doc(items, 'both-merge-true');
  await setDoc(mergeTrueRef, { existing: 'stay', masked: 'old', unmasked: 'old-unmasked' });
  const mergeTrueAttempt = await observeFirestoreWriteAttempt(
    () =>
      setDoc(
        mergeTrueRef,
        { masked: 'new-masked', unmasked: 'new-unmasked' },
        { merge: true, mergeFields: ['masked'] } as never,
      ),
    firebaseErrorCtor,
  );
  const mergeTrueSnap = await getDoc(mergeTrueRef);

  const mergeFalseRef = doc(items, 'both-merge-false');
  await setDoc(mergeFalseRef, { existing: 'stay', masked: 'old', unmasked: 'old-unmasked' });
  const mergeFalseAttempt = await observeFirestoreWriteAttempt(
    () =>
      setDoc(
        mergeFalseRef,
        { masked: 'new-masked', unmasked: 'new-unmasked' },
        { merge: false, mergeFields: ['masked'] } as never,
      ),
    firebaseErrorCtor,
  );
  const mergeFalseSnap = await getDoc(mergeFalseRef);

  return {
    mergeTrueAndMergeFields: {
      threw: mergeTrueAttempt.threw,
      errorName: mergeTrueAttempt.errorName,
      isFirebaseError: mergeTrueAttempt.isFirebaseError,
      code: mergeTrueAttempt.code,
      storedData: mergeTrueSnap.data() ?? null,
    },
    mergeFalseAndMergeFields: {
      threw: mergeFalseAttempt.threw,
      errorName: mergeFalseAttempt.errorName,
      isFirebaseError: mergeFalseAttempt.isFirebaseError,
      code: mergeFalseAttempt.code,
      storedData: mergeFalseSnap.data() ?? null,
    },
  };
}

export async function replaySetDocConverterOptionsForwarding(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { collection, doc, getDoc, setDoc } = ctx.fs;
  const items = collection(ctx.db, `${ctx.base}/setdoc-converter-opts`);
  const rawRef = doc(items, 'item-1');
  const { converter, calls } = createSetDocOptionsRecorder();
  const typedRef = rawRef.withConverter(converter as never);

  await setDoc(typedRef, { label: 'First', units: 2, note: 'init' });
  const afterFullSnap = await getDoc(rawRef);
  const afterFullRaw = afterFullSnap.data() ?? null;

  await setDoc(typedRef, { units: 6 }, { merge: true });
  const afterMergeTrueSnap = await getDoc(rawRef);
  const afterMergeTrueRaw = afterMergeTrueSnap.data() ?? null;

  await setDoc(
    typedRef,
    { label: 'MaskedLabel', note: 'IgnoredByMask' },
    { mergeFields: ['dbLabel'] },
  );
  const afterMergeFieldsRawSnap = await getDoc(rawRef);
  const afterMergeFieldsRaw = afterMergeFieldsRawSnap.data() ?? null;
  const afterMergeFieldsTypedSnap = await getDoc(typedRef);
  const afterMergeFieldsTyped = afterMergeFieldsTypedSnap.data() ?? null;

  return {
    toFirestoreCalls: calls,
    afterFullRaw,
    afterMergeTrueRaw,
    afterMergeFieldsRaw,
    afterMergeFieldsTyped,
  };
}

export async function verifySetDocAtomicMergePrecedence(
  ctx: FirestoreScenarioContext,
): Promise<Record<string, unknown>> {
  const { collection, doc, getDoc, runTransaction, setDoc, writeBatch } = ctx.fs;
  const items = collection(ctx.db, `${ctx.base}/setdoc-atomic-precedence`);

  const setShortCircuitRef = doc(items, 'setdoc-short-circuit');
  await setDoc(setShortCircuitRef, { keep: 'kept', masked: 'old' });
  await setDoc(
    setShortCircuitRef,
    { masked: 'new', extra: 'included' },
    { merge: true, mergeFields: ['absentInData'] } as never,
  );
  const setShortCircuitSnap = await getDoc(setShortCircuitRef);

  const batchMergeTrueRef = doc(items, 'batch-merge-true');
  const batchMergeFalseRef = doc(items, 'batch-merge-false');
  await setDoc(batchMergeTrueRef, { existing: 'stay', masked: 'old', unmasked: 'old-unmasked' });
  await setDoc(batchMergeFalseRef, { existing: 'stay', masked: 'old', unmasked: 'old-unmasked' });

  const batch = writeBatch(ctx.db);
  batch.set(
    batchMergeTrueRef,
    { masked: 'new-masked', unmasked: 'new-unmasked' },
    { merge: true, mergeFields: ['absentInData'] } as never,
  );
  batch.set(
    batchMergeFalseRef,
    { masked: 'new-masked', unmasked: 'new-unmasked' },
    { merge: false, mergeFields: ['masked'] } as never,
  );
  await batch.commit();
  const batchMergeTrueSnap = await getDoc(batchMergeTrueRef);
  const batchMergeFalseSnap = await getDoc(batchMergeFalseRef);

  const txMergeTrueRef = doc(items, 'tx-merge-true');
  const txMergeFalseRef = doc(items, 'tx-merge-false');
  await setDoc(txMergeTrueRef, { existing: 'stay', masked: 'old', unmasked: 'old-unmasked' });
  await setDoc(txMergeFalseRef, { existing: 'stay', masked: 'old', unmasked: 'old-unmasked' });

  await runTransaction(ctx.db, async (tx) => {
    tx.set(
      txMergeTrueRef,
      { masked: 'new-masked', unmasked: 'new-unmasked' },
      { merge: true, mergeFields: ['absentInData'] } as never,
    );
    tx.set(
      txMergeFalseRef,
      { masked: 'new-masked', unmasked: 'new-unmasked' },
      { merge: false, mergeFields: ['masked'] } as never,
    );
  });
  const txMergeTrueSnap = await getDoc(txMergeTrueRef);
  const txMergeFalseSnap = await getDoc(txMergeFalseRef);

  return {
    setDocShortCircuit: setShortCircuitSnap.data() ?? null,
    batchMergeTrue: batchMergeTrueSnap.data() ?? null,
    batchMergeFalse: batchMergeFalseSnap.data() ?? null,
    txMergeTrue: txMergeTrueSnap.data() ?? null,
    txMergeFalse: txMergeFalseSnap.data() ?? null,
  };
}
