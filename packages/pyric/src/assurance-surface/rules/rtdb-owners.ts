/**
 * Owner conditions from Realtime Database rules: walks the rules tree,
 * parses every `.read`, `.write` and `.validate` with Pyric's RTDB
 * expression parser, and records each place the expression positively ties
 * access to `auth.uid`.
 */
import {
  parseRtdbExpressionTree,
  printRtdbExpressionTree,
  type RtdbExpressionTree,
} from '../../rules/internal/rtdb.js';
import {
  classifyTernaryBranches,
  flipRelationalSides,
  isRelationalOp,
  negateRelationalOp,
  satisfyingRelationalValue,
  type RelationalOp,
} from './rules-ast-utils.js';
import type { OwnerCondition, OwnerKind, OwnerRelation } from './types.js';

const RULE_KEYS: Record<string, string> = { '.read': 'read', '.write': 'write', '.validate': 'validate' };

/** A reference into the database, read from `data`, `newData` or `root` chains. */
interface DbRef {
  base: 'data' | 'newData' | 'root';
  /** Segments after the base; `..` for `parent()`, `{auth.uid}` where the uid is a key. */
  segments: string[];
  /** True when a segment is keyed by `auth.uid`. */
  authKeyed: boolean;
}

/** Collect owner conditions from a single parsed RTDB rule expression. */
export function rtdbExpressionOwnerConditions(
  tree: RtdbExpressionTree,
  path: readonly string[],
  op: string,
  source: string,
): OwnerCondition[] {
  const out: OwnerCondition[] = [];
  collect(tree, { path: [...path], op, source, out, required: true, negated: false });
  return out;
}

