import { FirebaseError } from 'pyric/app';
import {
  captureNamedFirestoreState,
  DEFAULT_FIRESTORE_DATABASE,
  isValidFirestoreDatabaseId,
  listDeclaredFirestoreDatabases,
  readFirestoreDeclaredFromMeta,
  restoreNamedFirestorePersistence,
  restoreNamedFirestoreState,
  undeclareFirestoreDatabase,
  type NamedFirestoreCapturedState,
} from 'pyric/firestore/internal';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import type { LocalSandbox, SandboxRuleSources } from 'pyric/sandbox';
import {
  captureCheckpoint,
  isCheckpointEnvelope,
  restoreCheckpoint,
  type Checkpoint,
  type CheckpointBackend,
  type SavedCheckpoint,
} from 'pyric/sandbox/checkpoints';
import { decodeImportBundle } from 'pyric/sandbox/internal';

export type ImportedStateOutcome =
  | {
      kind: 'checkpoint';
      rules: SandboxRuleSources;
      firestoreDatabaseRules: Record<string, string>;
    }
  | {
      kind: 'records';
      rtdbRules: ReadonlyMap<string | undefined, { rules: Record<string, unknown> }>;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractPersistedRtdbRules(
  rtdbService: unknown,
): Map<string | undefined, { rules: Record<string, unknown> }> {
  const extracted = new Map<string | undefined, { rules: Record<string, unknown> }>();
  if (!isPlainRecord(rtdbService) || rtdbService['.pyricRtdbPersistence'] !== 1) {
    return extracted;
  }
  const collectOne = (selector: string | undefined, envelope: Record<string, unknown>): void => {
    if (!isPlainRecord(envelope.rules) || !isPlainRecord(envelope.rules.rules)) return;
    const candidate = { rules: envelope.rules.rules };
    const rejection = rtdbRulesSourceRejection(candidate);
    if (rejection !== null) {
      const target = selector ?? '(default)';
      throw new FirebaseError(
        'invalid-argument',
        `State import Realtime Database rules for '${target}' are invalid: ${rejection.message}`,
      );
    }
    extracted.set(selector, structuredClone(candidate));
  };
  collectOne(undefined, rtdbService);
  if (isPlainRecord(rtdbService.instances)) {
    for (const [name, instanceEnvelope] of Object.entries(rtdbService.instances)) {
      if (isPlainRecord(instanceEnvelope)) collectOne(name, instanceEnvelope);
    }
  }
  return extracted;
}

/** Attach named Firestore state and counts onto a captured checkpoint when declared. */
export function withNamedFirestoreCheckpoint(sandbox: LocalSandbox, checkpoint: Checkpoint): Checkpoint {
  const named = captureNamedFirestoreState(sandbox);
  if (named.declared.length === 0) {
    return checkpoint;
  }
  return {
    ...checkpoint,
    counts: {
      ...checkpoint.counts,
      firestore: checkpoint.counts.firestore + named.documentCount,
    },
    state: {
      ...checkpoint.state,
      firestoreNamed: named,
    } as Checkpoint['state'],
  };
}

/** Restore named Firestore state from a checkpoint and return active named rule sources. */
export function applyNamedFirestoreCheckpoint(
  sandbox: LocalSandbox,
  checkpoint: Checkpoint,
): Record<string, string> {
  const rawState = checkpoint.state as Checkpoint['state'] & {
    firestoreNamed?: NamedFirestoreCapturedState;
  };
  const { refusals } = restoreNamedFirestoreState(sandbox, rawState.firestoreNamed);
  if (refusals.length > 0) {
    throw new FirebaseError('invalid-argument', refusals.join('; '));
  }
  return rawState.firestoreNamed?.rules ?? {};
}

function importLegacyRecordNamedDatabases(sandbox: LocalSandbox, parsed: unknown): void {
  if (!isPlainRecord(parsed)) {
    for (const existingId of listDeclaredFirestoreDatabases(sandbox)) {
      undeclareFirestoreDatabase(sandbox, existingId);
    }
    return;
  }
  const rawRecords = isPlainRecord(parsed.records) ? parsed.records : undefined;
  const declared = new Set<string>(
    rawRecords !== undefined ? readFirestoreDeclaredFromMeta(rawRecords.meta) : [],
  );
  const databases = new Map<string, Iterable<[string, unknown]>>();
  if (isPlainRecord(parsed.firestoreDatabases)) {
    for (const [dbId, dbRecords] of Object.entries(parsed.firestoreDatabases)) {
      if (dbId === DEFAULT_FIRESTORE_DATABASE || !isValidFirestoreDatabaseId(dbId)) {
        throw new FirebaseError(
          'invalid-argument',
          `State import contains invalid Firestore database id '${dbId}'.`,
        );
      }
      if (!isPlainRecord(dbRecords)) continue;
      declared.add(dbId);
      databases.set(dbId, Object.entries(dbRecords));
    }
  }
  for (const existingId of listDeclaredFirestoreDatabases(sandbox)) {
    if (!declared.has(existingId)) {
      undeclareFirestoreDatabase(sandbox, existingId);
    }
  }
  if (declared.size > 0) {
    restoreNamedFirestorePersistence(sandbox, [...declared].sort(), databases);
  }
}

/** Capture the sandbox (including named Firestore databases) and store it under `name`. */
export async function saveCheckpoint(
  backend: CheckpointBackend,
  name: string,
  sandbox: LocalSandbox,
): Promise<SavedCheckpoint> {
  const overwrote = (await backend.read(name)) !== null;
  const checkpoint = withNamedFirestoreCheckpoint(
    sandbox,
    await captureCheckpoint(sandbox, { storage: backend.storage ?? 'inline' }),
  );
  await backend.write(name, checkpoint);
  return { name, overwrote, checkpoint };
}

/** Portable exports share the complete service state and validation of checkpoints. */
export async function exportStateBundle(sandbox: LocalSandbox): Promise<string> {
  const checkpoint = withNamedFirestoreCheckpoint(sandbox, await captureCheckpoint(sandbox));
  return JSON.stringify(checkpoint);
}

/** Report malformed JSON through the same caller error contract as invalid state. */
function parseStateBundle(bundle: string): unknown {
  try {
    return JSON.parse(bundle);
  } catch {
    throw new FirebaseError('invalid-argument', 'State import requires a JSON state bundle.');
  }
}

/** Read complete exports and preserve the import contract of older record bundles. */
export async function importStateBundle(sandbox: LocalSandbox, bundle: string): Promise<ImportedStateOutcome> {
  const value = parseStateBundle(bundle);
  const isCheckpoint = isCheckpointEnvelope(value);
  if (isCheckpoint) {
    await restoreCheckpoint(sandbox, value);
    const firestoreDatabaseRules = applyNamedFirestoreCheckpoint(sandbox, value);
    return { kind: 'checkpoint', rules: value.state.rules, firestoreDatabaseRules };
  }
  const snapshot = decodeImportBundle(bundle);
  const rtdbRules = extractPersistedRtdbRules(snapshot.services.rtdb);
  sandbox.loadSnapshot(snapshot);
  importLegacyRecordNamedDatabases(sandbox, value);
  return { kind: 'records', rtdbRules };
}
