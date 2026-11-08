/**
 * Function call and constructor dispatch, parameter binding, bounded
 * recursion, branch type-narrowing, and control-flow return collection.
 */
import ts from 'typescript';
import { builtinCall } from './builtins.js';
import type { Evaluator } from './evaluator.js';
import { typeofLeaf, unwrapExpr } from './operators.js';
import { expressionName, functionName } from './paths.js';
import { apiCall, apiNew } from './sdk-models.js';
import {
  alternatives,
  definiteTruthiness,
  literalText,
  union,
  unknown,
  type AVal,
  type Env,
} from './values.js';

const MAX_INLINE_DEPTH = 14;
const MAX_SELF_RECURSION = 3;

export type FunctionLike = ts.SignatureDeclaration & { body?: ts.ConciseBody };

function sameCallArgs(a: AVal[], b: AVal[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

function markCallerHandles(v: AVal): AVal {
  if (v.k === 'db') {
    if (v.fromCallers) return v;
    return { ...v, fromCallers: true };
  }
  if (v.k === 'union') {
    return union(v.alts.map(markCallerHandles));
  }
  return v;
}

export class CallInliner {
  private readonly activeFnCalls = new Map<ts.Node, AVal[][]>();
  private readonly returnOrThrowCache = new WeakMap<ts.Node, boolean>();
  private inlineDepth = 0;

  constructor(private readonly ev: Evaluator) {}

  evalCall(node: ts.CallExpression, env: Env | undefined): AVal {
    const callee = this.ev.force(this.ev.eval(node.expression, env));
    const out: AVal[] = [];
    for (const c of alternatives(callee)) {
      switch (c.k) {
        case 'api':
          out.push(apiCall(this.ev, c, node, env));
          break;
        case 'fn':
          out.push(this.inlineCall(c, node.arguments, env));
          break;
        case 'unknown': {
          const builtin = builtinCall(this.ev, node, env);
          out.push(builtin ?? unknown(`result of ${expressionName(node.expression)}(): ${c.reason}`));
          break;
        }
        case 'class':
          out.push(unknown('class called without new'));
          break;
        default:
          break;
      }
    }
    return union(out);
  }

  evalNew(node: ts.NewExpression, env: Env | undefined): AVal {
    const callee = this.ev.force(this.ev.eval(node.expression, env));
    if (callee.k === 'class') return { k: 'instance', decl: callee.decl };
    if (callee.k === 'api') return apiNew(this.ev, callee, node, env);
    const builtin = builtinCall(this.ev, node, env);
    return builtin ?? unknown(`new ${expressionName(node.expression)}()`);
  }

  callFunction(fn: Extract<AVal, { k: 'fn' }>, args: AVal[]): AVal {
    return this.inlineWith(fn, args);
  }

  bindCall(fn: Extract<AVal, { k: 'fn' }>, argExprs: readonly ts.Expression[], callerEnv: Env | undefined): Env {
    const args = argExprs.map((a) => (ts.isSpreadElement(a) ? unknown('spread argument') : this.ev.eval(a, callerEnv)));
    return this.bindValues(fn, args);
  }

  private inlineCall(fn: Extract<AVal, { k: 'fn' }>, args: readonly ts.Expression[], env: Env | undefined): AVal {
    const values = args.map((a) => (ts.isSpreadElement(a) ? unknown('spread argument') : this.ev.eval(a, env)));
    return this.inlineWith(fn, values);
  }

  private bindValues(fn: Extract<AVal, { k: 'fn' }>, args: AVal[]): Env {
    const bindings = new Map<ts.Symbol, AVal>();
    const initialBindings = new Map<ts.Symbol, AVal>();
    const env: Env = { bindings, parent: fn.env, initialBindings };
    fn.decl.parameters.forEach((p, i) => {
      let v: AVal;
      if (p.dotDotDotToken) {
        v = { k: 'arr', items: args.slice(i) };
      } else if (i < args.length) {
        v = p.initializer ? union([args[i], this.ev.eval(p.initializer, env)]) : args[i];
      } else if (p.initializer) {
        v = this.ev.eval(p.initializer, env);
      } else {
        v = { k: 'undefined' };
      }
      this.ev.assignments.bindName(p.name, v, bindings);
    });
    for (const [sym, boundVal] of [...bindings.entries()]) {
      const callerVal = markCallerHandles(boundVal);
      initialBindings.set(sym, callerVal);
      const decl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (decl) bindings.set(sym, this.ev.assignments.applyReassignments(sym, decl, callerVal, env));
      else bindings.set(sym, callerVal);
    }
    return env;
  }

  private inlineWith(fn: Extract<AVal, { k: 'fn' }>, args: AVal[]): AVal {
    if (this.inlineDepth >= MAX_INLINE_DEPTH) return unknown(`calls nested deeper than ${MAX_INLINE_DEPTH}`);
    const stack = this.activeFnCalls.get(fn.decl) ?? [];
    if (stack.length > 0) {
      const prevArgs = stack[stack.length - 1];
      const canRecurseOnPayload =
        stack.length < MAX_SELF_RECURSION &&
        prevArgs.some((a) => {
          const f = this.ev.force(a);
          return f.k === 'obj' || f.k === 'arr';
        });
      if (!canRecurseOnPayload || stack.some((prev) => sameCallArgs(prev, args))) {
        const rootIdx = this.ev.activeCycleIndex(`c${this.ev.idOf(fn.decl)}:0`);
        this.ev.recordCycle(rootIdx);
        return unknown('the value depends on itself');
      }
    }
    const env = this.bindValues(fn, args);
    const depth = stack.length;
    this.activeFnCalls.set(fn.decl, [...stack, args]);
    this.inlineDepth += 1;
    try {
      return this.ev.guard(`c${this.ev.idOf(fn.decl)}:${depth}`, () => this.returnsOf(fn.decl as FunctionLike, env));
    } finally {
      this.inlineDepth -= 1;
      if (stack.length === 0) this.activeFnCalls.delete(fn.decl);
      else this.activeFnCalls.set(fn.decl, stack);
    }
  }

  private hasReturnOrThrow(node: ts.Node): boolean {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
    const cached = this.returnOrThrowCache.get(node);
    if (cached !== undefined) return cached;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
        found = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    this.returnOrThrowCache.set(node, found);
    return found;
  }

  returnsOf(fn: FunctionLike, env: Env | undefined): AVal {
    const body = fn.body;
    if (!body) return unknown(`${functionName(fn)} has no body`);
    if (!ts.isBlock(body)) return this.ev.eval(body, env);
    if (!this.hasReturnOrThrow(body)) return { k: 'undefined' };
    const values: AVal[] = [];
    const createdEnvs: Env[] = [];

    const walkStmt = (stmt: ts.Statement, curEnv: Env | undefined): { terminated: boolean; nextEnv: Env | undefined } => {
      if (ts.isFunctionLike(stmt) || ts.isClassLike(stmt) || !this.hasReturnOrThrow(stmt)) {
        return { terminated: false, nextEnv: curEnv };
      }
      if (ts.isBlock(stmt)) {
        let blockEnv = curEnv;
        for (const s of stmt.statements) {
          const res = walkStmt(s, blockEnv);
          blockEnv = res.nextEnv;
          if (res.terminated) return { terminated: true, nextEnv: blockEnv };
        }
        return { terminated: false, nextEnv: blockEnv };
      }
      if (ts.isReturnStatement(stmt)) {
        values.push(stmt.expression ? this.ev.eval(stmt.expression, curEnv) : { k: 'undefined' });
        return { terminated: true, nextEnv: curEnv };
      }
      if (ts.isThrowStatement(stmt)) return { terminated: true, nextEnv: curEnv };
      if (ts.isIfStatement(stmt)) {
        const t = definiteTruthiness(this.ev.force(this.ev.eval(stmt.expression, curEnv)));
        if (t === true) return { terminated: walkStmt(stmt.thenStatement, curEnv).terminated, nextEnv: curEnv };
        if (t === false) {
          if (!stmt.elseStatement) return { terminated: false, nextEnv: curEnv };
          return { terminated: walkStmt(stmt.elseStatement, curEnv).terminated, nextEnv: curEnv };
        }
        const thenRes = walkStmt(stmt.thenStatement, curEnv);
        let elseRes = { terminated: false, nextEnv: curEnv };
        if (stmt.elseStatement) elseRes = walkStmt(stmt.elseStatement, curEnv);
        if (thenRes.terminated && elseRes.terminated) return { terminated: true, nextEnv: curEnv };
        if (thenRes.terminated && !elseRes.terminated && curEnv) {
          return { terminated: false, nextEnv: this.narrowEnv(stmt.expression, curEnv, false, createdEnvs) };
        }
        if (!thenRes.terminated && elseRes.terminated && curEnv) {
          return { terminated: false, nextEnv: this.narrowEnv(stmt.expression, curEnv, true, createdEnvs) };
        }
        return { terminated: false, nextEnv: curEnv };
      }
      const visitNested = (n: ts.Node): void => {
        if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
        if (ts.isStatement(n) && n !== stmt) {
          walkStmt(n, curEnv);
          return;
        }
        ts.forEachChild(n, visitNested);
      };
      ts.forEachChild(stmt, visitNested);
      return { terminated: false, nextEnv: curEnv };
    };

    try {
      walkStmt(body, env);
    } finally {
      for (const e of createdEnvs) this.ev.clearEnv(e);
    }
    if (values.length === 0) return { k: 'undefined' };
    return union(values);
  }

  narrowEnv(cond: ts.Expression, env: Env | undefined, truthyBranch: boolean, createdEnvs?: Env[]): Env | undefined {
    const e = unwrapExpr(cond);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      return this.narrowEnv(e.operand, env, !truthyBranch, createdEnvs);
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken && truthyBranch) {
        const mid = this.narrowEnv(e.left, env, true, createdEnvs);
        return this.narrowEnv(e.right, mid, true, createdEnvs);
      }
      if (op === ts.SyntaxKind.BarBarToken && !truthyBranch) {
        const mid = this.narrowEnv(e.left, env, false, createdEnvs);
        return this.narrowEnv(e.right, mid, false, createdEnvs);
      }
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        const isEqOp = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
        const isStrict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
        const wantMatch = truthyBranch ? isEqOp : !isEqOp;
        return this.narrowComparison(unwrapExpr(e.left), unwrapExpr(e.right), isStrict, wantMatch, env, createdEnvs);
      }
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
      if (e.expression.expression.text === 'Array' && e.expression.name.text === 'isArray' && e.arguments[0]) {
        const arg = unwrapExpr(e.arguments[0]);
        if (ts.isIdentifier(arg)) {
          return this.filterSymbolAlts(arg, env, (a) => (truthyBranch ? a.k === 'arr' || a.k === 'unknown' : a.k !== 'arr'), createdEnvs);
        }
      }
    }
    if (ts.isIdentifier(e) && e.text !== 'undefined') {
      return this.filterSymbolAlts(
        e,
        env,
        (a) => (truthyBranch ? definiteTruthiness(a) !== false : definiteTruthiness(a) !== true),
        createdEnvs,
      );
    }
    return env;
  }

  private narrowComparison(
    left: ts.Expression,
    right: ts.Expression,
    strict: boolean,
    wantMatch: boolean,
    env: Env | undefined,
    createdEnvs?: Env[],
  ): Env | undefined {
    if (ts.isTypeOfExpression(left) && ts.isStringLiteralLike(right)) {
      const target = unwrapExpr(left.expression);
      if (ts.isIdentifier(target)) {
        const typeStr = right.text;
        return this.filterSymbolAlts(
          target,
          env,
          (a) => {
            const t = literalText(typeofLeaf(a));
            if (t === null) return true;
            return wantMatch ? t === typeStr : t !== typeStr;
          },
          createdEnvs,
        );
      }
    }
    if (ts.isTypeOfExpression(right) && ts.isStringLiteralLike(left)) {
      return this.narrowComparison(right, left, strict, wantMatch, env, createdEnvs);
    }
    const checkNullish = (idExpr: ts.Expression, other: ts.Expression): Env | undefined => {
      if (!ts.isIdentifier(idExpr) || idExpr.text === 'undefined') return env;
      const isNull = other.kind === ts.SyntaxKind.NullKeyword;
      const isUndef = ts.isIdentifier(other) && other.text === 'undefined';
      if (!isNull && !isUndef) return env;
      return this.filterSymbolAlts(
        idExpr,
        env,
        (a) => {
          if (a.k === 'unknown') return true;
          let matches = false;
          if (!strict) matches = a.k === 'null' || a.k === 'undefined';
          else if (isNull) matches = a.k === 'null';
          else matches = a.k === 'undefined';
          return wantMatch ? matches : !matches;
        },
        createdEnvs,
      );
    };
    const next = checkNullish(left, right);
    if (next !== env) return next;
    return checkNullish(right, left);
  }

  private filterSymbolAlts(
    id: ts.Identifier,
    env: Env | undefined,
    pred: (a: AVal) => boolean,
    createdEnvs?: Env[],
  ): Env | undefined {
    const sym = this.ev.targetSymbol(id);
    if (!sym) return env;
    const alts = alternatives(this.ev.force(this.ev.evalIdentifier(id, env)));
    if (alts.length <= 1) return env;
    const filtered = alts.filter(pred);
    if (filtered.length === alts.length || filtered.length === 0) return env;
    const child: Env = { bindings: new Map([[sym, union(filtered)]]), parent: env };
    if (createdEnvs) createdEnvs.push(child);
    return child;
  }
}
