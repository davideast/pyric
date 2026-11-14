/**
 * Query and constraint evaluation for registered {@link SdkServiceModel}s:
 * preserves filter operands (`literal`, `auth`, `array`, `param`, `unknown`),
 * nested `and`/`or` children, dynamic `orderBy` directions, and Cartesian
 * constraint branch combinations.
 */
import ts from 'typescript';
import type { AssuranceService } from '../../sandbox/internal/resource-pattern.js';
import type { Evaluator } from './evaluator.js';
import { unwrapExpr } from './operators.js';
import { mergeAuth } from './paths.js';
import { authOf } from './payload.js';
import type {
  ConstraintOperand,
  ConstraintSpec,
  SdkQueryConstraint,
  WrapperOperandSegment,
  WrapperOperandValue,
} from './service-models/types.js';
import { literalUint8Bytes } from './binary-constructors.js';
import {
  alternatives,
  literalText,
  MAX_UNION,
  union,
  unknown,
  type AVal,
  type ConstraintValue,
  type Env,
} from './values.js';

type RefVal = Extract<AVal, { k: 'ref' }>;

function arrayElementExpr(expr: ts.Expression | undefined, index: number): ts.Expression | undefined {
  if (!expr) return undefined;
  const unwrapped = unwrapExpr(expr);
  if (!ts.isArrayLiteralExpression(unwrapped)) return undefined;
  const item = unwrapped.elements[index];
  if (!item || ts.isSpreadElement(item)) return undefined;
  return item;
}

function rootAccessIdentifier(expr: ts.Expression | undefined): ts.Identifier | undefined {
  if (!expr) return undefined;
  let cur: ts.Expression = unwrapExpr(expr);
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    cur = unwrapExpr(cur.expression);
  }
  return ts.isIdentifier(cur) ? cur : undefined;
}

function isDeclaredParameter(ev: Evaluator, id: ts.Identifier): boolean {
  const sym = ev.targetSymbol(id);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (!decl) return false;
  if (ts.isParameter(decl)) return true;
  if (ts.isBindingElement(decl)) {
    return ts.findAncestor(decl, ts.isParameter) !== undefined;
  }
  return false;
}

function isParameterOperand(
  ev: Evaluator,
  rawVal: AVal,
  forced: AVal,
  argExpr: ts.Expression | undefined,
): boolean {
  if (rawVal.k === 'sym') return true;
  const alts = alternatives(forced).filter((a) => a.k !== 'undefined' && a.k !== 'null');
  if (
    alts.length > 0
    && alts.every(
      (a) => a.k === 'unknown' && a.reason.startsWith('no in-project caller of '),
    )
  ) {
    return true;
  }
  const rootId = rootAccessIdentifier(argExpr);
  if (rootId && isDeclaredParameter(ev, rootId)) {
    return alts.length === 0 || alts.some((a) => a.k === 'unknown');
  }
  return false;
}

function refToWrapperOperand(
  ref: RefVal,
): Extract<WrapperOperandValue, { wrapperKind: 'reference' }> | undefined {
  if (
    ref.service !== 'firestore'
    || ref.refKind !== 'doc'
    || ref.notes.length > 0
    || ref.segments.length < 2
    || ref.segments.length % 2 !== 0
  ) {
    return undefined;
  }
  const segments: WrapperOperandSegment[] = [];
  for (const seg of ref.segments) {
    const text = literalText({ k: 'str', parts: seg });
    if (text !== null) {
      if (text.length === 0) return undefined;
      segments.push({ kind: 'lit', text });
      continue;
    }
    if (seg.length === 1 && seg[0]!.kind === 'hole') {
      const hole = seg[0]!;
      if (hole.auth.length === 0 || !hole.auth.every((m) => m.exact)) {
        return undefined;
      }
      const merged = mergeAuth(hole.auth, true);
      if (!merged || merged.length === 0) return undefined;
      segments.push({ kind: 'auth', auth: merged });
      continue;
    }
    const allExactUidHoles = seg.every(
      (part) =>
        part.kind === 'lit'
        || (part.auth.length === 1 && part.auth[0]!.source === 'auth.uid' && part.auth[0]!.exact),
    );
    if (!allExactUidHoles) return undefined;
    const pattern = seg.map((part) => (part.kind === 'lit' ? part.text : '{auth.uid}')).join('');
    segments.push({
      kind: 'auth',
      auth: [{ source: 'auth.uid', certainty: 'exact' }],
      pattern,
    });
  }
  return {
    wrapperKind: 'reference',
    databaseId: ref.resourceId,
    segments,
  };
}

