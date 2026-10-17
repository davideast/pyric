import type { Expression, FunctionDef } from './FirestoreAST.js';

/**
 * The four built-in document access calls production counts against a
 * request's 10-read budget.
 */
const DOCUMENT_ACCESS_BUILTINS = new Set(['get', 'exists', 'getAfter', 'existsAfter']);

/**
 * Count the document access calls (get/exists/getAfter/existsAfter, and a
 * Storage rule's firestore.get/firestore.exists)
 * reachable from a rule condition, expanding each user-defined function
 * once PER CALL SITE. `isOwner(a) && isOwner(b) && isOwner(c)` with three
 * gets inside `isOwner` costs nine, matching production where each call
 * performs its own reads (different arguments mean different paths).
 * A function's `let` bindings evaluate on every call, so their reads count
 * too. The call stack guards recursion only, and entries unwind on return,
 * so sibling call sites each pay full price.
 *
 * This is a static over-approximation: production caches repeated reads of
 * the SAME path within a request (see site-docs
 * secure/firestore-rules-limits.md), but path identity is not decidable
 * statically, so every call site is charged. The cache-aware, distinct-path
 * count is the runtime concern of LookupBudget in
 * simulator/lookup-budget.ts, which counts what an evaluation actually
 * reads rather than what a condition could reach.
 *
 * This is the single walker behind both static consumers: the validator's
 * SEM-3 finding and the linter's GET_COUNT warning.
 */
export function countDocumentAccessCalls(
  expr: Expression,
  functions: ReadonlyMap<string, FunctionDef>,
  callStack: Set<string> = new Set<string>(),
  fnScopes?: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
): number {
  const cleanMemo = new Map<FunctionDef, number>();
  const activeFns = new Set<FunctionDef>();
  return visitExpr(expr, functions).count;

  function visitFn(
    fn: FunctionDef,
    fallbackScope: ReadonlyMap<string, FunctionDef>,
  ): { count: number; hitStack: boolean } {
    const cached = cleanMemo.get(fn);
    if (cached !== undefined) return { count: cached, hitStack: false };
    if (activeFns.has(fn) || callStack.has(fn.name)) return { count: 0, hitStack: true };
    const scope = fnScopes?.get(fn) ?? fallbackScope;
    activeFns.add(fn);
    callStack.add(fn.name);
    let total = 0;
    let hitStack = false;
    for (const binding of fn.lets) {
      const sub = visitExpr(binding.value, scope);
      total += sub.count;
      if (sub.hitStack) hitStack = true;
    }
    const bodyRes = visitExpr(fn.body, scope);
    total += bodyRes.count;
    if (bodyRes.hitStack) hitStack = true;
    callStack.delete(fn.name);
    activeFns.delete(fn);
    if (!hitStack) cleanMemo.set(fn, total);
    return { count: total, hitStack };
  }

  function visitExpr(
    node: Expression,
    scope: ReadonlyMap<string, FunctionDef>,
  ): { count: number; hitStack: boolean } {
    let count = 0;
    let hitStack = false;
    const visit = (e: Expression): void => {
      const sub = visitExpr(e, scope);
      count += sub.count;
      if (sub.hitStack) hitStack = true;
    };

    switch (node.type) {
      case 'functionCall':
        if (DOCUMENT_ACCESS_BUILTINS.has(node.name)) {
          count++;
        } else {
          const fn = scope.get(node.name);
          if (fn !== undefined) {
            const sub = visitFn(fn, scope);
            count += sub.count;
            if (sub.hitStack) hitStack = true;
          }
        }
        node.args.forEach(visit);
        break;
      case 'binaryOp': visit(node.left); visit(node.right); break;
      case 'unaryOp': visit(node.operand); break;
      case 'ternary': visit(node.condition); visit(node.consequent); visit(node.alternate); break;
      case 'methodCall':
        // Storage rules read a Firestore document through firestore.get()
        // and firestore.exists().
        if (node.object.type === 'identifier' && node.object.name === 'firestore' &&
          (node.method === 'get' || node.method === 'exists')) {
          count++;
        }
        visit(node.object);
        node.args.forEach(visit);
        break;
      case 'memberAccess': visit(node.object); break;
      case 'bracketAccess': visit(node.object); visit(node.index); break;
      case 'sliceAccess': visit(node.object); visit(node.start); visit(node.end); break;
      case 'inExpr': visit(node.element); visit(node.collection); break;
      case 'isExpr': visit(node.value); break;
      case 'listLiteral': node.elements.forEach(visit); break;
      case 'mapLiteral': node.entries.forEach((entry) => { visit(entry.key); visit(entry.value); }); break;
      case 'pathLiteral':
        for (const segment of node.segments) {
          if (typeof segment !== 'string') visit(segment);
        }
        break;
    }
    return { count, hitStack };
  }
}
