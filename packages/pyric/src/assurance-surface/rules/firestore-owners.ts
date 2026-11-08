/**
 * Owner conditions from Firestore rules: parses the rules with Pyric's
 * Firestore grammar, walks match blocks (accumulating the path), inlines
 * user functions with their arguments bound and `let` bindings, and records
 * each place an `allow` condition positively ties access to `request.auth.uid`.
 */
import {
  assembleExpression,
  type AllowRule,
  type Expression,
  type FunctionDef,
  type MatchBlock,
  type Operation,
} from '../../rules/internal/index.js';
import { parseRulesAstWithMultiMatch } from './rules-ast-utils.js';
import type { OwnerCondition, OwnerKind, OwnerRelation } from './types.js';

const MAX_INLINE_DEPTH = 8;
const DOCUMENTS_PREFIX = ['databases', '{database}', 'documents'];

/** A name bound to an expression, closed over the scope it was written in. */
interface Bound {
  expr: Expression;
  scope: Scope;
}

interface Scope {
  vars: Map<string, Bound>;
  functions: FunctionDef[][];
  wildcards: Set<string>;
  depth: number;
}

interface Ctx {
  path: string[];
  ops: string[];
  source: string;
  out: OwnerCondition[];
  required: boolean;
  negated: boolean;
}

/** Collect owner conditions from a single Firestore `allow` clause. */
export function firestoreAllowOwnerConditions(
  allow: AllowRule,
  fallbackLine: number | undefined,
  fullPath: readonly string[],
  functions: readonly (readonly FunctionDef[])[],
  wildcards: ReadonlySet<string>,
  file: string,
): OwnerCondition[] {
  const out: OwnerCondition[] = [];
  const scope: Scope = {
    vars: new Map(),
    functions: functions.map((group) => [...group]),
    wildcards: new Set(wildcards),
    depth: 0,
  };
  const line = allow.loc?.line ?? fallbackLine;
  let ruleSource = file;
  if (line) ruleSource = `${file}:${line}`;
  const ctx: Ctx = {
    path: stripDocuments([...fullPath]),
    ops: expandOps(allow.operations),
    source: ruleSource,
    out,
    required: true,
    negated: false,
  };
  visit(allow.condition, scope, ctx);
  return out;
}

/** Collect owner conditions from Firestore rules source. Returns [] when it doesn't parse. */
export function firestoreOwnerConditions(source: string, file: string): OwnerCondition[] {
  const services = parseRulesAstWithMultiMatch(source);
  const out: OwnerCondition[] = [];
  for (const service of services) {
    if (!/firestore/.test(service.name)) continue;
    const functions: FunctionDef[][] = service.functions.map((group) => [...group]);
    for (const match of service.matches) {
      walkMatch(match, [], functions, new Set(), file, out);
    }
  }
  return out;
}

function walkMatch(
  match: MatchBlock,
  parent: string[],
  functions: FunctionDef[][],
  wildcards: Set<string>,
  file: string,
  out: OwnerCondition[],
): void {
  const path = [...parent];
  const names = new Set(wildcards);
  for (const seg of match.path.segments) {
    if (seg.type === 'literal') {
      path.push(seg.value);
    } else if (seg.type === 'wildcard') {
      path.push(`{${seg.name}}`);
      names.add(seg.name);
    } else {
      path.push(`{${seg.name}=**}`);
      names.add(seg.name);
    }
  }
  const scopeFns = [...functions, match.functions];
  for (const allow of match.allows) {
    out.push(...firestoreAllowOwnerConditions(allow, match.loc?.line, path, scopeFns, names, file));
  }
  for (const child of match.children) walkMatch(child, path, scopeFns, names, file, out);
}

function matchesPrefixSegment(prefixSeg: string, actual: string): boolean {
  if (prefixSeg === '{database}') return actual.length > 0;
  return actual === prefixSeg;
}

function stripDocuments(path: string[]): string[] {
  const isPrefix = DOCUMENTS_PREFIX.every((seg, i) => matchesPrefixSegment(seg, path[i] ?? ''));
  if (isPrefix) return path.slice(DOCUMENTS_PREFIX.length);
  return path;
}

