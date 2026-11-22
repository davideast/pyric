import type { AllowRule, Expression, FirestoreRules, FunctionDef } from '../grammar/FirestoreAST.js';
import { CALL_DEPTH_LIMIT } from '../grammar/compile-limits.js';
import { countDocumentAccessCalls } from '../grammar/document-access-count.js';
import {
  analyzeCallChains,
  functionReferences,
  type RulesetScopes,
} from '../grammar/function-scopes.js';
import {
  collectServiceRules,
  countFunctionCallSites,
  expressionFingerprint,
  extractFirstExpression,
  functionContainsGet,
} from './ast-utils.js';
import { pushWarning } from './compile-limit-warnings.js';
import { EXPRESSION_LIMIT, type RuleCostEstimate } from './expression-cost.js';
import { ruleLibraryCalls } from './library-calls.js';
import type { LintWarning } from './linter.js';

const CALL_DEPTH_WARN = 18;
const GET_COUNT_WARN = 5;
const GET_COUNT_ERROR = 10;
const MEMBER_CHAIN_FAILED_TERMS = 4900;

/** The operands, elements, arguments and receivers an expression evaluates. */
function childExpressions(expr: Expression): Expression[] {
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

export function checkMemberChainLength(
  ast: FirestoreRules,
  functions: readonly FunctionDef[],
  warnings: LintWarning[],
): void {
  const roots: { expr: Expression; functionName?: string; line?: number }[] = [];
  for (const fn of functions) {
    for (const binding of fn.lets) roots.push({ expr: binding.value, functionName: fn.name });
    roots.push({ expr: fn.body, functionName: fn.name });
  }
  for (const { rule } of collectServiceRules(ast.service)) {
    const entry: { expr: Expression; line?: number } = { expr: rule.condition };
    if (rule.loc !== undefined) entry.line = rule.loc.line;
    roots.push(entry);
  }
  for (const root of roots) {
    let longest = 0;
    const stack: Expression[] = [root.expr];
    while (stack.length > 0) {
      const expr = stack.pop()!;
      let terms = 1;
      let inner = expr;
      while (inner.type === 'memberAccess') {
        terms++;
        inner = inner.object;
      }
      if (expr.type === 'memberAccess') longest = Math.max(longest, terms);
      stack.push(...childExpressions(inner));
    }
    if (longest < MEMBER_CHAIN_FAILED_TERMS) continue;
    let subject = 'An allow rule';
    if (root.functionName !== undefined) {
      subject = `Function '${root.functionName}'`;
    } else if (root.line !== undefined) {
      subject = `The rule at line ${root.line}`;
    }
    const warning: LintWarning = {
      rule: 'MEMBER_CHAIN_LENGTH',
      severity: 'error',
      message: `${subject} reads a member chain of ${longest} terms. The Rules Test API answered a ruleset holding a ${MEMBER_CHAIN_FAILED_TERMS.toLocaleString('en-US')}-term member chain with an internal error instead of compiling it.`,
      fix: 'Shorten the chain: bind a value partway along it to a `let` or a function parameter, and read the rest of the chain from that name.',
    };
    if (root.functionName !== undefined) {
      warning.location = { functionName: root.functionName };
    }
    warnings.push(warning);
  }
}

export function checkSharedGates(
  rules: { rule: { condition: Expression; operations: string[] }; path: string }[],
  warnings: LintWarning[],
): void {
  const byPath = new Map<string, { index: number; gate: string; ops: string[] }[]>();
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    if (!r.rule.operations.some((op) => op === 'update' || op === 'write')) continue;
    const gate = expressionFingerprint(extractFirstExpression(r.rule.condition));
    const path = r.path;
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path)!.push({ index: i, gate, ops: r.rule.operations });
  }

  for (const [path, entries] of byPath) {
    const gateGroups = new Map<string, number[]>();
    for (const e of entries) {
      if (!gateGroups.has(e.gate)) gateGroups.set(e.gate, []);
      gateGroups.get(e.gate)!.push(e.index);
    }
    for (const [, indices] of gateGroups) {
      if (indices.length >= 2) {
        warnings.push({
          rule: 'SHARED_GATE',
          severity: 'warning',
          message: `${indices.length} allow rules in '${path}' share the same gate expression. This may cause cross-rule budget exhaustion. Rules: ${indices.join(', ')}.`,
          location: { matchPath: path },
          fix: 'Assign unique moveType or discriminator values so each rule has a unique first expression.',
        });
      }
    }
  }
}

export function checkExpressionBudget(
  estimates: RuleCostEstimate[],
  warnings: LintWarning[],
): void {
  for (const estimate of estimates) {
    if (estimate.grantCost === null || estimate.grantCost < EXPRESSION_LIMIT) continue;
    warnings.push({
      rule: 'EXPRESSION_BUDGET',
      severity: 'warning',
      message: `Rule #${estimate.ruleIndex} in '${estimate.blockPath}' can evaluate up to ~${estimate.grantCost} expressions for a request it grants, counting the earlier rules that deny it first. Production denies a request that reaches ${EXPRESSION_LIMIT}.`,
      location: { ruleIndex: estimate.ruleIndex, matchPath: estimate.blockPath },
      fix: 'Put a cheap discriminator first in each rule so earlier rules fail at their gate, split expensive checks so a request evaluates only the branch it needs, or move lookup work into documents.',
    });
  }
}

