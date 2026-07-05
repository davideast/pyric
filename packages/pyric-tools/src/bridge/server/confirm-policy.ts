/**
 * Per-tool confirmation policies for prod-mode bridge.
 *
 * Pure data + lookup. No I/O, no side effects, no terminal access.
 * Lives separate from the prompt + handler so the policy decisions
 * are reviewable in one place — the file you grep when you ask
 * "does this tool require confirmation in prod?"
 *
 * Reads default to `never`; writes / deletes / deploys default to
 * `always`. Anything not in the table defaults to `always` in prod
 * mode (fail-safe). Sandbox mode uses `never` universally.
 */

export type ConfirmPolicy = 'never' | 'session' | 'always' | 'deny';

/**
 * Default policies for prod mode. Conservative: writes and deploys
 * always prompt; reads and pure compute never prompt.
 */
export const DEFAULT_PROD_POLICIES: ReadonlyMap<string, ConfirmPolicy> = new Map([
  // ── Reads / pure compute — never prompt ─────────────────────────
  ['firestore_get_document', 'never'],
  ['firestore_list_documents', 'never'],
  ['firestore_query_where', 'never'],
  ['sandbox_inspect', 'never'],
  ['firestore_get_rules', 'never'],
  ['firestore_get_index_status', 'never'],
  ['firestore_discover_paths', 'never'],
  ['firestore_extract_indexes', 'never'],
  ['firestore_lint_rules', 'never'],
  ['firestore_simulate_rules', 'never'],
  ['firestore_resolve_modules', 'never'],
  ['firestore_test_rules', 'never'],
  ['firestore_rules_stdlib_list', 'never'],
  ['firestore_rules_stdlib_get', 'never'],
  ['rtdb_get', 'never'],
  ['rtdb_get_rules', 'never'],
  ['rtdb_simulate_access', 'never'],
  ['rtdb_build_expression', 'never'],
  ['rtdb_crawl_structure', 'never'],

  // ── Writes — always prompt ──────────────────────────────────────
  ['firestore_create_document', 'always'],
  ['firestore_add_document', 'always'],
  ['firestore_update_document', 'always'],
  ['firestore_delete_document', 'always'],
  ['firestore_batch_write', 'always'],
  ['rtdb_set', 'always'],
  ['rtdb_update', 'always'],
  ['rtdb_push', 'always'],
  ['rtdb_delete', 'always'],
  ['rtdb_validated_write', 'always'],

  // ── Deploys / control plane — always prompt ─────────────────────
  ['firestore_deploy_rules', 'always'],
  ['firestore_ensure_rules', 'always'],
  ['firestore_provision_database', 'always'],
  ['firestore_deploy_indexes', 'always'],
  ['firestore_create_index', 'always'],
  ['rtdb_deploy_rules', 'always'],
  ['hosting_deploy', 'always'],
  ['hosting_ensure_site', 'always'],
  ['functions_deploy', 'always'],
]);

/** Sandbox mode bypasses confirmation entirely. */
export const DEFAULT_SANDBOX_POLICY: ConfirmPolicy = 'never';

/** Default for prod-mode tools NOT in DEFAULT_PROD_POLICIES — fail-safe. */
export const FALLBACK_PROD_POLICY: ConfirmPolicy = 'always';

export interface PolicyOverrides {
  /** Tool names to lower to `never` (auto-approve). */
  autoApprove?: string[];
  /** Tool names to raise to `always`. Overrides `autoApprove` if both list it. */
  requireConfirm?: string[];
  /** Force every tool to `always`, even reads. Paranoid mode. */
  requireConfirmAll?: boolean;
  /** Default policy for tools NOT in the base map. Prod defaults to `always`. */
  fallback?: ConfirmPolicy;
}

/**
 * Merge a base policy map with overrides. Returns a fresh map (does
 * not mutate the base). Use this once at bridge startup.
 *
 * Override precedence (high to low):
 *   1. requireConfirmAll: forces every key to `always`
 *   2. requireConfirm: forces listed keys to `always`
 *   3. autoApprove: lowers listed keys to `never`
 *   4. base map
 *
 * Unknown tools (not in base) get `fallback` (default `always` for
 * prod). Override mechanisms can introduce new keys: if `autoApprove`
 * lists a tool not in the base map, that tool gets `never`.
 */
export function buildPolicyMap(
  base: ReadonlyMap<string, ConfirmPolicy>,
  overrides: PolicyOverrides = {},
): Map<string, ConfirmPolicy> {
  const result = new Map(base);

  if (overrides.autoApprove) {
    for (const name of overrides.autoApprove) {
      result.set(name, 'never');
    }
  }
  if (overrides.requireConfirm) {
    for (const name of overrides.requireConfirm) {
      result.set(name, 'always');
    }
  }
  if (overrides.requireConfirmAll) {
    for (const name of result.keys()) {
      result.set(name, 'always');
    }
  }

  return result;
}

/**
 * Look up a tool's policy, falling back as appropriate.
 *
 *   - If the tool is in the map, return its mapped policy.
 *   - If not in the map AND `requireConfirmAll`, return `always`.
 *   - Otherwise return `fallback` (default `always` for prod).
 */
export function policyFor(
  policies: ReadonlyMap<string, ConfirmPolicy>,
  tool: string,
  fallback: ConfirmPolicy = FALLBACK_PROD_POLICY,
): ConfirmPolicy {
  return policies.get(tool) ?? fallback;
}
