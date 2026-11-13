import { assembleExpression } from '../grammar/FirestoreAssembler.js';
import type { AllowRule, Expression, FunctionDef, MatchBlock } from '../grammar/FirestoreAST.js';
import {
  analyzeListRulePathInvariance,
  type ListRulePathAnalysis,
} from './list-rule-path-proof.js';
import {
  getFunctionScope,
  getValidFunctionLexicalScope,
  type FunctionScopeBindings,
} from './match-resolution.js';
import {
  callsResolveInOuterScope,
  inlineFunctionsInExpr,
  isProvablyDocIndependent,
  lexicalCaptureLiteralBindings,
  substituteIdentifiers,
} from './query-proof-scope.js';

export interface OrBudgetStep {
  readonly operator: Expression;
  readonly side: 'before' | 'after';
  readonly branch: Expression;
}

export type ListBlockStep =
  | { readonly kind: 'budget'; readonly rule: AllowRule; readonly index: number }
  | { readonly kind: 'grant'; readonly rule: AllowRule; readonly index: number };

export interface WorstCaseBudgetOptions {
  readonly outerFunctions: ReadonlyMap<string, FunctionDef>;
  readonly functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>;
  readonly candidateVariables?: ReadonlySet<string>;
  readonly ambiguousNames?: ReadonlySet<string>;
  readonly checkResourceDependence?: boolean;
}

const orBudgetStepsMap = new WeakMap<Expression, readonly OrBudgetStep[]>();
const listBlockStepsMap = new WeakMap<MatchBlock, readonly ListBlockStep[]>();
const LOOKUP_BUILTINS = new Set(['get', 'exists', 'getAfter', 'existsAfter']);
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

export function attachOrBudgetStep(target: Expression, step: OrBudgetStep): Expression {
  const existing = orBudgetStepsMap.get(target) ?? [];
  const cloned: Expression = { ...target };
  orBudgetStepsMap.set(cloned, [step, ...existing]);
  return cloned;
}

export function getOrBudgetSteps(expr: Expression): readonly OrBudgetStep[] | undefined {
  return orBudgetStepsMap.get(expr);
}

export function setListBlockSteps(block: MatchBlock, steps: readonly ListBlockStep[]): void {
  listBlockStepsMap.set(block, steps);
}

export function getListBlockSteps(block: MatchBlock): readonly ListBlockStep[] | undefined {
  return listBlockStepsMap.get(block);
}

function hasAttachedBudgetSteps(expr: Expression): boolean {
  const seen = new Set<Expression>();
  const walk = (node: Expression): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    const steps = getOrBudgetSteps(node);
    if (steps && steps.length > 0) return true;
    switch (node.type) {
      case 'literal':
      case 'identifier':
        return false;
      case 'memberAccess':
        return walk(node.object);
      case 'bracketAccess':
        return walk(node.object) || walk(node.index);
      case 'sliceAccess':
        return walk(node.object) || walk(node.start) || walk(node.end);
      case 'binaryOp':
        return walk(node.left) || walk(node.right);
      case 'unaryOp':
        return walk(node.operand);
      case 'ternary':
        return walk(node.condition) || walk(node.consequent) || walk(node.alternate);
      case 'inExpr':
        return walk(node.element) || walk(node.collection);
      case 'isExpr':
        return walk(node.value);
      case 'listLiteral':
        return node.elements.some(walk);
      case 'mapLiteral':
        return node.entries.some((entry) => walk(entry.key) || walk(entry.value));
      case 'pathLiteral':
        return node.segments.some((seg) => typeof seg !== 'string' && walk(seg));
      case 'methodCall':
        return walk(node.object) || node.args.some(walk);
      case 'functionCall':
        return node.args.some(walk);
    }
  };
  return walk(expr);
}