function expandOps(ops: Operation[]): string[] {
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

function findFunction(scope: Scope, name: string): FunctionDef | undefined {
  for (let i = scope.functions.length - 1; i >= 0; i--) {
    const fn = scope.functions[i].find((f) => f.name === name);
    if (fn) return fn;
  }
  return undefined;
}

/** Follow identifiers bound by `let` or function parameters to the expression they stand for. */
function resolve(expr: Expression, scope: Scope): { expr: Expression; scope: Scope } {
  let cur = { expr, scope };
  for (let i = 0; i < 16 && cur.expr.type === 'identifier'; i++) {
    const bound = cur.scope.vars.get(cur.expr.name);
    if (!bound) break;
    cur = { expr: bound.expr, scope: bound.scope };
  }
  return cur;
}

function booleanLiteralValue(expr: Expression, scope: Scope): boolean | undefined {
  const resolved = resolve(expr, scope).expr;
  if (resolved.type === 'literal' && typeof resolved.value === 'boolean') {
    return resolved.value;
  }
  return undefined;
}

function visit(expr: Expression, scope: Scope, ctx: Ctx): void {
  const { expr: e, scope: s } = resolve(expr, scope);
  switch (e.type) {
    case 'binaryOp':
      visitBinary(e, s, ctx);
      return;
    case 'unaryOp':
      if (e.op === '!') {
        visit(e.operand, s, { ...ctx, negated: !ctx.negated });
      } else {
        visit(e.operand, s, { ...ctx, required: false });
      }
      return;
    case 'ternary':
      visitTernary(e, s, ctx);
      return;
    case 'inExpr':
      if (!ctx.negated && isAuthUid(e.element, s)) {
        record(e.collection, s, 'contains', e, ctx);
      }
      return;
    case 'methodCall':
      if (
        !ctx.negated &&
        (e.method === 'hasAny' || e.method === 'hasAll') &&
        e.args.some((arg) => arg.type === 'listLiteral' && arg.elements.some((el) => isAuthUid(el, s)))
      ) {
        record(e.object, s, 'contains', e, ctx);
      }
      return;
    case 'functionCall':
      visitCall(e, s, ctx);
      return;
    default:
      return;
  }
}

function visitBinary(e: Extract<Expression, { type: 'binaryOp' }>, scope: Scope, ctx: Ctx): void {
  if (e.op === '&&') {
    let branchCtx = ctx;
    if (ctx.negated) branchCtx = { ...ctx, required: false };
    visit(e.left, scope, branchCtx);
    visit(e.right, scope, branchCtx);
    return;
  }
  if (e.op === '||') {
    let branchCtx: Ctx = { ...ctx, required: false };
    if (ctx.negated) branchCtx = ctx;
    visit(e.left, scope, branchCtx);
    visit(e.right, scope, branchCtx);
    return;
  }
  if (e.op === '==' || e.op === '!=') {
    const leftBool = booleanLiteralValue(e.left, scope);
    const rightBool = booleanLiteralValue(e.right, scope);
    if (leftBool !== undefined || rightBool !== undefined) {
      const boolVal = leftBool ?? rightBool ?? false;
      let target = e.left;
      if (leftBool !== undefined) target = e.right;
      const flipsPolarity = (e.op === '==' && !boolVal) || (e.op === '!=' && boolVal);
      let nextNegated = ctx.negated;
      if (flipsPolarity) nextNegated = !ctx.negated;
      visit(target, scope, { ...ctx, negated: nextNegated });
      return;
    }
    const isPositiveEquality = (e.op === '==' && !ctx.negated) || (e.op === '!=' && ctx.negated);
    if (!isPositiveEquality) return;
    if (isAuthUid(e.left, scope)) record(e.right, scope, 'equals', e, ctx);
    else if (isAuthUid(e.right, scope)) record(e.left, scope, 'equals', e, ctx);
  }
}

function visitTernary(e: Extract<Expression, { type: 'ternary' }>, scope: Scope, ctx: Ctx): void {
  if (!ctx.negated && booleanLiteralValue(e.alternate, scope) === false) {
    visit(e.condition, scope, ctx);
    visit(e.consequent, scope, ctx);
    return;
  }
  if (!ctx.negated && booleanLiteralValue(e.consequent, scope) === false) {
    visit(e.condition, scope, { ...ctx, negated: true });
    visit(e.alternate, scope, ctx);
    return;
  }
  const branchCtx: Ctx = { ...ctx, required: false };
  visit(e.condition, scope, branchCtx);
  visit(e.consequent, scope, branchCtx);
  visit(e.alternate, scope, branchCtx);
}

function visitCall(e: Extract<Expression, { type: 'functionCall' }>, scope: Scope, ctx: Ctx): void {
  if (e.name === 'exists' || e.name === 'existsAfter') {
    if (ctx.negated) return;
    let path: { text: string; authKeyed: boolean } | undefined;
    if (e.args[0]) path = lookupPath(e.args[0], scope);
    if (path && path.authKeyed) push(ctx, 'lookup', path.text, 'exists', e, undefined);
    return;
  }
  const fn = findFunction(scope, e.name);
  if (!fn || scope.depth >= MAX_INLINE_DEPTH) return;
  const vars = new Map<string, Bound>();
  fn.parameters.forEach((param, i) => {
    const arg = e.args[i];
    if (arg) vars.set(param, { expr: arg, scope });
  });
  const inner: Scope = { vars, functions: scope.functions, wildcards: scope.wildcards, depth: scope.depth + 1 };
  for (const letBinding of fn.lets) inner.vars.set(letBinding.name, { expr: letBinding.value, scope: inner });
  visit(fn.body, inner, ctx);
}

function isAuthUid(expr: Expression, scope: Scope): boolean {
  const { expr: e, scope: s } = resolve(expr, scope);
  if (e.type !== 'memberAccess' || e.property !== 'uid') return false;
  const auth = resolve(e.object, s).expr;
  if (auth.type !== 'memberAccess' || auth.property !== 'auth') return false;
  const req = resolve(auth.object, s).expr;
  return req.type === 'identifier' && req.name === 'request';
}

/** Record what the uid is compared with. */
function record(other: Expression, scope: Scope, relation: OwnerRelation, whole: Expression, ctx: Ctx): void {
  const { expr: e, scope: s } = resolve(other, scope);
  if (e.type === 'identifier' && s.wildcards.has(e.name)) {
    const foundIndex = ctx.path.findIndex((p) => p === `{${e.name}}` || p === `{${e.name}=**}`);
    let varIndex: number | undefined;
    if (foundIndex >= 0) varIndex = foundIndex;
    push(ctx, 'pathVar', `{${e.name}}`, relation, whole, undefined, varIndex);
    return;
  }
  const field = dataField(e, s);
  if (field) {
    if (field.base === 'lookup') {
      push(ctx, 'lookup', `${field.lookupPath}#${field.field}`, relation, whole, undefined);
      return;
    }
    let kind: OwnerKind = 'storedField';
    if (field.base === 'incoming') kind = 'incomingField';
    push(ctx, kind, field.field, relation, whole, `${ctx.path.join('/')}#${field.field}`);
  }
}

/** `resource.data.a.b`, `request.resource.data['a']`, `resource.data.get('a', x)`, `get(/path).data.a`. */
function dataField(
  expr: Expression,
  scope: Scope,
): { base: 'stored' | 'incoming' | 'lookup'; field: string; lookupPath?: string } | null {
  const fields: string[] = [];
  let cur = resolve(expr, scope);
  for (let i = 0; i < 32; i++) {
    const e = cur.expr;
    if (e.type === 'memberAccess') {
      if (e.property === 'data') {
        const holder = resolve(e.object, cur.scope).expr;
        const field = fields.reverse().join('.');
        if (!field) return null;
        if (isPath(holder, ['resource'], cur.scope)) return { base: 'stored', field };
        if (isPath(holder, ['request', 'resource'], cur.scope)) return { base: 'incoming', field };
        if (holder.type === 'functionCall' && (holder.name === 'get' || holder.name === 'getAfter') && holder.args[0]) {
          const path = lookupPath(holder.args[0], cur.scope);
          if (path) return { base: 'lookup', field, lookupPath: path.text };
          return null;
        }
        return null;
      }
      fields.push(e.property);
      cur = resolve(e.object, cur.scope);
    } else if (e.type === 'bracketAccess' && e.index.type === 'literal' && typeof e.index.value === 'string') {
      fields.push(e.index.value);
      cur = resolve(e.object, cur.scope);
    } else if (e.type === 'methodCall' && e.method === 'get' && e.args[0]?.type === 'literal' && typeof e.args[0].value === 'string') {
      fields.push(e.args[0].value);
      cur = resolve(e.object, cur.scope);
    } else if (e.type === 'methodCall' && (e.method === 'keys' || e.method === 'values')) {
      cur = resolve(e.object, cur.scope);
    } else {
      return null;
    }
  }
  return null;
}

function isPath(expr: Expression, names: string[], scope: Scope): boolean {
  let cur = resolve(expr, scope);
  for (let i = names.length - 1; i > 0; i--) {
    if (cur.expr.type !== 'memberAccess' || cur.expr.property !== names[i]) return false;
    cur = resolve(cur.expr.object, cur.scope);
  }
  return cur.expr.type === 'identifier' && cur.expr.name === names[0];
}

/** A `/databases/$(database)/documents/a/$(b)` path as a template; `{auth.uid}` where the uid is a key. */
function lookupPath(expr: Expression, scope: Scope): { text: string; authKeyed: boolean } | undefined {
  const { expr: e, scope: s } = resolve(expr, scope);
  if (e.type !== 'pathLiteral') return undefined;
  let authKeyed = false;
  const parts: string[] = [];
  for (const seg of e.segments) {
    if (typeof seg === 'string') {
      parts.push(...seg.split('/').filter((x) => x.length > 0));
      continue;
    }
    if (isAuthUid(seg, s)) {
      parts.push('{auth.uid}');
      authKeyed = true;
      continue;
    }
    const r = resolve(seg, s).expr;
    if (r.type === 'identifier') parts.push(`{${r.name}}`);
    else parts.push('{*}');
  }
  const stripped = stripDocuments(parts);
  return { text: stripped.join('/'), authKeyed };
}

function push(
  ctx: Ctx,
  kind: OwnerKind,
  field: string,
  relation: OwnerRelation,
  whole: Expression,
  location: string | undefined,
  varIndex?: number,
): void {
  const c: OwnerCondition = {
    service: 'firestore',
    path: ctx.path.join('/'),
    ops: ctx.ops,
    kind,
    field,
    relation,
    required: ctx.required,
    source: ctx.source,
    expression: safeAssemble(whole),
  };
  if (varIndex !== undefined) c.varIndex = varIndex;
  if (location !== undefined) c.location = location;
  ctx.out.push(c);
}

function safeAssemble(e: Expression): string {
  try {
    return assembleExpression(e);
  } catch {
    return e.type;
  }
}
