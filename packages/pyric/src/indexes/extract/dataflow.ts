/**
 * `scanFunctionBody` — intra-procedural walker that finds every assignment
 * to a chain variable (typically `q`) inside a function body, classifies
 * each assignment's RHS via `classifyQueryCall`, and stamps each emitted
 * fragment with branch context (branchId/clauseId/skippable).
 *
 * Branch context lets the enumerator (next module) correctly model
 * mutually exclusive clauses and skippable optional `if (cond)` blocks.
 *
 * Scope:
 *   - Variable bindings tracked at function scope only.
 *   - if/else-if/else chains supported. switch / try / nested function
 *     bodies are walked but their branches are NOT enumerated separately
 *     (treated as unconditional within the enclosing scope).
 *   - Optional inter-procedural following (Layer 2.5): callers may pass a
 *     `CallResolver` to recursively inline a same-file wrapper that takes
 *     the chain variable as a parameter and returns a modified chain.
 *     Single-level only, root-context only, identifier-arg only.
 */
import ts from 'typescript';
import { getCalleeName } from './ast.js';
import { classifyQueryCall, type ClassifiedFragment } from './classify.js';
import type { Fragment, QueryBaseDecl } from './types.js';

/**
 * Result returned by a `CallResolver` when it knows how to inline a call.
 *
 * `body` is the wrapper function's body node — the recursion runs
 * `scanFunctionBody`'s inner walker over it, treating `chainParamName` as
 * the wrapper's chain variable.
 */
export interface ResolvedCall {
  body: ts.Node;
  chainParamName: string;
}

/**
 * Optional callback that lets the walker follow chain-var-passing calls
 * into other functions in the same source file (Layer 2.5).
 *
 * Receives the called function's name and the position of the chain
 * variable in the argument list. Returns the wrapper's body and the
 * parameter name corresponding to that argument, or `null` if the call
 * shouldn't be followed (unknown function, wrong arity, parameter not an
 * identifier, etc.).
 */
export type CallResolver = (functionName: string, chainArgIndex: number) => ResolvedCall | null;

interface BranchContext {
  branchId: number | null;
  clauseId: number | null;
  skippable: boolean;
}

interface ScanContext {
  /** Per-invocation counter — replaces the probe's module-level `let`. */
  nextBranchId: number;
}

const ROOT_CTX: BranchContext = { branchId: null, clauseId: null, skippable: false };

/**
 * Decide whether an `if`-chain has a final `else` (so one branch always
 * runs) or not (so all branches are individually skippable).
 */
function ifChainHasFinalElse(node: ts.IfStatement): boolean {
  let cur: ts.IfStatement | undefined = node;
  while (cur) {
    if (!cur.elseStatement) return false;
    if (ts.isIfStatement(cur.elseStatement)) {
      cur = cur.elseStatement;
    } else {
      return true; // final else block
    }
  }
  return false;
}

/**
 * Apply branch context to a classified fragment, producing the final
 * `Fragment` shape with branchId/clauseId/skippable populated.
 *
 * INIT contributions are NOT emitted as fragments — they're recorded on
 * the QueryBaseDecl directly. Only constraint fragments flow through.
 */
function attachContext(frag: ClassifiedFragment, ctx: BranchContext): Fragment {
  return {
    kind: frag.kind,
    filter: frag.filter,
    order: frag.order,
    limit: frag.limit,
    branchId: ctx.branchId,
    clauseId: ctx.clauseId,
    skippable: ctx.skippable,
  };
}

