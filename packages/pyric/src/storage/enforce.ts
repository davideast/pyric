/**
 * Rule-enforcement helper shared by every gated operation. Pulled
 * out so `upload.ts`, `download.ts`, and `metadata.ts` don't each
 * grow their own copy of the same dispatch.
 *
 * Behavior:
 *   - No rules configured → allow. The v1 scope's session-archive
 *     ruleset is opt-in; bare `getStorage` with no `rules` option
 *     keeps the open-by-default semantics consistent with the
 *     pre-Slice-8 surface.
 *   - Rules configured → call `evaluateStorageRules`. Throw
 *     `storage/unauthorized` with the evaluator's `reasons` joined
 *     into the message on denial.
 *
 * `listAll` DOES call this (ST-B2): Firebase Storage's `read`
 * permission governs both download and list, so `list.ts` enforces a
 * `read` check on the scanned prefix path. A previous v1 scope build
 * silently bypassed list — that contradicted the rules-enforcement
 * contract (a denied tree was still enumerable). With no rules
 * configured the check is a no-op (open-by-default), so the
 * session-archive demo is unaffected.
 */
import type { StorageService, Target } from './service.js';
import { evaluateStorageRules, type EvaluationInput } from './rules.js';
import { unauthorized } from './errors.js';

export function enforceRules(
  service: StorageService,
  input: EvaluationInput,
  target?: Target,
): void {
  // Admin plane (internal `getAdminStorageSandbox` handles): rules are
  // bypassed entirely — firebase-admin semantics. See `SandboxTarget.admin`.
  if (target?.kind === 'sandbox' && target.admin === true) return;
  if (!service.rules) return;
  const result = evaluateStorageRules(service.rules, input);
  if (result.allowed) return;
  const detail = result.reasons.length > 0 ? ` — ${result.reasons.join('; ')}` : '';
  throw unauthorized(input.request.method, input.request.path, detail);
}
