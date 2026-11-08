/**
 * Shared browser-clean AST helpers for Firestore and Storage security rules:
 * multi-match / literal-(default) normalization (preserving 1-based line numbers),
 * lexical helper-function inlining with cycle guards, verb expansion, and
 * overbroad auth-only write guard detection.
 */
import {
  parseToAST,
  topLevelMatches,
  type Expression,
  type FunctionDef,
  type MatchBlock,
  type Operation,
  type PathSegment,
} from '../../rules/internal/index.js';
import type { RtdbExpressionTree } from '../../rules/internal/rtdb.js';

export const MAX_RULE_INLINE_DEPTH = 8;

const MULTI_ROOT_SENTINEL = '__pyric_multi_root__';
const DEFAULT_DB_SENTINEL = '__pyric_default_db__';

export interface BoundRuleExpr {
  readonly expr: Expression;
  readonly scope: RuleAstScope;
}

export interface RuleAstScope {
  readonly vars: Map<string, BoundRuleExpr>;
  readonly functions: readonly (readonly FunctionDef[])[];
  readonly wildcards: ReadonlySet<string>;
  readonly depth: number;
}

export interface ParsedServiceMatches {
  readonly name: string;
  readonly functions: readonly (readonly FunctionDef[])[];
  readonly matches: readonly MatchBlock[];
}

export function expandRuleOps(ops: readonly Operation[]): string[] {
  const out = new Set<string>();
  for (const op of ops) {
    if (op === 'read') {
      out.add('get');
      out.add('list');
    } else if (op === 'write') {
      out.add('create');
      out.add('update');
      out.add('delete');
    } else {
      out.add(op);
    }
  }
  return [...out];
}

export function formatMatchSegment(seg: PathSegment): string {
  if (seg.type === 'literal') {
    if (seg.value === DEFAULT_DB_SENTINEL) return '(default)';
    return seg.value;
  }
  if (seg.type === 'wildcard') return `{${seg.name}}`;
  return `{${seg.name}=**}`;
}

function restoreExprSentinels(expr: Expression): Expression {
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return expr;
    case 'memberAccess':
      return { ...expr, object: restoreExprSentinels(expr.object) };
    case 'methodCall':
      return { ...expr, object: restoreExprSentinels(expr.object), args: expr.args.map(restoreExprSentinels) };
    case 'bracketAccess':
      return { ...expr, object: restoreExprSentinels(expr.object), index: restoreExprSentinels(expr.index) };
    case 'sliceAccess':
      return {
        ...expr,
        object: restoreExprSentinels(expr.object),
        start: restoreExprSentinels(expr.start),
        end: restoreExprSentinels(expr.end),
      };
    case 'binaryOp':
      return { ...expr, left: restoreExprSentinels(expr.left), right: restoreExprSentinels(expr.right) };
    case 'unaryOp':
      return { ...expr, operand: restoreExprSentinels(expr.operand) };
    case 'ternary':
      return {
        ...expr,
        condition: restoreExprSentinels(expr.condition),
        consequent: restoreExprSentinels(expr.consequent),
        alternate: restoreExprSentinels(expr.alternate),
      };
    case 'inExpr':
      return { ...expr, element: restoreExprSentinels(expr.element), collection: restoreExprSentinels(expr.collection) };
    case 'isExpr':
      return { ...expr, value: restoreExprSentinels(expr.value) };
    case 'listLiteral':
      return { ...expr, elements: expr.elements.map(restoreExprSentinels) };
    case 'mapLiteral':
      return {
        ...expr,
        entries: expr.entries.map((entry) => ({
          key: restoreExprSentinels(entry.key),
          value: restoreExprSentinels(entry.value),
        })),
      };
    case 'pathLiteral':
      return {
        ...expr,
        raw: expr.raw.replaceAll(DEFAULT_DB_SENTINEL, '(default)'),
        segments: expr.segments.map((seg) => {
          if (typeof seg === 'string') return seg.replaceAll(DEFAULT_DB_SENTINEL, '(default)');
          return restoreExprSentinels(seg);
        }),
      };
    case 'functionCall':
      return { ...expr, args: expr.args.map(restoreExprSentinels) };
  }
}