function collectReachableFunctionDefs(
  expr: Expression,
  currentFunctions: ReadonlyMap<string, FunctionDef>,
  out: Set<FunctionDef>,
  visiting: Set<FunctionDef> = new Set(),
): void {
  const steps = getOrBudgetSteps(expr);
  if (steps) {
    for (const step of steps) {
      collectReachableFunctionDefs(step.branch, currentFunctions, out, visiting);
    }
  }
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return;
    case 'memberAccess':
      collectReachableFunctionDefs(expr.object, currentFunctions, out, visiting);
      return;
    case 'bracketAccess':
      collectReachableFunctionDefs(expr.object, currentFunctions, out, visiting);
      collectReachableFunctionDefs(expr.index, currentFunctions, out, visiting);
      return;
    case 'sliceAccess':
      collectReachableFunctionDefs(expr.object, currentFunctions, out, visiting);
      collectReachableFunctionDefs(expr.start, currentFunctions, out, visiting);
      collectReachableFunctionDefs(expr.end, currentFunctions, out, visiting);
      return;
    case 'binaryOp':
      collectReachableFunctionDefs(expr.left, currentFunctions, out, visiting);
      collectReachableFunctionDefs(expr.right, currentFunctions, out, visiting);
      return;
    case 'unaryOp':
      collectReachableFunctionDefs(expr.operand, currentFunctions, out, visiting);
      return;
    case 'ternary':
      collectReachableFunctionDefs(expr.condition, currentFunctions, out, visiting);
      collectReachableFunctionDefs(expr.consequent, currentFunctions, out, visiting);
      collectReachableFunctionDefs(expr.alternate, currentFunctions, out, visiting);
      return;
    case 'inExpr':
      collectReachableFunctionDefs(expr.element, currentFunctions, out, visiting);
      collectReachableFunctionDefs(expr.collection, currentFunctions, out, visiting);
      return;
    case 'isExpr':
      collectReachableFunctionDefs(expr.value, currentFunctions, out, visiting);
      return;
    case 'listLiteral':
      for (const el of expr.elements) {
        collectReachableFunctionDefs(el, currentFunctions, out, visiting);
      }
      return;
    case 'mapLiteral':
      for (const entry of expr.entries) {
        collectReachableFunctionDefs(entry.key, currentFunctions, out, visiting);
        collectReachableFunctionDefs(entry.value, currentFunctions, out, visiting);
      }
      return;
    case 'pathLiteral':
      for (const seg of expr.segments) {
        if (typeof seg !== 'string') {
          collectReachableFunctionDefs(seg, currentFunctions, out, visiting);
        }
      }
      return;
    case 'methodCall':
      collectReachableFunctionDefs(expr.object, currentFunctions, out, visiting);
      for (const arg of expr.args) {
        collectReachableFunctionDefs(arg, currentFunctions, out, visiting);
      }
      return;
    case 'functionCall': {
      for (const arg of expr.args) {
        collectReachableFunctionDefs(arg, currentFunctions, out, visiting);
      }
      const fn = currentFunctions.get(expr.name);
      if (!fn) return;
      out.add(fn);
      if (visiting.has(fn)) return;
      visiting.add(fn);
      const nextFunctions = getValidFunctionLexicalScope(fn, currentFunctions) ?? currentFunctions;
      for (const b of fn.lets) {
        collectReachableFunctionDefs(b.value, nextFunctions, out, visiting);
      }
      collectReachableFunctionDefs(fn.body, nextFunctions, out, visiting);
      visiting.delete(fn);
    }
  }
}

function mentionsIdentifier(expr: Expression, name: string): boolean {
  switch (expr.type) {
    case 'literal':
      return false;
    case 'identifier':
      return expr.name === name;
    case 'memberAccess':
      return mentionsIdentifier(expr.object, name);
    case 'bracketAccess':
      return mentionsIdentifier(expr.object, name) || mentionsIdentifier(expr.index, name);
    case 'sliceAccess':
      return (
        mentionsIdentifier(expr.object, name)
        || mentionsIdentifier(expr.start, name)
        || mentionsIdentifier(expr.end, name)
      );
    case 'binaryOp':
      return mentionsIdentifier(expr.left, name) || mentionsIdentifier(expr.right, name);
    case 'unaryOp':
      return mentionsIdentifier(expr.operand, name);
    case 'ternary':
      return (
        mentionsIdentifier(expr.condition, name)
        || mentionsIdentifier(expr.consequent, name)
        || mentionsIdentifier(expr.alternate, name)
      );
    case 'inExpr':
      return mentionsIdentifier(expr.element, name) || mentionsIdentifier(expr.collection, name);
    case 'isExpr':
      return mentionsIdentifier(expr.value, name);
    case 'listLiteral':
      return expr.elements.some((el) => mentionsIdentifier(el, name));
    case 'mapLiteral':
      return expr.entries.some((en) => mentionsIdentifier(en.key, name) || mentionsIdentifier(en.value, name));
    case 'pathLiteral':
      return expr.segments.some((seg) => typeof seg !== 'string' && mentionsIdentifier(seg, name));
    case 'methodCall':
      return mentionsIdentifier(expr.object, name) || expr.args.some((arg) => mentionsIdentifier(arg, name));
    case 'functionCall':
      return expr.args.some((arg) => mentionsIdentifier(arg, name));
  }
}

