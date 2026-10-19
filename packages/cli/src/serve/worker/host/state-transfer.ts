import { FirebaseError } from 'pyric/app';
import type { LocalSandbox, SandboxRuleSources } from 'pyric/sandbox';
import { captureCheckpoint, isCheckpointEnvelope, restoreCheckpoint } from 'pyric/sandbox/checkpoints';
import { decodeImportBundle } from 'pyric/sandbox/internal';

export type ImportedStateOutcome =
  | { kind: 'checkpoint'; rules: SandboxRuleSources }
  | { kind: 'records' };

/** Portable exports share the complete service state and validation of checkpoints. */
export async function exportStateBundle(sandbox: LocalSandbox): Promise<string> {
  return JSON.stringify(await captureCheckpoint(sandbox));
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
    return { kind: 'checkpoint', rules: value.state.rules };
  }
  const snapshot = decodeImportBundle(bundle);
  sandbox.loadSnapshot(snapshot);
  return { kind: 'records' };
}
