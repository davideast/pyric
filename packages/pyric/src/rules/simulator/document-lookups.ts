import type { SimulationContext, SimResource } from './evaluation-context.js';
import { EvalError } from './eval-error.js';
import { Path } from './wrappers/path.js';

// ═══ T2.1 — per-request document-lookup budget ═══
//
// Production hard-limits security-rule document access calls — get(),
// exists(), getAfter(), existsAfter() — to 10 per single-document request
// or query evaluation. Multi-document transactions and batched writes get
// an AGGREGATE budget of 20 on top of a per-operation 10; only the per-
// operation 10 is modeled here (each batched op's simulate() call gets its
// own fresh LookupBudget, mirroring how WriteRuntime.buildBatchProjection
// shares one projection map across per-op simulate() calls but each op is
// its own rules evaluation).
//
// Counting semantics — distinct accesses, not raw calls. In-repo production
// evidence:
//   - site-docs secure/firestore-rules-limits.md ("More than 10 document
//     access calls"): "Repeated reads of the same path are cached; reads of
//     different paths are not."
//   - rules/stdlib-modules.ts spaces guidance: "get() is cached per request,
//     so all rules on the request share a single read of the 10-get budget."
//   - The Storage sibling limit (storage/sandbox/rules-methods.ts) uses a
//     per-request distinct-path set, verified by real-resource capture.
// Pre-write reads (get/exists) and post-write projections (getAfter/
// existsAfter) read different snapshots, so they charge separate keys —
// the fail-closed direction where production's cache granularity is not
// yet capture-verified.
// TODO(verify-against-capture): a credentialed production capture (corpus
// scenario firestore/get-budget-exceeded) should pin (a) same-path caching
// across get/exists, (b) whether getAfter shares get's cache slot, and
// (c) whether budget exhaustion is CEL-absorbable (modeled: not absorbable).

/** Production's per-evaluation document access budget (single request). */
const DOCUMENT_LOOKUP_LIMIT = 10;

/**
 * Structured resource-limit error. Distinct from a plain EvalError because
 * budget exhaustion fails the WHOLE evaluation closed — the evaluator's
 * CEL error-absorption (`error || true`, `error && false`) must NOT
 * swallow it into an ALLOW.
 */
export class LookupBudgetError extends EvalError {
  constructor(message: string) {
    super(message);
    this.name = 'LookupBudgetError';
  }
}

/**
 * Per-request lookup counter. The handler creates ONE per test case
 * (request evaluation) and every match block / allow rule evaluated for
 * that request shares it — production's budget spans OR'd rules and
 * overlapping match blocks alike (the linter's SHARED_GATE "cross-rule
 * budget exhaustion" hazard).
 */
export class LookupBudget {
  private readonly accessed = new Set<string>();

  /**
   * Charge one document access. `kind` is 'doc' for pre-write reads
   * (get/exists) and 'after' for post-write projections (getAfter/
   * existsAfter). A repeat access to the same (kind, path) is cached and
   * free; the 11th DISTINCT access throws {@link LookupBudgetError} →
   * fail-closed DENY.
   */
  charge(kind: 'doc' | 'after', normalizedPath: string): void {
    const key = `${kind}:${normalizedPath}`;
    if (this.accessed.has(key)) return; // cached — does not count against the budget
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
 * Charge the budget for a raw (unnormalized) lookup path. Malformed paths
 * charge nothing — no document read happens; the caller's own validation
 * produces the error/false result.
 */
export function chargeLookup(ctx: SimulationContext, kind: 'doc' | 'after', rawPath: string): void {
  if (!ctx.lookupBudget) return;
  const normalized = normalizeDocumentPath(rawPath);
  if (!isDocumentPath(normalized)) return;
  ctx.lookupBudget.charge(kind, normalized);
}

/**
 * Check if a path or segment list points to a document (non-empty, even segment count).
 */
export function isDocumentPath(segmentsOrPath: string | readonly string[]): boolean {
  const segments = typeof segmentsOrPath === 'string'
    ? segmentsOrPath.split('/').filter(Boolean)
    : segmentsOrPath;
  return segments.length > 0 && segments.length % 2 === 0;
}

export function normalizeDocumentPath(rawPath: string): string {
  let cleaned = rawPath.replace(/\$\(database\)/g, '(default)');
  const dbPrefix = '/databases/(default)/documents/';
  if (cleaned.startsWith(dbPrefix)) {
    cleaned = cleaned.slice(dbPrefix.length);
  } else if (cleaned.startsWith('/databases/(default)/documents')) {
    cleaned = cleaned.slice('/databases/(default)/documents'.length);
  }
  if (cleaned.startsWith('/')) {
    cleaned = cleaned.slice(1);
  }

  const rawSegments = cleaned.split('/').filter((s) => s.length > 0 && s !== '.');
  const stack: string[] = [];

  for (const seg of rawSegments) {
    if (seg === '..') {
      if (stack.length > 1) {
        stack.pop();
      }
      // When stack.length <= 1, .. is clamped to prevent escaping collection or document root.
    } else {
      stack.push(seg);
    }
  }

  return stack.join('/');
}

/** Build the identity-bearing value returned by a real document lookup. */
export function makeGetResource(relPath: string, data: Record<string, unknown>): SimResource {
  const segments = relPath.split('/').filter(Boolean);
  return {
    data,
    id: segments.at(-1) ?? '',
    __name__: new Path(['databases', '(default)', 'documents', ...segments]),
  };
}

export function resolveGet(rawPath: string, context: SimulationContext): SimResource {
  const path = normalizeDocumentPath(rawPath);
  const segments = path.split('/').filter(Boolean);
  if (!isDocumentPath(segments)) {
    throw new EvalError(
      `get() requires a path pointing to a document (even segment count), got '${path}'`,
    );
  }
  let document = context.mockDocuments.get(path);
  if (!document && context.getDoc) {
    const loaded = context.getDoc(path);
    if (loaded) {
      context.mockDocuments.set(path, loaded);
      document = loaded;
    }
  }
  if (document) {
    return context.identitylessFunctionMocks?.has(path)
      ? { data: document }
      : makeGetResource(path, document);
  }
  throw new EvalError(`get() of non-existent document '${path}' (guard with exists() first)`);
}

export function resolveExists(rawPath: string, context: SimulationContext): boolean {
  const path = normalizeDocumentPath(rawPath);
  const segments = path.split('/').filter(Boolean);
  if (!isDocumentPath(segments)) {
    return false;
  }
  if (context.mockDocuments.has(path)) return true;
  if (context.getDoc) {
    const loaded = context.getDoc(path);
    if (loaded) {
      context.mockDocuments.set(path, loaded);
      return true;
    }
  }
  return false;
}
