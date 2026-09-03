import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const CONFORMANCE_SUITE = 'packages/kt-client/src/test/kotlin/dev/pyric/firestore/ConformanceTest.kt';
const UNOBSERVED_REASON =
  'Behavior stated from com.google.firebase.firestore specification; unit test has not passed yet.';

const buildRow = defineRows({
  surface: 'firestore-kotlin',
});

interface KotlinRowSeed {
  ref: number;
  section: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  flipped?: 'unit-backed';
}

function row(seed: KotlinRowSeed): CompatibilityRow {
  const { ref, flipped, evidence, ...rest } = seed;
  const defaultEvidence = flipped
    ? 'com.google.firebase.firestore specification.'
    : 'com.google.firebase.firestore specification; unverified locally.';
  const resolvedEvidence = evidence ?? defaultEvidence;
  const climb = flipped
    ? {
        status: 'conforms' as const,
        automation: 'unit-backed' as const,
        evidence: `${resolvedEvidence} Test: \`${CONFORMANCE_SUITE}\` assertion set \`firestore-kotlin#${ref}\`.`,
        conformanceTests: [CONFORMANCE_SUITE],
      }
    : {
        status: 'unverified' as const,
        automation: 'unverified' as const,
        risk: ['unobserved'],
        riskScore: 2,
        riskReasons: [UNOBSERVED_REASON],
        evidence: resolvedEvidence,
      };
  return buildRow({
    ...rest,
    rowRef: String(ref),
    ...climb,
  });
}

