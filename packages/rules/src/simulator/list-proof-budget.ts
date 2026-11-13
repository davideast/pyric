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

export type OrBudgetStep =
  | {
      readonly kind?: 'linear';
      readonly operator: Expression;
      readonly side: 'before' | 'after';
      readonly branch: Expression;
    }
  | {
      readonly kind: 'bind';
      readonly operator: Expression;
      readonly name: string;
      readonly branch: Expression;
      readonly isLet?: boolean;
    }
  | {
      readonly kind: 'fork';
      readonly operator: Expression;
      readonly condition?: Expression;
      readonly branches: readonly Expression[];
    }
  | {
      readonly kind: 'variants';
      readonly branches: readonly Expression[];
    };

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
const LOCAL_TOKEN_PATTERN = /__pyric_local_\d+__/g;
const MAX_INLINE_CANONICAL_KEY_LEN = 256;
const MAX_CANONICAL_CACHE_ENTRIES = 50_000;
const localCanonicalKeyMap = new Map<string, string>();
let nextBudgetLocalId = 0;

function fnv1aHex(input: string, seed: bigint): string {
  let h = seed;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}

function compactCanonicalKey(raw: string): string {
  if (raw.length <= MAX_INLINE_CANONICAL_KEY_LEN) return raw;
  const h1 = fnv1aHex(raw, 0xcbf29ce484222325n);
  const h2 = fnv1aHex(raw, 0x84222325cbf29ce4n);
  return `#digest:${raw.length}:${h1}${h2}#`;
}

function canonicalKeyForExpr(expr: Expression): string {
  if (expr.type === 'identifier') {
    const mapped = localCanonicalKeyMap.get(expr.name);
    if (mapped !== undefined) return mapped;
  }
  const raw = assembleExpression(expr);
  const expanded = raw.replace(LOCAL_TOKEN_PATTERN, (match) => {
    const mapped = localCanonicalKeyMap.get(match);
    return mapped !== undefined ? `(${mapped})` : match;
  });
  return compactCanonicalKey(expanded);
}

function recordLocalCanonicalKey(localName: string, boundExpr: Expression): void {
  if (localCanonicalKeyMap.size >= MAX_CANONICAL_CACHE_ENTRIES) {
    localCanonicalKeyMap.clear();
  }
  localCanonicalKeyMap.set(localName, canonicalKeyForExpr(boundExpr));
}

export function attachOrBudgetStep(target: Expression, step: OrBudgetStep): Expression {
  const existing = orBudgetStepsMap.get(target) ?? [];
  const cloned: Expression = { ...target };
  orBudgetStepsMap.set(cloned, [step, ...existing]);
  return cloned;
}

export function getOrBudgetSteps(expr: Expression): readonly OrBudgetStep[] | undefined {
  return orBudgetStepsMap.get(expr);
}

export function getOrBudgetStepExpressions(step: OrBudgetStep): readonly Expression[] {
  if (step.kind === 'fork') {
    return step.condition ? [step.condition, ...step.branches] : step.branches;
  }
  if (step.kind === 'variants') {
    return step.branches;
  }
  return [step.branch];
}

export function mapOrBudgetStepExpressions(
  step: OrBudgetStep,
  mapExpr: (expr: Expression) => Expression,
): OrBudgetStep {
  if (step.kind === 'fork') {
    return {
      ...step,
      ...(step.condition ? { condition: mapExpr(step.condition) } : {}),
      branches: step.branches.map(mapExpr),
    };
  }
  if (step.kind === 'variants') {
    return {
      ...step,
      branches: step.branches.map(mapExpr),
    };
  }
  return {
    ...step,
    branch: mapExpr(step.branch),
  };
}

export function setListBlockSteps(block: MatchBlock, steps: readonly ListBlockStep[]): void {
  listBlockStepsMap.set(block, steps);
}

export function getListBlockSteps(block: MatchBlock): readonly ListBlockStep[] | undefined {
  return listBlockStepsMap.get(block);
}