/** Collect owner conditions from a parsed RTDB rules object (`{ rules: {...} }`). */
export function rtdbOwnerConditions(rulesJson: unknown, file: string): OwnerCondition[] {
  const out: OwnerCondition[] = [];
  const root = (rulesJson as { rules?: unknown } | null)?.rules;
  if (!isObject(root)) return out;
  const walk = (node: Record<string, unknown>, path: string[]): void => {
    for (const [key, value] of Object.entries(node)) {
      const op = RULE_KEYS[key];
      if (op && typeof value === 'string') {
        const parsed = parseRtdbExpressionTree(value);
        if (!parsed.ok) continue;
        const source = `${file}#/rules/${[...path, key].join('/')}`;
        collect(parsed.tree, { path, op, source, out, required: true, negated: false });
      } else if (isObject(value) && !key.startsWith('.')) {
        walk(value, [...path, key]);
      }
    }
  };
  walk(root, []);
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface Ctx {
  path: string[];
  op: string;
  source: string;
  out: OwnerCondition[];
  required: boolean;
  negated: boolean;
}

function booleanLiteralValue(t: RtdbExpressionTree): boolean | undefined {
  if (t.type === 'boolean') return t.value;
  return undefined;
}

function rtdbNumericLiteral(t: RtdbExpressionTree): number | undefined {
  if (t.type === 'number') {
    const num = Number(t.raw);
    return Number.isFinite(num) ? num : undefined;
  }
  if (t.type === 'unary' && t.operator === '-') {
    const inner = rtdbNumericLiteral(t.argument);
    return inner === undefined ? undefined : -inner;
  }
  return undefined;
}

function rtdbScalarLiteral(t: RtdbExpressionTree): string | number | boolean | undefined {
  if (t.type === 'string') return t.value;
  if (t.type === 'boolean') return t.value;
  return rtdbNumericLiteral(t);
}

/** Walk an expression; `required` tracks all-`&&` routes and `negated` tracks polarity. */
function collect(t: RtdbExpressionTree, ctx: Ctx): void {
  switch (t.type) {
    case 'binary':
      collectBinary(t, ctx);
      return;
    case 'unary':
      if (t.operator === '!') {
        collect(t.argument, { ...ctx, negated: !ctx.negated });
      } else {
        collect(t.argument, { ...ctx, required: false });
      }
      return;
    case 'ternary':
      collectTernary(t, ctx);
      return;
    case 'call':
      if (!ctx.negated) collectCall(t, ctx);
      return;
    default:
      return;
  }
}

function collectBinary(t: Extract<RtdbExpressionTree, { type: 'binary' }>, ctx: Ctx): void {
  if (t.operator === '&&') {
    let branchCtx = ctx;
    if (ctx.negated) branchCtx = { ...ctx, required: false };
    collect(t.left, branchCtx);
    collect(t.right, branchCtx);
    return;
  }
  if (t.operator === '||') {
    let branchCtx: Ctx = { ...ctx, required: false };
    if (ctx.negated) branchCtx = ctx;
    collect(t.left, branchCtx);
    collect(t.right, branchCtx);
    return;
  }

  const isEq = t.operator === '==' || t.operator === '===';
  const isNeq = t.operator === '!=' || t.operator === '!==';
  if (isEq || isNeq) {
    const leftBool = booleanLiteralValue(t.left);
    const rightBool = booleanLiteralValue(t.right);
    if (leftBool !== undefined || rightBool !== undefined) {
      const boolVal = leftBool ?? rightBool ?? false;
      let target = t.left;
      if (leftBool !== undefined) target = t.right;
      const flipsPolarity = (isEq && !boolVal) || (isNeq && boolVal);
      let nextNegated = ctx.negated;
      if (flipsPolarity) nextNegated = !ctx.negated;
      collect(target, { ...ctx, negated: nextNegated });
      return;
    }

    if (t.left.type === 'null' || t.right.type === 'null') {
      let other = t.left;
      if (t.left.type === 'null') other = t.right;
      const assertsPresent = (isNeq && !ctx.negated) || (isEq && ctx.negated);
      if (assertsPresent) recordAuthKeyed(other, ctx);
      return;
    }

    const isPositiveEq = (isEq && !ctx.negated) || (isNeq && ctx.negated);
    if (!isPositiveEq) return;
    if (isAuthUid(t.left)) record(t.right, 'equals', t, ctx);
    else if (isAuthUid(t.right)) record(t.left, 'equals', t, ctx);
    else {
      const leftRef = dbRefOf(t.left);
      const rightRef = dbRefOf(t.right);
      const leftScalar = rtdbScalarLiteral(t.left);
      const rightScalar = rtdbScalarLiteral(t.right);
      if (leftRef?.authKeyed && rightScalar !== undefined) {
        push(ctx, kindOfBase(leftRef.base, true), refField(leftRef, ctx.path), 'exists', t, refLocation(leftRef, ctx.path), undefined, rightScalar);
      } else if (rightRef?.authKeyed && leftScalar !== undefined) {
        push(ctx, kindOfBase(rightRef.base, true), refField(rightRef, ctx.path), 'exists', t, refLocation(rightRef, ctx.path), undefined, leftScalar);
      } else {
        recordAuthKeyed(t, ctx);
      }
    }
    return;
  }

  if (isRelationalOp(t.operator)) {
    const leftRef = dbRefOf(t.left);
    const rightRef = dbRefOf(t.right);
    const leftNum = rtdbNumericLiteral(t.left);
    const rightNum = rtdbNumericLiteral(t.right);
    if (leftRef?.authKeyed && rightNum !== undefined) {
      let effOp: RelationalOp = t.operator;
      if (ctx.negated) effOp = negateRelationalOp(effOp);
      const seedValue = satisfyingRelationalValue(effOp, rightNum);
      push(ctx, kindOfBase(leftRef.base, true), refField(leftRef, ctx.path), 'exists', t, refLocation(leftRef, ctx.path), undefined, seedValue, effOp);
      return;
    }
    if (rightRef?.authKeyed && leftNum !== undefined) {
      let effOp = flipRelationalSides(t.operator);
      if (ctx.negated) effOp = negateRelationalOp(effOp);
      const seedValue = satisfyingRelationalValue(effOp, leftNum);
      push(ctx, kindOfBase(rightRef.base, true), refField(rightRef, ctx.path), 'exists', t, refLocation(rightRef, ctx.path), undefined, seedValue, effOp);
      return;
    }
  }

  if (!ctx.negated) {
    recordAuthKeyed(t, ctx);
  }
}

function collectTernary(t: Extract<RtdbExpressionTree, { type: 'ternary' }>, ctx: Ctx): void {
  const plan = classifyTernaryBranches(
    booleanLiteralValue(t.consequent),
    booleanLiteralValue(t.alternate),
    ctx.negated,
  );
  if (plan.conditionNegated === undefined) return;
  const required = plan.singleRoute ? ctx.required : false;
  collect(t.test, { ...ctx, required, negated: plan.conditionNegated });
  if (plan.visitConsequent) collect(t.consequent, { ...ctx, required });
  if (plan.visitAlternate) collect(t.alternate, { ...ctx, required });
}

function collectCall(t: Extract<RtdbExpressionTree, { type: 'call' }>, ctx: Ctx): void {
  if (t.method === 'beginsWith' || t.method === 'endsWith' || t.method === 'contains') {
    const arg = t.args[0];
    if (arg && containsAuthUid(arg)) {
      record(t.receiver, 'prefix', t, ctx);
      return;
    }
    if (containsAuthUid(t.receiver) && arg) {
      record(arg, 'prefix', t, ctx);
      return;
    }
  }
  if (t.method === 'exists' || t.method === 'hasChild' || t.method === 'val') {
    recordAuthKeyed(t, ctx);
  }
}

/** A comparison or call with `auth.uid` inside a database reference's key (`root.child('members').child(auth.uid)`). */
function recordAuthKeyed(t: RtdbExpressionTree, ctx: Ctx): void {
  const refs: DbRef[] = [];
  findDbRefs(t, refs);
  for (const ref of refs) {
    if (!ref.authKeyed) continue;
    push(ctx, kindOfBase(ref.base, true), refField(ref, ctx.path), 'exists', t, refLocation(ref, ctx.path));
  }
}

function findDbRefs(t: RtdbExpressionTree, out: DbRef[]): void {
  const ref = dbRefOf(t);
  if (ref) {
    out.push(ref);
    return;
  }
  for (const child of childrenOf(t)) findDbRefs(child, out);
}

function childrenOf(t: RtdbExpressionTree): RtdbExpressionTree[] {
  switch (t.type) {
    case 'binary':
      return [t.left, t.right];
    case 'unary':
      return [t.argument];
    case 'ternary':
      return [t.test, t.consequent, t.alternate];
    case 'call':
      return [t.receiver, ...t.args];
    case 'member':
      return [t.object];
    case 'index':
      return [t.object, t.index];
    case 'array':
      return t.elements;
    default:
      return [];
  }
}

/** Record the value compared to the uid. */
function record(other: RtdbExpressionTree, relation: OwnerRelation, whole: RtdbExpressionTree, ctx: Ctx): void {
  if (other.type === 'identifier' && other.name.startsWith('$')) {
    const foundIndex = ctx.path.indexOf(other.name);
    let varIndex: number | undefined;
    if (foundIndex >= 0) varIndex = foundIndex;
    push(ctx, 'pathVar', other.name, relation, whole, undefined, varIndex);
    return;
  }
  const ref = dbRefOf(other);
  if (ref) {
    push(ctx, kindOfBase(ref.base, false), refField(ref, ctx.path), relation, whole, refLocation(ref, ctx.path));
    return;
  }
  const vars = pathVarsIn(other);
  for (const v of vars) {
    const foundIndex = ctx.path.indexOf(v);
    let varIndex: number | undefined;
    if (foundIndex >= 0) varIndex = foundIndex;
    let nextRelation = relation;
    if (relation === 'equals') nextRelation = 'prefix';
    push(ctx, 'pathVar', v, nextRelation, whole, undefined, varIndex);
  }
}

function pathVarsIn(t: RtdbExpressionTree): string[] {
  if (t.type === 'identifier') {
    if (t.name.startsWith('$')) return [t.name];
    return [];
  }
  return childrenOf(t).flatMap(pathVarsIn);
}

function kindOfBase(base: DbRef['base'], keyed: boolean): OwnerKind {
  if (base === 'root' || keyed) return 'lookup';
  if (base === 'newData') return 'incomingField';
  return 'storedField';
}

/** `data.child('a').parent().child($b).val()` and friends, or null. */
function dbRefOf(t: RtdbExpressionTree): DbRef | null {
  let cur = t;
  if (cur.type === 'call' && (cur.method === 'val' || cur.method === 'exists' || cur.method === 'isString' || cur.method === 'getPriority')) {
    cur = cur.receiver;
  }
  const segments: string[] = [];
  let authKeyed = false;
  for (let depth = 0; depth < 64; depth++) {
    if (cur.type === 'identifier') {
      if (cur.name === 'data' || cur.name === 'newData' || cur.name === 'root') {
        return { base: cur.name, segments: segments.reverse(), authKeyed };
      }
      return null;
    }
    if (cur.type !== 'call') return null;
    if (cur.method === 'child' && cur.args[0]) {
      const seg = segmentOf(cur.args[0]);
      if (seg === '{auth.uid}') authKeyed = true;
      for (const s of seg.split('/').reverse()) segments.push(s);
    } else if (cur.method === 'hasChild' && cur.args[0]) {
      const seg = segmentOf(cur.args[0]);
      if (seg === '{auth.uid}') authKeyed = true;
      segments.push(seg);
    } else if (cur.method === 'parent') {
      segments.push('..');
    } else {
      return null;
    }
    cur = cur.receiver;
  }
  return null;
}

function segmentOf(arg: RtdbExpressionTree): string {
  if (arg.type === 'string') return arg.value;
  if (arg.type === 'identifier') return arg.name;
  if (isAuthUid(arg)) return '{auth.uid}';
  return '*';
}

/** The field as written relative to the rule node (`author`, `../speaker/uid`, `.`), or the absolute lookup path. */
function refField(ref: DbRef, path: string[]): string {
  if (ref.base === 'root') return ref.segments.join('/');
  if (ref.authKeyed) return resolveSegments(path, ref.segments).join('/');
  if (ref.segments.length > 0) return ref.segments.join('/');
  return '.';
}

/** The field's absolute location: rule path plus the relative segments, `..` resolved. */
function refLocation(ref: DbRef, path: string[]): string {
  if (ref.base === 'root') return ref.segments.join('/');
  return resolveSegments(path, ref.segments).join('/');
}

function resolveSegments(path: string[], rel: string[]): string[] {
  const out = [...path];
  for (const s of rel) {
    if (s === '..') out.pop();
    else if (s !== '') out.push(s);
  }
  return out;
}

function isAuthUid(t: RtdbExpressionTree): boolean {
  return t.type === 'member' && t.property === 'uid' && t.object.type === 'identifier' && t.object.name === 'auth';
}

function containsAuthUid(t: RtdbExpressionTree): boolean {
  return isAuthUid(t) || childrenOf(t).some(containsAuthUid);
}

function push(
  ctx: Ctx,
  kind: OwnerKind,
  field: string,
  relation: OwnerRelation,
  whole: RtdbExpressionTree,
  location: string | undefined,
  varIndex?: number,
  seedValue?: string | number | boolean,
  comparisonOp?: RelationalOp,
): void {
  const c: OwnerCondition = {
    service: 'rtdb',
    path: ctx.path.join('/'),
    ops: [ctx.op],
    kind,
    field,
    relation,
    required: ctx.required,
    source: ctx.source,
    expression: printRtdbExpressionTree(whole),
  };
  if (varIndex !== undefined) c.varIndex = varIndex;
  if (location !== undefined) c.location = location;
  if (seedValue !== undefined) c.seedValue = seedValue;
  if (comparisonOp !== undefined) c.comparisonOp = comparisonOp;
  ctx.out.push(c);
}
