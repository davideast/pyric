/**
 * Bounded `Object.entries`, `Object.keys`, and `for..in` accumulator-loop
 * unrolling for the abstract evaluator.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { unwrapExpr } from './operators.js';
import { sentinelObjKind } from './payload.js';
import {
  alternatives,
  definiteTruthiness,
  lit,
  literalText,
  NEVER,
  union,
  unknown,
  type AVal,
  type Env,
} from './values.js';

const MAX_UNROLL_PROPS = 25;

export interface ObjectLoopSpec {
  loop: ts.ForOfStatement | ts.ForInStatement;
  mode: 'entries' | 'keys';
  srcExpr: ts.Expression;
}

interface LoopState {
  env: Env | undefined;
  assigned: Map<string, AVal>;
  optional: Set<string>;
}

export function mergeProp(map: Map<string, AVal>, key: string, val: AVal): void {
  const existing = map.get(key);
  if (existing) map.set(key, union([existing, val]));
  else map.set(key, val);
}

export function findEnclosingObjectLoop(node: ts.Node, decl: ts.VariableDeclaration): ObjectLoopSpec | undefined {
  for (let n: ts.Node | undefined = node.parent; n && n.pos > decl.pos; n = n.parent) {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return undefined;
    if (ts.isForOfStatement(n)) {
      const loopExpr = unwrapExpr(n.expression);
      if (
        ts.isCallExpression(loopExpr) &&
        ts.isPropertyAccessExpression(loopExpr.expression) &&
        ts.isIdentifier(loopExpr.expression.expression) &&
        loopExpr.expression.expression.text === 'Object' &&
        (loopExpr.expression.name.text === 'entries' || loopExpr.expression.name.text === 'keys') &&
        loopExpr.arguments[0]
      ) {
        return { loop: n, mode: loopExpr.expression.name.text, srcExpr: loopExpr.arguments[0] };
      }
    }
    if (ts.isForInStatement(n)) {
      return { loop: n, mode: 'keys', srcExpr: n.expression };
    }
  }
  return undefined;
}

export function applyObjectLoopAssignments(
  ev: Evaluator,
  bindName: (name: ts.BindingName, v: AVal, bindings: Map<ts.Symbol, AVal>) => void,
  sym: ts.Symbol,
  baseVal: AVal,
  spec: ObjectLoopSpec,
  env: Env | undefined,
): AVal {
  const srcAlts = alternatives(ev.force(ev.eval(spec.srcExpr, env)));
  const objAlts = srcAlts.filter((a): a is Extract<AVal, { k: 'obj' }> => a.k === 'obj' && !sentinelObjKind(a, (x) => ev.force(x)));
  const hasUnknown = srcAlts.some((a) => a.k === 'unknown');
  if (objAlts.length === 0) {
    if (hasUnknown) return unknown('object mapped from unknown input');
    if (srcAlts.length > 0 && srcAlts.every((a) => a.k === 'fieldValue' || a.k === 'ref')) return NEVER;
    return baseVal;
  }

  const baseObjs = alternatives(baseVal).filter((a): a is Extract<AVal, { k: 'obj' }> => a.k === 'obj');
  const initialProps = new Map<string, AVal>();
  const initialOptional = new Set<string>();
  for (const bo of baseObjs) {
    for (const [k, val] of bo.props) mergeProp(initialProps, k, val);
    for (const k of bo.optional) initialOptional.add(k);
  }

  const srcId = unwrapExpr(spec.srcExpr);
  let srcSym: ts.Symbol | undefined;
  if (ts.isIdentifier(srcId)) srcSym = ev.targetSymbol(srcId);
  const outAlts: AVal[] = [];

  for (const srcObj of objAlts) {
    const props = new Map(initialProps);
    const optional = new Set([...initialOptional, ...srcObj.optional]);
    const computed = [...srcObj.computed];
    const open = srcObj.open || hasUnknown || srcObj.props.size > MAX_UNROLL_PROPS;
    const entries = [...srcObj.props.entries()].slice(0, MAX_UNROLL_PROPS);
    for (const [propName, rawPropVal] of entries) {
      unrollPropertyIteration(ev, bindName, sym, spec, srcObj, srcSym, propName, rawPropVal, props, optional, env);
    }
    outAlts.push({ k: 'obj', props, computed, open, optional });
  }
  return union(outAlts);
}

function unrollPropertyIteration(
  ev: Evaluator,
  bindName: (name: ts.BindingName, v: AVal, bindings: Map<ts.Symbol, AVal>) => void,
  sym: ts.Symbol,
  spec: ObjectLoopSpec,
  srcObj: Extract<AVal, { k: 'obj' }>,
  srcSym: ts.Symbol | undefined,
  propName: string,
  rawPropVal: AVal,
  props: Map<string, AVal>,
  optional: Set<string>,
  env: Env | undefined,
): void {
  const propVal = ev.force(rawPropVal);
  const hasExplicitUndefined = alternatives(propVal).some((a) => a.k === 'undefined');
  const treatUnknownAsDefined = !hasExplicitUndefined && !srcObj.optional.has(propName);
  const bindings = new Map<ts.Symbol, AVal>();
  if (srcSym) bindings.set(srcSym, srcObj);
  if (ts.isVariableDeclarationList(spec.loop.initializer) && spec.loop.initializer.declarations[0]) {
    const loopDecl = spec.loop.initializer.declarations[0];
    let itemVal: AVal = { k: 'arr', items: [lit(propName), propVal] };
    if (spec.mode === 'keys') itemVal = lit(propName);
    bindName(loopDecl.name, itemVal, bindings);
  }
  const loopEnv: Env = { bindings, parent: env };
  try {
    const { active, completed } = walkLoopBody(
      ev,
      spec.loop.statement,
      [{ env: loopEnv, assigned: new Map(), optional: new Set() }],
      sym,
      treatUnknownAsDefined,
    );
    const endStates = [...active, ...completed];
    const writtenKeys = new Set<string>();
    for (const st of endStates) {
      for (const k of st.assigned.keys()) writtenKeys.add(k);
    }
    for (const k of writtenKeys) {
      const vals = endStates.filter((st) => st.assigned.has(k)).map((st) => st.assigned.get(k)!);
      const assignedEverywhere = endStates.every((st) => st.assigned.has(k) && !st.optional.has(k));
      mergeProp(props, k, union(vals));
      if (!assignedEverywhere || (k === propName && srcObj.optional.has(propName))) optional.add(k);
    }
  } finally {
    ev.clearEnv(loopEnv);
  }
}

function walkLoopBody(
  ev: Evaluator,
  stmt: ts.Statement,
  states: LoopState[],
  targetSym: ts.Symbol,
  treatUnknownAsDefined: boolean,
): { active: LoopState[]; completed: LoopState[] } {
  if (states.length === 0) return { active: [], completed: [] };
  if (ts.isBlock(stmt)) {
    let cur = states;
    const completed: LoopState[] = [];
    for (const s of stmt.statements) {
      if (cur.length === 0) break;
      const next = walkLoopBody(ev, s, cur, targetSym, treatUnknownAsDefined);
      cur = next.active;
      completed.push(...next.completed);
    }
    return { active: cur, completed };
  }
  if (ts.isContinueStatement(stmt) || ts.isBreakStatement(stmt) || ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) {
    return { active: [], completed: states };
  }
  if (ts.isIfStatement(stmt)) {
    return walkLoopIf(ev, stmt, states, targetSym, treatUnknownAsDefined);
  }
  collectElementWritesInNode(ev, stmt, states, targetSym);
  return { active: states, completed: [] };
}

function walkLoopIf(
  ev: Evaluator,
  stmt: ts.IfStatement,
  states: LoopState[],
  targetSym: ts.Symbol,
  treatUnknownAsDefined: boolean,
): { active: LoopState[]; completed: LoopState[] } {
  const nextActive: LoopState[] = [];
  const completed: LoopState[] = [];
  for (const st of states) {
    let t = definiteTruthiness(ev.force(ev.eval(stmt.expression, st.env)));
    if (t === undefined && treatUnknownAsDefined) t = undefinedGuardOutcome(ev, stmt.expression, st.env);
    if (t === true) {
      const res = walkLoopBody(ev, stmt.thenStatement, [st], targetSym, treatUnknownAsDefined);
      nextActive.push(...res.active);
      completed.push(...res.completed);
    } else if (t === false) {
      if (stmt.elseStatement) {
        const res = walkLoopBody(ev, stmt.elseStatement, [st], targetSym, treatUnknownAsDefined);
        nextActive.push(...res.active);
        completed.push(...res.completed);
      } else {
        nextActive.push(st);
      }
    } else {
      const clonedThen: LoopState = { env: st.env, assigned: new Map(st.assigned), optional: new Set(st.optional) };
      const clonedElse: LoopState = { env: st.env, assigned: new Map(st.assigned), optional: new Set(st.optional) };
      const thenRes = walkLoopBody(ev, stmt.thenStatement, [clonedThen], targetSym, treatUnknownAsDefined);
      let elseRes: { active: LoopState[]; completed: LoopState[] } = { active: [clonedElse], completed: [] };
      if (stmt.elseStatement) elseRes = walkLoopBody(ev, stmt.elseStatement, [clonedElse], targetSym, treatUnknownAsDefined);
      nextActive.push(...thenRes.active, ...elseRes.active);
      completed.push(...thenRes.completed, ...elseRes.completed);
    }
  }
  return { active: collapseLoopStates(nextActive), completed };
}

function collectElementWritesInNode(ev: Evaluator, node: ts.Node, states: LoopState[], targetSym: ts.Symbol): void {
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(n.left)) {
      const targetExpr = n.left.expression;
      if (ts.isIdentifier(targetExpr) && ev.targetSymbol(targetExpr) === targetSym) {
        for (const st of states) {
          const keyText = literalText(ev.force(ev.eval(n.left.argumentExpression, st.env)));
          if (keyText !== null) {
            st.assigned.set(keyText, ev.eval(n.right, st.env));
            st.optional.delete(keyText);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

function undefinedGuardOutcome(ev: Evaluator, expr: ts.Expression, env: Env | undefined): boolean | undefined {
  const e = unwrapExpr(expr);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = undefinedGuardOutcome(ev, e.operand, env);
    if (inner === undefined) return undefined;
    return !inner;
  }
  if (!ts.isBinaryExpression(e)) return undefined;
  const op = e.operatorToken.kind;
  const isStrict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const isLoose = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isStrict && !isLoose) return undefined;
  const wantEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const left = unwrapExpr(e.left);
  const right = unwrapExpr(e.right);
  const isUndef = (n: ts.Expression): boolean => ts.isIdentifier(n) && n.text === 'undefined';
  const isNull = (n: ts.Expression): boolean => n.kind === ts.SyntaxKind.NullKeyword;
  let subject: ts.Expression | undefined;
  if (isUndef(right) || (!isStrict && isNull(right))) subject = left;
  else if (isUndef(left) || (!isStrict && isNull(left))) subject = right;
  else if (ts.isTypeOfExpression(left) && ts.isStringLiteralLike(right) && right.text === 'undefined') subject = left.expression;
  else if (ts.isTypeOfExpression(right) && ts.isStringLiteralLike(left) && left.text === 'undefined') subject = right.expression;
  if (!subject) return undefined;
  const alts = alternatives(ev.force(ev.eval(subject, env)));
  if (alts.length === 0) return undefined;
  if (alts.some((a) => a.k === 'undefined' || (!isStrict && a.k === 'null'))) return undefined;
  return !wantEq;
}

function collapseLoopStates(states: LoopState[]): LoopState[] {
  if (states.length <= 4) return states;
  const assigned = new Map<string, AVal>();
  const optional = new Set<string>();
  const keys = new Set<string>();
  for (const st of states) {
    for (const k of st.assigned.keys()) keys.add(k);
  }
  for (const k of keys) {
    const vals = states.filter((st) => st.assigned.has(k)).map((st) => st.assigned.get(k)!);
    assigned.set(k, union(vals));
    if (!states.every((st) => st.assigned.has(k) && !st.optional.has(k))) optional.add(k);
  }
  return [{ env: states[0].env, assigned, optional }];
}
