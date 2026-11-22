/**
 * Browser-safe named Cloud Firestore database helpers for verify captures,
 * case derivation, and replay (`verify/fixture.ts`, `verify/cases.ts`, `verify/firestore-verify.ts`).
 *
 * Node-only CLI file resolution (`--rules firestore:<database>=<path>` and
 * `firebase.json` lookup) lives in `./firestore-candidate-rules.js` so
 * `verify/fixture.ts` stays 100% browser-bundleable for `worker.js`.
 */
import {
  captureNamedFirestoreState,
  DEFAULT_FIRESTORE_DATABASE,
} from 'pyric/firestore/internal';
import type { Sandbox, SandboxEvent } from 'pyric/sandbox';
import {
  encodeSnapshotMap,
  rehydrateSnapshotDocument,
} from 'pyric/sandbox/internal';

import type {
  PyricVerifyFixture,
  VerifyFirestoreRulesBlock,
} from './fixture.js';

/** One named Firestore database in a capture: its active rules and encoded documents. */
export interface VerifyFirestoreDatabaseCapture {
  rules: VerifyFirestoreRulesBlock;
  state: { documents: Record<string, Record<string, unknown>> };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setOwnEntry<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Encode the `(default)` Firestore snapshot documents from `sandbox.snapshot()`. */
export function encodeDefaultFirestoreSnapshot(
  snapshot: ReturnType<Sandbox['snapshot']>,
): Record<string, Record<string, unknown>> {
  const firestoreDocuments: Record<string, Record<string, unknown>> = {};
  for (const [docPath, docData] of Object.entries(snapshot.firestore)) {
    const hydratedDoc = rehydrateSnapshotDocument(
      docData,
      snapshot.firestoreWrappers?.[docPath],
      snapshot.firestoreUnescapedMaps?.[docPath],
    );
    setOwnEntry(
      firestoreDocuments,
      docPath,
      encodeSnapshotMap(hydratedDoc) as Record<string, unknown>,
    );
  }
  return firestoreDocuments;
}

/** Capture every declared named Firestore database on `sandbox` (empty on mock stubs or `(default)`-only sandboxes). */
export function captureFirestoreDatabases(sandbox: unknown): {
  declared: string[];
  databases: Record<string, VerifyFirestoreDatabaseCapture>;
} {
  let captured;
  try {
    captured = captureNamedFirestoreState(sandbox as Sandbox);
  } catch {
    return { declared: [], databases: {} };
  }
  const databases: Record<string, VerifyFirestoreDatabaseCapture> = {};
  for (const dbId of captured.declared) {
    let rawDocs: Record<string, unknown> = {};
    if (Object.hasOwn(captured.databases, dbId)) {
      rawDocs = captured.databases[dbId] ?? {};
    }
    const docsCopy: Record<string, Record<string, unknown>> = {};
    for (const [docPath, docData] of Object.entries(rawDocs)) {
      setOwnEntry(docsCopy, docPath, docData as Record<string, unknown>);
    }
    const rulesSource = Object.hasOwn(captured.rules, dbId) ? captured.rules[dbId] ?? '' : '';
    setOwnEntry(databases, dbId, {
      rules: {
        format: 'firestore.rules',
        source: rulesSource,
      },
      state: { documents: docsCopy },
    });
  }
  return {
    declared: [...captured.declared],
    databases,
  };
}

/** Validate `fixture.services.firestore`, including optional `declared` and `databases`. */
export function assertFirestoreServiceRecord(value: unknown): void {
  if (!isPlainRecord(value)) {
    throw new Error('fixture.services.firestore must be an object.');
  }
  if (
    !isPlainRecord(value.rules) ||
    value.rules.format !== 'firestore.rules' ||
    typeof value.rules.source !== 'string'
  ) {
    throw new Error('fixture.services.firestore.rules must contain firestore.rules source.');
  }
  if (!isPlainRecord(value.state) || !isPlainRecord(value.state.documents)) {
    throw new Error('fixture.services.firestore.state.documents must be an object.');
  }
  assertFirestoreDatabasesCapture(value);
}

/** Validate optional `declared` and `databases` fields on `fixture.services.firestore`. */
function assertFirestoreDatabasesCapture(value: Record<string, unknown>): void {
  if (value.declared !== undefined) {
    if (
      !Array.isArray(value.declared) ||
      value.declared.some((entry) => typeof entry !== 'string' || entry.length === 0)
    ) {
      throw new Error(
        'fixture.services.firestore.declared must be an array of database id strings.',
      );
    }
  }
  if (value.databases === undefined) return;
  if (!isPlainRecord(value.databases)) {
    throw new Error('fixture.services.firestore.databases must be an object.');
  }
  for (const [name, entry] of Object.entries(value.databases)) {
    const label = `fixture.services.firestore.databases["${name}"]`;
    if (!isPlainRecord(entry)) {
      throw new Error(`${label} must be an object.`);
    }
    if (
      !isPlainRecord(entry.rules) ||
      entry.rules.format !== 'firestore.rules' ||
      typeof entry.rules.source !== 'string'
    ) {
      throw new Error(`${label}.rules must contain firestore.rules source.`);
    }
    if (!isPlainRecord(entry.state) || !isPlainRecord(entry.state.documents)) {
      throw new Error(`${label}.state.documents must be an object.`);
    }
  }
}

function isFirestoreFixtureEvent(event: SandboxEvent): boolean {
  if ('service' in event && typeof event.service === 'string') {
    return event.service === 'firestore';
  }
  return (
    event.kind === 'request' ||
    event.kind === 'write' ||
    event.kind === 'snapshot_delivery' ||
    event.kind === 'snapshot_suppressed' ||
    event.kind === 'listener_attach' ||
    event.kind === 'listener_detach' ||
    event.kind === 'listener_errored'
  );
}

/** Return the non-default Firestore database id for a Firestore event, or `undefined` for `(default)` / non-Firestore events. */
export function firestoreEventDatabase(event: SandboxEvent): string | undefined {
  if (!isFirestoreFixtureEvent(event)) return undefined;
  const direct = (event as { database?: unknown }).database;
  if (typeof direct === 'string' && direct.length > 0 && direct !== DEFAULT_FIRESTORE_DATABASE) {
    return direct;
  }
  const detailDb = (event as { detail?: { database?: unknown } }).detail?.database;
  if (
    typeof detailDb === 'string' &&
    detailDb.length > 0 &&
    detailDb !== DEFAULT_FIRESTORE_DATABASE
  ) {
    return detailDb;
  }
  return undefined;
}

function isDefaultFirestoreEvent(event: SandboxEvent): boolean {
  return isFirestoreFixtureEvent(event) && firestoreEventDatabase(event) === undefined;
}

/** Sorted list of named Firestore databases that a capture actually used (events or stored documents). */
export function recordedFirestoreDatabases(fixture: PyricVerifyFixture): string[] {
  const names = new Set<string>();
  const databases = fixture.services.firestore?.databases ?? {};
  for (const [name, entry] of Object.entries(databases)) {
    if (name !== DEFAULT_FIRESTORE_DATABASE && Object.keys(entry.state.documents).length > 0) {
      names.add(name);
    }
  }
  for (const event of fixture.events) {
    const dbId = firestoreEventDatabase(event);
    if (dbId !== undefined) names.add(dbId);
  }
  return [...names].sort();
}

/** Whether a capture used `(default)` (events on `(default)`, documents in `(default)`, or no named databases used). */
export function recordsDefaultFirestoreDatabase(fixture: PyricVerifyFixture): boolean {
  const defaultDocs = fixture.services.firestore?.state?.documents;
  const holdsData = defaultDocs !== undefined && Object.keys(defaultDocs).length > 0;
  const hasEvents = fixture.events.some(isDefaultFirestoreEvent);
  return hasEvents || holdsData || recordedFirestoreDatabases(fixture).length === 0;
}

/** Return a fixture view scoped to a single Firestore database (`undefined` for `(default)`). */
export function filterFixtureForFirestoreDatabase(
  fixture: PyricVerifyFixture,
  databaseId?: string,
): PyricVerifyFixture {
  let target: string | undefined;
  if (databaseId !== undefined && databaseId !== '' && databaseId !== DEFAULT_FIRESTORE_DATABASE) {
    target = databaseId;
  }
  const filteredEvents = fixture.events.filter((event) => {
    if (!isFirestoreFixtureEvent(event)) return true;
    return firestoreEventDatabase(event) === target;
  });

  const existingFirestore = fixture.services.firestore;
  if (!existingFirestore) {
    return {
      ...fixture,
      events: filteredEvents,
    };
  }

  let scopedRules: VerifyFirestoreRulesBlock;
  let scopedDocs: Record<string, Record<string, unknown>>;
  if (target === undefined) {
    scopedRules = existingFirestore.rules;
    scopedDocs = existingFirestore.state.documents;
  } else {
    let entry: VerifyFirestoreDatabaseCapture | undefined;
    if (
      existingFirestore.databases !== undefined &&
      Object.hasOwn(existingFirestore.databases, target)
    ) {
      entry = existingFirestore.databases[target];
    }
    scopedRules = entry?.rules ?? { format: 'firestore.rules', source: '' };
    scopedDocs = entry?.state.documents ?? {};
  }

  return {
    ...fixture,
    events: filteredEvents,
    services: {
      ...fixture.services,
      firestore: {
        rules: scopedRules,
        state: { documents: scopedDocs },
      },
    },
  };
}
