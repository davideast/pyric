/**
 * compile-rules — SF-S3 "compile-with-holes" (plans/epic-scaffold-and-fill.md
 * section S3, plans/app-spec.md Appendix-A). The HOST owns Firestore-rule generation:
 * for the ~91% of access conditions that are enumerable (checkpoint #1
 * custom-rate 8.7%), `compileRules(spec)` emits the ruleset
 * correct-by-construction; the model fills only the `custom` holes.
 *
 * The binding principle (epic section S3 / app-spec section 5): the compiler descends from
 * the SAME access matrix as the deriver (./derive.ts). They MUST agree — a
 * compiler that emits an `allow` the deriver's cases reject (or vice versa)
 * is a bug in one of them, caught by THE ROUND-TRIP PIN
 * (compile-rules.roundtrip.test.ts): spec → compileRules → deriveTests
 * replayed through the real workspace runner, all cases green. The per-kind
 * encoding below is the exact mirror of `evaluateCondition` / the deriver's
 * case enumeration — every choice here (the list/get split, owner on create
 * vs read, requiredFields on create only, the enumTransition disjunction) is
 * dictated by what the deriver tests.
 *
 * Pure (no I/O); the emitted output is lint-clean (pinned in a test against
 * the existing `lintFirestoreRules`).
 */
import { FIRESTORE_METHODS, type FirestoreMethod } from 'pyric/rules';
import {
  collectionPathOf,
  isWildcard,
  resolveCollection,
  type AccessRule,
  type AppSpecV1,
  type CollectionSpec,
  type Condition,
  type FieldSpec,
} from './schema';

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

/** A `custom` condition the compiler could not emit deterministically.
 *  The host surfaces these so the model fills the named expression
 *  (repair feedback quotes collection + op + rationale). */
export interface CustomHole {
  collection: string;
  op: FirestoreMethod;
  /** The model-supplied raw rules expression, or null when it still needs
   *  filling (the spec author wrote no `rulesExpr`). A non-null value is
   *  spliced verbatim into the `allow`. */
  rulesExpr: string | null;
  rationale: string;
}

export interface CompiledRules {
  rules: string;
  holes: CustomHole[];
}

// ─────────────────────────────────────────────────────────────────────
// Per-op classification (mirrors the deriver's op handling)
// ─────────────────────────────────────────────────────────────────────

/** Read ops evaluate against `resource.data` (the existing doc); on `list`
 *  there is no single `resource`, so `resource.data.<field>` always fails —
 *  owner degrades to authenticated and field-shaped reads are never emitted
 *  (the deriver makes the identical choice). */
function isReadOp(op: FirestoreMethod): boolean {
  return op === 'get' || op === 'list';
}

/** Write ops carry an incoming payload — `request.resource.data` is the
 *  doc being written; `resource.data` is the prior state (null on create). */
function isWriteOp(op: FirestoreMethod): boolean {
  return op === 'create' || op === 'update' || op === 'delete';
}

// ─────────────────────────────────────────────────────────────────────
// Value literals → rules source
// ─────────────────────────────────────────────────────────────────────

/** Render a spec value (claim equals / fieldEquals value) as a rules-source
 *  literal. Strings single-quote (rules convention); numbers/booleans/null
 *  pass through; anything structured (map/array) renders as JSON, which the
 *  rules grammar accepts for the equality forms the matrix uses. */
function literal(v: unknown): string {
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return 'null';
  return JSON.stringify(v);
}

// ─────────────────────────────────────────────────────────────────────
// Owner resolution (mirrors derive.ts docPath / ownerUidFromPath)
// ─────────────────────────────────────────────────────────────────────

/** The match-block wildcard that carries the owner uid for a path-uid
 *  collection (no `ownerField`). Single-wildcard template (users/{uid}) →
 *  that wildcard; rooted subcollection (users/{uid}/items/{itemId}) → the
 *  wildcard BEFORE the doc-id tail. Returns null when no wildcard exists.
 *  Inverse of `ownerUidFromPath` — same slot the deriver writes the uid into. */