function mayPerformDocumentLookup(
  expr: Expression,
  currentFunctions: ReadonlyMap<string, FunctionDef>,
  visiting: ReadonlySet<FunctionDef> = new Set(),
): boolean {
  const steps = getOrBudgetSteps(expr);
  if (steps?.some((step) => mayPerformDocumentLookup(step.branch, currentFunctions, visiting))) {
    return true;
  }
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return false;
    case 'memberAccess':
      return mayPerformDocumentLookup(expr.object, currentFunctions, visiting);
    case 'bracketAccess':
      return (
        mayPerformDocumentLookup(expr.object, currentFunctions, visiting)
        || mayPerformDocumentLookup(expr.index, currentFunctions, visiting)
      );
    case 'sliceAccess':
      return (
        mayPerformDocumentLookup(expr.object, currentFunctions, visiting)
        || mayPerformDocumentLookup(expr.start, currentFunctions, visiting)
        || mayPerformDocumentLookup(expr.end, currentFunctions, visiting)
      );
    case 'binaryOp':
      return (
        mayPerformDocumentLookup(expr.left, currentFunctions, visiting)
        || mayPerformDocumentLookup(expr.right, currentFunctions, visiting)
      );
    case 'unaryOp':
      return mayPerformDocumentLookup(expr.operand, currentFunctions, visiting);
    case 'ternary':
      return (
        mayPerformDocumentLookup(expr.condition, currentFunctions, visiting)
        || mayPerformDocumentLookup(expr.consequent, currentFunctions, visiting)
        || mayPerformDocumentLookup(expr.alternate, currentFunctions, visiting)
      );
    case 'inExpr':
      return (
        mayPerformDocumentLookup(expr.element, currentFunctions, visiting)
        || mayPerformDocumentLookup(expr.collection, currentFunctions, visiting)
      );
    case 'isExpr':
      return mayPerformDocumentLookup(expr.value, currentFunctions, visiting);
    case 'listLiteral':
      return expr.elements.some((el) => mayPerformDocumentLookup(el, currentFunctions, visiting));
    case 'mapLiteral':
      return expr.entries.some(
        (en) =>
          mayPerformDocumentLookup(en.key, currentFunctions, visiting)
          || mayPerformDocumentLookup(en.value, currentFunctions, visiting),
      );
    case 'pathLiteral':
      return expr.segments.some(
        (seg) => typeof seg !== 'string' && mayPerformDocumentLookup(seg, currentFunctions, visiting),
      );
    case 'methodCall':
      return (
        mayPerformDocumentLookup(expr.object, currentFunctions, visiting)
        || expr.args.some((arg) => mayPerformDocumentLookup(arg, currentFunctions, visiting))
      );
    case 'functionCall': {
      if (expr.args.some((arg) => mayPerformDocumentLookup(arg, currentFunctions, visiting))) {
        return true;
      }
      const fn = currentFunctions.get(expr.name);
      if (!fn) {
        return LOOKUP_BUILTINS.has(expr.name);
      }
      if (visiting.has(fn)) return true;
      const nextVisiting = new Set(visiting).add(fn);
      const nextFunctions = getValidFunctionLexicalScope(fn, currentFunctions) ?? currentFunctions;
      if (fn.lets.some((b) => mayPerformDocumentLookup(b.value, nextFunctions, nextVisiting))) {
        return true;
      }
      return mayPerformDocumentLookup(fn.body, nextFunctions, nextVisiting);
    }
  }
}

function budgetTokenForExpr(expr: Expression): string {
  return `__pyric_budget_${encodeURIComponent(assembleExpression(expr))}__`;
}

/**
 * Projects an unprovable rule condition or dropped `||` branch so that
 * residual list evaluation charges the worst-case document-lookup and
 * expression budgets across unconstrained document fields and candidate
 * path variables without short-circuiting on `syntheticResource = {}` or
 * placeholder document IDs.
 */
