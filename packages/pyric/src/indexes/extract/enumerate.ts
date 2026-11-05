/**
 * `enumerateShapes` — turn a `QueryBaseDecl` (base + branched fragments)
 * into the finite set of `QueryShape`s the source may issue at runtime.
 *
 * Algorithm:
 *   1. Group fragments by branchId (null = unconditional).
 *   2. For each branch, the choices are: each clause's fragment-list,
 *      plus an empty-choice if the branch is skippable.
 *   3. Cartesian product across branches.
 *   4. Each combo includes all unconditional fragments.
 *   5. Dedupe shapes by stable key.
 */
import type { Annotations, Filter, Fragment, Order, QueryBaseDecl, QueryShape } from './types.js';

/**
 * Stable string key for a QueryShape — only used for dedupe inside this
 * module. Field order matters (it's part of the shape's identity in the
 * Firestore index sense), so don't sort.
 */
function shapeKey(s: QueryShape): string {
  const scope = s.isCollectionGroup ? 'G' : 'C';
  const filters = s.filters.map(f => `${f.field}${f.op}`).join(',');
  const orders = s.orders.map(o => `${o.field}:${o.direction}`).join(',');
  const limit = s.limit ?? '-';
  return `${scope}:${s.collectionPath}|${filters}|${orders}|L=${limit}`;
}

interface Branch {
  skippable: boolean;
  clauses: Map<number, Fragment[]>;
}

export function enumerateShapes(decl: QueryBaseDecl): QueryShape[] {
  // No statically-resolved base path → nothing to emit. Caller can still
  // surface this as a warning ("partial-base").
  if (decl.collectionPath === null) return [];

  const unconditional: Fragment[] = [];
  const branches = new Map<number, Branch>();

  for (const f of decl.fragments) {
    if (f.branchId === null) {
      unconditional.push(f);
      continue;
    }
    let entry = branches.get(f.branchId);
    if (!entry) {
      entry = { skippable: f.skippable, clauses: new Map() };
      branches.set(f.branchId, entry);
    }
    const clauseId = f.clauseId ?? 0;
    let clauseFrags = entry.clauses.get(clauseId);
    if (!clauseFrags) {
      clauseFrags = [];
      entry.clauses.set(clauseId, clauseFrags);
    }
    clauseFrags.push(f);
  }

  // Build the per-branch choice lists. Choice = the fragments that fire
  // when that clause is taken (or [] when the branch is skipped).
  const branchChoices: Fragment[][][] = [];
  for (const branch of branches.values()) {
    const choices: Fragment[][] = [];
    for (const clauseFrags of branch.clauses.values()) {
      choices.push(clauseFrags);
    }
    if (branch.skippable) choices.push([]);
    branchChoices.push(choices);
  }

  // Cartesian product. Start with the empty combo; for each branch,
  // multiply the running set by that branch's choices.
  let combos: Fragment[][] = [[]];
  for (const choices of branchChoices) {
    const next: Fragment[][] = [];
    for (const acc of combos) {
      for (const choice of choices) {
        next.push([...acc, ...choice]);
      }
    }
    combos = next;
  }

  // Materialize combos into QueryShapes (each combo + all unconditional).
  const shapes: QueryShape[] = [];
  for (const combo of combos) {
    const all = [...unconditional, ...combo];
    const filters: Filter[] = [];
    const orders: Order[] = [];
    let limit: number | null = null;
    for (const f of all) {
      if (f.kind === 'where' && f.filter) filters.push(f.filter);
      else if (f.kind === 'orderBy' && f.order) orders.push(f.order);
      else if (f.kind === 'limit' && f.limit != null) limit = f.limit;
      // 'unknown' fragments contribute nothing — they're tracked at
      // the warning level by the orchestrator, not here.
    }
    shapes.push({
      collectionPath: decl.collectionPath,
      isCollectionGroup: decl.isCollectionGroup,
      filters,
      orders,
      limit,
    });
  }

  // Dedupe — different combos can collapse to the same shape (e.g., when
  // a skippable branch happens to add nothing).
  const seen = new Set<string>();
  const unique: QueryShape[] = [];
  for (const s of shapes) {
    const k = shapeKey(s);
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(s);
    }
  }
  return unique;
}

/**
 * Result of applying `@firestore-mutex` and `@firestore-required` to a
 * shape list. Counts let the caller surface how many shapes each
 * annotation pruned via `AnnotationApplied`.
 */
export interface PruneResult {
  shapes: QueryShape[];
  prunedByMutex: number;
  prunedByRequired: number;
}

/**
 * Apply mutex + required annotations to an enumerated shape list.
 *
 * - Mutex: a shape is dropped if any mutex group has ≥2 of its fields
 *   present in the shape's filters or orderBy. (One field from a group
 *   is fine — the constraint is "at most one".)
 * - Required: a shape is dropped if it doesn't contain every field in
 *   `annotations.required` somewhere in filters or orderBy.
 *
 * `@firestore-budget` is **not** applied here — that's a soft cap
 * surfaced as a warning at the orchestrator level, not a prune.
 *
 * No-op when `annotations` is `undefined`, empty mutexGroups, and empty
 * required — returns the input shapes with zero prune counts.
 */
export function pruneByAnnotations(
  shapes: QueryShape[],
  annotations: Annotations | undefined,
): PruneResult {
  if (!annotations || (annotations.mutexGroups.length === 0 && annotations.required.size === 0)) {
    return { shapes, prunedByMutex: 0, prunedByRequired: 0 };
  }

  let prunedByMutex = 0;
  let prunedByRequired = 0;
  const kept: QueryShape[] = [];

  for (const s of shapes) {
    const fields = new Set<string>();
    for (const f of s.filters) fields.add(f.field);
    for (const o of s.orders) fields.add(o.field);

    // Mutex check first — if a shape is mutex-violating, attribute to mutex.
    let mutexViolated = false;
    for (const group of annotations.mutexGroups) {
      let hits = 0;
      for (const g of group) {
        if (fields.has(g)) hits++;
        if (hits >= 2) { mutexViolated = true; break; }
      }
      if (mutexViolated) break;
    }
    if (mutexViolated) {
      prunedByMutex++;
      continue;
    }

    // Required check.
    let missingRequired = false;
    for (const r of annotations.required) {
      if (!fields.has(r)) { missingRequired = true; break; }
    }
    if (missingRequired) {
      prunedByRequired++;
      continue;
    }

    kept.push(s);
  }

  return { shapes: kept, prunedByMutex, prunedByRequired };
}