/** Classify a filter or cursor argument into a {@link ConstraintOperand}. */
export function operandOf(
  ev: Evaluator,
  rawVal: AVal,
  argExpr?: ts.Expression,
): ConstraintOperand {
  const forced = ev.force(rawVal);
  const auth = authOf(forced);
  if (auth && auth.length > 0) {
    return { kind: 'auth', auth };
  }
  if (forced.k === 'wrapper') {
    return { kind: 'wrapper', wrapper: forced.value };
  }
  const uint8Bytes = literalUint8Bytes(forced);
  if (uint8Bytes !== undefined) {
    return { kind: 'wrapper', wrapper: { wrapperKind: 'bytes', bytes: uint8Bytes } };
  }
  if (forced.k === 'ref') {
    const refWrapper = refToWrapperOperand(forced);
    if (refWrapper !== undefined) {
      return { kind: 'wrapper', wrapper: refWrapper };
    }
  }
  if (forced.k === 'null') {
    return { kind: 'literal', literal: null };
  }
  if (forced.k === 'bool' && forced.value !== undefined) {
    return { kind: 'literal', literal: forced.value };
  }
  if (forced.k === 'num' && forced.value !== undefined) {
    return { kind: 'literal', literal: forced.value };
  }
  const text = literalText(forced);
  if (text !== null) {
    return { kind: 'literal', literal: text };
  }
  if (forced.k === 'arr') {
    if (forced.open) return { kind: 'unknown' };
    return {
      kind: 'array',
      items: forced.items.map((item, idx) => operandOf(ev, item, arrayElementExpr(argExpr, idx))),
    };
  }
  if (isParameterOperand(ev, rawVal, forced, argExpr)) {
    return { kind: 'param' };
  }
  return { kind: 'unknown' };
}

function toConstraintValues(ev: Evaluator, val: AVal): ConstraintValue[] {
  const alts = alternatives(ev.force(val));
  if (alts.length === 0) return [{ kind: 'unknown' }];
  return alts.map((c) => (c.k === 'constraint' ? c.value : { kind: 'unknown' }));
}

function argumentConstraintSequences(
  ev: Evaluator,
  argNode: ts.Expression,
  evalArg: () => AVal,
  env: Env | undefined,
): ConstraintValue[][] {
  if (ts.isSpreadElement(argNode)) {
    const spreadAlts = alternatives(ev.force(ev.eval(argNode.expression, env)));
    if (spreadAlts.length > 0 && spreadAlts.every((a) => a.k === 'arr' && !a.open)) {
      const sequences: ConstraintValue[][] = [];
      for (const arrAlt of spreadAlts) {
        if (arrAlt.k !== 'arr') continue;
        let partial: ConstraintValue[][] = [[]];
        for (const item of arrAlt.items) {
          const itemChoices = toConstraintValues(ev, item);
          const next: ConstraintValue[][] = [];
          for (const prefix of partial) {
            for (const choice of itemChoices) {
              if (next.length >= MAX_UNION) break;
              next.push([...prefix, choice]);
            }
          }
          partial = next;
        }
        sequences.push(...partial);
      }
      if (sequences.length > 0) return sequences.slice(0, MAX_UNION);
    }
    return [[{ kind: 'unknown' }]];
  }
  return toConstraintValues(ev, evalArg()).map((c) => [c]);
}

/** Bounded Cartesian product of constraint arguments from `fromIndex` onward. */
function cartesianConstraintLists(
  ev: Evaluator,
  call: ts.CallExpression,
  fromIndex: number,
  arg: (i: number) => AVal,
  env: Env | undefined,
): ConstraintValue[][] {
  let acc: ConstraintValue[][] = [[]];
  for (let i = fromIndex; i < call.arguments.length; i++) {
    const argNode = call.arguments[i]!;
    const choices = argumentConstraintSequences(ev, argNode, () => arg(i), env);
    const next: ConstraintValue[][] = [];
    for (const prefix of acc) {
      for (const seq of choices) {
        if (next.length >= MAX_UNION) break;
        next.push([...prefix, ...seq]);
      }
      if (next.length >= MAX_UNION) break;
    }
    acc = next;
  }
  return acc;
}

function buildConstraint(
  kind: string,
  field: string | undefined,
  op: string | undefined,
  direction: 'asc' | 'desc' | undefined,
  operand: ConstraintOperand | undefined,
): SdkQueryConstraint {
  const out: {
    kind: string;
    field?: string;
    op?: string;
    direction?: 'asc' | 'desc';
    operand?: ConstraintOperand;
  } = { kind };
  if (field !== undefined) out.field = field;
  if (op !== undefined) out.op = op;
  if (direction !== undefined) out.direction = direction;
  if (operand !== undefined) out.operand = operand;
  return out;
}

function resolveDirections(
  ev: Evaluator,
  spec: ConstraintSpec,
  call: ts.CallExpression,
  arg: (i: number) => AVal,
): ('asc' | 'desc')[] {
  const dirIndex = spec.directionArg!;
  const fallback = spec.defaultDirection ?? 'asc';
  if (call.arguments.length <= dirIndex) return [fallback];
  const dirAlts = alternatives(ev.force(arg(dirIndex)));
  if (dirAlts.length === 0) return ['asc', 'desc'];
  const dirs = new Set<'asc' | 'desc'>();
  for (const alt of dirAlts) {
    if (alt.k === 'undefined') {
      dirs.add(fallback);
      continue;
    }
    const text = literalText(alt);
    if (text === 'asc' || text === 'desc') {
      dirs.add(text);
    } else {
      dirs.add('asc');
      dirs.add('desc');
    }
  }
  return [...dirs];
}

