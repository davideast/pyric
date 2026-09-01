/**
 * Rule-enforcement helper shared by every gated operation. Pulled
 * out so `upload.ts`, `download.ts`, and `metadata.ts` don't each
 * grow their own copy of the same dispatch.
 *
 * Behavior:
 *   - No rules configured → deny. Matches Firebase production fail-closed
 *     security invariants: bare `getStorage` with no `rules` option
 *     rejects client operations with `storage/unauthorized`.
 *   - Rules configured → call `evaluateStorageRules`. Throw
 *     `storage/unauthorized` with the evaluator's `reasons` joined
 *     into the message on denial.
 *
 * `listAll` DOES call this (ST-B2): Firebase Storage's `read`
 * permission governs both download and list, so `list.ts` enforces a
 * `read` check on the scanned prefix path. A previous v1 scope build
 * silently bypassed list — that contradicted the rules-enforcement
 * contract (a denied tree was still enumerable). When no rules are
 * configured the check fails closed (default-deny).
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
import {
  storageOperationProvenance,
  type CrossServiceIam,
  type StorageService,
  type Target,
} from './service.js';
import { evaluateStorageRules } from './sandbox/rules-evaluator.js';
import { RuleEvalError } from './sandbox/rules-evaluation-error.js';
import type { EvaluationInput, FirestoreLookup } from './sandbox/rules.js';
import { unauthorized } from './errors.js';

export function enforceRules(
  service: StorageService,
  input: EvaluationInput,
  target?: Target,
  provenance?: EventProvenance,
): void {
  const boundProvenance = target?.kind === 'sandbox'
    ? storageOperationProvenance(target, provenance)
    : provenance;
  // Admin plane (internal `getAdminStorageSandbox` handles): rules are
  // bypassed entirely — firebase-admin semantics. See `SandboxTarget.admin`.
  // Rules never ran; the event still lands so Studio can show the op, with
  // `result: 'not-applicable'` + `origin: 'admin'` — the same shape RTDB's
  // admin plane (`adminSet`/`adminGet`/...) emits, with an explicit
  // bypass disposition independent of source or auth-lens presentation.
  if (target?.kind === 'sandbox' && target.admin === true) {
    emitOperation(target, input, 'not-applicable', undefined, 'admin', false, boundProvenance);
    return;
  }
  if (!service.rules) {
    const reasons = ['No Storage rules configured; default deny.'];
    emitOperation(target, input, 'deny', reasons, 'user', false, boundProvenance);
    throw unauthorized(input.request.method, input.request.path, ' — No Storage rules configured; default deny.');
  }
  const evaluationInput = target ? withCanonicalRulesPath(input, target.bucket) : input;
  const result = evaluateStorageRules(
    service.rules,
    evaluationInput,
    undefined,
    firestoreLookupFor(target, service.crossServiceIam),
  );
  if (!result.allowed) {
    emitOperation(target, input, 'deny', result.reasons, 'user', true, boundProvenance);
    const detail = result.reasons.length > 0 ? ` — ${result.reasons.join('; ')}` : '';
    throw unauthorized(input.request.method, input.request.path, detail);
  }
  emitOperation(target, input, 'allow', result.reasons, 'user', true, boundProvenance);
}

/**
 * Firebase's modular Storage SDK exposes object-relative references, while
 * Storage Rules match those objects below `/b/{bucket}/o`. Keep the public
 * reference, persistence key, errors, and emitted Traffic path object-relative;
 * canonicalize only the evaluator input at this boundary.
 */
function withCanonicalRulesPath(input: EvaluationInput, bucket: string): EvaluationInput {
  const objectPath = input.request.path.replace(/^\/+/, '');
  return {
    ...input,
    request: {
      ...input.request,
      path: objectPath === '' ? `b/${bucket}/o` : `b/${bucket}/o/${objectPath}`,
    },
  };
}

/**
 * Build + emit the `SandboxOperationEvent` for one enforcement decision.
 * No-op for bare `StorageService` calls with no `target` (unit tests that drive
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
  if (!target) return;
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
        rulesDisposition: origin === 'admin'
          ? { kind: 'bypassed', reason: 'admin' }
          : evaluated
            ? { kind: 'evaluated', verdict: result === 'deny' ? 'deny' : 'allow' }
            : { kind: 'not-evaluated', reason: 'no-rules' },
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

/**
 * Build the {@link FirestoreLookup} a rule's `firestore.get()/exists()`
 * calls read from. Only sandbox targets have Firestore data reachable
 * in-process: `sandbox.admin.getDocument` is a SYNCHRONOUS, rules-bypassing
 * in-memory read of the SAME per-sandbox store the user-plane writes to, so
 * the enforcement seam stays synchronous AND the lookup is invoked lazily
 * during evaluation (honoring short-circuit) exactly like production.
 *
 * Calls without a target get no lookup — a rule that reaches for
 * `firestore.*` there denies "unsupported" rather than false-allowing.
 *
 * `crossServiceIam: 'denied'` models the production project state WITHOUT
 * `roles/firebaserules.firestoreServiceAgent` on the Storage service agent:
 * the lookup capability is still injected (so path validation and laziness
 * behave identically), but every EXECUTED get/exists fails — see
 * {@link crossServiceIamDeniedLookup}.
 */
function firestoreLookupFor(
  target: Target | undefined,
  crossServiceIam: CrossServiceIam,
): FirestoreLookup | undefined {
  if (!target) return undefined;
  if (crossServiceIam === 'denied') return crossServiceIamDeniedLookup();
  const admin = target.sandbox.admin;
  return {
    get: (path) => admin.getDocument(path) as Record<string, unknown> | null,
    exists: (path) => admin.getDocument(path) !== null,
  };
}

/**
 * The `crossServiceIam: 'denied'` lookup: every executed
 * `firestore.get()/exists()` throws a {@link RuleEvalError} naming the
 * missing service-agent role, so the rule denies with that reason —
 * mirroring production's IAM-disabled boundary captured by conformance
 * observation `stdlib-realstorage-p3-lookup-budget` (row storage-rules#134):
 * every lookup-executing family DENIES while a short-circuited lookup is
 * never invoked and its rule still ALLOWS. The capture pins only that
 * executed-lookup/short-circuit boundary; how an IAM failure interacts
 * with CEL `&&`/`||` error absorption is NOT pinned by it (no absorption
 * family ran IAM-disabled), so this uses the same absorbable
 * {@link RuleEvalError} class as the existing no-capability deny path.
 *
 * Exported for the conformance replay test
 * (`packages/conformance/test/src/storage-stdlib-real-replay.test.ts`),
 * which runs the captured IAM-disabled matrix against the evaluator with
 * THIS production lookup — not a hand-rolled twin.
 */
export function crossServiceIamDeniedLookup(): FirestoreLookup {
  const fail = (method: 'get' | 'exists'): never => {
    throw new RuleEvalError(
      `firestore.${method}() failed: cross-service Firestore access is not authorized — ` +
        "the Storage service agent lacks roles/firebaserules.firestoreServiceAgent (crossServiceIam: 'denied')",
    );
  };
  return {
    get: () => fail('get'),
    exists: () => fail('exists'),
  };
}