function restoreFunctionSentinels(fn: FunctionDef): FunctionDef {
  return {
    ...fn,
    lets: fn.lets.map((letBinding) => ({
      ...letBinding,
      value: restoreExprSentinels(letBinding.value),
    })),
    body: restoreExprSentinels(fn.body),
  };
}

function restoreMatchSentinels(block: MatchBlock): MatchBlock {
  const segments = block.path.segments.map((seg): PathSegment => {
    if (seg.type === 'literal' && seg.value === DEFAULT_DB_SENTINEL) {
      return { type: 'literal', value: '(default)' };
    }
    return seg;
  });
  return {
    ...block,
    path: {
      raw: block.path.raw.replaceAll(DEFAULT_DB_SENTINEL, '(default)'),
      segments,
    },
    functions: block.functions.map(restoreFunctionSentinels),
    allows: block.allows.map((allow) => ({
      ...allow,
      condition: restoreExprSentinels(allow.condition),
    })),
    children: block.children.map(restoreMatchSentinels),
  };
}

/**
 * Scan `source` outside string literals and comments to:
 * 1. Replace `/databases/(default)/` and `/b/(default)/` in `match` headers with `DEFAULT_DB_SENTINEL`.
 * 2. Expand bare `allow <ops>;` to `allow <ops>: if true;` on the same line.
 * 3. Wrap each `service <name> { ... }` body in `match /__pyric_multi_root__ { ... }`
 *    on the exact opening/closing brace lines so line numbers never shift.
 */
