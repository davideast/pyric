import type { JsonValue } from './sandbox/data-tree.js';
import { targetOf } from './routing.js';
import type { Database } from './types.js';

// ─── Sandbox-only ops ───────────────────────────────────────────────
//
// Mirrors `pyric/firestore`'s `sandbox` namespace — explicit
// per-package sandbox lifecycle.

export const DEFAULT_DENY_RTDB_RULES: { rules: Record<string, unknown> } = {
  rules: {
    '.read': false,
    '.write': false,
  },
};

export const DEFAULT_OPEN_RTDB_RULES: { rules: Record<string, unknown> } = {
  rules: {
    '.read': true,
    '.write': true,
  },
};

export const sandbox = {
  DEFAULT_DENY_RULES: DEFAULT_DENY_RTDB_RULES,
  DEFAULT_OPEN_RULES: DEFAULT_OPEN_RTDB_RULES,

  /**
   * Set the default access policy when no rules are loaded ('allow' or 'deny').
   * In 'deny' mode (matching production Firebase), all client reads and writes
   * without rules are rejected with PERMISSION_DENIED.
   */
  setDefaultPolicy(db: Database, policy: 'allow' | 'deny'): void {
    const target = targetOf(db);
    target.backend.setDefaultPolicy(policy);
  },

  /**
   * Replace deployed rules. Pass `null` to clear (sandbox returns to
   * default policy). Rules are evaluated through the existing
   * RTDB rules simulator — the same engine used by the rules tooling.
   *
   * @example
   * ```ts
   * sandbox.setRules(db, {
   *   rules: {
   *     '.read': 'auth != null',
   *     '.write': 'auth != null',
   *   },
   * });
   * ```
   */
  setRules(db: Database, rulesJson: { rules: Record<string, unknown> } | null): void {
    const target = targetOf(db);
    target.backend.setRules(rulesJson);
  },

  /**
   * Bulk-load data bypassing rules. The supplied map's keys are
   * absolute paths (`'/users/alice'`) and the values land at those
   * paths. Convenient for test fixtures.
   */
  setData(db: Database, data: Record<string, unknown>): void {
    const target = targetOf(db);
    target.backend.setData(data as Record<string, JsonValue>);
  },

  /** Snapshot the full sandbox tree (rule-bypass read). Usually a keyed
   *  object; may be a primitive when the root holds one (DB-B13). */
  snapshotState(db: Database): JsonValue {
    const target = targetOf(db);
    return target.backend.snapshotState();
  },
};
