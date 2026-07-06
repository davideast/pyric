/**
 * Traffic-conformance harness (SF-S0c, plans/app-spec.md §3.5).
 *
 * The scaffold-and-fill UI is never spec'd or templated — it is validated
 * BEHAVIORALLY. This is the validator's pure core: given the app's access
 * matrix (the AppSpec, from #609) and a log of the Firestore ops the app
 * ACTUALLY performed in the sandbox, flag any op the matrix would DENY for
 * the identity that performed it. Such an op is an off-contract affordance
 * — a located UX/security defect: the app exposed a path to a user the
 * backend contract says it shouldn't.
 *
 * This is a MEASUREMENT TOOL, not a gate. It is pure (no I/O, no sandbox,
 * browser-safe): it consumes RECORDED traffic, it does not run the app.
 * S4 will turn it into an ambient check + write-gate; nothing here wires
 * into any live path.
 *
 * Condition semantics are NOT reimplemented here — `evaluateGrant`
 * (../agent/spec/derive) is the single owner of the GRANT decision, beside
 * the deriver's condition primitives it shares (§5 type-cohesion: one
 * declaration, consumers in lockstep). This module only (a) maps a
 * recorded traffic op onto a matrix cell and (b) extracts the evidence
 * `evaluateGrant` reads.
 */
import type { FirestoreMethod } from 'pyric/rules';
import {
  evaluateGrant,
  type GrantEvidence,
  type GrantEvaluation,
} from '../agent/spec/derive';
import {
  collectionPathOf,
  ownerUidFromPath,
  resolveCollection,
  type AccessRule,
  type AppSpecV1,
  type CollectionSpec,
} from '../agent/spec/schema';

// ─────────────────────────────────────────────────────────────────────
// Input: a recorded sandbox op (the conformance-relevant subset of
// @pyric/sandbox `RequestEvent` / the playground's `TrafficEntry`).
// ─────────────────────────────────────────────────────────────────────

/**
 * The traffic the harness consumes — a structural subset of the recorded
 * `RequestEvent` (sandbox traffic ring buffer). Deliberately the same
 * field names so a `TrafficEntry` / `RequestEvent` / the
 * `inspect_firestore_traffic` result entry is assignable to it without
 * a mapper. Note `method` is the DATA-PLANE vocabulary (includes `set`);
 * `set` is lowered to create/update before matching a matrix rule (whose
 * ops are the rules vocabulary).
 */
export interface RecordedOp {
  /** Op id, surfaced verbatim in violations for traceability. */
  id?: string;
  /** Data-plane method — `set` is lowered to create/update by before-state. */
  method: 'get' | 'list' | 'create' | 'update' | 'set' | 'delete';
  /** Document path (collection path for `list`). */
  path: string;
  /** Acting identity; null = unauthenticated. */
  auth: { uid: string; token?: Record<string, unknown> } | null;
  /** The simulator's own outcome, when present — used only to NOTE
   *  disagreements; the harness's verdict is the matrix's, independent of
   *  whatever rules the app happened to ship. */
  result?: 'allow' | 'deny' | 'unsupported';
  /** Write payload (create/update/set). */
  request?: { resourceData?: Record<string, unknown> };
  /** Pre-op document state (immutability + set-lowering). */
  resourceBefore?: { data: Record<string, unknown> | null; exists: boolean };
}

// ─────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────

/** An op the app performed that the matrix DENIES for the acting
 *  identity — an off-contract affordance. */
export interface ConformanceViolation {
  opId?: string;
  path: string;
  /** The rules method the op lowered to (the matrix cell's method). */
  method: FirestoreMethod;
  /** The identity that performed it (uid, or 'anonymous'). */
  identity: string;
  /** The matrix rule that should have denied it. */
  rule: AccessRule;
  /** Why the matrix denied — the first decidably-violated condition. */
  reason: string;
  /** Full per-condition breakdown (teaching / debugging). */
  evaluation: GrantEvaluation;
}

/** An op the matrix has no rule for (no collection matched). Reported as
 *  coverage, NOT a violation — the matrix simply doesn't speak to it. */
export interface CoverageNote {
  opId?: string;
  path: string;
  method: 'get' | 'list' | 'create' | 'update' | 'set' | 'delete';
  identity: string;
  reason: string;
}

export interface ConformanceReport {
  violations: ConformanceViolation[];
  /** Ops the matrix doesn't cover (no matching collection rule). */
  coverage: CoverageNote[];
  /** Total ops considered (after origin/dedup is the caller's job). */
  opsChecked: number;
  /** Ops the matrix granted for the acting identity (within contract). */
  conformant: number;
}

// ─────────────────────────────────────────────────────────────────────
// Op → matrix cell
// ─────────────────────────────────────────────────────────────────────

const RULES_METHODS = new Set<FirestoreMethod>(['get', 'list', 'create', 'update', 'delete']);

/**
 * Lower a data-plane method onto the rules vocabulary. `set` is the only
 * one that lowers: it is a `create` when no doc existed before, else an
 * `update` (matches the simulator's set→create/update lowering). The rest
 * pass through.
 */
function toRulesMethod(op: RecordedOp): FirestoreMethod {
  if (op.method === 'set') {
    return op.resourceBefore?.exists ? 'update' : 'create';
  }
  return op.method as FirestoreMethod;
}