export function scanFunctionBody(
  body: ts.Node,
  varName: string,
  callResolver?: CallResolver,
): QueryBaseDecl {
  const decl: QueryBaseDecl = {
    varName,
    collectionPath: null,
    isCollectionGroup: false,
    fragments: [],
  };
  const scan: ScanContext = { nextBranchId: 1 };

  /**
   * Try to inline a non-`query` call that receives the current chain
   * variable as an argument. Returns true when the call was recognized
   * (whether or not it actually inlined — a recognized-but-skipped call
   * still yields a warning and shouldn't be re-tried elsewhere).
   *
   * Hard limits per Layer 2.5 design:
   *   - Single-level only (depth 0 inlines once; depth ≥ 1 short-circuits
   *     with `inter-proc-recursion` warning).
   *   - Root context only — calls inside `if`-branches surface
   *     `inter-proc-nested` and skip inlining.
   *   - Chain variable must appear as a bare identifier in the args.
   */
  function tryInlineCall(
    call: ts.CallExpression,
    chainVar: string,
    ctx: BranchContext,
    depth: number,
  ): boolean {
    if (!callResolver) return false;
    const fnName = getCalleeName(call);
    if (!fnName || fnName === 'query') return false;

    let chainArgIndex = -1;
    for (let i = 0; i < call.arguments.length; i++) {
      const a = call.arguments[i];
      if (ts.isIdentifier(a) && a.text === chainVar) {
        chainArgIndex = i;
        break;
      }
    }
    if (chainArgIndex === -1) return false;

    if (depth >= 1) {
      pushInterProcWarning('inter-proc-recursion', fnName, `Skipped follow into '${fnName}': single-level inter-procedural only.`);
      return true;
    }

    if (ctx.branchId !== null) {
      pushInterProcWarning('inter-proc-nested', fnName, `Skipped follow into '${fnName}': call site is inside a branch.`);
      return true;
    }

    const resolved = callResolver(fnName, chainArgIndex);
    if (!resolved) return false;

    walkBody(resolved.body, resolved.chainParamName, depth + 1);
    decl.inlinedFunctions = decl.inlinedFunctions ?? [];
    if (!decl.inlinedFunctions.includes(fnName)) decl.inlinedFunctions.push(fnName);
    return true;
  }

  function pushInterProcWarning(
    code: 'inter-proc-nested' | 'inter-proc-recursion',
    functionName: string,
    message: string,
  ): void {
    decl.interProcWarnings = decl.interProcWarnings ?? [];
    decl.interProcWarnings.push({ code, functionName, message });
  }

  /**
   * Walk a function body looking for assignments to `chainVar`. The same
   * `decl` and `scan.nextBranchId` are shared across recursive calls so
   * branch IDs across caller + wrapper stay distinct.
   */
  function walkBody(targetBody: ts.Node, chainVar: string, depth: number): void {
    function processAssignmentRHS(rhs: ts.Expression, ctx: BranchContext): void {
      if (!ts.isCallExpression(rhs)) return;
      if (getCalleeName(rhs) === 'query') {
        const r = classifyQueryCall(rhs, chainVar);
        if (r.isInit) {
          // The first INIT we see wins. Subsequent re-INITs would mean
          // the chain restarts — rare in real code, ignored for v1.
          if (decl.collectionPath === null) {
            decl.collectionPath = r.collectionPath ?? null;
            decl.isCollectionGroup = r.isCollectionGroup ?? false;
          }
        }
        for (const f of r.fragments) {
          decl.fragments.push(attachContext(f, ctx));
        }
        return;
      }
      // Not a `query(...)` call — try the inter-procedural follower.
      tryInlineCall(rhs, chainVar, ctx, depth);
    }

    function visit(node: ts.Node, ctx: BranchContext): void {
      // 1. Variable declaration: `let q = query(...)` or `let q = wrapper(q,...)`
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === chainVar && d.initializer) {
            processAssignmentRHS(d.initializer, ctx);
          }
        }
      }

      // 2. Assignment: `q = query(q, ...)` or `q = wrapper(q, ...)`
      if (
        ts.isExpressionStatement(node)
        && ts.isBinaryExpression(node.expression)
        && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const lhs = node.expression.left;
        if (ts.isIdentifier(lhs) && lhs.text === chainVar) {
          processAssignmentRHS(node.expression.right, ctx);
        }
      }

      // 3. if/else chain: open a new branchId, walk each clause separately.
      if (ts.isIfStatement(node)) {
        const branchId = scan.nextBranchId++;
        const skippable = !ifChainHasFinalElse(node);

        let clauseIdx = 0;
        let walker: ts.IfStatement | ts.Statement | undefined = node;
        while (walker) {
          if (ts.isIfStatement(walker)) {
            visit(walker.thenStatement, { branchId, clauseId: clauseIdx, skippable });
            if (walker.elseStatement && !ts.isIfStatement(walker.elseStatement)) {
              // final else
              clauseIdx += 1;
              visit(walker.elseStatement, { branchId, clauseId: clauseIdx, skippable });
              walker = undefined;
            } else if (walker.elseStatement && ts.isIfStatement(walker.elseStatement)) {
              clauseIdx += 1;
              walker = walker.elseStatement;
            } else {
              walker = undefined;
            }
          } else {
            walker = undefined;
          }
        }
        return; // handled — don't recurse into the if's children again
      }

      // Default: recurse into children with the current ctx.
      ts.forEachChild(node, (n) => visit(n, ctx));
    }

    visit(targetBody, ROOT_CTX);
  }

  walkBody(body, varName, 0);
  return decl;
}