/** Visit direct child expressions of `expr` (excluding string path segments). */
export function forEachChildExpression(
  expr: Expression,
  visit: (child: Expression) => void,
): void {
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return;
    case 'memberAccess':
      visit(expr.object);
      return;
    case 'bracketAccess':
      visit(expr.object);
      visit(expr.index);
      return;
    case 'sliceAccess':
      visit(expr.object);
      visit(expr.start);
      visit(expr.end);
      return;
    case 'binaryOp':
      visit(expr.left);
      visit(expr.right);
      return;
    case 'unaryOp':
      visit(expr.operand);
      return;
    case 'ternary':
      visit(expr.condition);
      visit(expr.consequent);
      visit(expr.alternate);
      return;
    case 'inExpr':
      visit(expr.element);
      visit(expr.collection);
      return;
    case 'isExpr':
      visit(expr.value);
      return;
    case 'listLiteral':
      for (const el of expr.elements) visit(el);
      return;
    case 'mapLiteral':
      for (const entry of expr.entries) {
        visit(entry.key);
        visit(entry.value);
      }
      return;
    case 'pathLiteral':
      for (const seg of expr.segments) {
        if (typeof seg !== 'string') visit(seg);
      }
      return;
    case 'methodCall':
      visit(expr.object);
      for (const arg of expr.args) visit(arg);
      return;
    case 'functionCall':
      for (const arg of expr.args) visit(arg);
      return;
  }
}

/** True when `expr` is a single literal or identifier with no side effects or budget steps. */
export function isTrivialPureExpr(expr: Expression): boolean {
  if (getOrBudgetSteps(expr)?.length) return false;
  return expr.type === 'literal' || expr.type === 'identifier';
}

/**
 * True when evaluating `expr` is guaranteed to evaluate identifier `name` at
 * least once regardless of runtime operand values (not behind the right arm of
 * `&&`/`||` or the branches of `ternary`).
 */
export function isUnconditionallyEvaluatedInExpr(name: string, expr: Expression): boolean {
  if (expr.type === 'identifier') return expr.name === name;
  if (expr.type === 'literal') return false;
  if (expr.type === 'binaryOp' && (expr.op === '&&' || expr.op === '||')) {
    return isUnconditionallyEvaluatedInExpr(name, expr.left);
  }
  if (expr.type === 'ternary') {
    return isUnconditionallyEvaluatedInExpr(name, expr.condition);
  }
  let found = false;
  forEachChildExpression(expr, (child) => {
    if (!found && isUnconditionallyEvaluatedInExpr(name, child)) {
      found = true;
    }
  });
  return found;
}

