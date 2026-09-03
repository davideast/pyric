import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const CONFORMANCE_SUITE = 'packages/flutter-client/test/conformance_test.dart';
const UNOBSERVED_REASON =
  'Behavior stated from cloud_firestore_platform_interface specification; containerized test has not passed yet.';

const buildRow = defineRows({
  surface: 'firestore-flutter',
});

interface FlutterRowSeed {
  ref: number;
  section: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  flipped?: 'unit-backed';
}

function row(seed: FlutterRowSeed): CompatibilityRow {
  const { ref, flipped, evidence, ...rest } = seed;
  const defaultEvidence = flipped ? 'cloud_firestore_platform_interface specification.' : 'cloud_firestore_platform_interface specification; unverified locally.';
  const resolvedEvidence = evidence ?? defaultEvidence;
  const climb = flipped
    ? {
        status: 'conforms' as const,
        automation: 'unit-backed' as const,
        evidence: `${resolvedEvidence} Container test: \`${CONFORMANCE_SUITE}\` assertion set \`firestore-flutter#${ref}\`.`,
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

export const firestoreFlutterRows: CompatibilityRow[] = [
  // ── 1. FirebaseFirestorePlatform: Instance & Lifecycle ───────────────────
  row({ ref: 1, flipped: 'unit-backed', section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.instance', behavior: 'Returns the default platform instance registered via PlatformInterface.', featureKeys: ['instance'] }),
  row({ ref: 2, flipped: 'unit-backed', section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.instanceFor(app, databaseId)', behavior: 'Provides isolated platform instances distinguished by FirebaseApp and database ID.', featureKeys: ['instanceFor'] }),
  row({ ref: 3, flipped: 'unit-backed', section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.settings', behavior: 'Configures host, sslEnabled, persistenceEnabled, and cacheSizeBytes.', featureKeys: ['settings'] }),
  row({ ref: 4, flipped: 'unit-backed', section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.doc(path)', behavior: 'Instantiates a DocumentReferencePlatform pointing to the slash-delimited path.', featureKeys: ['doc'] }),
  row({ ref: 5, flipped: 'unit-backed', section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.collection(path)', behavior: 'Instantiates a CollectionReferencePlatform pointing to the slash-delimited path.', featureKeys: ['collection'] }),
  row({ ref: 6, flipped: 'unit-backed', section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.collectionGroup(collectionId)', behavior: 'Instantiates a QueryPlatform spanning all collections with the specified collectionId.', featureKeys: ['collectionGroup'] }),
  row({ ref: 7, flipped: 'unit-backed', section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.writeBatch()', behavior: 'Instantiates a WriteBatchPlatform for atomic batched mutations.', featureKeys: ['writeBatch'] }),
  row({
    ref: 8,
    flipped: 'unit-backed',
    section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.runTransaction(handler, {timeout, maxAttempts})',
    behavior: 'Runs interactive transaction handler with automatic conflict retries.',
    featureKeys: ['runTransaction'],
  }),
  row({ ref: 9, section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.clearPersistence()', behavior: 'Clears offline client persistence cache when no active listeners exist.', featureKeys: ['clearPersistence'] }),
  row({ ref: 10, section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.enableNetwork() / disableNetwork()', behavior: 'Toggles client network connectivity to simulate offline operation.', featureKeys: ['enableNetwork', 'disableNetwork'] }),
  row({ ref: 11, flipped: 'unit-backed', section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.terminate()', behavior: 'Terminates the platform client, unsubscribing all active snapshot streams.', featureKeys: ['terminate'] }),
  row({ ref: 12, section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.waitForPendingWrites()', behavior: 'Resolves when all locally initiated writes have been committed by the server.', featureKeys: ['waitForPendingWrites'] }),
  row({ ref: 13, section: '`FirebaseFirestorePlatform` — instance & lifecycle',
    api: 'FirebaseFirestorePlatform.snapshotsInSync()', behavior: 'Emits an event when all active listeners have caught up to the same state.', featureKeys: ['snapshotsInSync'] }),

  // ── 2. DocumentReferencePlatform: Document Operations ────────────────────
  row({ ref: 14, flipped: 'unit-backed', section: '`DocumentReferencePlatform` — document operations',
    api: 'DocumentReferencePlatform.get(options)', behavior: 'Reads a single document snapshot from server or cache based on GetOptions.', featureKeys: ['get'] }),
  row({ ref: 15, flipped: 'unit-backed', section: '`DocumentReferencePlatform` — document operations',
    api: 'DocumentReferencePlatform.set(data)', behavior: 'Overwrites target document completely with provided map payload.', featureKeys: ['set'] }),
  row({ ref: 16, flipped: 'unit-backed', section: '`DocumentReferencePlatform` — document operations',
    api: 'DocumentReferencePlatform.set(data, SetOptions(merge: true))', behavior: 'Merges payload fields into existing document without overwriting unspecified fields.', featureKeys: ['set', 'merge'] }),
  row({ ref: 17, flipped: 'unit-backed', section: '`DocumentReferencePlatform` — document operations',
    api: 'DocumentReferencePlatform.update(data)', behavior: 'Updates specified fields in an existing document; fails if document does not exist.', featureKeys: ['update'] }),
  row({ ref: 18, flipped: 'unit-backed', section: '`DocumentReferencePlatform` — document operations',
    api: 'DocumentReferencePlatform.delete()', behavior: 'Deletes document at reference path from Firestore database.', featureKeys: ['delete'] }),
  row({ ref: 19, flipped: 'unit-backed', section: '`DocumentReferencePlatform` — document operations',
    api: 'DocumentReferencePlatform.collection(subPath)', behavior: 'Returns a child CollectionReferencePlatform nested under this document.', featureKeys: ['collection'] }),
  row({ ref: 20, flipped: 'unit-backed', section: '`DocumentReferencePlatform` — document operations',
    api: 'DocumentReferencePlatform.snapshots(options)', behavior: 'Returns a broadcast Stream emitting DocumentSnapshotPlatform on document changes.', featureKeys: ['snapshots'] }),

  // ── 3. QueryPlatform: Filters & Constraints ──────────────────────────────
  row({ ref: 21, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.where(field, isEqualTo: value)', behavior: 'Filters documents matching exact field equality.', featureKeys: ['where'] }),
  row({ ref: 22, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.where(field, isNotEqualTo: value)', behavior: 'Filters documents where field does not equal specified value.', featureKeys: ['where'] }),
  row({ ref: 23, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.where(field, isLessThan / isLessThanOrEqualTo / isGreaterThan / isGreaterThanOrEqualTo)', behavior: 'Applies relational range comparison filters on field value.', featureKeys: ['where'] }),
  row({ ref: 24, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.where(field, arrayContains: value)', behavior: 'Filters documents where array field contains the specified element.', featureKeys: ['where', 'arrayContains'] }),
  row({ ref: 25, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.where(field, arrayContainsAny: values)', behavior: 'Filters documents where array field contains any element from the values list.', featureKeys: ['where', 'arrayContainsAny'] }),
  row({ ref: 26, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.where(field, whereIn: values)', behavior: 'Filters documents where field value matches any element in values list (IN query).', featureKeys: ['where', 'whereIn'] }),
  row({ ref: 27, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.where(field, whereNotIn: values)', behavior: 'Filters documents where field value matches no element in values list (NOT IN query).', featureKeys: ['where', 'whereNotIn'] }),
  row({ ref: 28, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.where(field, isNull: true/false)', behavior: 'Filters documents based on null equality or field existence.', featureKeys: ['where', 'isNull'] }),
  row({ ref: 29, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.orderBy(field, descending: bool)', behavior: 'Orders query results by field ascending or descending.', featureKeys: ['orderBy'] }),
  row({ ref: 30, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.limit(limit)', behavior: 'Limits maximum number of matched documents returned.', featureKeys: ['limit'] }),
  row({ ref: 31, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.limitToLast(limit)', behavior: 'Limits query results to the last N documents relative to query ordering.', featureKeys: ['limitToLast'] }),
  row({ ref: 32, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.startAt(values) / startAfter(values)', behavior: 'Positions starting cursor boundary using field values.', featureKeys: ['startAt', 'startAfter'] }),
  row({ ref: 33, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.endAt(values) / endBefore(values)', behavior: 'Positions ending cursor boundary using field values.', featureKeys: ['endAt', 'endBefore'] }),
  row({ ref: 34, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.startAtDocument / endAtDocument', behavior: 'Positions query pagination cursors using DocumentSnapshotPlatform instances.', featureKeys: ['startAtDocument', 'endAtDocument'] }),
  row({ ref: 35, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.get(options)', behavior: 'Executes query and returns QuerySnapshotPlatform containing matched documents.', featureKeys: ['get'] }),
  row({ ref: 36, flipped: 'unit-backed', section: '`QueryPlatform` — filters & constraints',
    api: 'QueryPlatform.snapshots(options)', behavior: 'Returns broadcast stream emitting QuerySnapshotPlatform upon matching changes.', featureKeys: ['snapshots'] }),

  // ── 4. CollectionReferencePlatform: Collection Operations ────────────────
  row({ ref: 37, flipped: 'unit-backed', section: '`CollectionReferencePlatform` — collection operations',
    api: 'CollectionReferencePlatform.doc([path])', behavior: 'Returns DocumentReferencePlatform under collection; auto-generates 20-char ID if path omitted.', featureKeys: ['doc'] }),
  row({ ref: 38, flipped: 'unit-backed', section: '`CollectionReferencePlatform` — collection operations',
    api: 'CollectionReferencePlatform.add(data)', behavior: 'Generates auto-ID, writes document data, and returns DocumentReferencePlatform.', featureKeys: ['add'] }),

  // ── 5. Snapshots & Metadata ──────────────────────────────────────────────
  row({ ref: 39, flipped: 'unit-backed', section: 'Snapshots & metadata',
    api: 'DocumentSnapshotPlatform.exists', behavior: 'Reports true if document is present in Firestore; false if absent.', featureKeys: ['exists'] }),
  row({ ref: 40, flipped: 'unit-backed', section: 'Snapshots & metadata',
    api: 'DocumentSnapshotPlatform.data()', behavior: 'Returns revived Map<String, dynamic> containing document field data.', featureKeys: ['data'] }),
  row({ ref: 41, flipped: 'unit-backed', section: 'Snapshots & metadata',
    api: 'DocumentSnapshotPlatform.get(field)', behavior: 'Extracts single field value supporting dot notation or FieldPath instances.', featureKeys: ['get'] }),
  row({ ref: 42, flipped: 'unit-backed', section: 'Snapshots & metadata',
    api: 'SnapshotMetadataPlatform (hasPendingWrites, isFromCache)', behavior: 'Exposes local cache and uncommitted pending write status on snapshots.', featureKeys: ['metadata'] }),
  row({ ref: 43, flipped: 'unit-backed', section: 'Snapshots & metadata',
    api: 'QuerySnapshotPlatform.docs', behavior: 'Provides ordered List<DocumentSnapshotPlatform> of all query result documents.', featureKeys: ['docs'] }),
  row({ ref: 44, flipped: 'unit-backed', section: 'Snapshots & metadata',
    api: 'QuerySnapshotPlatform.docChanges', behavior: 'Exposes List<DocumentChangePlatform> detailing added, modified, removed types and index shifts.', featureKeys: ['docChanges'] }),

  // ── 6. WriteBatchPlatform: Atomic Batches ─────────────────────────────────
  row({ ref: 45, flipped: 'unit-backed', section: '`WriteBatchPlatform` — atomic batches',
    api: 'WriteBatchPlatform.set(path, data, options)', behavior: 'Enqueues set or merge operation into atomic mutation batch.', featureKeys: ['set', 'batch'] }),
  row({ ref: 46, flipped: 'unit-backed', section: '`WriteBatchPlatform` — atomic batches',
    api: 'WriteBatchPlatform.update(path, data)', behavior: 'Enqueues update operation into atomic mutation batch.', featureKeys: ['update', 'batch'] }),
  row({ ref: 47, flipped: 'unit-backed', section: '`WriteBatchPlatform` — atomic batches',
    api: 'WriteBatchPlatform.delete(path)', behavior: 'Enqueues delete operation into atomic mutation batch.', featureKeys: ['delete', 'batch'] }),
  row({ ref: 48, flipped: 'unit-backed', section: '`WriteBatchPlatform` — atomic batches',
    api: 'WriteBatchPlatform.commit()', behavior: 'Atomically commits all enqueued mutations across multiple documents.', featureKeys: ['commit', 'batch'] }),

  // ── 7. TransactionPlatform: Interactive Transactions ─────────────────────
  row({ ref: 49, flipped: 'unit-backed', section: '`TransactionPlatform` — interactive transactions',
    api: 'TransactionPlatform.get(path)', behavior: 'Reads document snapshot within transaction context and acquires read lock.', featureKeys: ['get', 'transaction'] }),
  row({ ref: 50, flipped: 'unit-backed', section: '`TransactionPlatform` — interactive transactions',
    api: 'TransactionPlatform.set(path, data, options)', behavior: 'Enqueues transactional set mutation to be committed on handler completion.', featureKeys: ['set', 'transaction'] }),
  row({ ref: 51, flipped: 'unit-backed', section: '`TransactionPlatform` — interactive transactions',
    api: 'TransactionPlatform.update(path, data)', behavior: 'Enqueues transactional update mutation to be committed on handler completion.', featureKeys: ['update', 'transaction'] }),
  row({ ref: 52, flipped: 'unit-backed', section: '`TransactionPlatform` — interactive transactions',
    api: 'TransactionPlatform.delete(path)', behavior: 'Enqueues transactional delete mutation to be committed on handler completion.', featureKeys: ['delete', 'transaction'] }),
  row({ ref: 53, section: '`TransactionPlatform` — interactive transactions',
    api: 'TransactionPlatform retry mechanism', behavior: 'Catches optimistic locking conflicts and re-executes handler up to maxAttempts.', featureKeys: ['runTransaction'] }),

  // ── 8. FieldValuePlatform: Sentinels & Transformations ───────────────────
  row({ ref: 54, flipped: 'unit-backed', section: '`FieldValuePlatform` — sentinels & transformations',
    api: 'FieldValuePlatform.serverTimestamp()', behavior: 'Encodes sentinel replaced by server commit timestamp during write.', featureKeys: ['serverTimestamp'] }),
  row({ ref: 55, flipped: 'unit-backed', section: '`FieldValuePlatform` — sentinels & transformations',
    api: 'FieldValuePlatform.delete()', behavior: 'Encodes sentinel that deletes the target field during document update.', featureKeys: ['deleteField'] }),
  row({ ref: 56, flipped: 'unit-backed', section: '`FieldValuePlatform` — sentinels & transformations',
    api: 'FieldValuePlatform.increment(value)', behavior: 'Encodes numeric transformation operand that atomically increments field value.', featureKeys: ['increment'] }),
  row({ ref: 57, flipped: 'unit-backed', section: '`FieldValuePlatform` — sentinels & transformations',
    api: 'FieldValuePlatform.arrayUnion(elements)', behavior: 'Encodes transformation adding elements to array field if absent.', featureKeys: ['arrayUnion'] }),
  row({ ref: 58, flipped: 'unit-backed', section: '`FieldValuePlatform` — sentinels & transformations',
    api: 'FieldValuePlatform.arrayRemove(elements)', behavior: 'Encodes transformation removing matching elements from array field.', featureKeys: ['arrayRemove'] }),

  // ── 9. Data Types & Value Codecs: Serialization ──────────────────────────
  row({ ref: 59, flipped: 'unit-backed', section: 'Data types & value codecs',
    api: 'Timestamp codec', behavior: 'Serializes and revives Timestamp preserving seconds and nanoseconds across bridge wire format.', featureKeys: ['Timestamp'] }),
  row({ ref: 60, flipped: 'unit-backed', section: 'Data types & value codecs',
    api: 'GeoPoint codec', behavior: 'Serializes and revives GeoPoint coordinates (latitude, longitude) over WebSocket bridge.', featureKeys: ['GeoPoint'] }),
  row({ ref: 61, flipped: 'unit-backed', section: 'Data types & value codecs',
    api: 'Blob codec', behavior: 'Serializes Uint8List byte buffers to base64 bridge wire format and revives them as Blob.', featureKeys: ['Blob'] }),
  row({ ref: 62, flipped: 'unit-backed', section: 'Data types & value codecs',
    api: 'DocumentReference codec', behavior: 'Encodes and decodes DocumentReferencePlatform values stored within document fields.', featureKeys: ['DocumentReference'] }),
  row({ ref: 63, flipped: 'unit-backed', section: 'Data types & value codecs',
    api: 'Nested Map and List collections', behavior: 'Deeply encodes and revives recursive nested Maps and Lists containing mixed primitives and sentinels.', featureKeys: ['data'] }),

  // ── 10. Aggregations & Advanced Queries ──────────────────────────────────
  row({ ref: 64, flipped: 'unit-backed', section: 'Aggregations & advanced queries',
    api: 'AggregateQueryPlatform.count()', behavior: 'Returns count of matched documents without pulling full document payloads.', featureKeys: ['count'] }),
  row({ ref: 65, flipped: 'unit-backed', section: 'Aggregations & advanced queries',
    api: 'AggregateQueryPlatform.aggregate(sum, average)', behavior: 'Computes server-side numeric sum and average across matched query documents.', featureKeys: ['aggregate'] }),
];

const INTRO = `# Flutter Cloud Firestore integration compatibility

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — containerized Dart test matches platform interface under replay |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match platform interface but does not |
| — | **Not implemented yet** — explicitly outside the implemented slice |
| ? | **Unverified** — platform interface behavior not yet verified in container |
`;

export const firestoreFlutterRegistry: CompatibilitySurfaceRegistry = {
  surface: 'firestore-flutter',
  label: 'Firestore · Flutter',
  compatPath: 'packages/conformance/docs/firestore-flutter/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    {
      kind: 'table',
      prefix: '## `FirebaseFirestorePlatform` — instance & lifecycle\n',
      rows: firestoreFlutterRows.filter((r) => r.section.includes('FirebaseFirestorePlatform')),
    },
    {
      kind: 'table',
      prefix: '## `DocumentReferencePlatform` — document operations\n',
      rows: firestoreFlutterRows.filter((r) => r.section.includes('DocumentReferencePlatform')),
    },
    {
      kind: 'table',
      prefix: '## `QueryPlatform` — filters & constraints\n',
      rows: firestoreFlutterRows.filter((r) => r.section.includes('QueryPlatform')),
    },
    {
      kind: 'table',
      prefix: '## `CollectionReferencePlatform` — collection operations\n',
      rows: firestoreFlutterRows.filter((r) => r.section.includes('CollectionReferencePlatform')),
    },
    {
      kind: 'table',
      prefix: '## Snapshots & metadata\n',
      rows: firestoreFlutterRows.filter((r) => r.section === 'Snapshots & metadata'),
    },
    {
      kind: 'table',
      prefix: '## `WriteBatchPlatform` — atomic batches\n',
      rows: firestoreFlutterRows.filter((r) => r.section.includes('WriteBatchPlatform')),
    },
    {
      kind: 'table',
      prefix: '## `TransactionPlatform` — interactive transactions\n',
      rows: firestoreFlutterRows.filter((r) => r.section.includes('TransactionPlatform')),
    },
    {
      kind: 'table',
      prefix: '## `FieldValuePlatform` — sentinels & transformations\n',
      rows: firestoreFlutterRows.filter((r) => r.section.includes('FieldValuePlatform')),
    },
    {
      kind: 'table',
      prefix: '## Data types & value codecs\n',
      rows: firestoreFlutterRows.filter((r) => r.section === 'Data types & value codecs'),
    },
    {
      kind: 'table',
      prefix: '## Aggregations & advanced queries\n',
      rows: firestoreFlutterRows.filter((r) => r.section === 'Aggregations & advanced queries'),
    },
  ],
};

export default firestoreFlutterRegistry;
