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
 *
 * Studio observability (storage-denial-events): every enforcement
 * decision — allow, deny, AND admin-plane bypass — lands on the
 * unified sandbox `onEvent`/`history()` stream as a `kind: 'operation'`
 * event, mirroring RTDB's `emitOperation` (see
 * `src/database/sandbox/backend.ts`) and Firestore's `RequestEvent`
 * deny path. Before this, a rules-denied storage op threw a plain
 * `StorageError` with NO trace on the event stream — invisible to
 * Studio's Traffic surface and the rules inspector. Field names are
 * chosen to match RTDB's `SandboxOperationEvent` exactly (`result`,
 * `reasons`, `rules.engine`/`.reason`, `origin`) so Traffic/inspector
 * work without Studio-side changes. The storage evaluator returns a
 * flat `{ allowed, reasons[] }` — no rule index/position is tracked —
 * so `rules.matchedRule`/`.ruleIndex` are always omitted rather than
 * fabricated.
 *
 * Emission is additive and best-effort: a throw from the emit path
 * never blocks the real allow/deny control flow, and a denial still
 * throws `StorageError` exactly as before — the error contract to
 * app code is unchanged.
 */
import { emitSandboxEvent, makeSandboxOperationEvent } from 'pyric/sandbox/internal';
import type { EventProvenance } from 'pyric/sandbox';
import type { StorageService, Target } from './service.js';
import { evaluateStorageRules, type EvaluationInput } from './rules.js';
import { unauthorized } from './errors.js';

export function enforceRules(
  service: StorageService,
  input: EvaluationInput,
  target?: Target,
  provenance?: EventProvenance,
): void {
  // Admin plane (internal `getAdminStorageSandbox` handles): rules are
  // bypassed entirely — firebase-admin semantics. See `SandboxTarget.admin`.
  // Rules never ran; the event still lands so Studio can show the op, with
  // `result: 'not-applicable'` + `origin: 'admin'` — the same shape RTDB's
  // admin plane (`adminSet`/`adminGet`/...) emits, which Studio's
  // `verdict.ts` classifies as `'admin'` regardless of `result`.
  if (target?.kind === 'sandbox' && target.admin === true) {
    emitOperation(target, input, 'not-applicable', undefined, 'admin', false, provenance);
    return;
  }
  if (!service.rules) {
    // Open-by-default: no rules configured, no evaluation happened.
    // Still emit `allow` for parity — an unrestricted op is legitimately
    // "allowed", just never evaluated.
    emitOperation(target, input, 'allow', undefined, 'user', false, provenance);
    return;
  }
  const result = evaluateStorageRules(service.rules, input);
  if (!result.allowed) {
    emitOperation(target, input, 'deny', result.reasons, 'user', true, provenance);
    const detail = result.reasons.length > 0 ? ` — ${result.reasons.join('; ')}` : '';
    throw unauthorized(input.request.method, input.request.path, detail);
  }
  emitOperation(target, input, 'allow', result.reasons, 'user', true, provenance);
}

/**
 * Build + emit the `SandboxOperationEvent` for one enforcement decision.
 * No-op for prod targets (rules are server-side; nothing to observe here)
 * and bare `StorageService` calls with no `target` (unit tests that drive
 * `enforceRules` directly without a sandbox handle).
 */
function emitOperation(
  target: Target | undefined,
  input: EvaluationInput,
  result: 'allow' | 'deny' | 'not-applicable',
  reasons: string[] | undefined,
  origin: 'user' | 'admin',
  evaluated: boolean,
  provenance: EventProvenance | undefined,
): void {
  if (!target || target.kind !== 'sandbox') return;
  try {
    emitSandboxEvent(
      target.sandbox,
      makeSandboxOperationEvent({
        service: 'storage',
        method: input.request.method,
        path: input.request.path,
        auth: input.request.auth,
        result,
        origin,
        reasons,
        rules: evaluated
          ? {
              engine: 'storage',
              reason: reasons && reasons.length > 0 ? reasons.join('; ') : undefined,
            }
          : undefined,
      }),
      { ...provenance, service: 'storage' },
    );
  } catch {
    // Observational — never let event emission break storage enforcement.
  }
}