function hasAttachedBudgetSteps(expr: Expression): boolean {
  const seen = new Set<Expression>();
  const walk = (node: Expression): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (getOrBudgetSteps(node)?.length) return true;
    let found = false;
    forEachChildExpression(node, (child) => {
      if (!found && walk(child)) found = true;
    });
    return found;
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
      for (const sub of getOrBudgetStepExpressions(step)) {
        collectReachableFunctionDefs(sub, currentFunctions, out, visiting);
      }
    }
  }
  forEachChildExpression(expr, (child) => {
    collectReachableFunctionDefs(child, currentFunctions, out, visiting);
  });
  if (expr.type === 'functionCall') {
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

function mentionsAnyIdentifier(expr: Expression, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  let found = expr.type === 'identifier' && names.has(expr.name);
  if (found) return true;
  const steps = getOrBudgetSteps(expr);
  if (steps) {
    for (const step of steps) {
      for (const sub of getOrBudgetStepExpressions(step)) {
        if (mentionsAnyIdentifier(sub, names)) return true;
      }
    }
  }
  forEachChildExpression(expr, (child) => {
    if (!found && mentionsAnyIdentifier(child, names)) {
      found = true;
    }
  });
  return found;
}

function budgetTokenForExpr(expr: Expression): string {
  return `__pyric_budget_${encodeURIComponent(canonicalKeyForExpr(expr))}__`;
}

/**
 * Projects an unprovable rule condition or dropped `||` branch so that
 * residual list evaluation charges the worst-case document-lookup and
 * expression budgets across unconstrained document fields and candidate
 * path variables without short-circuiting on `syntheticResource = {}` or
 * placeholder document IDs, while evaluating mutually exclusive ternary
 * arms under forked budgets and binding call-by-value arguments and `let`s
 * once in lexical scope to prevent exponential AST duplication.
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
  const nonInvariantLocals = new Set<string>();
  let expansionBudget = 2000;

  const checkInvariance = (
    node: Expression,
    currentFunctions: ReadonlyMap<string, FunctionDef>,
    currentCandidateVars: ReadonlySet<string> | undefined,
  ): { invariant: boolean; pathAnalysis?: ListRulePathAnalysis } => {
    if (hasAttachedBudgetSteps(node)) {
      return { invariant: false };
    }
    if (mentionsAnyIdentifier(node, nonInvariantLocals)) {
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
      // Project prior steps in execution order first so any bound locals whose
      // values become non-invariant (e.g. resource-dependent in stage 2) mark
      // `nonInvariantLocals` before `stripped` is projected.
      const projectedSteps = priorSteps.map((step) => {
        if (
          step.kind === 'bind'
          && !checkInvariance(step.branch, currentFunctions, currentCandidateVars).invariant
        ) {
          nonInvariantLocals.add(step.name);
        }
        return mapOrBudgetStepExpressions(step, (sub) =>
          project(sub, currentFunctions, currentCandidateVars, visiting),
        );
      });
      const stripped: Expression = { ...node };
      let projectedTarget = project(stripped, currentFunctions, currentCandidateVars, visiting);
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
      const bindSteps: OrBudgetStep[] = [];
      for (let i = 0; i < fn.parameters.length; i++) {
        const paramName = fn.parameters[i]!;
        const argExpr = expandedArgs[i]!;
        const argInvariant = checkInvariance(argExpr, currentFunctions, currentCandidateVars).invariant;
        const projectedArg = project(argExpr, currentFunctions, currentCandidateVars, visiting);
        const localName = `__pyric_local_${++nextBudgetLocalId}__`;
        recordLocalCanonicalKey(localName, argExpr);
        if (!argInvariant) {
          nonInvariantLocals.add(localName);
        }
        bindSteps.push({
          kind: 'bind',
          operator: node,
          name: localName,
          branch: projectedArg,
          isLet: false,
        });
        bindings.set(paramName, { type: 'identifier', name: localName });
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
      for (const binding of fn.lets) {
        const boundLet = substituteIdentifiers(binding.value, bindings);
        const letInvariant = checkInvariance(boundLet, nextFunctions, nextCandidateVars).invariant;
        const projectedLet = project(boundLet, nextFunctions, nextCandidateVars, nextVisiting);
        const localName = `__pyric_local_${++nextBudgetLocalId}__`;
        recordLocalCanonicalKey(localName, boundLet);
        if (!letInvariant) {
          nonInvariantLocals.add(localName);
        }
        bindSteps.push({
          kind: 'bind',
          operator: node,
          name: localName,
          branch: projectedLet,
          isLet: true,
        });
        bindings.set(binding.name, { type: 'identifier', name: localName });
      }

      let projectedBody = project(
        substituteIdentifiers(fn.body, bindings),
        nextFunctions,
        nextCandidateVars,
        nextVisiting,
      );
      for (let i = bindSteps.length - 1; i >= 0; i--) {
        projectedBody = attachOrBudgetStep(projectedBody, bindSteps[i]!);
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
        return attachOrBudgetStep(
          { type: 'literal', value: false, raw: 'false' },
          {
            kind: 'fork',
            operator: node,
            condition,
            branches: [consequent, alternate],
          },
        );
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
