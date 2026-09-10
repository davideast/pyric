import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const CONFORMANCE_SUITE = 'packages/swift-client/Tests/PyricDatabaseTests/RtdbConformanceTests.swift';

const buildRow = defineRows({
  surface: 'rtdb-swift',
});

interface SwiftRtdbRowSeed {
  ref: string;
  section: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
}

function row(seed: SwiftRtdbRowSeed): CompatibilityRow {
  const { ref, evidence, ...rest } = seed;
  const resolvedEvidence = evidence ?? 'FirebaseDatabase Swift specification.';
  return buildRow({
    ...rest,
    rowRef: ref,
    status: 'conforms',
    automation: 'unit-backed',
    evidence: `${resolvedEvidence} Swift test: \`${CONFORMANCE_SUITE}\` assertion set \`rtdb-swift#${ref}\`.`,
    conformanceTests: [CONFORMANCE_SUITE],
  });
}

const SEC_INSTANCE = 'Database Instance & Connection';
const SEC_REF = 'DatabaseReference Navigation & Properties';
const SEC_WRITE = 'Write Operations';
const SEC_SENTINELS = 'ServerValue Sentinels';
const SEC_READ = 'One-Shot Reads & DataSnapshot Inspection';
const SEC_LISTEN = 'Realtime Listeners & Streams';
const SEC_QUERY = 'Query Ordering, Filtering & Limits';
const SEC_TX = 'Transactions & OnDisconnect';

