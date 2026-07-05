/**
 * `classifyQueryCall` — given a `query(...)` call expression, decide whether
 * it's an INIT (`query(collection(db, "X"), ...)`) or a WRAP
 * (`query(q, ...constraints)`), and produce the fragments contributed by
 * the call's constraint arguments.
 *
 * One call may produce multiple fragments — `query(q, where(...), orderBy(...))`
 * yields a `where` and an `orderBy` fragment. Callers wrap each fragment
 * with branch context (branchId/clauseId/skippable) before storing.
 */
import ts from 'typescript';
import { getCalleeName, strLit } from './ast.js';
import type { Filter, Order } from './types.js';

/**
 * A fragment without branch context — `dataflow.ts` adds branchId/clauseId
 * /skippable when it sees the fragment in its lexical position.
 */
export interface ClassifiedFragment {
  kind: 'where' | 'orderBy' | 'limit' | 'unknown';
  filter?: Filter;
  order?: Order;
  limit?: number;
}

export interface ClassifiedCall {
  /** True iff this call initializes the chain (`query(collection(...))`). */
  isInit: boolean;
  /** Present when isInit is true and the path was statically resolvable. */
  collectionPath?: string | null;
  /** True when the INIT used `collectionGroup(...)` instead of `collection(...)`. */
  isCollectionGroup?: boolean;
  /** Constraints emitted by this call. */
  fragments: ClassifiedFragment[];
}

/**
 * Resolve a `collection(db, "a", id?, "b"?, ...)` or
 * `collectionGroup(db, "name")` call into its (possibly composite) path.
 *
 * For modular `collection(db, ...segments)`:
 *   - 2-arg form returns the literal path (or null).
 *   - 3+ arg form stitches literal segments and replaces dynamic ones with
 *     `{*}`. The result still pins the **last segment** as the collection
 *     group, which is the only piece an index spec needs.
 *
 * Returns `null` when the first segment isn't a literal — in that case
 * we have no statically resolvable path at all.
 */
function resolveCollectionPath(call: ts.CallExpression): string | null {
  // First arg is `db`; segments start at index 1.
  if (call.arguments.length < 2) return null;
  const segs: string[] = [];
  for (let i = 1; i < call.arguments.length; i++) {
    const lit = strLit(call.arguments[i]);
    if (lit !== null) segs.push(lit);
    else segs.push('{*}');
  }
  // If the very first segment is dynamic, we can't say anything useful.
  if (segs[0] === '{*}') return null;
  return segs.join('/');
}

/**
 * Process a single constraint call (`where`, `orderBy`, `limit`) and emit
 * one or more fragments. Splits the dynamic-direction `orderBy(field, dir)`
 * case into two fragments (asc + desc) so over-shoot is preferred to
 * silent under-shoot.
 */
function classifyConstraint(call: ts.CallExpression): ClassifiedFragment[] {
  const cn = getCalleeName(call);
  const args = call.arguments;

  if (cn === 'where') {
    const field = args[0] ? strLit(args[0]) : null;
    const op = args[1] ? strLit(args[1]) : null;
    if (field && op) return [{ kind: 'where', filter: { field, op } }];
    return [{ kind: 'unknown' }];
  }

  if (cn === 'orderBy') {
    const field = args[0] ? strLit(args[0]) : null;
    if (!field) return [{ kind: 'unknown' }];

    if (args.length === 1) {
      // Default direction is asc.
      return [{ kind: 'orderBy', order: { field, direction: 'asc' } }];
    }

    const dirLit = args[1] ? strLit(args[1]) : null;
    if (dirLit === 'asc' || dirLit === 'desc') {
      return [{ kind: 'orderBy', order: { field, direction: dirLit } }];
    }

    // Dynamic direction — emit both. Better to over-index than under-index;
    // the agent layer can prune via @firestore-mutex if it knows better.
    return [
      { kind: 'orderBy', order: { field, direction: 'asc' } },
      { kind: 'orderBy', order: { field, direction: 'desc' } },
    ];
  }

  if (cn === 'limit') {
    const n = args[0];
    if (n && ts.isNumericLiteral(n)) {
      return [{ kind: 'limit', limit: Number(n.text) }];
    }
    return [{ kind: 'unknown' }];
  }

  // Anything else — `startAt`, `endBefore`, custom helpers — count as
  // unknown for now. The composite-index detector treats unknown as a
  // pass-through (no constraint contribution).
  return [{ kind: 'unknown' }];
}

/**
 * Classify a `query(...)` call. Caller is expected to have already
 * confirmed `getCalleeName(call) === 'query'`.
 *
 * `varName` is the local that the chain is being built on (typically `q`).
 * Used to recognize the WRAP shape `query(q, ...)`.
 */
export function classifyQueryCall(call: ts.CallExpression, varName: string): ClassifiedCall {
  const args = call.arguments;
  if (args.length === 0) return { isInit: false, fragments: [] };

  const first = args[0];
  let isInit = false;
  let collectionPath: string | null | undefined = undefined;
  let isCollectionGroup = false;

  if (ts.isCallExpression(first)) {
    const cname = getCalleeName(first);
    if (cname === 'collection' || cname === 'collectionGroup') {
      isInit = true;
      isCollectionGroup = cname === 'collectionGroup';
      if (cname === 'collectionGroup') {
        // collectionGroup(db, "name")
        collectionPath = first.arguments[1] ? strLit(first.arguments[1]) : null;
      } else {
        collectionPath = resolveCollectionPath(first);
      }
    }
  } else if (ts.isIdentifier(first) && first.text === varName) {
    // WRAP: query(q, ...constraints)
    isInit = false;
  } else {
    // First arg is something else — different variable, expression, etc.
    // Treat as unknown, no fragments.
    return { isInit: false, fragments: [{ kind: 'unknown' }] };
  }

  // Process the rest as constraints.
  const fragments: ClassifiedFragment[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!ts.isCallExpression(a)) continue;
    fragments.push(...classifyConstraint(a));
  }

  return { isInit, collectionPath, isCollectionGroup, fragments };
}
