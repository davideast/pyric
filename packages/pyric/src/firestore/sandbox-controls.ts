/**
 * Firestore-specific controls for the public `pyric/sandbox/firestore`
 * subpath.
 *
 * The implementation stays with the Firestore module even though the package
 * export is nested below `pyric/sandbox`: central sandbox owns cross-service
 * lifecycle, while each Firebase surface owns its own backend controls.
 */
import type { Sandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';

import type { DocumentData, LintResult } from './types.js';

/** Load Firestore Rules into one sandbox and notify its live listeners. */
export function setRules(sandbox: Sandbox, source: string): LintResult {
  return getInternalEnv(sandbox).deployRules(source);
}

/** Replace Firestore documents in bulk, preserving rules and bypassing evaluation. */
export function seedDocuments(
  sandbox: Sandbox,
  documents: Record<string, DocumentData>,
): LintResult {
  const env = getInternalEnv(sandbox);
  return env.seed({ rules: env.getRules(), documents });
}
