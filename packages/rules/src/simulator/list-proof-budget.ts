import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
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
  allocateBudgetLocalName,
  attachOrBudgetStep,
  budgetTokenForExpr,
  collectReachableFunctionDefs,
  getOrBudgetSteps,
  hasAttachedBudgetSteps,
  mapOrBudgetStepExpressions,
  mentionsAnyIdentifier,
  recordLocalCanonicalKey,
  type OrBudgetStep,
} from './or-budget-steps.js';
import {
  callsResolveInOuterScope,
  inlineFunctionsInExpr,
  isProvablyDocIndependent,
  lexicalCaptureLiteralBindings,
  substituteIdentifiers,
} from './query-proof-scope.js';

export {
  attachOrBudgetStep,
  getListBlockSteps,
  getOrBudgetStepExpressions,
  getOrBudgetSteps,
  isTrivialPureExpr,
  isUnconditionallyEvaluatedInExpr,
  mapOrBudgetStepExpressions,
  setListBlockSteps,
  type ListBlockStep,
  type OrBudgetStep,
} from './or-budget-steps.js';

export interface WorstCaseBudgetOptions {
  readonly outerFunctions: ReadonlyMap<string, FunctionDef>;
  readonly functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>;
  readonly candidateVariables?: ReadonlySet<string>;
  readonly ambiguousNames?: ReadonlySet<string>;
  readonly checkResourceDependence?: boolean;
  readonly database?: string;
}

const LOOKUP_BUILTINS = new Set(['get', 'exists', 'getAfter', 'existsAfter']);
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

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
        const step = projectedSteps[i];
        if (step !== undefined) {
          projectedTarget = attachOrBudgetStep(projectedTarget, step);
        }
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

    const calledFn = node.type === 'functionCall' ? currentFunctions.get(node.name) : undefined;
    if (node.type === 'functionCall' && calledFn !== undefined) {
      const fnScope = getFunctionScope(calledFn);
      const nextFunctions = getValidFunctionLexicalScope(calledFn, currentFunctions);
      if (
        visiting.has(calledFn)
        || calledFn.parameters.length !== node.args.length
        || !nextFunctions
        || (!fnScope && ambiguousNames.has(node.name))
      ) {
        requiredDefs.add(calledFn);
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
        requiredDefs.add(calledFn);
        collectReachableFunctionDefs(node, currentFunctions, requiredDefs);
        return {
          ...node,
          args: node.args.map((arg) => project(arg, currentFunctions, currentCandidateVars, visiting)),
        };
      }

      const bindings = lexicalCaptureLiteralBindings(calledFn, functionScopes);
      const bindSteps: OrBudgetStep[] = [];
      for (let i = 0; i < calledFn.parameters.length; i++) {
        const paramName = calledFn.parameters[i];
        const argExpr = expandedArgs[i];
        if (paramName === undefined || argExpr === undefined) continue;
        const argInvariant = checkInvariance(argExpr, currentFunctions, currentCandidateVars).invariant;
        const projectedArg = project(argExpr, currentFunctions, currentCandidateVars, visiting);
        const localName = allocateBudgetLocalName();
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
      const fnLexical = functionScopes?.get(calledFn);
      if (fnLexical && nextCandidateVars !== undefined) {
        nextCandidateVars = new Set([
          ...nextCandidateVars,
          ...fnLexical.candidateVariables,
        ]);
      }

      const nextVisiting = new Set(visiting).add(calledFn);
      for (const binding of calledFn.lets) {
        const boundLet = substituteIdentifiers(binding.value, bindings);
        const letInvariant = checkInvariance(boundLet, nextFunctions, nextCandidateVars).invariant;
        const projectedLet = project(boundLet, nextFunctions, nextCandidateVars, nextVisiting);
        const localName = allocateBudgetLocalName();
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
        substituteIdentifiers(calledFn.body, bindings),
        nextFunctions,
        nextCandidateVars,
        nextVisiting,
      );
      for (let i = bindSteps.length - 1; i >= 0; i--) {
        const step = bindSteps[i];
        if (step !== undefined) {
          projectedBody = attachOrBudgetStep(projectedBody, step);
        }
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
        if (sub === inner.operand) return node;
        return { type: 'unaryOp', op: '!', operand: { type: 'unaryOp', op: '!', operand: sub } };
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
      if (condition === node.condition && consequent === node.consequent && alternate === node.alternate) {
        return node;
      }
      return { ...node, condition, consequent, alternate };
    }

    const singleArg = node.type === 'functionCall' && node.args.length === 1 ? node.args[0] : undefined;
    if (
      node.type === 'functionCall'
      && !currentFunctions.has(node.name)
      && LOOKUP_BUILTINS.has(node.name)
      && singleArg !== undefined
    ) {
      if (singleArg.type === 'pathLiteral') {
        const segSteps: Expression[] = [];
        let changed = false;
        const segments = singleArg.segments.map((seg) => {
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
          args: [{ ...singleArg, segments }],
        };
        for (let i = segSteps.length - 1; i >= 0; i--) {
          const branch = segSteps[i];
          if (branch !== undefined) {
            rewrittenCall = attachOrBudgetStep(rewrittenCall, {
              operator: node,
              side: 'before',
              branch,
            });
          }
        }
        return rewrittenCall;
      }

      const argInv = checkInvariance(singleArg, currentFunctions, currentCandidateVars);
      if (!argInv.invariant) {
        const projectedArg = project(singleArg, currentFunctions, currentCandidateVars, visiting);
        const token = budgetTokenForExpr(singleArg);
        let targetDb = '(default)';
        if (options.database !== undefined && options.database.length > 0) {
          targetDb = options.database;
        }
        const syntheticPath: Expression = {
          type: 'pathLiteral',
          raw: `/databases/${targetDb}/documents/__pyric_budget_ref__/${token}`,
          segments: [
            'databases',
            targetDb,
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
        if (object === node.object && start === node.start && end === node.end) return node;
        return { ...node, object, start, end };
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
        if (element === node.element && collection === node.collection) return node;
        return { ...node, element, collection };
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
        const unchanged = entries.every((entry, idx) => {
          const orig = node.entries[idx];
          return orig !== undefined && entry.key === orig.key && entry.value === orig.value;
        });
        return unchanged ? node : { ...node, entries };
      }
      case 'pathLiteral': {
        const segments = node.segments.map((seg) => (typeof seg === 'string' ? seg : sub(seg)));
        return segments.every((seg, idx) => seg === node.segments[idx]) ? node : { ...node, segments };
      }
      case 'methodCall': {
        const object = sub(node.object);
        const args = node.args.map(sub);
        const unchanged = object === node.object && args.every((arg, idx) => arg === node.args[idx]);
        return unchanged ? node : { ...node, object, args };
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
