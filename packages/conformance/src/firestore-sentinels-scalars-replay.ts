import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';
import type { FirestoreScenarioContext } from './capture/sdk-scenarios/scenario-types.ts';

export async function replayTimestampRoundTripAndNegativeMillis(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const {
    Timestamp,
    collection,
    doc,
    getDoc,
    getDocs,
    orderBy,
    query,
    serverTimestamp,
    setDoc,
    where,
  } = ctx.fs;

  const negMillis = Timestamp.fromMillis(-500);
  const negDate = Timestamp.fromDate(new Date(-500));
  const earlierNeg = Timestamp.fromMillis(-1500);
  const posMillis = Timestamp.fromMillis(500);

  const valueApi = {
    negMillisSeconds: negMillis.seconds,
    negMillisNanoseconds: negMillis.nanoseconds,
    negMillisRoundTrip: negMillis.toMillis(),
    negDateEqualsNegMillis: negDate.isEqual(negMillis),
    negMillisNotEqualsEarlier: !negMillis.isEqual(earlierNeg),
    negMillisJson: negMillis.toJSON(),
    valueOfOrdersChronologically:
      earlierNeg.valueOf() < negMillis.valueOf() &&
      negMillis.valueOf() < posMillis.valueOf(),
  };

  const fixedMillis = 1_700_000_000_250;
  const explicitInput = Timestamp.fromMillis(fixedMillis);
  const dateInput = new Date(fixedMillis);

  const items = collection(ctx.db, `${ctx.base}/timestamp-roundtrip`);
  const targetRef = doc(items, 'ts-doc');
  await setDoc(targetRef, {
    explicitTs: explicitInput,
    dateTs: dateInput,
    negTs: negMillis,
    serverTs: serverTimestamp(),
  });

  const snap = await getDoc(targetRef);
  const raw = snap.data() ?? {};
  const readExplicit = raw.explicitTs as InstanceType<typeof Timestamp>;
  const readDate = raw.dateTs as InstanceType<typeof Timestamp>;
  const readNeg = raw.negTs as InstanceType<typeof Timestamp>;
  const readServer = raw.serverTs as InstanceType<typeof Timestamp>;

  const unifiedColl = collection(ctx.db, `${ctx.base}/timestamp-unified-query`);
  await setDoc(doc(unifiedColl, 'c-server'), { ts: serverTimestamp() });
  await setDoc(doc(unifiedColl, 'b-date'), { ts: new Date(1_700_000_005_000) });
  await setDoc(doc(unifiedColl, 'a-explicit'), {
    ts: Timestamp.fromMillis(1_700_000_000_000),
  });

  const orderedUnifiedSnap = await getDocs(query(unifiedColl, orderBy('ts', 'asc')));
  const rangeUnifiedSnap = await getDocs(
    query(
      unifiedColl,
      where('ts', '>=', Timestamp.fromMillis(1_700_000_002_000)),
      orderBy('ts', 'asc'),
    ),
  );

  return {
    valueApi,
    roundTrip: {
      explicitIsTimestamp: readExplicit instanceof Timestamp,
      explicitSeconds: readExplicit.seconds,
      explicitNanoseconds: readExplicit.nanoseconds,
      explicitMillis: readExplicit.toMillis(),
      dateIsTimestamp: readDate instanceof Timestamp,
      dateEqualsExplicit: readDate.isEqual(readExplicit),
      negIsTimestamp: readNeg instanceof Timestamp,
      negSeconds: readNeg.seconds,
      negNanoseconds: readNeg.nanoseconds,
      negMillis: readNeg.toMillis(),
      serverIsTimestamp: readServer instanceof Timestamp,
      serverSecondsInteger:
        Number.isInteger(readServer.seconds) && readServer.seconds > 1_600_000_000,
      serverNanosecondsInRange:
        Number.isInteger(readServer.nanoseconds) &&
        readServer.nanoseconds >= 0 &&
        readServer.nanoseconds < 1_000_000_000,
    },
    unifiedQuery: {
      orderedAscIds: orderedUnifiedSnap.docs.map((entry) => entry.id),
      rangeGteIds: rangeUnifiedSnap.docs.map((entry) => entry.id),
    },
  };
}

