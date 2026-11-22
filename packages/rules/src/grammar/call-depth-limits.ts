import type { Expression, FirestoreRules, FunctionDef, MatchBlock, ServiceBlock } from './FirestoreAST.js';
import { allServiceBlocks, isStorageServiceName, topLevelMatches } from './service-blocks.js';

/** Most functions one call stack may hold; 22 is rejected. */
export const CALL_DEPTH_LIMIT = 21;

/** Production's call depth message for a stack of {@link CALL_DEPTH_LIMIT} function names. */
export function callDepthMessage(stack: readonly string[]): string {
  return `Maximum allowed call depth of 20 is reached for [${stack.join('->')}] call stack.`;
}

export interface CallGraphNode {
  fn: FunctionDef;
  isFirestore: boolean;
  /** The declared functions this function calls, in call order. */
  callees: CallGraphNode[];
}

export function expressionChildren(expr: Expression): Expression[] {
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return [];
    case 'memberAccess':
      return [expr.object];
    case 'methodCall':
      return [expr.object, ...expr.args];
    case 'bracketAccess':
      return [expr.object, expr.index];
    case 'sliceAccess':
      return [expr.object, expr.start, expr.end];
    case 'binaryOp':
      return [expr.left, expr.right];
    case 'unaryOp':
      return [expr.operand];
    case 'ternary':
      return [expr.condition, expr.consequent, expr.alternate];
    case 'inExpr':
      return [expr.element, expr.collection];
    case 'isExpr':
      return [expr.value];
    case 'listLiteral':
      return expr.elements;
    case 'mapLiteral':
      return expr.entries.flatMap((e) => [e.key, e.value]);
    case 'pathLiteral':
      return expr.segments.filter((s): s is Expression => typeof s !== 'string');
    case 'functionCall':
      return expr.args;
  }
}

/**
 * Every declared function with the declared functions it calls. A call
 * resolves by declaration scope: the functions of the declaring match block
 * and each enclosing one, then service, then global scope, the innermost
 * declaration winning.
 */
export function buildCallGraph(
  ast: FirestoreRules,
  services: readonly ServiceBlock[] = allServiceBlocks(ast),
): CallGraphNode[] {
  interface Scope {
    names: Map<string, CallGraphNode>;
    parent: Scope | undefined;
  }
  const nodes: CallGraphNode[] = [];
  const pending: { node: CallGraphNode; scope: Scope }[] = [];
  const declare = (
    fns: readonly FunctionDef[],
    parent: Scope | undefined,
    isFirestore: boolean,
  ): Scope => {
    const scope: Scope = { names: new Map(), parent };
    for (const fn of fns) {
      const node: CallGraphNode = { fn, isFirestore, callees: [] };
      nodes.push(node);
      scope.names.set(fn.name, node);
      pending.push({ node, scope });
    }
    return scope;
  };
  const globalIsFirestore = services.length === 0 || services.some((s) => !isStorageServiceName(s.name));
  const globalScope = declare(ast.functions ?? [], undefined, globalIsFirestore);
  const walk = (match: MatchBlock, parent: Scope, isFirestore: boolean) => {
    const scope = declare(match.functions, parent, isFirestore);
    for (const child of match.children) walk(child, scope, isFirestore);
  };
  for (const service of services) {
    const svcIsFirestore = !isStorageServiceName(service.name);
    const serviceScope = declare(service.functions ?? [], globalScope, svcIsFirestore);
    for (const root of topLevelMatches(service)) {
      walk(root, serviceScope, svcIsFirestore);
    }
  }

  for (const { node, scope } of pending) {
    const seen = new Set<CallGraphNode>();
    const visit = (expr: Expression) => {
      if (expr.type === 'functionCall') {
        for (let s: Scope | undefined = scope; s; s = s.parent) {
          const callee = s.names.get(expr.name);
          if (callee === undefined) continue;
          if (!seen.has(callee)) {
            seen.add(callee);
            node.callees.push(callee);
          }
          break;
        }
      }
      for (const child of expressionChildren(expr)) visit(child);
    };
    for (const binding of node.fn.lets) visit(binding.value);
    visit(node.fn.body);
  }
  return nodes;
}

export interface CallDepthRejection {
  code: 'CALL_DEPTH';
  message: string;
  line?: number;
  functionName: string;
}

/**
 * One rejection per call chain longer than {@link CALL_DEPTH_LIMIT},
 * reported from the chain's first function: one no other function calls.
 */
export function callDepthViolations(nodes: readonly CallGraphNode[]): CallDepthRejection[] {
  const depth = new Map<CallGraphNode, number>();
  const onStack = new Set<CallGraphNode>();
  const longest = (node: CallGraphNode): number => {
    const known = depth.get(node);
    if (known !== undefined) return known;
    if (onStack.has(node)) return Infinity;
    onStack.add(node);
    let deepest = 0;
    for (const callee of node.callees) deepest = Math.max(deepest, longest(callee));
    onStack.delete(node);
    depth.set(node, deepest + 1);
    return deepest + 1;
  };

  const called = new Set<CallGraphNode>();
  for (const node of nodes) {
    for (const callee of node.callees) {
      if (callee !== node) called.add(callee);
    }
  }
  const covered = new Set<CallGraphNode>();
  const cover = (node: CallGraphNode) => {
    if (covered.has(node)) return;
    covered.add(node);
    for (const callee of node.callees) cover(callee);
  };
  const starts: CallGraphNode[] = [];
  for (const node of nodes) {
    if (called.has(node)) continue;
    starts.push(node);
    cover(node);
  }
  for (const node of nodes) {
    if (covered.has(node) || longest(node) !== Infinity) continue;
    starts.push(node);
    cover(node);
  }

  const out: CallDepthRejection[] = [];
  for (const start of starts) {
    if (longest(start) <= CALL_DEPTH_LIMIT) continue;
    const chain = [start];
    while (chain.length <= CALL_DEPTH_LIMIT) {
      const tail = chain[chain.length - 1]!;
      let next = tail.callees[0]!;
      for (const callee of tail.callees) {
        if (longest(callee) > longest(next)) next = callee;
      }
      chain.push(next);
    }
    const over = chain[CALL_DEPTH_LIMIT]!;
    const rejection: CallDepthRejection = {
      code: 'CALL_DEPTH',
      message: callDepthMessage(chain.slice(0, CALL_DEPTH_LIMIT).map((n) => n.fn.name)),
      functionName: over.fn.name,
    };
    if (over.fn.loc !== undefined) {
      rejection.line = over.fn.loc.line;
    }
    out.push(rejection);
  }
  return out;
}
