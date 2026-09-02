import type { SimulationContext } from './evaluation-context.js';
import { ResourceLimitError } from './eval-error.js';
import { isDocumentPath, normalizeDocumentPath } from './document-lookups.js';

// ═══ Per-request document-lookup budget ═══
//
// Production hard-limits security-rule document access calls, get(),
// exists(), getAfter() and existsAfter(), to 10 per single-document request
// or query evaluation. Multi-document transactions and batched writes get
// an AGGREGATE budget of 20 on top of a per-operation 10; only the per-
// operation 10 is modeled here (each batched op's simulate() call gets its
// own fresh LookupBudget, mirroring how WriteRuntime.buildBatchProjection
// shares one projection map across per-op simulate() calls but each op is
// its own rules evaluation).
//
// Counting semantics: distinct accesses, not raw calls. In-repo production
// evidence:
//   - site-docs secure/firestore-rules-limits.md ("More than 10 document
//     access calls"): "Repeated reads of the same path are cached; reads of
//     different paths are not."
//   - rules/stdlib-modules.ts spaces guidance: "get() is cached per request,
//     so all rules on the request share a single read of the 10-get budget."
//   - The Storage sibling limit (storage/sandbox/rules-methods.ts) uses a
//     per-request distinct-path set, verified by real-resource capture.
//
// What is implemented, exactly: the budget keys on (kind, path), where kind
// is 'doc' for pre-write reads (get/exists) and 'after' for post-write
// projections (getAfter/existsAfter). So get() and exists() on one path
// share a slot, getAfter() and existsAfter() on one path share a slot, and
// a path read by BOTH a pre-write and a post-write call charges TWO slots.
// The two calls read different snapshots, so charging them separately is the
// fail-closed direction while production's cache granularity is uncaptured.
//
// TODO(unverified): a credentialed production capture is needed to pin
// (a) whether get() and exists() on one path really share one cache slot,
// (b) whether getAfter() on a path already read by get() charges a second
// slot or reuses the first, and (c) whether exhausting the budget is
// absorbable by a determining CEL operand (modeled: not absorbable). The
// capture is a ruleset whose condition performs 10 lookups and then an
// 11th, deployed and probed against a live project. The Rules Test API does
// not enforce the budget, so it cannot produce this evidence.

/** Production's per-evaluation document access budget (single request). */
const DOCUMENT_LOOKUP_LIMIT = 10;

/**
 * Budget exhaustion. A {@link ResourceLimitError}, not a plain EvalError,
 * because it fails the WHOLE request closed: CEL error absorption
 * (`error || true`, `error && false`) must not swallow it into an ALLOW,
 * and a sibling allow rule or match block must not evaluate past it.
 */
export class LookupBudgetError extends ResourceLimitError {
  constructor(message: string) {
    super(message);
    this.name = 'LookupBudgetError';
  }
}

/**
 * Per-request lookup counter. The handler creates ONE per test case
 * (request evaluation) and every match block and allow rule evaluated for
 * that request shares it: production's budget spans OR'd rules and
 * overlapping match blocks alike (the linter's SHARED_GATE "cross-rule
 * budget exhaustion" hazard).
 */
export class LookupBudget {
  private readonly accessed = new Set<string>();

  /**
   * Charge one document access. `kind` is 'doc' for pre-write reads
   * (get/exists) and 'after' for post-write projections (getAfter/
   * existsAfter). A repeat access to the same (kind, path) is cached and
   * free; the 11th DISTINCT access throws {@link LookupBudgetError}, which
   * fails the request closed.
   */
  charge(kind: 'doc' | 'after', normalizedPath: string): void {
    const key = `${kind}:${normalizedPath}`;
    if (this.accessed.has(key)) return; // cached, does not count against the budget
    if (this.accessed.size >= DOCUMENT_LOOKUP_LIMIT) {
      throw new LookupBudgetError(
        `document access limit exceeded: this request already read ${DOCUMENT_LOOKUP_LIMIT} distinct documents `
        + `via get()/exists()/getAfter()/existsAfter() (production allows 10 per request; `
        + `the 11th distinct access fails the evaluation)`,
      );
    }
    this.accessed.add(key);
  }
}

/**
 * The single charging seam for all four document access builtins. Charges
 * the budget for a raw (unnormalized) lookup path. Malformed paths charge
 * nothing: no document read happens, and the caller's own validation
 * produces the error or false result.
 */
export function chargeLookup(ctx: SimulationContext, kind: 'doc' | 'after', rawPath: string): void {
  if (!ctx.lookupBudget) return;
  const normalized = normalizeDocumentPath(rawPath);
  if (!isDocumentPath(normalized)) return;
  ctx.lookupBudget.charge(kind, normalized);
}