export async function replaySentinelTypeMismatchOverwrite(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { arrayRemove, arrayUnion, collection, doc, getDoc, increment, setDoc, updateDoc } =
    ctx.fs;

  const items = collection(ctx.db, `${ctx.base}/sentinel-mismatch`);
  const updateRef = doc(items, 'update-target');
  await setDoc(updateRef, {
    strScore: 'not-a-number',
    mapScore: { nested: 1 },
    nullScore: null,
    strTags: 'scalar-tag',
    numTags: 42,
    strDrop: 'scalar-drop',
    arrDrop: ['keep', 'remove'],
  });

  await updateDoc(updateRef, {
    absentScore: increment(5),
    strScore: increment(5),
    mapScore: increment(-3),
    nullScore: increment(2),
    absentTags: arrayUnion('x', 'y', 'x'),
    strTags: arrayUnion('alpha', 'beta'),
    numTags: arrayUnion(7),
    absentDrop: arrayRemove('z'),
    strDrop: arrayRemove('scalar-drop'),
    arrDrop: arrayRemove('remove'),
  });

  const afterUpdateSnap = await getDoc(updateRef);
  const afterUpdateRaw = afterUpdateSnap.data();
  const afterUpdate = afterUpdateRaw ?? null;

  const mergeRef = doc(items, 'merge-target');
  await setDoc(mergeRef, {
    priorStr: 'hello',
    priorNum: 99,
    untouched: 'kept',
  });
  await setDoc(
    mergeRef,
    {
      priorStr: increment(4),
      priorNum: arrayUnion('item'),
      freshCount: increment(1),
    },
    { merge: true },
  );

  const afterMergeSnap = await getDoc(mergeRef);
  const afterMergeRaw = afterMergeSnap.data();
  const afterMergeSet = afterMergeRaw ?? null;

  return {
    afterUpdate,
    afterMergeSet,
  };
}

export async function replayScalarBytesGeoPointVectorRoundTrip(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const {
    Bytes,
    FieldPath,
    GeoPoint,
    VectorValue,
    collection,
    doc,
    documentId,
    getDoc,
    setDoc,
    vector,
  } = ctx.fs;

  const bytesInput = Bytes.fromUint8Array(new Uint8Array([0, 127, 255]));
  const bytesFromBase64 = Bytes.fromBase64String(bytesInput.toBase64());
  const geoInput = new GeoPoint(37.7749, -122.4194);
  const vecInput = vector([1.5, -2, 3.25]);
  const fpAB = new FieldPath('a', 'b');
  const fpSame = new FieldPath('a', 'b');
  const fpLiteral = new FieldPath('a.b');
  const docIdPath = documentId();

  const items = collection(ctx.db, `${ctx.base}/scalars-roundtrip`);
  const targetRef = doc(items, 'scalar-doc');
  await setDoc(targetRef, {
    payload: bytesInput,
    location: geoInput,
    embedding: vecInput,
  });

  const snap = await getDoc(targetRef);
  const data = snap.data() ?? {};
  const readBytes = data.payload as typeof bytesInput;
  const readGeo = data.location as typeof geoInput;
  const readVec = data.embedding as typeof vecInput;

  return {
    bytes: {
      isBytes: readBytes instanceof Bytes,
      base64: readBytes.toBase64(),
      uint8Array: Array.from(readBytes.toUint8Array()),
      equalsOriginal: readBytes.isEqual(bytesInput),
      equalsFromBase64: readBytes.isEqual(bytesFromBase64),
    },
    geoPoint: {
      isGeoPoint: readGeo instanceof GeoPoint,
      latitude: readGeo.latitude,
      longitude: readGeo.longitude,
      equalsOriginal: readGeo.isEqual(geoInput),
      json: readGeo.toJSON(),
    },
    vector: {
      isVectorValue: readVec instanceof VectorValue,
      array: readVec.toArray(),
      equalsOriginal: readVec.isEqual(vecInput),
      json: readVec.toJSON(),
    },
    fieldPath: {
      isFieldPath: fpAB instanceof FieldPath,
      equalsSameSegments: fpAB.isEqual(fpSame),
      equalsLiteralDot: fpAB.isEqual(fpLiteral),
      documentIdIsFieldPath: docIdPath instanceof FieldPath,
      documentIdEqualsSecondCall: docIdPath.isEqual(documentId()),
    },
  };
}

export async function replayQueryDocumentIdAndNestedFieldPath(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
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
  } = ctx.fs;

  const items = collection(ctx.db, `${ctx.base}/docid-fieldpath-queries`);
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
}