export function checkLibraryCalls(ast: FirestoreRules, warnings: LintWarning[]): void {
  for (const rule of ruleLibraryCalls(ast)) {
    const top = rule.calls.slice(0, 3).map((c) => {
      const range = c.cost.min === c.cost.max ? `${c.cost.max}` : `${c.cost.min} to ${c.cost.max}`;
      let reads = '';
      if (c.reads === 1) {
        reads = ', 1 read per call';
      } else if (c.reads > 1) {
        reads = `, ${c.reads} reads per call`;
      }
      return `${c.name} (${c.module}): ${c.count} call${c.count === 1 ? '' : 's'}, ${range} expressions per call${reads}`;
    });
    warnings.push({
      rule: 'EXPRESSION_LIBRARY_CALLS',
      severity: 'info',
      message: `Rule #${rule.ruleIndex} in '${rule.blockPath}' spends most on these library calls: ${top.join('; ')}. Calls are not memoized: each call pays again.`,
      location: { ruleIndex: rule.ruleIndex, matchPath: rule.blockPath },
    });
  }
}

export function checkCallDepth(
  scopes: RulesetScopes,
  warnings: LintWarning[],
): Map<FunctionDef, number> {
  const { depths, cyclic } = analyzeCallChains(scopes);
  const calledByFunction = new Set<FunctionDef>();
  for (const scoped of scopes.functions) {
    for (const callee of functionReferences(scoped).callees) {
      if (callee !== scoped.fn) calledByFunction.add(callee);
    }
  }
  let reportedCycle = false;
  for (const scoped of scopes.functions) {
    if (cyclic.has(scoped.fn)) {
      if (!reportedCycle) {
        reportedCycle = true;
        pushWarning(
          warnings,
          {
            rule: 'CALL_DEPTH',
            severity: 'error',
            message: `Function '${scoped.fn.name}' is part of a recursive call cycle, exceeding the call depth limit of ${CALL_DEPTH_LIMIT}.`,
            fix: 'Remove recursion between helper functions; Firestore rules do not allow recursive calls.',
          },
          { functionName: scoped.fn.name, matchPath: scoped.label, line: scoped.fn.loc?.line },
        );
      }
      continue;
    }
    if (calledByFunction.has(scoped.fn)) continue;
    const depth = depths.get(scoped.fn) ?? 1;
    if (depth < CALL_DEPTH_WARN) continue;
    const over = depth > CALL_DEPTH_LIMIT;
    let severity: LintWarning['severity'] = 'warning';
    if (over) severity = 'error';
    const base: Omit<LintWarning, 'location'> = {
      rule: 'CALL_DEPTH',
      severity,
      message: `Function '${scoped.fn.name}' starts a function call chain of depth ${depth}. Limit is ${CALL_DEPTH_LIMIT}.`,
    };
    if (over) {
      base.fix = 'Inline intermediate functions to reduce call depth.';
    }
    pushWarning(warnings, base, {
      functionName: scoped.fn.name,
      matchPath: scoped.label,
      line: scoped.fn.loc?.line,
    });
  }
  return depths;
}

export function checkGetCount(
  rules: { rule: AllowRule }[],
  ruleScopes: ReadonlyMap<AllowRule, ReadonlyMap<string, FunctionDef>>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  warnings: LintWarning[],
  isStorage = false,
): void {
  const emptyScope = new Map<string, FunctionDef>();
  const errorLimit = isStorage ? 2 : GET_COUNT_ERROR;
  const warnLimit = isStorage ? 2 : GET_COUNT_WARN;
  const callLabel = isStorage
    ? 'firestore.get()/firestore.exists()'
    : 'get()/exists()/getAfter()/existsAfter()';
  for (let i = 0; i < rules.length; i++) {
    const fnMap = ruleScopes.get(rules[i]!.rule) ?? emptyScope;
    const count = countDocumentAccessCalls(rules[i]!.rule.condition, fnMap, new Set(), fnScopes, isStorage);
    if (count > errorLimit) {
      warnings.push({
        rule: 'GET_COUNT',
        severity: 'error',
        message: `Rule #${i} may invoke ${count} ${callLabel} calls. Limit is ${errorLimit}.`,
        location: { ruleIndex: i },
        fix: 'Cache get() results via a config() wrapper function. Same-path calls are cached by Firestore.',
      });
    } else if (count >= warnLimit) {
      warnings.push({
        rule: 'GET_COUNT',
        severity: 'warning',
        message: `Rule #${i} invokes ${count} ${callLabel} calls. Limit is ${errorLimit}.`,
        location: { ruleIndex: i },
      });
    }
  }
}

export function checkGetDuplication(
  rules: { rule: AllowRule }[],
  ruleScopes: ReadonlyMap<AllowRule, ReadonlyMap<string, FunctionDef>>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  warnings: LintWarning[],
  isStorage = false,
): void {
  const emptyScope = new Map<string, FunctionDef>();
  for (let i = 0; i < rules.length; i++) {
    const fnMap = ruleScopes.get(rules[i]!.rule) ?? emptyScope;
    const fnNames = new Set(fnMap.keys());
    const callCounts = countFunctionCallSites(rules[i]!.rule.condition, fnNames);
    for (const [fnName, count] of callCounts) {
      if (count >= 2 && functionContainsGet(fnName, fnMap, new Set(), fnScopes, new Set(), isStorage)) {
        warnings.push({
          rule: 'GET_DUPLICATION',
          severity: 'warning',
          message: `Function '${fnName}' (contains get/exists) is called ${count} times in rule #${i}. Cache the result with a let binding in a wrapper function to reduce get() calls from ${count} to 1.`,
          location: { ruleIndex: i },
          fix: `Create a wrapper: function verifyAll(ret) { let c = ${fnName}(); return verify1(ret, c) && verify2(ret, c) && ...; }`,
        });
      }
    }
  }
}