export function projectWorstCaseBudgetExpr(
  expr: Expression,
  options: WorstCaseBudgetOptions,
): { expr: Expression; requiredFunctionDefs: ReadonlySet<FunctionDef> } {
  const {
    outerFunctions,
    functionScopes,
    candidateVariables,
    ambiguousNames = EMPTY_STRING_SET,
    checkResourceDependence = false,
  } = options;
  const requiredDefs = new Set<FunctionDef>();
  let expansionBudget = 2000;

  const checkInvariance = (
    node: Expression,
    currentFunctions: ReadonlyMap<string, FunctionDef>,
    currentCandidateVars: ReadonlySet<string> | undefined,
  ): { invariant: boolean; pathAnalysis?: ListRulePathAnalysis } => {
    if (hasAttachedBudgetSteps(node)) {
      return { invariant: false };
    }
    if (!callsResolveInOuterScope(node, currentFunctions, outerFunctions)) {
      return { invariant: false };
    }
    if (checkResourceDependence && !isProvablyDocIndependent(node, currentFunctions)) {
      return { invariant: false };
    }
    if (currentCandidateVars !== undefined) {
      const pathAnalysis = analyzeListRulePathInvariance(
        node,
        currentCandidateVars,
        currentFunctions,
        ambiguousNames,
        functionScopes,
      );
      if (!pathAnalysis.pathInvariant) {
        return { invariant: false, pathAnalysis };
      }
      return { invariant: true, pathAnalysis };
    }
    return { invariant: true };
  };

  const project = (
    node: Expression,
    currentFunctions: ReadonlyMap<string, FunctionDef>,
    currentCandidateVars: ReadonlySet<string> | undefined,
    visiting: ReadonlySet<FunctionDef>,
  ): Expression => {
    if (--expansionBudget < 0) {
      collectReachableFunctionDefs(node, currentFunctions, requiredDefs);
      return node;
    }

    const priorSteps = getOrBudgetSteps(node);
    if (priorSteps && priorSteps.length > 0) {
      const stripped: Expression = { ...node };
      let projectedTarget = project(stripped, currentFunctions, currentCandidateVars, visiting);
      const projectedSteps = priorSteps.map((step) => ({
        ...step,
        branch: project(step.branch, currentFunctions, currentCandidateVars, visiting),
      }));
      for (let i = projectedSteps.length - 1; i >= 0; i--) {
        projectedTarget = attachOrBudgetStep(projectedTarget, projectedSteps[i]!);
      }
      return projectedTarget;
    }

    const inv = checkInvariance(node, currentFunctions, currentCandidateVars);
    if (inv.invariant) {
      if (inv.pathAnalysis) {
        for (const fnDef of inv.pathAnalysis.requiredFunctionDefs) {
          requiredDefs.add(fnDef);
        }
      } else {
        collectReachableFunctionDefs(node, currentFunctions, requiredDefs);
      }
      return node;
    }

    if (node.type === 'functionCall' && currentFunctions.has(node.name)) {
      const fn = currentFunctions.get(node.name)!;
      const fnScope = getFunctionScope(fn);
      const nextFunctions = getValidFunctionLexicalScope(fn, currentFunctions);
      if (
        visiting.has(fn)
        || fn.parameters.length !== node.args.length
        || !nextFunctions
        || (!fnScope && ambiguousNames.has(node.name))
      ) {
        requiredDefs.add(fn);
        collectReachableFunctionDefs(node, currentFunctions, requiredDefs);
        return {
          ...node,
          args: node.args.map((arg) => project(arg, currentFunctions, currentCandidateVars, visiting)),
        };
      }

      const expandedArgs: Expression[] = [];
      let crossScopeFailed = false;
      for (const arg of node.args) {
        if (
          currentFunctions !== nextFunctions
          && !callsResolveInOuterScope(arg, currentFunctions, nextFunctions)
        ) {
          const inlinedArg = inlineFunctionsInExpr(arg, currentFunctions, visiting, functionScopes);
          if (
            !inlinedArg
            || !callsResolveInOuterScope(inlinedArg, currentFunctions, nextFunctions)
            || !callsResolveInOuterScope(inlinedArg, currentFunctions, outerFunctions)
          ) {
            crossScopeFailed = true;
            break;
          }
          expandedArgs.push(inlinedArg);
        } else {
          expandedArgs.push(arg);
        }
      }

      if (crossScopeFailed) {
        requiredDefs.add(fn);
        collectReachableFunctionDefs(node, currentFunctions, requiredDefs);
        return {
          ...node,
          args: node.args.map((arg) => project(arg, currentFunctions, currentCandidateVars, visiting)),
        };
      }

      const bindings = lexicalCaptureLiteralBindings(fn, functionScopes);
      for (let i = 0; i < fn.parameters.length; i++) {
        bindings.set(fn.parameters[i]!, expandedArgs[i]!);
      }

      let nextCandidateVars = currentCandidateVars;
      const fnLexical = functionScopes?.get(fn);
      if (fnLexical && nextCandidateVars !== undefined) {
        nextCandidateVars = new Set([
          ...nextCandidateVars,
          ...fnLexical.candidateVariables,
        ]);
      }

      const nextVisiting = new Set(visiting).add(fn);
      const eagerSteps: Expression[] = [];
      for (let i = 0; i < fn.lets.length; i++) {
        const binding = fn.lets[i]!;
        const boundLet = substituteIdentifiers(binding.value, bindings);
        const referencedLater =
          fn.lets.slice(i + 1).some((later) => mentionsIdentifier(later.value, binding.name))
          || mentionsIdentifier(fn.body, binding.name);
        if (!referencedLater || mayPerformDocumentLookup(boundLet, nextFunctions)) {
          eagerSteps.push(project(boundLet, nextFunctions, nextCandidateVars, nextVisiting));
        }
        bindings.set(binding.name, boundLet);
      }

      let projectedBody = project(
        substituteIdentifiers(fn.body, bindings),
        nextFunctions,
        nextCandidateVars,
        nextVisiting,
      );
      for (let i = eagerSteps.length - 1; i >= 0; i--) {
        projectedBody = attachOrBudgetStep(projectedBody, {
          operator: node,
          side: 'before',
          branch: eagerSteps[i]!,
        });
      }
      return projectedBody;
    }

    if (node.type === 'unaryOp' && node.op === '!') {
      const inner = node.operand;
      if (inner.type === 'binaryOp' && (inner.op === '&&' || inner.op === '||')) {
        return project(
          {
            type: 'binaryOp',
            op: inner.op === '&&' ? '||' : '&&',
            left: { type: 'unaryOp', op: '!', operand: inner.left },
            right: { type: 'unaryOp', op: '!', operand: inner.right },
          },
          currentFunctions,
          currentCandidateVars,
          visiting,
        );
      }
      if (inner.type === 'unaryOp' && inner.op === '!') {
        const sub = project(inner.operand, currentFunctions, currentCandidateVars, visiting);
        return sub === inner.operand
          ? node
          : { type: 'unaryOp', op: '!', operand: { type: 'unaryOp', op: '!', operand: sub } };
      }
      if (inner.type === 'ternary') {
        return project(
          {
            ...inner,
            consequent: { type: 'unaryOp', op: '!', operand: inner.consequent },
            alternate: { type: 'unaryOp', op: '!', operand: inner.alternate },
          },
          currentFunctions,
          currentCandidateVars,
          visiting,
        );
      }
      const sub = project(inner, currentFunctions, currentCandidateVars, visiting);
      return sub === inner ? node : { ...node, operand: sub };
    }

    if (node.type === 'binaryOp' && (node.op === '&&' || node.op === '||')) {
      const left = project(node.left, currentFunctions, currentCandidateVars, visiting);
      const right = project(node.right, currentFunctions, currentCandidateVars, visiting);
      const leftInvariant = checkInvariance(node.left, currentFunctions, currentCandidateVars).invariant;
      if (!leftInvariant) {
        return attachOrBudgetStep(right, {
          operator: node,
          side: 'before',
          branch: left,
        });
      }
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }

    if (node.type === 'ternary') {
      const condition = project(node.condition, currentFunctions, currentCandidateVars, visiting);
      const consequent = project(node.consequent, currentFunctions, currentCandidateVars, visiting);
      const alternate = project(node.alternate, currentFunctions, currentCandidateVars, visiting);
      const condInvariant = checkInvariance(node.condition, currentFunctions, currentCandidateVars).invariant;
      if (!condInvariant) {
        const withConsequent = attachOrBudgetStep(alternate, {
          operator: node,
          side: 'before',
          branch: consequent,
        });
        return attachOrBudgetStep(withConsequent, {
          operator: node,
          side: 'before',
          branch: condition,
        });
      }
      return condition === node.condition && consequent === node.consequent && alternate === node.alternate
        ? node
        : { ...node, condition, consequent, alternate };
    }

    if (
      node.type === 'functionCall'
      && !currentFunctions.has(node.name)
      && LOOKUP_BUILTINS.has(node.name)
      && node.args.length === 1
    ) {
      const arg = node.args[0]!;
      if (arg.type === 'pathLiteral') {
        const segSteps: Expression[] = [];
        let changed = false;
        const segments = arg.segments.map((seg) => {
          if (typeof seg === 'string') return seg;
          const segInv = checkInvariance(seg, currentFunctions, currentCandidateVars);
          if (segInv.invariant) {
            if (segInv.pathAnalysis) {
              for (const fnDef of segInv.pathAnalysis.requiredFunctionDefs) {
                requiredDefs.add(fnDef);
              }
            } else {
              collectReachableFunctionDefs(seg, currentFunctions, requiredDefs);
            }
            return seg;
          }
          changed = true;
          segSteps.push(project(seg, currentFunctions, currentCandidateVars, visiting));
          return budgetTokenForExpr(seg);
        });
        if (!changed) return node;
        let rewrittenCall: Expression = {
          ...node,
          args: [{ ...arg, segments }],
        };
        for (let i = segSteps.length - 1; i >= 0; i--) {
          rewrittenCall = attachOrBudgetStep(rewrittenCall, {
            operator: node,
            side: 'before',
            branch: segSteps[i]!,
          });
        }
        return rewrittenCall;
      }

      const argInv = checkInvariance(arg, currentFunctions, currentCandidateVars);
      if (!argInv.invariant) {
        const projectedArg = project(arg, currentFunctions, currentCandidateVars, visiting);
        const token = budgetTokenForExpr(arg);
        const syntheticPath: Expression = {
          type: 'pathLiteral',
          raw: `/databases/$(database)/documents/__pyric_budget_ref__/${token}`,
          segments: [
            'databases',
            { type: 'identifier', name: 'database' },
            'documents',
            '__pyric_budget_ref__',
            token,
          ],
          isReference: true,
        };
        return attachOrBudgetStep(
          { ...node, args: [syntheticPath] },
          {
            operator: node,
            side: 'before',
            branch: projectedArg,
          },
        );
      }
    }

    const sub = (child: Expression): Expression =>
      project(child, currentFunctions, currentCandidateVars, visiting);

    switch (node.type) {
      case 'literal':
      case 'identifier':
        return node;
      case 'memberAccess': {
        const object = sub(node.object);
        return object === node.object ? node : { ...node, object };
      }
      case 'bracketAccess': {
        const object = sub(node.object);
        const index = sub(node.index);
        return object === node.object && index === node.index ? node : { ...node, object, index };
      }
      case 'sliceAccess': {
        const object = sub(node.object);
        const start = sub(node.start);
        const end = sub(node.end);
        return object === node.object && start === node.start && end === node.end
          ? node
          : { ...node, object, start, end };
      }
      case 'binaryOp': {
        const left = sub(node.left);
        const right = sub(node.right);
        return left === node.left && right === node.right ? node : { ...node, left, right };
      }
      case 'unaryOp': {
        const operand = sub(node.operand);
        return operand === node.operand ? node : { ...node, operand };
      }
      case 'inExpr': {
        const element = sub(node.element);
        const collection = sub(node.collection);
        return element === node.element && collection === node.collection
          ? node
          : { ...node, element, collection };
      }
      case 'isExpr': {
        const value = sub(node.value);
        return value === node.value ? node : { ...node, value };
      }
      case 'listLiteral': {
        const elements = node.elements.map(sub);
        return elements.every((el, idx) => el === node.elements[idx]) ? node : { ...node, elements };
      }
      case 'mapLiteral': {
        const entries = node.entries.map((entry) => ({
          key: sub(entry.key),
          value: sub(entry.value),
        }));
        return entries.every(
          (entry, idx) =>
            entry.key === node.entries[idx]!.key && entry.value === node.entries[idx]!.value,
        )
          ? node
          : { ...node, entries };
      }
      case 'pathLiteral': {
        const segments = node.segments.map((seg) => (typeof seg === 'string' ? seg : sub(seg)));
        return segments.every((seg, idx) => seg === node.segments[idx]) ? node : { ...node, segments };
      }
      case 'methodCall': {
        const object = sub(node.object);
        const args = node.args.map(sub);
        return object === node.object && args.every((arg, idx) => arg === node.args[idx])
          ? node
          : { ...node, object, args };
      }
      case 'functionCall': {
        const fn = currentFunctions.get(node.name);
        if (fn) requiredDefs.add(fn);
        const args = node.args.map(sub);
        return args.every((arg, idx) => arg === node.args[idx]) ? node : { ...node, args };
      }
    }
  };

  const projectedExpr = project(expr, outerFunctions, candidateVariables, new Set());
  return { expr: projectedExpr, requiredFunctionDefs: requiredDefs };
}