function normalizeMultiMatchSource(source: string): string {
  const serviceHeaderRe = /\bservice\s+[A-Za-z][A-Za-z.]*\s*\{/y;
  const defaultDbMatchRe = /\/(databases|b)\/\(default\)\//y;
  const bareAllowRe = /\ballow\s+((?:read|write|get|list|create|update|delete)(?:\s*,\s*(?:read|write|get|list|create|update|delete))*)\s*;/y;
  let out = '';
  let i = 0;
  let braceDepth = 0;
  const serviceCloseDepths: number[] = [];

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i + 2);
      let end = source.length;
      if (nl !== -1) end = nl;
      out += source.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      let end = source.length;
      if (close !== -1) end = close + 2;
      out += source.slice(i, end);
      i = end;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i]!;
        out += c;
        i += 1;
        if (c === '\\' && i < source.length) {
          out += source[i]!;
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }

    if (braceDepth === 0) {
      serviceHeaderRe.lastIndex = i;
      const m = serviceHeaderRe.exec(source);
      if (m !== null) {
        out += `${m[0]} match /${MULTI_ROOT_SENTINEL} {`;
        braceDepth += 1;
        serviceCloseDepths.push(braceDepth);
        i += m[0].length;
        continue;
      }
    }

    defaultDbMatchRe.lastIndex = i;
    const dbMatch = defaultDbMatchRe.exec(source);
    if (dbMatch !== null) {
      out += `/${dbMatch[1]}/${DEFAULT_DB_SENTINEL}/`;
      i += dbMatch[0].length;
      continue;
    }

    bareAllowRe.lastIndex = i;
    const bareAllow = bareAllowRe.exec(source);
    if (bareAllow !== null) {
      out += `allow ${bareAllow[1]}: if true;`;
      i += bareAllow[0].length;
      continue;
    }

    if (ch === '{') {
      braceDepth += 1;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '}') {
      const topServiceDepth = serviceCloseDepths[serviceCloseDepths.length - 1];
      if (topServiceDepth !== undefined && braceDepth === topServiceDepth) {
        serviceCloseDepths.pop();
        braceDepth -= 1;
        out += '} }';
        i += 1;
        continue;
      }
      if (braceDepth > 0) braceDepth -= 1;
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

export function parseRulesAstWithMultiMatch(source: string): ParsedServiceMatches[] {
  const direct = parseToAST(source);
  if (direct !== null) {
    let services = [direct.service];
    if (direct.services && direct.services.length > 0) services = direct.services;
    return services.map((svc) => ({
      name: svc.name,
      functions: [direct.functions ?? [], svc.functions ?? []],
      matches: topLevelMatches(svc),
    }));
  }

  const normalized = normalizeMultiMatchSource(source);
  const fallback = parseToAST(normalized);
  if (fallback === null) return [];

  let services = [fallback.service];
  if (fallback.services && fallback.services.length > 0) services = fallback.services;
  return services.map((svc) => {
    const topMatches = topLevelMatches(svc);
    const root = topMatches[0];
    const globalFns = (fallback.functions ?? []).map(restoreFunctionSentinels);
    const serviceFns = (svc.functions ?? []).map(restoreFunctionSentinels);
    if (!root) {
      return {
        name: svc.name,
        functions: [globalFns, serviceFns],
        matches: [],
      };
    }
    const isSyntheticRoot =
      topMatches.length === 1
      && root.path.segments.length === 1
      && root.path.segments[0]?.type === 'literal'
      && root.path.segments[0].value === MULTI_ROOT_SENTINEL;
    if (!isSyntheticRoot) {
      return {
        name: svc.name,
        functions: [globalFns, serviceFns],
        matches: topMatches.map(restoreMatchSentinels),
      };
    }
    return {
      name: svc.name,
      functions: [globalFns, serviceFns, root.functions.map(restoreFunctionSentinels)],
      matches: root.children.map(restoreMatchSentinels),
    };
  });
}

export function findScopedFunction(scope: RuleAstScope, name: string): FunctionDef | undefined {
  for (let i = scope.functions.length - 1; i >= 0; i -= 1) {
    const found = scope.functions[i]?.find((fn) => fn.name === name);
    if (found) return found;
  }
  return undefined;
}

export function resolveRuleExpr(expr: Expression, scope: RuleAstScope): BoundRuleExpr {
  let cur: BoundRuleExpr = { expr, scope };
  for (let i = 0; i < 16 && cur.expr.type === 'identifier'; i += 1) {
    const bound = cur.scope.vars.get(cur.expr.name);
    if (!bound) break;
    cur = bound;
  }
  return cur;
}

export function inlineRuleCall(
  call: Extract<Expression, { type: 'functionCall' }>,
  scope: RuleAstScope,
): BoundRuleExpr | undefined {
  if (scope.depth >= MAX_RULE_INLINE_DEPTH) return undefined;
  const fn = findScopedFunction(scope, call.name);
  if (!fn) return undefined;
  const vars = new Map<string, BoundRuleExpr>();
  fn.parameters.forEach((param, idx) => {
    const arg = call.args[idx];
    if (arg) {
      vars.set(param, { expr: arg, scope });
    } else {
      vars.set(param, { expr: { type: 'literal', value: null, raw: 'null' }, scope });
    }
  });
  const inner: RuleAstScope = {
    vars,
    functions: scope.functions,
    wildcards: scope.wildcards,
    depth: scope.depth + 1,
  };
  for (const letBinding of fn.lets) {
    inner.vars.set(letBinding.name, { expr: letBinding.value, scope: inner });
  }
  return { expr: fn.body, scope: inner };
}

export function isRequestMemberChain(
  expr: Expression,
  scope: RuleAstScope,
  chain: readonly string[],
): boolean {
  let cur = resolveRuleExpr(expr, scope);
  for (let i = chain.length - 1; i > 0; i -= 1) {
    if (cur.expr.type !== 'memberAccess' || cur.expr.property !== chain[i]) return false;
    cur = resolveRuleExpr(cur.expr.object, cur.scope);
  }
  return (
    cur.expr.type === 'identifier'
    && cur.expr.name === chain[0]
    && !cur.scope.vars.has(chain[0]!)
  );
}

function isNullLiteral(expr: Expression, scope: RuleAstScope): boolean {
  const resolved = resolveRuleExpr(expr, scope).expr;
  return resolved.type === 'literal' && resolved.value === null;
}

function isEmptyStringLiteral(expr: Expression, scope: RuleAstScope): boolean {
  const resolved = resolveRuleExpr(expr, scope).expr;
  return resolved.type === 'literal' && resolved.value === '';
}

function isAuthPresenceTarget(expr: Expression, scope: RuleAstScope): boolean {
  return (
    isRequestMemberChain(expr, scope, ['request', 'auth'])
    || isRequestMemberChain(expr, scope, ['request', 'auth', 'uid'])
    || isRequestMemberChain(expr, scope, ['request', 'auth', 'token'])
  );
}

type GuardSummary = 'auth-only' | 'tautology' | 'impossible' | 'narrowed';

function combineConjunction(left: GuardSummary, right: GuardSummary): GuardSummary {
  if (left === 'impossible' || right === 'impossible') return 'impossible';
  if (left === 'narrowed' || right === 'narrowed') return 'narrowed';
  if (left === 'auth-only' || right === 'auth-only') return 'auth-only';
  return 'tautology';
}

export function summarizeRulesGuard(
  expr: Expression,
  scope: RuleAstScope,
  negated: boolean,
): GuardSummary {
  const resolved = resolveRuleExpr(expr, scope);
  const e = resolved.expr;
  const s = resolved.scope;

  if (e.type === 'literal' && typeof e.value === 'boolean') {
    let val = e.value;
    if (negated) val = !val;
    if (val) return 'tautology';
    return 'impossible';
  }

  if (e.type === 'unaryOp' && e.op === '!') {
    return summarizeRulesGuard(e.operand, s, !negated);
  }

  if (e.type === 'binaryOp') {
    if ((e.op === '&&' && !negated) || (e.op === '||' && negated)) {
      return combineConjunction(
        summarizeRulesGuard(e.left, s, negated),
        summarizeRulesGuard(e.right, s, negated),
      );
    }
    if ((e.op === '||' && !negated) || (e.op === '&&' && negated)) {
      const left = summarizeRulesGuard(e.left, s, negated);
      const right = summarizeRulesGuard(e.right, s, negated);
      if (left === 'auth-only' || right === 'auth-only') return 'auth-only';
      if (left === 'tautology' || right === 'tautology') return 'tautology';
      if (left === 'impossible' && right === 'impossible') return 'impossible';
      return 'narrowed';
    }
    if (e.op === '==' || e.op === '!=') {
      const leftRes = resolveRuleExpr(e.left, s).expr;
      const rightRes = resolveRuleExpr(e.right, s).expr;
      if (leftRes.type === 'literal' && typeof leftRes.value === 'boolean') {
        const flips = (e.op === '==' && !leftRes.value) || (e.op === '!=' && leftRes.value);
        let nextNeg = negated;
        if (flips) nextNeg = !negated;
        return summarizeRulesGuard(e.right, s, nextNeg);
      }
      if (rightRes.type === 'literal' && typeof rightRes.value === 'boolean') {
        const flips = (e.op === '==' && !rightRes.value) || (e.op === '!=' && rightRes.value);
        let nextNeg = negated;
        if (flips) nextNeg = !negated;
        return summarizeRulesGuard(e.left, s, nextNeg);
      }
      const assertsNotEqual = (e.op === '!=' && !negated) || (e.op === '==' && negated);
      if (assertsNotEqual) {
        if (isAuthPresenceTarget(e.left, s) && (isNullLiteral(e.right, s) || isEmptyStringLiteral(e.right, s))) {
          return 'auth-only';
        }
        if (isAuthPresenceTarget(e.right, s) && (isNullLiteral(e.left, s) || isEmptyStringLiteral(e.left, s))) {
          return 'auth-only';
        }
      }
      return 'narrowed';
    }
    return 'narrowed';
  }

  if (e.type === 'isExpr') {
    if (!negated && e.typeName === 'string' && isRequestMemberChain(e.value, s, ['request', 'auth', 'uid'])) {
      return 'auth-only';
    }
    return 'narrowed';
  }

  if (e.type === 'ternary') {
    const condTrue = combineConjunction(
      summarizeRulesGuard(e.condition, s, false),
      summarizeRulesGuard(e.consequent, s, negated),
    );
    const condFalse = combineConjunction(
      summarizeRulesGuard(e.condition, s, true),
      summarizeRulesGuard(e.alternate, s, negated),
    );
    if (condTrue === 'auth-only' || condFalse === 'auth-only') return 'auth-only';
    if (condTrue === 'tautology' || condFalse === 'tautology') return 'tautology';
    if (condTrue === 'impossible' && condFalse === 'impossible') return 'impossible';
    return 'narrowed';
  }

  if (e.type === 'functionCall') {
    const inlined = inlineRuleCall(e, s);
    if (!inlined) return 'narrowed';
    return summarizeRulesGuard(inlined.expr, inlined.scope, negated);
  }

  return 'narrowed';
}

export function isOverbroadAuthOnlyRulesExpr(expr: Expression, scope: RuleAstScope): boolean {
  return summarizeRulesGuard(expr, scope, false) === 'auth-only';
}

function isRtdbAuthTarget(t: RtdbExpressionTree): boolean {
  if (t.type === 'identifier' && t.name === 'auth') return true;
  if (t.type === 'member' && (t.property === 'uid' || t.property === 'token')) {
    return t.object.type === 'identifier' && t.object.name === 'auth';
  }
  return false;
}

function isRtdbNullOrEmpty(t: RtdbExpressionTree): boolean {
  if (t.type === 'null') return true;
  return t.type === 'string' && t.value === '';
}

export function summarizeRtdbGuard(t: RtdbExpressionTree, negated: boolean): GuardSummary {
  if (t.type === 'boolean') {
    let val = t.value;
    if (negated) val = !val;
    if (val) return 'tautology';
    return 'impossible';
  }
  if (t.type === 'unary' && t.operator === '!') {
    return summarizeRtdbGuard(t.argument, !negated);
  }
  if (t.type === 'binary') {
    if ((t.operator === '&&' && !negated) || (t.operator === '||' && negated)) {
      return combineConjunction(
        summarizeRtdbGuard(t.left, negated),
        summarizeRtdbGuard(t.right, negated),
      );
    }
    if ((t.operator === '||' && !negated) || (t.operator === '&&' && negated)) {
      const left = summarizeRtdbGuard(t.left, negated);
      const right = summarizeRtdbGuard(t.right, negated);
      if (left === 'auth-only' || right === 'auth-only') return 'auth-only';
      if (left === 'tautology' || right === 'tautology') return 'tautology';
      if (left === 'impossible' && right === 'impossible') return 'impossible';
      return 'narrowed';
    }
    const isEq = t.operator === '==' || t.operator === '===';
    const isNeq = t.operator === '!=' || t.operator === '!==';
    if (isEq || isNeq) {
      if (t.left.type === 'boolean') {
        const flips = (isEq && !t.left.value) || (isNeq && t.left.value);
        let nextNeg = negated;
        if (flips) nextNeg = !negated;
        return summarizeRtdbGuard(t.right, nextNeg);
      }
      if (t.right.type === 'boolean') {
        const flips = (isEq && !t.right.value) || (isNeq && t.right.value);
        let nextNeg = negated;
        if (flips) nextNeg = !negated;
        return summarizeRtdbGuard(t.left, nextNeg);
      }
      const assertsNotEqual = (isNeq && !negated) || (isEq && negated);
      if (assertsNotEqual) {
        if (isRtdbAuthTarget(t.left) && isRtdbNullOrEmpty(t.right)) return 'auth-only';
        if (isRtdbAuthTarget(t.right) && isRtdbNullOrEmpty(t.left)) return 'auth-only';
      }
      return 'narrowed';
    }
    return 'narrowed';
  }
  if (t.type === 'ternary') {
    const condTrue = combineConjunction(
      summarizeRtdbGuard(t.test, false),
      summarizeRtdbGuard(t.consequent, negated),
    );
    const condFalse = combineConjunction(
      summarizeRtdbGuard(t.test, true),
      summarizeRtdbGuard(t.alternate, negated),
    );
    if (condTrue === 'auth-only' || condFalse === 'auth-only') return 'auth-only';
    if (condTrue === 'tautology' || condFalse === 'tautology') return 'tautology';
    if (condTrue === 'impossible' && condFalse === 'impossible') return 'impossible';
    return 'narrowed';
  }
  return 'narrowed';
}

export function isOverbroadAuthOnlyRtdbExpr(t: RtdbExpressionTree): boolean {
  return summarizeRtdbGuard(t, false) === 'auth-only';
}
