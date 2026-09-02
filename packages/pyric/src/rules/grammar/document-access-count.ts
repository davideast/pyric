import type { Expression, FunctionDef } from './FirestoreAST.js';

/**
 * The four built-in document access calls production counts against a
 * request's 10-read budget.
 */
const DOCUMENT_ACCESS_BUILTINS = new Set(['get', 'exists', 'getAfter', 'existsAfter']);

/**
 * Count the document access calls (get/exists/getAfter/existsAfter)
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
  functions: Map<string, FunctionDef>,
  callStack: Set<string> = new Set<string>(),
): number {
  let count = 0;

  const visit = (e: Expression): void => {
    switch (e.type) {
      case 'functionCall':
        if (DOCUMENT_ACCESS_BUILTINS.has(e.name)) {
          count++;
        } else {
          const fn = functions.get(e.name);
          const isExpandable = fn !== undefined && !callStack.has(e.name);
          if (isExpandable) {
            callStack.add(e.name);
            for (const binding of fn!.lets) visit(binding.value);
            visit(fn!.body);
            callStack.delete(e.name); // unwind: count once per call site, not once per rule
          }
        }
        e.args.forEach(visit);
        break;
      case 'binaryOp': visit(e.left); visit(e.right); break;
      case 'unaryOp': visit(e.operand); break;
      case 'ternary': visit(e.condition); visit(e.consequent); visit(e.alternate); break;
      case 'methodCall': visit(e.object); e.args.forEach(visit); break;
      case 'memberAccess': visit(e.object); break;
      case 'bracketAccess': visit(e.object); visit(e.index); break;
      case 'sliceAccess': visit(e.object); visit(e.start); visit(e.end); break;
      case 'inExpr': visit(e.element); visit(e.collection); break;
      case 'isExpr': visit(e.value); break;
      case 'listLiteral': e.elements.forEach(visit); break;
      case 'mapLiteral': e.entries.forEach((entry) => { visit(entry.key); visit(entry.value); }); break;
      case 'pathLiteral':
        for (const segment of e.segments) {
          if (typeof segment !== 'string') visit(segment);
        }
        break;
    }
  };

  visit(expr);
  return count;
}
