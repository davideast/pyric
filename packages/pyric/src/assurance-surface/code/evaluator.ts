/**
 * The abstract evaluator facade: owns memo/cycle/step-budget lifecycle,
 * dispatches expressions, templates, object literals, and identifiers, and
 * coordinates member, caller, assignment, and call-inliner collaborators.
 *
 * Traces that recurse, run too deep, or exhaust their budget stop with an
 * `unknown` reason so sites built on them report why instead of vanishing.
 */
import ts from 'typescript';
import { AssignmentResolver } from './assignments.js';
import { CallInliner, type FunctionLike } from './call-inliner.js';
import { CallerTracer } from './callers.js';
import { MemberResolver } from './members.js';
import { evalBinary, evalPrefixUnary, evalTypeOf } from './operators.js';
import { interpolate } from './paths.js';
import { propertyNameText, ReferenceIndex } from './references.js';
import { sdkBinding, type SdkTable } from './sdk-imports.js';
import {
  alternatives,
  concatParts,
  definiteTruthiness,
  literalText,
  NEVER,
  union,
  unknown,
  type AVal,
  type Env,
} from './values.js';

const MAX_DEPTH = 120;

function isInsideFunction(decl: ts.Node): boolean {
  return ts.findAncestor(decl.parent, (n) => ts.isFunctionLike(n) || ts.isIterationStatement(n, false)) !== undefined;
}

export class Evaluator {
  private readonly cache = new Map<ts.Node, AVal>();
  private readonly envCache = new WeakMap<Env, Map<ts.Node, AVal>>();
  private readonly envSymbolCache = new WeakMap<Env, Map<ts.Symbol, AVal>>();
  private readonly symbolCache = new Map<ts.Symbol, AVal>();
  private readonly activeIndex = new Map<string, number>();
  private readonly symbolIds = new WeakMap<object, number>();
  private nextSymbolId = 1;
  private openCycleDepth = Number.POSITIVE_INFINITY;
  private steps = 0;
  private stepLimit = Number.POSITIVE_INFINITY;

  readonly members: MemberResolver;
  readonly callers: CallerTracer;
  readonly assignments: AssignmentResolver;
  readonly inliner: CallInliner;

  constructor(
    readonly checker: ts.TypeChecker,
    readonly refs: ReferenceIndex,
    readonly sdk: SdkTable,
  ) {
    this.members = new MemberResolver(this);
    this.callers = new CallerTracer(this);
    this.assignments = new AssignmentResolver(this);
    this.inliner = new CallInliner(this);
  }

  /** @internal */
  idOf(o: object): number {
    let id = this.symbolIds.get(o);
    if (id === undefined) {
      id = this.nextSymbolId++;
      this.symbolIds.set(o, id);
    }
    return id;
  }

  startBudget(limit: number): void {
    this.steps = 0;
    this.stepLimit = limit;
  }

  /** @internal */
  activeCycleIndex(key: string): number {
    return this.activeIndex.get(key) ?? 0;
  }

  /** @internal */
  recordCycle(targetDepth: number): void {
    if (targetDepth < this.openCycleDepth) {
      this.openCycleDepth = targetDepth;
    }
  }

  /** @internal */
  guard(key: string, compute: () => AVal): AVal {
    const existing = this.activeIndex.get(key);
    if (existing !== undefined) {
      this.recordCycle(existing);
      return unknown('the value depends on itself');
    }
    if (this.activeIndex.size > MAX_DEPTH) {
      this.recordCycle(-1);
      return unknown('trace too deep');
    }
    const depth = this.activeIndex.size;
    this.activeIndex.set(key, depth);
    try {
      return compute();
    } finally {
      this.activeIndex.delete(key);
    }
  }

  /** @internal */
  memo<K>(map: Map<K, AVal>, key: K, compute: () => AVal): AVal {
    const hit = map.get(key);
    if (hit) return hit;
    const myDepth = this.activeIndex.size;
    const savedOpen = this.openCycleDepth;
    this.openCycleDepth = Number.POSITIVE_INFINITY;
    try {
      const v = compute();
      if (this.openCycleDepth >= myDepth) map.set(key, v);
      return v;
    } finally {
      if (this.openCycleDepth < myDepth) this.openCycleDepth = Math.min(savedOpen, this.openCycleDepth);
      else this.openCycleDepth = savedOpen;
    }
  }