export const rtdbSwiftRows: CompatibilityRow[] = [
  // ── 1. Database Instance & Connection (5 rows) ────────────────────────────
  row({
    ref: 'instance-default',
    section: SEC_INSTANCE,
    api: 'Database.database()',
    behavior: 'Returns the default Database instance bound to the active bridge connection.',
    featureKeys: ['database'],
  }),
  row({
    ref: 'instance-url',
    section: SEC_INSTANCE,
    api: 'Database.database(url:)',
    behavior: 'Returns an isolated Database instance targeting a specific database URL.',
    featureKeys: ['databaseUrl'],
  }),
  row({
    ref: 'ref-root',
    section: SEC_INSTANCE,
    api: 'Database.reference()',
    behavior: 'Returns a DatabaseReference pointing to the root of the Realtime Database.',
    featureKeys: ['reference'],
  }),
  row({
    ref: 'ref-path',
    section: SEC_INSTANCE,
    api: 'Database.reference(withPath:)',
    behavior: 'Returns a DatabaseReference pointing to the specified slash-delimited path.',
    featureKeys: ['referenceWithPath'],
  }),
  row({
    ref: 'connection-toggle',
    section: SEC_INSTANCE,
    api: 'Database.goOffline() / goOnline()',
    behavior: 'Suspends and resumes the Realtime Database connection to the Pyric worker.',
    featureKeys: ['goOffline', 'goOnline'],
  }),

  // ── 2. DatabaseReference Navigation & Properties (7 rows) ────────────────
  row({
    ref: 'ref-child',
    section: SEC_REF,
    api: 'DatabaseReference.child(_:)',
    behavior: 'Returns a child DatabaseReference relative to the current path.',
    featureKeys: ['child'],
  }),
  row({
    ref: 'ref-parent',
    section: SEC_REF,
    api: 'DatabaseReference.parent',
    behavior: 'Returns the parent DatabaseReference, or nil when called on the root reference.',
    featureKeys: ['parent'],
  }),
  row({
    ref: 'ref-root-prop',
    section: SEC_REF,
    api: 'DatabaseReference.root',
    behavior: 'Returns the root DatabaseReference from any descendant reference.',
    featureKeys: ['root'],
  }),
  row({
    ref: 'ref-key',
    section: SEC_REF,
    api: 'DatabaseReference.key',
    behavior: 'Returns the last path segment token of the reference, or nil for the root reference.',
    featureKeys: ['key'],
  }),
  row({
    ref: 'ref-path-prop',
    section: SEC_REF,
    api: 'DatabaseReference.url / path',
    behavior: 'Returns the normalized slash-delimited full path of the reference.',
    featureKeys: ['path'],
  }),
  row({
    ref: 'ref-push',
    section: SEC_REF,
    api: 'DatabaseReference.childByAutoId()',
    behavior: 'Generates a new child DatabaseReference with a chronologically ordered unique push ID.',
    featureKeys: ['childByAutoId'],
  }),
  row({
    ref: 'ref-push-key-ordering',
    section: SEC_REF,
    api: 'DatabaseReference.childByAutoId().key',
    behavior: 'Monotonically orders generated push keys lexicographically by creation timestamp.',
    featureKeys: ['pushKeyOrdering'],
  }),

  // ── 3. Write Operations (6 rows) ─────────────────────────────────────────
  row({
    ref: 'write-set',
    section: SEC_WRITE,
    api: 'DatabaseReference.setValue(_:)',
    behavior: 'Overwrites data at the reference path with the provided JSON-serializable value.',
    featureKeys: ['setValue'],
  }),
  row({
    ref: 'write-set-null',
    section: SEC_WRITE,
    api: 'DatabaseReference.setValue(nil)',
    behavior: 'Deletes data at the reference path when setValue is called with nil.',
    featureKeys: ['setValueNil'],
  }),
  row({
    ref: 'write-set-priority',
    section: SEC_WRITE,
    api: 'DatabaseReference.setPriority(_:)',
    behavior: 'Updates the ordering priority metadata of the node without altering its value.',
    featureKeys: ['setPriority'],
  }),
  row({
    ref: 'write-set-with-priority',
    section: SEC_WRITE,
    api: 'DatabaseReference.setValue(_:andPriority:)',
    behavior: 'Atomically writes the node value alongside its ordering priority metadata.',
    featureKeys: ['setValueAndPriority'],
  }),
  row({
    ref: 'write-update',
    section: SEC_WRITE,
    api: 'DatabaseReference.updateChildValues(_:)',
    behavior: 'Performs a multi-path atomic update of specified child keys without overwriting omitted siblings.',
    featureKeys: ['updateChildValues'],
  }),
  row({
    ref: 'write-remove',
    section: SEC_WRITE,
    api: 'DatabaseReference.removeValue()',
    behavior: 'Removes the node and all descendant data at the reference path.',
    featureKeys: ['removeValue'],
  }),

  // ── 4. ServerValue Sentinels (2 rows) ────────────────────────────────────
  row({
    ref: 'sentinel-timestamp',
    section: SEC_SENTINELS,
    api: 'ServerValue.timestamp()',
    behavior: 'Resolves server-side timestamp sentinel into current epoch milliseconds upon write.',
    featureKeys: ['serverTimestamp'],
  }),
  row({
    ref: 'sentinel-increment',
    section: SEC_SENTINELS,
    api: 'ServerValue.increment(_:)',
    behavior: 'Atomically increments the numeric value at the target path by delta on the server.',
    featureKeys: ['serverIncrement'],
  }),

  // ── 5. One-Shot Reads & DataSnapshot Inspection (7 rows) ─────────────────
  row({
    ref: 'read-get',
    section: SEC_READ,
    api: 'DatabaseReference.getData()',
    behavior: 'Fetches a one-shot DataSnapshot of the current data at the reference path.',
    featureKeys: ['getData'],
  }),
  row({
    ref: 'snap-exists',
    section: SEC_READ,
    api: 'DataSnapshot.exists()',
    behavior: 'Returns true if the DataSnapshot contains non-null data.',
    featureKeys: ['exists'],
  }),
  row({
    ref: 'snap-key',
    section: SEC_READ,
    api: 'DataSnapshot.key',
    behavior: 'Returns the key name of the location that generated the DataSnapshot.',
    featureKeys: ['snapshotKey'],
  }),
  row({
    ref: 'snap-value',
    section: SEC_READ,
    api: 'DataSnapshot.value',
    behavior: 'Returns the deserialized Swift value (Dictionary, Array, String, NSNumber, or nil) of the snapshot.',
    featureKeys: ['snapshotValue'],
  }),
  row({
    ref: 'snap-children',
    section: SEC_READ,
    api: 'DataSnapshot.children',
    behavior: 'Returns an iterator of child DataSnapshots ordered according to the active query.',
    featureKeys: ['children'],
  }),
  row({
    ref: 'snap-child-path',
    section: SEC_READ,
    api: 'DataSnapshot.childSnapshot(forPath:)',
    behavior: 'Returns a DataSnapshot for the relative descendant path within the snapshot.',
    featureKeys: ['childSnapshot'],
  }),
  row({
    ref: 'snap-priority',
    section: SEC_READ,
    api: 'DataSnapshot.priority',
    behavior: 'Returns the priority value (String, NSNumber, or nil) associated with the snapshot node.',
    featureKeys: ['priority'],
  }),

  // ── 6. Realtime Listeners & Streams (5 rows) ─────────────────────────────
  row({
    ref: 'listen-value',
    section: SEC_LISTEN,
    api: 'DatabaseQuery.observe(.value) / valueStream',
    behavior: 'Emits DataSnapshot initially and upon any data change at the path via AsyncStream or observer.',
    featureKeys: ['observeValue', 'valueStream'],
  }),
  row({
    ref: 'listen-child-added',
    section: SEC_LISTEN,
    api: 'DatabaseQuery.observe(.childAdded) / childEvents',
    behavior: 'Emits childAdded event for each existing child and whenever a new child is added.',
    featureKeys: ['observeChildAdded'],
  }),
  row({
    ref: 'listen-child-changed',
    section: SEC_LISTEN,
    api: 'DatabaseQuery.observe(.childChanged) / childEvents',
    behavior: 'Emits childChanged event whenever an existing child node is modified.',
    featureKeys: ['observeChildChanged'],
  }),
  row({
    ref: 'listen-child-removed',
    section: SEC_LISTEN,
    api: 'DatabaseQuery.observe(.childRemoved) / childEvents',
    behavior: 'Emits childRemoved event whenever a child node is removed from the watched location.',
    featureKeys: ['observeChildRemoved'],
  }),
  row({
    ref: 'listen-cancel',
    section: SEC_LISTEN,
    api: 'DatabaseQuery.removeObserver(withHandle:)',
    behavior: 'Cancels the active observer or AsyncStream task and unsubscribes the worker listener.',
    featureKeys: ['removeObserver'],
  }),

  // ── 7. Query Ordering, Filtering & Limits (6 rows) ───────────────────────
  row({
    ref: 'query-order-by-child',
    section: SEC_QUERY,
    api: 'DatabaseQuery.queryOrdered(byChild:)',
    behavior: 'Orders query results by the value of the specified nested child key.',
    featureKeys: ['queryOrderedByChild'],
  }),
  row({
    ref: 'query-order-by-key',
    section: SEC_QUERY,
    api: 'DatabaseQuery.queryOrderedByKey()',
    behavior: 'Orders query results lexicographically by child key name.',
    featureKeys: ['queryOrderedByKey'],
  }),
  row({
    ref: 'query-order-by-value',
    section: SEC_QUERY,
    api: 'DatabaseQuery.queryOrderedByValue()',
    behavior: 'Orders query results by direct scalar node values.',
    featureKeys: ['queryOrderedByValue'],
  }),
  row({
    ref: 'query-equal-to',
    section: SEC_QUERY,
    api: 'DatabaseQuery.queryEqual(toValue:childKey:)',
    behavior: 'Filters query results to nodes matching the exact sort value and optional key.',
    featureKeys: ['queryEqualToValue'],
  }),
  row({
    ref: 'query-range',
    section: SEC_QUERY,
    api: 'DatabaseQuery.queryStarting(atValue:) / queryEnding(atValue:)',
    behavior: 'Restricts query results to the inclusive lower and upper boundary values.',
    featureKeys: ['queryStartingAtValue', 'queryEndingAtValue'],
  }),
  row({
    ref: 'query-limit',
    section: SEC_QUERY,
    api: 'DatabaseQuery.queryLimited(toFirst:) / queryLimited(toLast:)',
    behavior: 'Caps query results to the first N or last N ordered child nodes.',
    featureKeys: ['queryLimitedToFirst', 'queryLimitedToLast'],
  }),

  // ── 8. Transactions & OnDisconnect (4 rows) ──────────────────────────────
  row({
    ref: 'tx-run',
    section: SEC_TX,
    api: 'DatabaseReference.runTransactionBlock(_:)',
    behavior: 'Executes optimistic concurrency transaction block on MutableData and commits upon success.',
    featureKeys: ['runTransactionBlock'],
  }),
  row({
    ref: 'tx-abort',
    section: SEC_TX,
    api: 'TransactionResult.abort()',
    behavior: 'Aborts an in-progress transaction without writing changes to the database.',
    featureKeys: ['transactionAbort'],
  }),
  row({
    ref: 'ondisconnect-set-remove',
    section: SEC_TX,
    api: 'DatabaseReference.onDisconnectSetValue(_:) / onDisconnectRemoveValue()',
    behavior: 'Registers server-side write or removal operations to execute upon client disconnect.',
    featureKeys: ['onDisconnectSetRemove'],
  }),
  row({
    ref: 'ondisconnect-cancel',
    section: SEC_TX,
    api: 'DatabaseReference.cancelDisconnectOperations()',
    behavior: 'Cancels previously queued OnDisconnect operations at the reference path.',
    featureKeys: ['onDisconnectCancel'],
  }),
];

