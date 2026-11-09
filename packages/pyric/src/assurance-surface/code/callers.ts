/**
 * Backward value tracing through callers: a parameter's values are what
 * its callers pass, a callback's parameters are what the SDK or the
 * in-project function that invokes it supplies, a component's props are
 * its JSX attributes, and a React context's value is its providers'.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { expressionName, functionName } from './paths.js';
import { apiCallbackParameter, memberCallbackParameter } from './sdk-models.js';
import { alternatives, union, unknown, withDefaultInitializer, type AVal } from './values.js';

type FunctionLike = ts.SignatureDeclaration & { body?: ts.ConciseBody };

export class CallerTracer {
  private readonly paramCache = new Map<ts.Node, AVal>();

  constructor(private readonly ev: Evaluator) {}

  /** A parameter's value: deferred, resolved from its callers when someone needs it. */
  parameterValue(param: ts.ParameterDeclaration): AVal {
    const name = ts.isIdentifier(param.name) ? param.name.text : 'props';
    return {
      k: 'sym',
      name,
      node: param,
      resolve: () => this.ev.memo(this.paramCache, param, () => this.ev.guard(`p${this.ev.idOf(param)}`, () => this.resolveParameter(param))),
    };
  }

  private resolveParameter(param: ts.ParameterDeclaration): AVal {
    const fn = param.parent as FunctionLike;
    const index = fn.parameters.indexOf(param);
    const values = this.argumentsFor(fn, index);
    if (values.length === 0) {
      const fnName = functionName(fn);
      const uncalled = unknown(`no in-project caller of ${fnName} supplies parameter '${expressionName(param.name)}'`);
      if (param.initializer) {
        return union([this.ev.eval(param.initializer), uncalled]);
      }
      return uncalled;
    }
    const combined = union(values);
    if (param.initializer) {
      return withDefaultInitializer(
        combined,
        () => this.ev.eval(param.initializer!),
        (v) => this.ev.force(v),
      );
    }
    return combined;
  }

  /** Values passed for parameter `index` of a function, from every place the function is invoked. */
  argumentsFor(fn: FunctionLike, index: number): AVal[] {
    const out: AVal[] = [];
    // A function expression passed directly as an argument: `onAuthStateChanged(auth, (u) => ...)`.
    let host: ts.Node = fn;
    while (ts.isParenthesizedExpression(host.parent)) host = host.parent;
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isCallExpression(host.parent)) {
      const call = host.parent;
      const argIndex = call.arguments.indexOf(host as ts.Expression);
      if (argIndex >= 0) out.push(this.callbackArgument(call, argIndex, index));
      return out;
    }
    for (const sym of this.callableSymbols(fn)) out.push(...this.valuesPassedToCallable(sym, index));
    return out;
  }

  /** The symbols through which a function is referenced: its name, the variable or property holding it, its class for constructors. */
  private callableSymbols(fn: FunctionLike): ts.Symbol[] {
    const out: ts.Symbol[] = [];
    const add = (n: ts.Node | undefined): void => {
      if (!n) return;
      const s = this.ev.checker.getSymbolAtLocation(n);
      if (s) out.push(s);
    };
    if (ts.isConstructorDeclaration(fn)) {
      add(fn.parent.name);
    } else if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) {
      add(fn.name);
    } else if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      let host: ts.Node = fn;
      while (ts.isParenthesizedExpression(host.parent) || ts.isAsExpression(host.parent) || ts.isSatisfiesExpression(host.parent)) host = host.parent;
      const p = host.parent;
      if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) add(p.name);
      else if (ts.isCallExpression(p) && ts.isVariableDeclaration(p.parent)) {
        // `const f = useCallback((x) => ..., deps)`, `const C = memo((props) => ...)`.
        add(p.parent.name);
      }
    }
    return out;
  }

  /** Values passed as argument `index` wherever the callable symbol is called, rendered, or handed on as a callback. */
  valuesPassedToCallable(sym: ts.Symbol, index: number): AVal[] {
    const out: AVal[] = [];
    for (const use of this.ev.refs.usesOfCallable(sym)) {
      if (use.kind === 'call') {
        const args = use.call.arguments ?? ts.factory.createNodeArray();
        const arg = args[index];
        if (!arg) out.push({ k: 'undefined' });
        else if (ts.isSpreadElement(arg)) out.push(unknown('spread argument'));
        else out.push(this.ev.eval(arg));
      } else if (use.kind === 'jsx') {
        out.push(index === 0 ? this.jsxProps(use.element) : { k: 'undefined' });
      } else {
        out.push(this.callbackArgument(use.call, use.argIndex, index));
      }
    }
    return out;
  }

  /** The value a callback receives as parameter `paramIndex`, when passed as argument `argIndex` of `call`. */
  private callbackArgument(call: ts.CallExpression, argIndex: number, paramIndex: number): AVal {
    const viaMember = memberCallbackParameter(this.ev, call, argIndex, paramIndex);
    if (viaMember !== undefined) return viaMember;
    const callee = this.ev.force(this.ev.eval(call.expression));
    const out: AVal[] = [];
    for (const c of alternatives(callee)) {
      if (c.k === 'api') out.push(apiCallbackParameter(this.ev, c, paramIndex));
      else if (c.k === 'fn') {
        const p = c.decl.parameters[argIndex];
        if (!p || !ts.isIdentifier(p.name)) {
          out.push(unknown(`callback parameter of ${functionName(c.decl)} not traced`));
          continue;
        }
        const pSym = this.ev.checker.getSymbolAtLocation(p.name);
        const vals = pSym ? this.valuesPassedToCallable(pSym, paramIndex) : [];
        out.push(vals.length > 0 ? union(vals) : unknown(`${functionName(c.decl)} never calls its callback '${p.name.text}'`));
      } else if (c.k === 'unknown') {
        out.push(unknown(`callback argument of ${expressionName(call.expression)}(): ${c.reason}`));
      }
    }
    return union(out);
  }

  private jsxProps(el: ts.JsxOpeningLikeElement): AVal {
    const props = new Map<string, AVal>();
    let open = false;
    for (const attr of el.attributes.properties) {
      if (ts.isJsxAttribute(attr)) {
        const name = ts.isIdentifier(attr.name) ? attr.name.text : attr.name.getText();
        const init = attr.initializer;
        if (!init) props.set(name, { k: 'bool', value: true });
        else if (ts.isStringLiteral(init)) props.set(name, { k: 'str', parts: [{ kind: 'lit', text: init.text }] });
        else if (ts.isJsxExpression(init) && init.expression) props.set(name, this.ev.eval(init.expression));
      } else {
        open = true;
      }
    }
    return { k: 'obj', props, computed: [], open, optional: new Set() };
  }


  /** Values of a React context: its default and every `<Ctx.Provider value>` in the project. */
  contextValue(ctxExpr: ts.Expression | undefined): AVal {
    if (!ctxExpr || !ts.isIdentifier(ctxExpr)) return unknown('context argument not traced');
    const sym0 = this.ev.refs.symbolOf(ctxExpr);
    const sym = sym0 ? this.ev.refs.resolveAlias(sym0) : undefined;
    if (!sym) return unknown(`context '${ctxExpr.text}' not traced`);
    const values: AVal[] = [];
    const decl = sym.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isCallExpression(decl.initializer) && decl.initializer.arguments[0]) {
      values.push(this.ev.eval(decl.initializer.arguments[0]));
    }
    for (const id of this.ev.refs.referencesOf(sym)) {
      let tag: ts.Node = id;
      if (ts.isPropertyAccessExpression(id.parent) && id.parent.expression === id && id.parent.name.text === 'Provider') tag = id.parent;
      const el = tag.parent;
      if ((ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el)) && el.tagName === tag) {
        const props = this.jsxProps(el);
        if (props.k === 'obj' && props.props.has('value')) values.push(props.props.get('value')!);
      }
    }
    if (values.length === 0) return unknown(`no provider value for context '${ctxExpr.text}'`);
    return union(values);
  }
}