function ownerWildcardName(col: CollectionSpec): string | null {
  const segs = col.path.split('/').filter((s) => s.length > 0);
  const wildIdxs = segs.map((s, i) => (isWildcard(s) ? i : -1)).filter((i) => i >= 0);
  if (wildIdxs.length === 0) return null;
  const ownerIdx = wildIdxs.length === 1 ? wildIdxs[0]! : wildIdxs[wildIdxs.length - 2]!;
  return segs[ownerIdx]!.slice(1, -1); // strip the {curly braces}
}

/** The `owner` predicate for a given op. The uid source mirrors the
 *  deriver's owner cases:
 *   - path-uid collection → the owning path wildcard == request.auth.uid;
 *   - ownerField collection, read/update/delete → resource.data.<ownerField>
 *     (the existing doc's owner);
 *   - ownerField collection, create → request.resource.data.<ownerField>
 *     (no prior doc; the payload declares the owner).
 *  `list` never reaches here (owner degrades to authenticated — see compileOp). */
function ownerExpr(col: CollectionSpec, op: FirestoreMethod): string {
  const wildcard = ownerWildcardName(col);
  if (!col.ownerField && wildcard) {
    return `request.auth.uid == ${wildcard}`;
  }
  if (col.ownerField) {
    const base = op === 'create' ? 'request.resource.data' : 'resource.data';
    return `request.auth.uid == ${base}.${col.ownerField}`;
  }
  // Path-uid collection with no owning wildcard (degenerate) — fall back to
  // authenticated, which is the strongest claim we can soundly make.
  return 'request.auth != null';
}

// ─────────────────────────────────────────────────────────────────────
// enumTransition disjunction (mirrors COFFEE_SHOP_GOOD_RULES / the deriver)
// ─────────────────────────────────────────────────────────────────────

/** `status` follows its declared transitions on update:
 *    (request...status == resource...status            // no-op write
 *     || (resource...status == 'placed' && request...status == 'ready')
 *     || …)
 *  The no-op disjunct mirrors the deriver's `benignUpdate`, which emits a
 *  legal-transition OR same-value update as the ALLOW case. */
function enumTransitionExpr(field: string, fieldSpec: FieldSpec | undefined): string {
  const reqF = `request.resource.data.${field}`;
  const resF = `resource.data.${field}`;
  const disjuncts: string[] = [`${reqF} == ${resF}`];
  const transitions = fieldSpec?.transitions ?? {};
  for (const [from, nexts] of Object.entries(transitions)) {
    for (const to of nexts) {
      disjuncts.push(`(${resF} == ${literal(from)} && ${reqF} == ${literal(to)})`);
    }
  }
  return `(${disjuncts.join(' || ')})`;
}

// ─────────────────────────────────────────────────────────────────────
// Single-condition → expression (the closed algebra)
// ─────────────────────────────────────────────────────────────────────

/** Compile one condition to a rules expression for a given op, or null
 *  when the condition contributes NO predicate for this op (the deriver
 *  derives no case for it either):
 *   - field-shaped conditions on read ops (resource.data unavailable on list,
 *     and reads carry no payload) → null;
 *   - requiredFields/crossDoc only constrain writes that carry a payload;
 *     on read/delete they emit nothing.
 *  `custom` returns null here and is handled separately (it produces a HOLE).
 */