function resolveTextChoices(ev: Evaluator, val: AVal): (string | undefined)[] {
  const alts = alternatives(ev.force(val));
  if (alts.length === 0) return [undefined];
  const seen = new Set<string | undefined>();
  const out: (string | undefined)[] = [];
  for (const alt of alts) {
    const text = literalText(alt) ?? undefined;
    if (!seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

function isConcreteValueAlt(ev: Evaluator, alt: AVal): boolean {
  const f = ev.force(alt);
  if (f.k === 'null') return true;
  if (f.k === 'bool') return f.value !== undefined;
  if (f.k === 'num') return f.value !== undefined;
  if (f.k === 'wrapper') return true;
  if (literalUint8Bytes(f) !== undefined) return true;
  if (f.k === 'ref' && refToWrapperOperand(f) !== undefined) return true;
  if (literalText(f) !== null) return true;
  if (f.k === 'arr') {
    return f.items.every((item) => isConcreteValueAlt(ev, item));
  }
  return false;
}

function resolveOperandChoices(
  ev: Evaluator,
  rawVal: AVal,
  argExpr: ts.Expression | undefined,
): ConstraintOperand[] {
  const forced = ev.force(rawVal);
  const auth = authOf(forced);
  if (auth && auth.length > 0) {
    return [{ kind: 'auth', auth }];
  }
  const alts = alternatives(forced);
  if (alts.length > 1 && alts.every((alt) => isConcreteValueAlt(ev, alt))) {
    return alts.map((alt) => operandOf(ev, alt, argExpr));
  }
  return [operandOf(ev, rawVal, argExpr)];
}

export function evalConstraintCall(
  ev: Evaluator,
  spec: ConstraintSpec,
  call: ts.CallExpression,
  arg: (i: number) => AVal,
  env: Env | undefined,
): AVal {
  if (spec.composite) {
    const childLists = cartesianConstraintLists(ev, call, 0, arg, env);
    return union(
      childLists.map((children) => ({
        k: 'constraint' as const,
        value: { kind: spec.kind, children },
      })),
    );
  }
  if (spec.kind === 'where' && call.arguments.length === 1) {
    const firstForce = ev.force(arg(0));
    if (alternatives(firstForce).some((a) => a.k === 'constraint')) {
      return firstForce;
    }
  }
  let fields: (string | undefined)[] = [undefined];
  if (spec.fieldArg !== undefined && call.arguments.length > spec.fieldArg) {
    fields = resolveTextChoices(ev, arg(spec.fieldArg));
  }
  let ops: (string | undefined)[] = [undefined];
  if (spec.opArg !== undefined && call.arguments.length > spec.opArg) {
    ops = resolveTextChoices(ev, arg(spec.opArg));
  }
  let operands: (ConstraintOperand | undefined)[] = [undefined];
  if (spec.valueArg !== undefined && call.arguments.length > spec.valueArg) {
    operands = resolveOperandChoices(ev, arg(spec.valueArg), call.arguments[spec.valueArg]);
  }
  let directions: ('asc' | 'desc' | undefined)[] = [undefined];
  if (spec.directionArg !== undefined) {
    directions = resolveDirections(ev, spec, call, arg);
  }
  const choices: AVal[] = [];
  for (const field of fields) {
    for (const op of ops) {
      for (const direction of directions) {
        for (const operand of operands) {
          if (choices.length >= MAX_UNION) break;
          choices.push({
            k: 'constraint',
            value: buildConstraint(spec.kind, field, op, direction, operand),
          });
        }
      }
    }
  }
  return union(choices);
}

export function evalQueryCall(
  ev: Evaluator,
  service: AssuranceService,
  call: ts.CallExpression,
  arg: (i: number) => AVal,
  env: Env | undefined,
): AVal {
  const constraintLists = cartesianConstraintLists(ev, call, 1, arg, env);
  const out: AVal[] = [];
  for (const b of alternatives(ev.force(arg(0)))) {
    if (b.k === 'ref' && b.service === service) {
      for (const constraints of constraintLists) {
        if (out.length >= MAX_UNION) break;
        const priorConstraints = b.constraints ?? [];
        out.push({
          ...b,
          built: [...b.built, call],
          constraints: [...priorConstraints, ...constraints],
          baseRef: b.baseRef ?? b,
          firstQueryCall: b.firstQueryCall ?? call,
          queryCall: call,
        } satisfies RefVal);
      }
    } else if (b.k === 'unknown') {
      out.push(unknown(`query() base was not traced: ${b.reason}`));
    }
  }
  if (out.length === 0) return unknown('query() on a value that is not a ref');
  return union(out);
}
