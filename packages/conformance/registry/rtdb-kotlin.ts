import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const CONFORMANCE_SUITE = 'packages/kt-client/src/test/kotlin/dev/pyric/database/RtdbConformanceTest.kt';

const buildRow = defineRows({
  surface: 'rtdb-kotlin',
});

interface KotlinRtdbRowSeed {
  ref: string;
  section: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
}

function row(seed: KotlinRtdbRowSeed): CompatibilityRow {
  const { ref, evidence, ...rest } = seed;
  const resolvedEvidence = evidence ?? 'com.google.firebase:firebase-database specification.';
  return buildRow({
    ...rest,
    rowRef: ref,
    status: 'conforms',
    automation: 'unit-backed',
    evidence: `${resolvedEvidence} Test: \`${CONFORMANCE_SUITE}\` assertion set \`rtdb-kotlin#${ref}\`.`,
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

export const rtdbKotlinRows: CompatibilityRow[] = [
  // ── 1. Database Instance & Connection (5 rows) ────────────────────────────
  row({
    ref: 'instance-default',
    section: SEC_INSTANCE,
    api: 'FirebaseDatabase.getInstance() / Firebase.database',
    behavior: 'Returns the default FirebaseDatabase instance bound to the active bridge connection.',
    featureKeys: ['getInstance'],
  }),
  row({
    ref: 'instance-url',
    section: SEC_INSTANCE,
    api: 'FirebaseDatabase.getInstance(url) / Firebase.database(url)',
    behavior: 'Returns an isolated FirebaseDatabase instance targeting a specific database URL.',
    featureKeys: ['getInstanceUrl'],
  }),
  row({
    ref: 'ref-root',
    section: SEC_INSTANCE,
    api: 'FirebaseDatabase.reference',
    behavior: 'Returns a DatabaseReference pointing to the root of the Realtime Database.',
    featureKeys: ['reference'],
  }),
  row({
    ref: 'ref-path',
    section: SEC_INSTANCE,
    api: 'FirebaseDatabase.getReference(path)',
    behavior: 'Returns a DatabaseReference pointing to the specified slash-delimited path.',
    featureKeys: ['getReference'],
  }),
  row({
    ref: 'connection-toggle',
    section: SEC_INSTANCE,
    api: 'FirebaseDatabase.goOffline() / goOnline()',
    behavior: 'Suspends and resumes the Realtime Database connection to the Pyric worker.',
    featureKeys: ['goOffline', 'goOnline'],
  }),

  // ── 2. DatabaseReference Navigation & Properties (7 rows) ────────────────
  row({
    ref: 'ref-child',
    section: SEC_REF,
    api: 'DatabaseReference.child(path)',
    behavior: 'Returns a child DatabaseReference relative to the current path.',
    featureKeys: ['child'],
  }),
  row({
    ref: 'ref-parent',
    section: SEC_REF,
    api: 'DatabaseReference.parent',
    behavior: 'Returns the parent DatabaseReference, or null when called on the root reference.',
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
    behavior: 'Returns the last path segment token of the reference, or null for the root reference.',
    featureKeys: ['key'],
  }),
  row({
    ref: 'ref-path-prop',
    section: SEC_REF,
    api: 'DatabaseReference.path',
    behavior: 'Returns the normalized slash-delimited full path of the reference.',
    featureKeys: ['path'],
  }),
  row({
    ref: 'ref-push',
    section: SEC_REF,
    api: 'DatabaseReference.push()',
    behavior: 'Generates a new child DatabaseReference with a chronologically ordered unique push ID.',
    featureKeys: ['push'],
  }),
  row({
    ref: 'ref-push-key-ordering',
    section: SEC_REF,
    api: 'DatabaseReference.push().key',
    behavior: 'Monotonically orders generated push keys lexicographically by creation timestamp.',
    featureKeys: ['pushKeyOrdering'],
  }),

  // ── 3. Write Operations (6 rows) ─────────────────────────────────────────
  row({
    ref: 'write-set',
    section: SEC_WRITE,
    api: 'DatabaseReference.setValue(value)',
    behavior: 'Overwrites data at the reference path with the provided value.',
    featureKeys: ['setValue'],
  }),
  row({
    ref: 'write-set-null',
    section: SEC_WRITE,
    api: 'DatabaseReference.setValue(null)',
    behavior: 'Deletes data at the reference path when setValue is called with null.',
    featureKeys: ['setValueNull'],
  }),
  row({
    ref: 'write-set-priority',
    section: SEC_WRITE,
    api: 'DatabaseReference.setPriority(priority)',
    behavior: 'Updates the ordering priority metadata of the node without altering its value.',
    featureKeys: ['setPriority'],
  }),
  row({
    ref: 'write-set-with-priority',
    section: SEC_WRITE,
    api: 'DatabaseReference.setValue(value, priority)',
    behavior: 'Atomically writes the node value alongside its ordering priority metadata.',
    featureKeys: ['setValueWithPriority'],
  }),
  row({
    ref: 'write-update',
    section: SEC_WRITE,
    api: 'DatabaseReference.updateChildren(update)',
    behavior: 'Performs a multi-path atomic update of specified child keys without overwriting omitted siblings.',
    featureKeys: ['updateChildren'],
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
    api: 'ServerValue.TIMESTAMP',
    behavior: 'Resolves server-side timestamp sentinel into current epoch milliseconds upon write.',
    featureKeys: ['serverTimestamp'],
  }),
  row({
    ref: 'sentinel-increment',
    section: SEC_SENTINELS,
    api: 'ServerValue.increment(delta)',
    behavior: 'Atomically increments the numeric value at the target path by delta on the server.',
    featureKeys: ['serverIncrement'],
  }),

  // ── 5. One-Shot Reads & DataSnapshot Inspection (7 rows) ─────────────────
  row({
    ref: 'read-get',
    section: SEC_READ,
    api: 'DatabaseReference.get()',
    behavior: 'Fetches a one-shot DataSnapshot of the current data at the reference path.',
    featureKeys: ['get'],
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
    api: 'DataSnapshot.value / getValue()',
    behavior: 'Returns the deserialized Kotlin value (Map, List, String, Number, Boolean, or null) of the snapshot.',
    featureKeys: ['snapshotValue'],
  }),
  row({
    ref: 'snap-children',
    section: SEC_READ,
    api: 'DataSnapshot.children',
    behavior: 'Returns an iterable of child DataSnapshots ordered according to the active query.',
    featureKeys: ['children'],
  }),
  row({
    ref: 'snap-child-path',
    section: SEC_READ,
    api: 'DataSnapshot.child(path)',
    behavior: 'Returns a DataSnapshot for the relative descendant path within the snapshot.',
    featureKeys: ['snapshotChild'],
  }),
  row({
    ref: 'snap-priority',
    section: SEC_READ,
    api: 'DataSnapshot.priority',
    behavior: 'Returns the priority value (String, Number, or null) associated with the snapshot node.',
    featureKeys: ['priority'],
  }),

  // ── 6. Realtime Listeners & Streams (5 rows) ─────────────────────────────
  row({
    ref: 'listen-value',
    section: SEC_LISTEN,
    api: 'Query.snapshots / addValueEventListener',
    behavior: 'Emits DataSnapshot initially and upon any data change at the path via Kotlin Flow or listener.',
    featureKeys: ['snapshots', 'addValueEventListener'],
  }),
  row({
    ref: 'listen-child-added',
    section: SEC_LISTEN,
    api: 'Query.childEvents / onChildAdded',
    behavior: 'Emits ChildEvent.Added for each existing child and whenever a new child is added.',
    featureKeys: ['onChildAdded'],
  }),
  row({
    ref: 'listen-child-changed',
    section: SEC_LISTEN,
    api: 'Query.childEvents / onChildChanged',
    behavior: 'Emits ChildEvent.Changed whenever an existing child node is modified.',
    featureKeys: ['onChildChanged'],
  }),
  row({
    ref: 'listen-child-removed',
    section: SEC_LISTEN,
    api: 'Query.childEvents / onChildRemoved',
    behavior: 'Emits ChildEvent.Removed whenever a child node is removed from the watched location.',
    featureKeys: ['onChildRemoved'],
  }),
  row({
    ref: 'listen-cancel',
    section: SEC_LISTEN,
    api: 'Query.removeEventListener / Job.cancel()',
    behavior: 'Cancels the active listener or coroutine Flow collection and unsubscribes the worker listener.',
    featureKeys: ['removeEventListener'],
  }),

  // ── 7. Query Ordering, Filtering & Limits (6 rows) ───────────────────────
  row({
    ref: 'query-order-by-child',
    section: SEC_QUERY,
    api: 'Query.orderByChild(path)',
    behavior: 'Orders query results by the value of the specified nested child key.',
    featureKeys: ['orderByChild'],
  }),
  row({
    ref: 'query-order-by-key',
    section: SEC_QUERY,
    api: 'Query.orderByKey()',
    behavior: 'Orders query results lexicographically by child key name.',
    featureKeys: ['orderByKey'],
  }),
  row({
    ref: 'query-order-by-value',
    section: SEC_QUERY,
    api: 'Query.orderByValue()',
    behavior: 'Orders query results by direct scalar node values.',
    featureKeys: ['orderByValue'],
  }),
  row({
    ref: 'query-equal-to',
    section: SEC_QUERY,
    api: 'Query.equalTo(value, key)',
    behavior: 'Filters query results to nodes matching the exact sort value and optional key.',
    featureKeys: ['equalTo'],
  }),
  row({
    ref: 'query-range',
    section: SEC_QUERY,
    api: 'Query.startAt(value) / endAt(value)',
    behavior: 'Restricts query results to the inclusive lower and upper boundary values.',
    featureKeys: ['startAt', 'endAt'],
  }),
  row({
    ref: 'query-limit',
    section: SEC_QUERY,
    api: 'Query.limitToFirst(limit) / limitToLast(limit)',
    behavior: 'Caps query results to the first N or last N ordered child nodes.',
    featureKeys: ['limitToFirst', 'limitToLast'],
  }),

  // ── 8. Transactions & OnDisconnect (4 rows) ──────────────────────────────
  row({
    ref: 'tx-run',
    section: SEC_TX,
    api: 'DatabaseReference.runTransaction(handler)',
    behavior: 'Executes optimistic concurrency transaction handler on MutableData and commits upon success.',
    featureKeys: ['runTransaction'],
  }),
  row({
    ref: 'tx-abort',
    section: SEC_TX,
    api: 'Transaction.abort()',
    behavior: 'Aborts an in-progress transaction without writing changes to the database.',
    featureKeys: ['transactionAbort'],
  }),
  row({
    ref: 'ondisconnect-set-remove',
    section: SEC_TX,
    api: 'OnDisconnect.setValue(value) / removeValue()',
    behavior: 'Registers server-side write or removal operations to execute upon client disconnect.',
    featureKeys: ['onDisconnectSetRemove'],
  }),
  row({
    ref: 'ondisconnect-cancel',
    section: SEC_TX,
    api: 'OnDisconnect.cancel()',
    behavior: 'Cancels previously queued OnDisconnect operations at the reference path.',
    featureKeys: ['onDisconnectCancel'],
  }),
];

const INTRO = `# Realtime Database · Kotlin Compatibility

Integration compatibility ledger for the Pure-Kotlin Realtime Database client (\`packages/kt-client\`), conforming to \`com.google.firebase:firebase-database\` via Pyric WebSocket bridge transport.
`;

export const rtdbKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'rtdb-kotlin',
  label: 'Realtime Database · Kotlin',
  compatPath: 'packages/conformance/docs/rtdb-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    {
      kind: 'table',
      prefix: `## ${SEC_INSTANCE}\n`,
      rows: rtdbKotlinRows.filter((r) => r.section === SEC_INSTANCE),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_REF}\n`,
      rows: rtdbKotlinRows.filter((r) => r.section === SEC_REF),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_WRITE}\n`,
      rows: rtdbKotlinRows.filter((r) => r.section === SEC_WRITE),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_SENTINELS}\n`,
      rows: rtdbKotlinRows.filter((r) => r.section === SEC_SENTINELS),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_READ}\n`,
      rows: rtdbKotlinRows.filter((r) => r.section === SEC_READ),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_LISTEN}\n`,
      rows: rtdbKotlinRows.filter((r) => r.section === SEC_LISTEN),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_QUERY}\n`,
      rows: rtdbKotlinRows.filter((r) => r.section === SEC_QUERY),
    },
    {
      kind: 'table',
      prefix: `## ${SEC_TX}\n`,
      rows: rtdbKotlinRows.filter((r) => r.section === SEC_TX),
    },
  ],
};

export default rtdbKotlinRegistry;