export const firestoreKotlinRows: CompatibilityRow[] = [
  // ── 1. FirebaseFirestore: Instance & Lifecycle ───────────────────────────
  row({ ref: 1, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.getInstance() / Firebase.firestore', behavior: 'Returns the default FirebaseFirestore instance for the default FirebaseApp.', featureKeys: ['getInstance'], flipped: 'unit-backed' }),
  row({ ref: 2, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.getInstance(app, database) / Firebase.firestore(app, database)', behavior: 'Provides isolated FirebaseFirestore instances distinguished by FirebaseApp and database ID.', featureKeys: ['getInstance'], flipped: 'unit-backed' }),
  row({ ref: 3, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.firestoreSettings', behavior: 'Configures host, sslEnabled, persistenceEnabled, and cacheSizeBytes via FirebaseFirestoreSettings.', featureKeys: ['settings'], flipped: 'unit-backed' }),
  row({ ref: 4, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.document(path)', behavior: 'Instantiates a DocumentReference pointing to the slash-delimited path.', featureKeys: ['document'], flipped: 'unit-backed' }),
  row({ ref: 5, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.collection(path)', behavior: 'Instantiates a CollectionReference pointing to the slash-delimited path.', featureKeys: ['collection'], flipped: 'unit-backed' }),
  row({ ref: 6, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.collectionGroup(collectionId)', behavior: 'Instantiates a Query spanning all collections with the specified collectionId.', featureKeys: ['collectionGroup'], flipped: 'unit-backed' }),
  row({ ref: 7, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.batch()', behavior: 'Instantiates a WriteBatch for atomic batched mutations.', featureKeys: ['batch'], flipped: 'unit-backed' }),
  row({ ref: 8, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.runTransaction(handler)', behavior: 'Runs interactive transaction handler with automatic conflict retries up to TransactionOptions.maxAttempts.', featureKeys: ['runTransaction'], flipped: 'unit-backed' }),
  row({ ref: 9, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.clearPersistence()', behavior: 'Clears offline client persistence cache when no active listeners exist.', featureKeys: ['clearPersistence'] }),
  row({ ref: 10, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.enableNetwork() / disableNetwork()', behavior: 'Toggles client network connectivity to simulate offline operation.', featureKeys: ['enableNetwork', 'disableNetwork'] }),
  row({ ref: 11, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.terminate()', behavior: 'Terminates the Firestore client, closing network connections and unsubscribing active snapshot flows.', featureKeys: ['terminate'], flipped: 'unit-backed' }),
  row({ ref: 12, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.waitForPendingWrites()', behavior: 'Resolves when all locally initiated writes have been committed by the server.', featureKeys: ['waitForPendingWrites'] }),
  row({ ref: 13, section: '`FirebaseFirestore` — instance & lifecycle',
    api: 'FirebaseFirestore.addSnapshotsInSyncListener(runnable)', behavior: 'Notifies when all active snapshot listeners are in sync with server state.', featureKeys: ['snapshotsInSync'] }),

  // ── 2. DocumentReference: Document Operations ────────────────────────────
  row({ ref: 14, section: '`DocumentReference` — document operations',
    api: 'DocumentReference.get(source)', behavior: 'Reads a single document snapshot from server or cache based on Source.', featureKeys: ['get'], flipped: 'unit-backed' }),
  row({ ref: 15, section: '`DocumentReference` — document operations',
    api: 'DocumentReference.set(data)', behavior: 'Overwrites target document completely with provided map or POJO payload.', featureKeys: ['set'], flipped: 'unit-backed' }),
  row({ ref: 16, section: '`DocumentReference` — document operations',
    api: 'DocumentReference.set(data, SetOptions.merge())', behavior: 'Merges payload fields into existing document without overwriting unspecified fields.', featureKeys: ['set', 'merge'], flipped: 'unit-backed' }),
  row({ ref: 17, section: '`DocumentReference` — document operations',
    api: 'DocumentReference.update(data)', behavior: 'Updates specified fields in an existing document; fails if document does not exist.', featureKeys: ['update'], flipped: 'unit-backed' }),
  row({ ref: 18, section: '`DocumentReference` — document operations',
    api: 'DocumentReference.delete()', behavior: 'Deletes document at reference path from Firestore database.', featureKeys: ['delete'], flipped: 'unit-backed' }),
  row({ ref: 19, section: '`DocumentReference` — document operations',
    api: 'DocumentReference.collection(path)', behavior: 'Returns a child CollectionReference nested under this document.', featureKeys: ['collection'], flipped: 'unit-backed' }),
  row({ ref: 20, section: '`DocumentReference` — document operations',
    api: 'DocumentReference.snapshots(metadataChanges)', behavior: 'Returns a Coroutine Flow emitting DocumentSnapshot on document changes.', featureKeys: ['snapshots'], flipped: 'unit-backed' }),

  // ── 3. Query: Filters & Constraints ──────────────────────────────────────
  row({ ref: 21, section: '`Query` — filters & constraints',
    api: 'Query.whereEqualTo(field, value)', behavior: 'Filters documents matching exact field equality.', featureKeys: ['whereEqualTo'], flipped: 'unit-backed' }),
  row({ ref: 22, section: '`Query` — filters & constraints',
    api: 'Query.whereNotEqualTo(field, value)', behavior: 'Filters documents where field does not equal specified value.', featureKeys: ['whereNotEqualTo'], flipped: 'unit-backed' }),
  row({ ref: 23, section: '`Query` — filters & constraints',
    api: 'Query.whereLessThan / whereLessThanOrEqualTo / whereGreaterThan / whereGreaterThanOrEqualTo', behavior: 'Applies relational range comparison filters on field value.', featureKeys: ['whereLessThan', 'whereGreaterThan'], flipped: 'unit-backed' }),
  row({ ref: 24, section: '`Query` — filters & constraints',
    api: 'Query.whereArrayContains(field, value)', behavior: 'Filters documents where array field contains the specified element.', featureKeys: ['whereArrayContains'], flipped: 'unit-backed' }),
  row({ ref: 25, section: '`Query` — filters & constraints',
    api: 'Query.whereArrayContainsAny(field, values)', behavior: 'Filters documents where array field contains any element from the values list.', featureKeys: ['whereArrayContainsAny'], flipped: 'unit-backed' }),
  row({ ref: 26, section: '`Query` — filters & constraints',
    api: 'Query.whereIn(field, values)', behavior: 'Filters documents where field value matches any element in values list (IN query).', featureKeys: ['whereIn'], flipped: 'unit-backed' }),
  row({ ref: 27, section: '`Query` — filters & constraints',
    api: 'Query.whereNotIn(field, values)', behavior: 'Filters documents where field value matches no element in values list (NOT IN query).', featureKeys: ['whereNotIn'], flipped: 'unit-backed' }),
  row({ ref: 28, section: '`Query` — filters & constraints',
    api: 'Query.where(filter)', behavior: 'Evaluates composite boolean expressions constructed via Filter.and(...) or Filter.or(...).', featureKeys: ['where', 'filter'], flipped: 'unit-backed' }),
  row({ ref: 29, section: '`Query` — filters & constraints',
    api: 'Query.orderBy(field, direction)', behavior: 'Orders query results by field ascending or descending.', featureKeys: ['orderBy'], flipped: 'unit-backed' }),
  row({ ref: 30, section: '`Query` — filters & constraints',
    api: 'Query.limit(limit)', behavior: 'Limits maximum number of matched documents returned.', featureKeys: ['limit'], flipped: 'unit-backed' }),
  row({ ref: 31, section: '`Query` — filters & constraints',
    api: 'Query.limitToLast(limit)', behavior: 'Limits query results to the last N documents relative to query ordering.', featureKeys: ['limitToLast'], flipped: 'unit-backed' }),
  row({ ref: 32, section: '`Query` — filters & constraints',
    api: 'Query.startAt(values) / startAfter(values)', behavior: 'Positions starting cursor boundary using field values.', featureKeys: ['startAt', 'startAfter'], flipped: 'unit-backed' }),
  row({ ref: 33, section: '`Query` — filters & constraints',
    api: 'Query.endAt(values) / endBefore(values)', behavior: 'Positions ending cursor boundary using field values.', featureKeys: ['endAt', 'endBefore'], flipped: 'unit-backed' }),
  row({ ref: 34, section: '`Query` — filters & constraints',
    api: 'Query.startAt(documentSnapshot) / endAt(documentSnapshot)', behavior: 'Positions query pagination cursors using DocumentSnapshot instances.', featureKeys: ['startAt', 'endAt'], flipped: 'unit-backed' }),
  row({ ref: 35, section: '`Query` — filters & constraints',
    api: 'Query.get(source)', behavior: 'Executes query and returns QuerySnapshot containing matched documents.', featureKeys: ['get'], flipped: 'unit-backed' }),
  row({ ref: 36, section: '`Query` — filters & constraints',
    api: 'Query.snapshots(metadataChanges)', behavior: 'Returns a Coroutine Flow emitting QuerySnapshot upon matching changes.', featureKeys: ['snapshots'], flipped: 'unit-backed' }),

  // ── 4. CollectionReference: Collection Operations ────────────────────────
  row({ ref: 37, section: '`CollectionReference` — collection operations',
    api: 'CollectionReference.document([path])', behavior: 'Returns DocumentReference under collection; auto-generates 20-char ID if path omitted.', featureKeys: ['document'], flipped: 'unit-backed' }),
  row({ ref: 38, section: '`CollectionReference` — collection operations',
    api: 'CollectionReference.add(data)', behavior: 'Generates auto-ID, writes document data, and returns DocumentReference.', featureKeys: ['add'], flipped: 'unit-backed' }),

  // ── 5. Snapshots & Metadata ──────────────────────────────────────────────
  row({ ref: 39, section: 'Snapshots & metadata',
    api: 'DocumentSnapshot.exists()', behavior: 'Reports true if document is present in Firestore; false if absent.', featureKeys: ['exists'], flipped: 'unit-backed' }),
  row({ ref: 40, section: 'Snapshots & metadata',
    api: 'DocumentSnapshot.getData()', behavior: 'Returns revived Map<String, Object> containing document field data.', featureKeys: ['getData'], flipped: 'unit-backed' }),
  row({ ref: 41, section: 'Snapshots & metadata',
    api: 'DocumentSnapshot.get(field)', behavior: 'Extracts single field value supporting dot notation or FieldPath instances.', featureKeys: ['get'], flipped: 'unit-backed' }),
  row({ ref: 42, section: 'Snapshots & metadata',
    api: 'DocumentSnapshot.toObject<T>()', behavior: 'Deserializes snapshot into typed data object via reified extension function.', featureKeys: ['toObject'], flipped: 'unit-backed' }),
  row({ ref: 43, section: 'Snapshots & metadata',
    api: 'SnapshotMetadata (hasPendingWrites, isFromCache)', behavior: 'Exposes local cache and uncommitted pending write status on snapshots.', featureKeys: ['metadata'], flipped: 'unit-backed' }),
  row({ ref: 44, section: 'Snapshots & metadata',
    api: 'QuerySnapshot.documents / documentChanges', behavior: 'Provides ordered List<DocumentSnapshot> and List<DocumentChange> detailing change types.', featureKeys: ['documents', 'documentChanges'], flipped: 'unit-backed' }),

  // ── 6. WriteBatch: Atomic Batches ────────────────────────────────────────
  row({ ref: 45, section: '`WriteBatch` — atomic batches',
    api: 'WriteBatch.set(documentReference, data, options)', behavior: 'Enqueues set or merge operation into atomic mutation batch.', featureKeys: ['set', 'batch'], flipped: 'unit-backed' }),
  row({ ref: 46, section: '`WriteBatch` — atomic batches',
    api: 'WriteBatch.update(documentReference, data)', behavior: 'Enqueues update operation into atomic mutation batch.', featureKeys: ['update', 'batch'], flipped: 'unit-backed' }),
  row({ ref: 47, section: '`WriteBatch` — atomic batches',
    api: 'WriteBatch.delete(documentReference)', behavior: 'Enqueues delete operation into atomic mutation batch.', featureKeys: ['delete', 'batch'], flipped: 'unit-backed' }),
  row({ ref: 48, section: '`WriteBatch` — atomic batches',
    api: 'WriteBatch.commit()', behavior: 'Atomically commits all enqueued mutations across multiple documents.', featureKeys: ['commit', 'batch'], flipped: 'unit-backed' }),

  // ── 7. Transaction: Interactive Transactions ─────────────────────────────
  row({ ref: 49, section: '`Transaction` — interactive transactions',
    api: 'Transaction.get(documentReference)', behavior: 'Reads document snapshot within transaction context and acquires read lock.', featureKeys: ['get', 'transaction'], flipped: 'unit-backed' }),
  row({ ref: 50, section: '`Transaction` — interactive transactions',
    api: 'Transaction.set(documentReference, data, options)', behavior: 'Enqueues transactional set mutation to be committed on handler completion.', featureKeys: ['set', 'transaction'], flipped: 'unit-backed' }),
  row({ ref: 51, section: '`Transaction` — interactive transactions',
    api: 'Transaction.update(documentReference, data)', behavior: 'Enqueues transactional update mutation to be committed on handler completion.', featureKeys: ['update', 'transaction'], flipped: 'unit-backed' }),
  row({ ref: 52, section: '`Transaction` — interactive transactions',
    api: 'Transaction.delete(documentReference)', behavior: 'Enqueues transactional delete mutation to be committed on handler completion.', featureKeys: ['delete', 'transaction'], flipped: 'unit-backed' }),
  row({ ref: 53, section: '`Transaction` — interactive transactions',
    api: 'Transaction retry mechanism', behavior: 'Catches optimistic locking conflicts and re-executes handler up to maxAttempts.', featureKeys: ['runTransaction'] }),

  // ── 8. FieldValue: Sentinels & Transformations ───────────────────────────
  row({ ref: 54, section: '`FieldValue` — sentinels & transformations',
    api: 'FieldValue.serverTimestamp()', behavior: 'Encodes sentinel replaced by server commit timestamp during write.', featureKeys: ['serverTimestamp'], flipped: 'unit-backed' }),
  row({ ref: 55, section: '`FieldValue` — sentinels & transformations',
    api: 'FieldValue.delete()', behavior: 'Encodes sentinel that deletes the target field during document update.', featureKeys: ['deleteField'], flipped: 'unit-backed' }),
  row({ ref: 56, section: '`FieldValue` — sentinels & transformations',
    api: 'FieldValue.increment(value)', behavior: 'Encodes numeric transformation operand that atomically increments field value.', featureKeys: ['increment'], flipped: 'unit-backed' }),
  row({ ref: 57, section: '`FieldValue` — sentinels & transformations',
    api: 'FieldValue.arrayUnion(elements)', behavior: 'Encodes transformation adding elements to array field if absent.', featureKeys: ['arrayUnion'], flipped: 'unit-backed' }),
  row({ ref: 58, section: '`FieldValue` — sentinels & transformations',
    api: 'FieldValue.arrayRemove(elements)', behavior: 'Encodes transformation removing matching elements from array field.', featureKeys: ['arrayRemove'], flipped: 'unit-backed' }),

  // ── 9. Data Types & Value Codecs: Serialization ──────────────────────────
  row({ ref: 59, section: 'Data types & value codecs',
    api: 'Timestamp codec', behavior: 'Serializes and revives Timestamp preserving seconds and nanoseconds across bridge wire format.', featureKeys: ['Timestamp'], flipped: 'unit-backed' }),
  row({ ref: 60, section: 'Data types & value codecs',
    api: 'GeoPoint codec', behavior: 'Serializes and revives GeoPoint coordinates (latitude, longitude) over WebSocket bridge.', featureKeys: ['GeoPoint'], flipped: 'unit-backed' }),
  row({ ref: 61, section: 'Data types & value codecs',
    api: 'Blob codec', behavior: 'Serializes byte arrays to base64 bridge wire format and revives them as Blob.', featureKeys: ['Blob'], flipped: 'unit-backed' }),
  row({ ref: 62, section: 'Data types & value codecs',
    api: 'DocumentReference codec', behavior: 'Encodes and decodes DocumentReference values stored within document fields.', featureKeys: ['DocumentReference'], flipped: 'unit-backed' }),
  row({ ref: 63, section: 'Data types & value codecs',
    api: 'Nested Map and List collections', behavior: 'Deeply encodes and revives recursive nested Maps and Lists containing mixed primitives and sentinels.', featureKeys: ['data'], flipped: 'unit-backed' }),

  // ── 10. Aggregations & Advanced Queries ──────────────────────────────────
  row({ ref: 64, section: 'Aggregations & advanced queries',
    api: 'AggregateQuery.count()', behavior: 'Returns count of matched documents without pulling full document payloads.', featureKeys: ['count'], flipped: 'unit-backed' }),
  row({ ref: 65, section: 'Aggregations & advanced queries',
    api: 'AggregateQuery.aggregate(sum, average)', behavior: 'Computes server-side numeric sum and average across matched query documents.', featureKeys: ['aggregate'], flipped: 'unit-backed' }),
];

const INTRO = `# Kotlin Cloud Firestore integration compatibility

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — Kotlin conformance test matches com.google.firebase.firestore specification |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match com.google.firebase.firestore specification but does not |
| — | **Not implemented yet** — explicitly outside the implemented slice |
| ? | **Unverified** — com.google.firebase.firestore behavior not yet verified by conformance test |
`;

export const firestoreKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'firestore-kotlin',
  label: 'Firestore · Kotlin',
  compatPath: 'packages/conformance/docs/firestore-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    {
      kind: 'table',
      prefix: '## `FirebaseFirestore` — instance & lifecycle\n',
      rows: firestoreKotlinRows.filter((r) => r.section === '`FirebaseFirestore` — instance & lifecycle'),
    },
    {
      kind: 'table',
      prefix: '## `DocumentReference` — document operations\n',
      rows: firestoreKotlinRows.filter((r) => r.section === '`DocumentReference` — document operations'),
    },
    {
      kind: 'table',
      prefix: '## `Query` — filters & constraints\n',
      rows: firestoreKotlinRows.filter((r) => r.section === '`Query` — filters & constraints'),
    },
    {
      kind: 'table',
      prefix: '## `CollectionReference` — collection operations\n',
      rows: firestoreKotlinRows.filter((r) => r.section === '`CollectionReference` — collection operations'),
    },
    {
      kind: 'table',
      prefix: '## Snapshots & metadata\n',
      rows: firestoreKotlinRows.filter((r) => r.section === 'Snapshots & metadata'),
    },
    {
      kind: 'table',
      prefix: '## `WriteBatch` — atomic batches\n',
      rows: firestoreKotlinRows.filter((r) => r.section === '`WriteBatch` — atomic batches'),
    },
    {
      kind: 'table',
      prefix: '## `Transaction` — interactive transactions\n',
      rows: firestoreKotlinRows.filter((r) => r.section === '`Transaction` — interactive transactions'),
    },
    {
      kind: 'table',
      prefix: '## `FieldValue` — sentinels & transformations\n',
      rows: firestoreKotlinRows.filter((r) => r.section === '`FieldValue` — sentinels & transformations'),
    },
    {
      kind: 'table',
      prefix: '## Data types & value codecs\n',
      rows: firestoreKotlinRows.filter((r) => r.section === 'Data types & value codecs'),
    },
    {
      kind: 'table',
      prefix: '## Aggregations & advanced queries\n',
      rows: firestoreKotlinRows.filter((r) => r.section === 'Aggregations & advanced queries'),
    },
  ],
};

export default firestoreKotlinRegistry;