/** Path/template segment match (wildcards match any segment). For `list`
 *  the rule's trailing doc-id wildcard is dropped first (a list targets
 *  the collection path). Mirrors the deriver's `pathMatchesTemplate`. */
function pathMatchesTemplate(template: string, path: string, isList: boolean): boolean {
  const t = template.split('/').filter((s) => s.length > 0);
  if (isList && t.length > 0 && t[t.length - 1]!.startsWith('{')) t.pop();
  const p = path.split('/').filter((s) => s.length > 0);
  if (t.length !== p.length) return false;
  return t.every((seg, i) => (seg.startsWith('{') && seg.endsWith('}')) || seg === p[i]);
}

/** Find the matrix rule (and its collection) covering a recorded op. */
function ruleForOp(
  spec: AppSpecV1,
  method: FirestoreMethod,
  path: string,
): { rule: AccessRule; col: CollectionSpec } | null {
  const isList = method === 'list';
  for (const rule of spec.access) {
    if (rule.op !== method) continue;
    const col = resolveCollection(spec, rule.collection);
    if (!col) continue;
    if (pathMatchesTemplate(col.path, path, isList)) return { rule, col };
  }
  return null;
}

/** The collection a path belongs to, regardless of whether a rule covers
 *  it — used to tell "uncovered op (coverage note)" from "covered cell
 *  with no explicit rule = deny-by-default (a real violation)". */
function collectionForPath(
  spec: AppSpecV1,
  method: FirestoreMethod,
  path: string,
): CollectionSpec | null {
  const isList = method === 'list';
  for (const col of spec.collections) {
    if (pathMatchesTemplate(col.path, path, isList)) return col;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Op → grant evidence
// ─────────────────────────────────────────────────────────────────────

function evidenceFor(op: RecordedOp, col: CollectionSpec): GrantEvidence {
  const data = op.request?.resourceData ?? null;
  const before = op.resourceBefore?.data ?? null;

  let ownerUid: string | null = null;
  if (col.ownerField) {
    // ownerField-owned: the owner lives in doc data. On a write the
    // proposed payload carries it; otherwise the existing doc does.
    const fromData = data?.[col.ownerField];
    const fromBefore = before?.[col.ownerField];
    const v = fromData ?? fromBefore;
    ownerUid = typeof v === 'string' ? v : null;
  } else {
    // path-uid-owned: the owner is a path segment.
    ownerUid = ownerUidFromPath(col, op.path);
  }

  return {
    identity: op.auth,
    ownerUid,
    data,
    before,
    existedBefore: op.resourceBefore?.exists,
  };
}

// ─────────────────────────────────────────────────────────────────────
// The check
// ─────────────────────────────────────────────────────────────────────

/**
 * Diff a recorded traffic log against an access matrix. For each op:
 *   - lower `set` to create/update;
 *   - find the covering matrix cell;
 *   - if the path matches NO collection → coverage note;
 *   - else evaluate the cell's grant for the op's identity. A cell with
 *     no explicit rule is deny-by-default — a covered path with no grant
 *     is a violation, never a coverage note (the matrix DOES speak to it);
 *   - if the grant denies the op the app performed → a violation.
 *
 * Pure: no I/O, deterministic, browser-safe.
 */
export function checkTrafficConformance(
  spec: AppSpecV1,
  trafficLog: readonly RecordedOp[],
): ConformanceReport {
  const violations: ConformanceViolation[] = [];
  const coverage: CoverageNote[] = [];
  let conformant = 0;

  for (const op of trafficLog) {
    const method = toRulesMethod(op);
    const identity = op.auth ? op.auth.uid : 'anonymous';

    // Guard: an unmodelled data-plane method we can't map to a cell.
    if (!RULES_METHODS.has(method)) {
      coverage.push({
        opId: op.id,
        path: op.path,
        method: op.method,
        identity,
        reason: `method "${op.method}" has no rules-vocabulary equivalent`,
      });
      continue;
    }

    const hit = ruleForOp(spec, method, op.path);
    if (!hit) {
      // No explicit rule for (collection, method). If the PATH belongs to
      // a declared collection, the matrix is deny-by-default here — the op
      // is off-contract. If no collection matches at all, the matrix
      // doesn't cover this path: a coverage note.
      const col = collectionForPath(spec, method, op.path);
      if (!col) {
        coverage.push({
          opId: op.id,
          path: op.path,
          method: op.method,
          identity,
          reason: `no collection in the matrix matches "${op.path}"`,
        });
        continue;
      }
      const denyRule: AccessRule = { collection: col.path, op: method, grant: 'deny' };
      const evaluation = evaluateGrant('deny', evidenceFor(op, col));
      violations.push({
        opId: op.id,
        path: op.path,
        method,
        identity,
        rule: denyRule,
        reason: `${method} on ${collectionPathOf(col.path)} is deny-by-default (no grant in the matrix)`,
        evaluation,
      });
      continue;
    }

    const evaluation = evaluateGrant(hit.rule.grant, evidenceFor(op, hit.col));
    if (evaluation.decision === 'deny') {
      violations.push({
        opId: op.id,
        path: op.path,
        method,
        identity,
        rule: hit.rule,
        reason: evaluation.violated?.detail ?? 'matrix denies this op for the acting identity',
        evaluation,
      });
    } else {
      conformant += 1;
    }
  }

  return {
    violations,
    coverage,
    opsChecked: trafficLog.length,
    conformant,
  };
}