  force(v: AVal, seen: Set<ts.Node> = new Set()): AVal {
    if (v.k === 'sym') {
      if (seen.has(v.node)) return NEVER;
      seen.add(v.node);
      return this.force(v.resolve(), seen);
    }
    if (v.k === 'union' && v.alts.some((a) => a.k === 'sym')) {
      return union(v.alts.map((a) => this.force(a, seen)));
    }
    return v;
  }

  clearEnv(env: Env): void {
    this.envCache.delete(env);
    this.envSymbolCache.delete(env);
  }

  eval(node: ts.Expression, env?: Env): AVal {
    if (env) {
      let m = this.envCache.get(env);
      if (!m) {
        m = new Map();
        this.envCache.set(env, m);
      }
      return this.memo(m, node, () => this.guard(`e${this.idOf(node)}:${this.idOf(env)}`, () => this.evalUncached(node, env)));
    }
    return this.memo(this.cache, node, () => this.guard(`e${this.idOf(node)}`, () => this.evalUncached(node, undefined)));
  }

  private evalUncached(node: ts.Expression, env: Env | undefined): AVal {
    this.steps += 1;
    if (this.steps > this.stepLimit) {
      this.recordCycle(-1);
      return unknown('trace budget exhausted');
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      return this.eval(node.expression, env);
    }
    if (ts.isStringLiteralLike(node)) return { k: 'str', parts: [{ kind: 'lit', text: node.text }] };
    if (ts.isNumericLiteral(node)) return { k: 'num', value: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { k: 'bool', value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { k: 'bool', value: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { k: 'null' };
    if (node.kind === ts.SyntaxKind.ThisKeyword) return { k: 'instance', decl: ts.findAncestor(node, ts.isClassLike) };
    if (ts.isTemplateExpression(node)) return this.evalTemplate(node, env);
    if (ts.isIdentifier(node)) return this.evalIdentifier(node, env);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return this.members.evalMember(node, env);
    if (ts.isCallExpression(node)) return this.inliner.evalCall(node, env);
    if (ts.isNewExpression(node)) return this.inliner.evalNew(node, env);
    if (ts.isConditionalExpression(node)) {
      const t = definiteTruthiness(this.force(this.eval(node.condition, env)));
      if (t === true) return this.eval(node.whenTrue, env);
      if (t === false) return this.eval(node.whenFalse, env);
      return union([this.eval(node.whenTrue, env), this.eval(node.whenFalse, env)]);
    }
    if (ts.isBinaryExpression(node)) return evalBinary(this, node, env);
    if (ts.isObjectLiteralExpression(node)) return this.evalObject(node, env);
    if (ts.isArrayLiteralExpression(node)) {
      return this.evalArray(node, env);
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { k: 'fn', decl: node, env };
    if (ts.isPrefixUnaryExpression(node)) return evalPrefixUnary(this, node, env);
    if (ts.isTypeOfExpression(node)) return evalTypeOf(this, node.expression, env);
    if (ts.isVoidExpression(node)) return { k: 'undefined' };
    if (ts.isClassExpression(node)) return { k: 'class', decl: node };
    return unknown(`${ts.SyntaxKind[node.kind]} is not traced`);
  }

  private evalTemplate(node: ts.TemplateExpression, env: Env | undefined): AVal {
    let parts = concatParts([{ kind: 'lit', text: node.head.text }]);
    for (const span of node.templateSpans) {
      const v = this.eval(span.expression, env);
      parts = concatParts(parts, interpolate(v, span.expression, (x) => this.force(x)), [{ kind: 'lit', text: span.literal.text }]);
    }
    return { k: 'str', parts };
  }

  private evalArray(node: ts.ArrayLiteralExpression, env: Env | undefined): AVal {
    const items: AVal[] = [];
    let open = false;
    for (const e of node.elements) {
      if (ts.isSpreadElement(e)) {
        const spread = this.force(this.eval(e.expression, env));
        const alts = alternatives(spread);
        if (alts.length === 1 && alts[0]!.k === 'arr') {
          const arrAlt = alts[0]!;
          items.push(...arrAlt.items);
          if (arrAlt.open) open = true;
        } else {
          open = true;
          items.push(this.members.elementOf(spread));
        }
      } else {
        items.push(this.eval(e, env));
      }
    }
    if (open) return { k: 'arr', items, open: true };
    return { k: 'arr', items };
  }

  private evalObject(node: ts.ObjectLiteralExpression, env: Env | undefined): AVal {
    const props = new Map<string, AVal>();
    const computed: { key: AVal; value: AVal }[] = [];
    const optional = new Set<string>();
    let open = false;
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p)) {
        const name = propertyNameText(p.name);
        if (name !== undefined) props.set(name, this.eval(p.initializer, env));
        else if (ts.isComputedPropertyName(p.name)) {
          const key = this.eval(p.name.expression, env);
          const text = literalText(this.force(key));
          if (text !== null) props.set(text, this.eval(p.initializer, env));
          else computed.push({ key, value: this.eval(p.initializer, env) });
        }
      } else if (ts.isShorthandPropertyAssignment(p)) {
        props.set(p.name.text, this.eval(p.name, env));
      } else if (ts.isSpreadAssignment(p)) {
        const spread = this.force(this.eval(p.expression, env));
        let merged = false;
        for (const alt of alternatives(spread)) {
          if (alt.k === 'obj') {
            merged = true;
            for (const [k, v] of alt.props) {
              if (props.size > 20) break;
              const prev = props.get(k);
              props.set(k, prev ? union([prev, v]) : v);
              optional.add(k);
            }
            computed.push(...alt.computed);
            if (alt.open) open = true;
          } else if (alt.k !== 'null' && alt.k !== 'undefined' && alt.k !== 'bool' && alt.k !== 'str') {
            open = true;
          }
        }
        if (!merged && spread.k === 'unknown') open = true;
      } else if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p)) {
        const name = propertyNameText(p.name);
        if (name !== undefined) props.set(name, { k: 'fn', decl: p, env });
      }
    }
    return { k: 'obj', props, computed, open, optional };
  }

  /** @internal */
  evalIdentifier(id: ts.Identifier, env: Env | undefined): AVal {
    if (id.text === 'undefined') return { k: 'undefined' };
    const sym = this.refs.symbolOf(id);
    if (!sym) return unknown(`'${id.text}' is not declared in the project`);
    const sdk = sdkBinding(this.checker, sym, this.sdk);
    if (sdk) return sdk;
    const target = this.refs.resolveAlias(sym);
    if (!target) return unknown(`'${id.text}' is imported from outside the project`);
    for (let e = env; e; e = e.parent) {
      if (e.stepSymbol === target) {
        return e.bindings.get(target)!;
      }
      const bound = e.bindings.get(target);
      if (bound) {
        const paramInit = e.initialBindings?.get(target);
        if (paramInit !== undefined) {
          const atPos = this.assignments.identifierValue(target, id, env, paramInit);
          if (atPos !== undefined) return atPos;
        }
        return bound;
      }
    }
    const decl = target.valueDeclaration ?? target.declarations?.[0];
    let useEnv: Env | undefined;
    if (env && decl && isInsideFunction(decl)) {
      useEnv = env;
    }
    const atPos = this.assignments.identifierValue(target, id, useEnv);
    if (atPos !== undefined) return atPos;
    return this.symbolValue(target, env);
  }

  /** @internal */
  targetSymbol(id: ts.Identifier): ts.Symbol | undefined {
    const sym = this.refs.symbolOf(id);
    if (!sym) return undefined;
    return this.refs.resolveAlias(sym);
  }

  symbolValue(sym: ts.Symbol, env: Env | undefined): AVal {
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl) return unknown(`'${sym.name}' has no declaration`);
    const useEnv = env && isInsideFunction(decl) ? env : undefined;
    if (useEnv) {
      let m = this.envSymbolCache.get(useEnv);
      if (!m) {
        m = new Map();
        this.envSymbolCache.set(useEnv, m);
      }
      return this.memo(m, sym, () => this.guard(`s${this.idOf(sym)}:${this.idOf(useEnv)}`, () => this.assignments.declarationValue(sym, decl, useEnv)));
    }
    return this.memo(this.symbolCache, sym, () => this.guard(`s${this.idOf(sym)}`, () => this.assignments.declarationValue(sym, decl, undefined)));
  }

  /** @internal */
  pathInto(v: AVal, path: (string | number)[]): AVal {
    return this.assignments.pathInto(v, path);
  }

  callFunction(fn: Extract<AVal, { k: 'fn' }>, args: AVal[]): AVal {
    return this.inliner.callFunction(fn, args);
  }

  bindCall(fn: Extract<AVal, { k: 'fn' }>, argExprs: readonly ts.Expression[], callerEnv: Env | undefined): Env {
    return this.inliner.bindCall(fn, argExprs, callerEnv);
  }

  returnsOf(fn: FunctionLike, env: Env | undefined): AVal {
    return this.inliner.returnsOf(fn, env);
  }

  contextValue(ctxExpr: ts.Expression | undefined): AVal {
    return this.callers.contextValue(ctxExpr);
  }
}
