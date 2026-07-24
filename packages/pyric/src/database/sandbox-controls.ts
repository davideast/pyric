/** RTDB-specific owner controls for the public `pyric/sandbox/database` seam. */
import type { LocalSandbox } from 'pyric/sandbox';

import { getOrCreateBackend } from './sandbox/backend-for.js';
import type { JsonValue } from './sandbox/data-tree.js';

export type RtdbRulesJson = { rules: Record<string, unknown> };

/** Replace the active RTDB rules. Pass `null` to restore default allow. */
export function setRules(
  sandbox: LocalSandbox,
  rules: RtdbRulesJson | null,
): void {
  getOrCreateBackend(sandbox).setRules(rules);
}

/** Read the currently active rules as detached JSON. */
export function getActiveRules(sandbox: LocalSandbox): RtdbRulesJson | null {
  return getOrCreateBackend(sandbox).getActiveRules();
}

/** Replace RTDB data in bulk without applying security rules. */
export function setData(
  sandbox: LocalSandbox,
  data: Record<string, unknown>,
): void {
  getOrCreateBackend(sandbox).setData(data as Record<string, JsonValue>);
}

/** Snapshot the complete RTDB tree without applying security rules. */
export function snapshotState(sandbox: LocalSandbox): JsonValue {
  return getOrCreateBackend(sandbox).snapshotState();
}