function conditionExpr(
  cond: Condition,
  col: CollectionSpec,
  op: FirestoreMethod,
  database: string,
  spec: AppSpecV1,
): string | null {
  switch (cond.kind) {
    case 'authenticated':
      return 'request.auth != null';
    case 'owner':
      // On list there is no single resource — owner can't be checked
      // doc-side; it degrades to authenticated (handled in compileOp by
      // dropping to `request.auth != null`). For get/create/update/delete
      // the owner predicate is sound.
      if (op === 'list') return 'request.auth != null';
      return ownerExpr(col, op);
    case 'claim':
      return `request.auth.token.${cond.name} == ${literal(cond.equals)}`;
    case 'fieldEquals':
      // A value constraint on a doc field. On writes it constrains the
      // INCOMING payload (`request.resource.data`); on get/delete it is
      // evaluable against the EXISTING doc (`resource.data`) — a read gated
      // by `status == 'published'` is a real, enforceable filter, so we emit
      // it (a fail-open here would silently make the read public). `list`
      // alone has no single `resource`, so `resource.data.<field>` can't be
      // evaluated — it contributes no predicate (and the op fails closed in
      // compileOp rather than degrading to public).
      if (op === 'create' || op === 'update') {
        return `request.resource.data.${cond.field} == ${literal(cond.value)}`;
      }
      if (op === 'get' || op === 'delete') {
        return `resource.data.${cond.field} == ${literal(cond.value)}`;
      }
      return null;
    case 'fieldImmutable':
      // "must not change" needs both prior + incoming — update only.
      if (op === 'update') {
        return `request.resource.data.${cond.field} == resource.data.${cond.field}`;
      }
      return null;
    case 'requiredFields':
      // The incoming doc must carry every field — create only (update's
      // merge semantics make "absent in payload" legal; the deriver derives
      // missing-field DENYs on CREATE only).
      if (op === 'create') {
        const list = cond.fields.map((f) => `'${f}'`).join(', ');
        return `request.resource.data.keys().hasAll([${list}])`;
      }
      return null;
    case 'enumTransition': {
      if (op === 'update') {
        const fs = col.fields.find((f) => f.name === cond.field);
        return enumTransitionExpr(cond.field, fs);
      }
      return null;
    }
    case 'crossDoc': {
      // The local field must equal a field on a referenced remote doc.
      // Only meaningful when a payload is present (create/update).
      if (op === 'create' || op === 'update') {
        // The get() path needs the remote collection in collection-NAME form
        // (no doc wildcard). The spec validator already guaranteed the remote
        // resolves; normalize whichever form the author wrote (`menuItems`
        // or `menuItems/{itemId}`) to the canonical collection name.
        const remote = resolveCollection(spec, cond.collection);
        const remoteColl = remote ? collectionPathOf(remote.path) : cond.collection;
        const localData = 'request.resource.data';
        return (
          `${localData}.${cond.localField} == ` +
          `get(/databases/$(${database})/documents/${remoteColl}/$(${localData}.${cond.docIdFrom})).data.${cond.remoteField}`
        );
      }
      return null;
    }
    case 'custom':
      // Handled by the caller (produces a HOLE; the rulesExpr, when present,
      // is spliced in by compileOp).
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Per-(collection, op) compilation
// ─────────────────────────────────────────────────────────────────────

interface OpResult {
  /** The `allow <op>: if <expr>;` line, or null when the op is denied
   *  (deny-by-default: no `allow` is emitted, so the op is denied). */
  line: string | null;
  /** Custom holes discovered for this op. */
  holes: CustomHole[];
}

function compileOp(
  rule: AccessRule | null,
  col: CollectionSpec,
  op: FirestoreMethod,
  database: string,
  spec: AppSpecV1,
): OpResult {
  // No rule, or an explicit 'deny' grant → emit no `allow` (denied).
  if (!rule || rule.grant === 'deny') return { line: null, holes: [] };

  const conds = rule.grant;
  // Empty grant ([]) = public → `if true`.
  if (conds.length === 0) return { line: `allow ${op}: if true;`, holes: [] };

  const parts: string[] = [];
  const holes: CustomHole[] = [];
  // De-dupe identical predicates (e.g. authenticated + owner both imply
  // `request.auth != null` on list) so the emitted expr stays clean.
  const seen = new Set<string>();
  const push = (expr: string): void => {
    if (!seen.has(expr)) {
      seen.add(expr);
      parts.push(expr);
    }
  };

  let hasCustom = false;
  // Does any condition imply authentication? (mirrors derive.ts requiresAuth:
  // authenticated / owner / claim) — used to floor an otherwise-empty
  // predicate at `request.auth != null` instead of public.
  let impliesAuth = false;
  for (const cond of conds) {
    if (cond.kind === 'authenticated' || cond.kind === 'owner' || cond.kind === 'claim') {
      impliesAuth = true;
    }
    if (cond.kind === 'custom') {
      hasCustom = true;
      const hole: CustomHole = {
        collection: rule.collection,
        op,
        rulesExpr: cond.rulesExpr.trim().length > 0 ? cond.rulesExpr.trim() : null,
        rationale: cond.rationale,
      };
      holes.push(hole);
      if (hole.rulesExpr) push(`(${hole.rulesExpr})`);
      // An unfilled hole contributes no predicate — the op still compiles
      // (deny-leaning: a missing custom predicate can only REMOVE an allow,
      // never add one), and the host surfaces the hole for the model to fill.
      continue;
    }
    const expr = conditionExpr(cond, col, op, database, spec);
    if (expr) push(expr);
  }

  if (parts.length === 0) {
    // No predicate survived for this op. FAIL CLOSED — a non-empty grant that
    // yields nothing for this op must NOT degrade to public (`if true`); that
    // is the fail-open bug. `if true` is reserved strictly for the explicit
    // empty grant (`[]`), handled above. The cases:
    //   · a `custom` condition is present → the deriver derives NO ALLOW for
    //     this cell, so emit no allow (denied) while the hole is unfilled.
    //   · any condition implied auth (authenticated/owner/claim) → floor at
    //     `request.auth != null` (the strongest sound claim), matching the
    //     deriver's auth-gated ALLOW.
    //   · otherwise (a non-empty grant whose every condition was inapplicable
    //     to this op — e.g. a `list` gated only by a field-shaped condition,
    //     which can't be evaluated doc-side) → `if false`. The deriver mirrors
    //     this by deny-routing the same cell (see grantCompilesToDeny in
    //     derive.ts), so the compiled `if false` and the derived all-deny
    //     probes agree.
    if (hasCustom) return { line: null, holes };
    return { line: `allow ${op}: if ${impliesAuth ? 'request.auth != null' : 'false'};`, holes };
  }

  return { line: `allow ${op}: if ${parts.join(' && ')};`, holes };
}

// ─────────────────────────────────────────────────────────────────────
// compileRules — the whole ruleset
// ─────────────────────────────────────────────────────────────────────

const DB = 'database';

/** The match-path form for a collection template. The spec stores
 *  `orders/{orderId}` — already a valid match path. Subcollection templates
 *  (`users/{uid}/items/{itemId}`) are likewise valid match paths verbatim. */
function matchPath(col: CollectionSpec): string {
  return col.path;
}

/**
 * Compile an AppSpecV1 to a Firestore ruleset (rules_version '2', canonical
 * service/match scaffolding). For each collection a `match` block; for each
 * op a deterministic `allow` (or nothing → deny-by-default). `custom`
 * conditions become HOLES: when the spec author supplied a `rulesExpr` it is
 * spliced in; otherwise the op denies and the hole is surfaced for filling.
 *
 * Agreement guarantee (the round-trip pin proves it): the emitted rules pass
 * every case `deriveTests(spec)` produces — both descend from the same matrix.
 */
export function compileRules(spec: AppSpecV1): CompiledRules {
  const holes: CustomHole[] = [];
  const blocks: string[] = [];

  for (const col of spec.collections) {
    const lines: string[] = [];
    for (const op of FIRESTORE_METHODS) {
      const rule =
        spec.access.find((r) => r.op === op && resolveCollection(spec, r.collection) === col) ??
        null;
      const res = compileOp(rule, col, op, DB, spec);
      holes.push(...res.holes);
      if (res.line) lines.push(res.line);
    }
    // A collection with no granted op gets an EMPTY match block — still
    // emitted (documents the deny-by-default surface; lint-clean). Indent
    // two levels under the documents match.
    const body = lines.length > 0 ? lines.map((l) => `      ${l}`).join('\n') : '';
    blocks.push(
      body.length > 0
        ? `    match /${matchPath(col)} {\n${body}\n    }`
        : `    match /${matchPath(col)} {\n    }`,
    );
  }

  const rules =
    `rules_version = '2';\n` +
    `service cloud.firestore {\n` +
    `  match /databases/{${DB}}/documents {\n` +
    `${blocks.join('\n')}\n` +
    `  }\n` +
    `}\n`;

  return { rules, holes };
}

/** Holes still needing a model-supplied expression (`rulesExpr === null`).
 *  The DV integration asks the model to fill exactly these. */
export function unfilledHoles(holes: CustomHole[]): CustomHole[] {
  return holes.filter((h) => h.rulesExpr === null);
}

/** Compact one-line description of a hole for repair feedback / observability
 *  (quotes collection + op + rationale per the epic's repair contract). */
export function describeHole(h: CustomHole): string {
  return `${h.collection} ${h.op}: custom condition needs a rules expression — ${h.rationale}`;
}
