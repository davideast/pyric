import { FirebaseError } from 'pyric/app';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import type { LocalSandbox, SandboxRuleSources } from 'pyric/sandbox';
import { captureCheckpoint, isCheckpointEnvelope, restoreCheckpoint } from 'pyric/sandbox/checkpoints';
import { decodeImportBundle } from 'pyric/sandbox/internal';

export type ImportedStateOutcome =
  | { kind: 'checkpoint'; rules: SandboxRuleSources }
  | { kind: 'records'; rtdbRules: ReadonlyMap<string | undefined, { rules: Record<string, unknown> }> };

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
  const rtdbRules = extractPersistedRtdbRules(snapshot.services.rtdb);
  sandbox.loadSnapshot(snapshot);
  return { kind: 'records', rtdbRules };
}