const INTRO = `# Realtime Database · Swift Compatibility

Integration compatibility ledger for the Pure-Swift Realtime Database client (\`packages/swift-client\`), conforming to \`FirebaseDatabase\` via Pyric WebSocket bridge transport.
`;

export const rtdbSwiftRegistry: CompatibilitySurfaceRegistry = {
  surface: 'rtdb-swift',
  label: 'Realtime Database · Swift',
  compatPath: 'packages/conformance/docs/rtdb-swift/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    {
      kind: 'table',
      prefix: `## ${SEC_INSTANCE}\n`,
      rows: rtdbSwiftRows.filter((r) => r.section === SEC_INSTANCE),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_REF}\n`,
      rows: rtdbSwiftRows.filter((r) => r.section === SEC_REF),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_WRITE}\n`,
      rows: rtdbSwiftRows.filter((r) => r.section === SEC_WRITE),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_SENTINELS}\n`,
      rows: rtdbSwiftRows.filter((r) => r.section === SEC_SENTINELS),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_READ}\n`,
      rows: rtdbSwiftRows.filter((r) => r.section === SEC_READ),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_LISTEN}\n`,
      rows: rtdbSwiftRows.filter((r) => r.section === SEC_LISTEN),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_QUERY}\n`,
      rows: rtdbSwiftRows.filter((r) => r.section === SEC_QUERY),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_TX}\n`,
      rows: rtdbSwiftRows.filter((r) => r.section === SEC_TX),
    },
  ],
};

export default rtdbSwiftRegistry;
