/**
 * Declaration, reassignment, property-mutation, destructuring, and React
 * `useState` resolution for the abstract evaluator.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { applyObjectLoopAssignments, findEnclosingObjectLoop, mergeProp, type ObjectLoopSpec } from './loop-unroller.js';
import { hole } from './paths.js';
import { propertyNameText } from './references.js';
import { alternatives, definiteTruthiness, literalText, union, unknown, type AVal, type Env } from './values.js';

type FunctionLike = ts.SignatureDeclaration & { body?: ts.ConciseBody };

function resolveBindingKey(be: ts.BindingElement, pattern: ts.BindingPattern): string | number | undefined {
  if (!ts.isObjectBindingPattern(pattern)) return pattern.elements.indexOf(be);
  if (be.dotDotDotToken) return undefined;
  if (be.propertyName) {
    if (ts.isIdentifier(be.propertyName) || ts.isStringLiteral(be.propertyName)) return be.propertyName.text;
    if (ts.isComputedPropertyName(be.propertyName)) return undefined;
    return propertyNameText(be.propertyName);
  }
  if (ts.isIdentifier(be.name)) return be.name.text;
  return undefined;
}

export class AssignmentResolver {
  constructor(private readonly ev: Evaluator) {}

  declarationValue(sym: ts.Symbol, decl: ts.Declaration, env: Env | undefined): AVal {
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) return this.variableValue(sym, decl, env);
    if (ts.isBindingElement(decl)) return this.bindingElementValue(decl, env);
    if (ts.isParameter(decl)) return this.applyReassignments(sym, decl, this.ev.callers.parameterValue(decl), env);
    if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) return { k: 'fn', decl, env };
    if (ts.isClassDeclaration(decl)) return { k: 'class', decl };
    if (ts.isPropertyAssignment(decl)) return this.ev.eval(decl.initializer, env);
    if (ts.isShorthandPropertyAssignment(decl)) return this.ev.eval(decl.name, env);
    if (ts.isPropertyDeclaration(decl) || ts.isGetAccessorDeclaration(decl)) return this.ev.members.classMemberValue(sym);
    if (ts.isEnumMember(decl)) {
      const c = this.ev.checker.getConstantValue(decl);
      if (typeof c === 'string') return { k: 'str', parts: [{ kind: 'lit', text: c }] };
      if (typeof c === 'number') return { k: 'num', value: c };
      return unknown(`enum member '${sym.name}' has no constant value`);
    }
    return unknown(`'${sym.name}' (${ts.SyntaxKind[decl.kind]}) is not traced`);
  }

  applyReassignments(sym: ts.Symbol, decl: ts.Declaration, initial: AVal, env: Env | undefined): AVal {
    const assigns = this.ev.refs.assignmentsTo(sym);
    if (assigns.length === 0) return initial;
    const declFn = ts.findAncestor(decl, ts.isFunctionLike);
    let cur = initial;
    for (const a of assigns) {
      const rhsVal = this.pathInto(this.ev.eval(a.rhs, env), a.path);
      const stmtParent = a.binary.parent;
      let isTopLevelStmt = false;
      if (a.path.length === 0 && ts.isExpressionStatement(stmtParent)) {
        if (declFn) isTopLevelStmt = stmtParent.parent === (declFn as FunctionLike).body;
        else isTopLevelStmt = ts.isSourceFile(stmtParent.parent);
      }
      if (isTopLevelStmt && a.operator === ts.SyntaxKind.BarBarEqualsToken) {
        const kept = alternatives(this.ev.force(cur)).filter((alt) => definiteTruthiness(alt) !== false);
        cur = union([...kept, rhsVal]);
      } else if (isTopLevelStmt && a.operator === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        const kept = alternatives(this.ev.force(cur)).filter((alt) => alt.k !== 'null' && alt.k !== 'undefined');
        cur = union([...kept, rhsVal]);
      } else {
        cur = union([cur, rhsVal]);
      }
    }
    return cur;
  }

  variableValue(sym: ts.Symbol, decl: ts.VariableDeclaration, env: Env | undefined): AVal {
    const values: AVal[] = [];
    const list = decl.parent;
    const loop = list.parent;
    if (ts.isForOfStatement(loop) && loop.initializer === list) {
      values.push(this.ev.members.elementOf(this.ev.eval(loop.expression, env)));
    } else if (ts.isForInStatement(loop) && loop.initializer === list) {
      values.push({ k: 'str', parts: [hole(sym.name)] });
    } else if (decl.initializer) {
      values.push(this.ev.eval(decl.initializer, env));
    }
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    if (!decl.initializer) {
      for (const a of this.ev.refs.assignmentsTo(sym)) values.push(this.pathInto(this.ev.eval(a.rhs, env), a.path));
    }
    if (values.length === 0) return unknown(`'${sym.name}' is declared without a value`);
    let v = union(values);
    if (!isConst && decl.initializer) v = this.applyReassignments(sym, decl, v, env);
    const extra = this.ev.refs.propertyAssignments(sym);
    if (extra.length > 0) v = this.withPropertyAssignments(v, extra, env);
    const elementAssignments = this.ev.refs.keyedElementAssignments(sym);
    if (elementAssignments.length > 0) v = this.applyKeyedElementAssignments(sym, decl, v, elementAssignments, env);
    return v;
  }

  private applyKeyedElementAssignments(
    sym: ts.Symbol,
    decl: ts.VariableDeclaration,
    baseVal: AVal,
    elementAssignments: { key: ts.Expression; rhs: ts.Expression }[],
    env: Env | undefined,
  ): AVal {
    const direct: { key: ts.Expression; rhs: ts.Expression }[] = [];
    const loopSpecs = new Map<ts.Node, ObjectLoopSpec>();
    for (const ea of elementAssignments) {
      const spec = findEnclosingObjectLoop(ea.rhs, decl);
      if (spec) {
        if (!loopSpecs.has(spec.loop)) loopSpecs.set(spec.loop, spec);
      } else {
        direct.push(ea);
      }
    }
    let v = baseVal;
    if (direct.length > 0) {
      v = union(
        alternatives(v).map((a) => {
          if (a.k !== 'obj') return a;
          return { ...a, props: this.evalObjectElementAssignments(direct, a.props, env) };
        }),
      );
    }
    for (const spec of loopSpecs.values()) {
      v = applyObjectLoopAssignments(this.ev, (n, val, b) => this.bindName(n, val, b), sym, v, spec, env);
    }
    return v;
  }

  private evalObjectElementAssignments(
    elementAssignments: { key: ts.Expression; rhs: ts.Expression }[],
    initialProps: Map<string, AVal>,
    env: Env | undefined,
  ): Map<string, AVal> {
    const props = new Map(initialProps);
    const byKey = new Map<string, AVal[]>();
    for (const { key, rhs } of elementAssignments) {
      const keyText = literalText(this.ev.force(this.ev.eval(key, env)));
      if (keyText !== null) {
        const arr = byKey.get(keyText) ?? [];
        arr.push(this.ev.eval(rhs, env));
        byKey.set(keyText, arr);
      }
    }
    for (const [keyText, writes] of byKey) {
      if (props.has(keyText)) writes.push(props.get(keyText)!);
      props.set(keyText, union(writes));
    }
    return props;
  }

  private withPropertyAssignments(v: AVal, extra: { name: string; rhs: ts.Expression }[], env: Env | undefined): AVal {
    return union(
      alternatives(v).map((alt) => {
        if (alt.k === 'fn') {
          const props = new Map(alt.props);
          for (const e of extra) mergeProp(props, e.name, this.ev.eval(e.rhs, env));
          return { ...alt, props };
        }
        if (alt.k !== 'obj') return alt;
        const props = new Map(alt.props);
        const optional = new Set(alt.optional);
        for (const e of extra) {
          mergeProp(props, e.name, this.ev.eval(e.rhs, env));
          if (!alt.props.has(e.name)) optional.add(e.name);
        }
        return { ...alt, props, optional };
      }),
    );
  }

  pathInto(v: AVal, path: (string | number)[]): AVal {
    let cur = v;
    for (const key of path) {
      if (typeof key === 'number') cur = this.ev.members.indexOf(cur, key);
      else cur = this.ev.members.memberOf(cur, key, undefined);
    }
    return cur;
  }

  bindingElementValue(be: ts.BindingElement, env: Env | undefined): AVal {
    const pattern = be.parent;
    const root = pattern.parent;
    if (ts.isObjectBindingPattern(pattern) && be.dotDotDotToken) return unknown('rest element');
    const key = resolveBindingKey(be, pattern);
    if (key === undefined) return unknown('computed destructuring key');

    let source: AVal;
    if (ts.isVariableDeclaration(root)) {
      if (ts.isArrayBindingPattern(pattern) && root.initializer && typeof key === 'number') {
        const state = this.reactStateBinding(root.initializer, be, key, env);
        if (state) return state;
      }
      const loop = root.parent.parent;
      if (ts.isForOfStatement(loop) && loop.initializer === root.parent) source = this.ev.members.elementOf(this.ev.eval(loop.expression, env));
      else if (root.initializer) source = this.ev.eval(root.initializer, env);
      else return unknown('destructured declaration without a value');
    } else if (ts.isParameter(root)) {
      source = this.ev.callers.parameterValue(root);
    } else if (ts.isBindingElement(root)) {
      source = this.bindingElementValue(root, env);
    } else {
      return unknown('destructuring source not traced');
    }
    let v = typeof key === 'number' ? this.ev.members.indexOf(source, key) : this.ev.members.memberOf(source, key, undefined);
    if (be.initializer) v = union([v, this.ev.eval(be.initializer, env)]);
    if (ts.isIdentifier(be.name)) {
      const sym = this.ev.checker.getSymbolAtLocation(be.name);
      if (sym) v = this.applyReassignments(sym, be, v, env);
    }
    return v;
  }

  private reactStateBinding(init: ts.Expression, be: ts.BindingElement, index: number, env: Env | undefined): AVal | undefined {
    if (!ts.isCallExpression(init)) return undefined;
    const callee = this.ev.force(this.ev.eval(init.expression, env));
    if (callee.k !== 'api' || callee.module !== 'react' || (callee.name !== 'useState' && callee.name !== 'useReducer')) return undefined;
    if (callee.name === 'useReducer' || index !== 0) return unknown('React state setter');
    const values: AVal[] = [];
    if (init.arguments[0]) {
      const first = this.ev.force(this.ev.eval(init.arguments[0], env));
      values.push(first.k === 'fn' ? this.ev.callFunction(first, []) : first);
    } else {
      values.push({ k: 'undefined' });
    }
    const pattern = be.parent as ts.ArrayBindingPattern;
    const setter = pattern.elements[1];
    if (setter && ts.isBindingElement(setter) && ts.isIdentifier(setter.name)) {
      const setterSym = this.ev.checker.getSymbolAtLocation(setter.name);
      if (setterSym) values.push(...this.ev.callers.valuesPassedToCallable(setterSym, 0));
    }
    return union(values);
  }

  bindName(name: ts.BindingName, v: AVal, bindings: Map<ts.Symbol, AVal>): void {
    if (ts.isIdentifier(name)) {
      const sym = this.ev.checker.getSymbolAtLocation(name);
      if (sym) bindings.set(sym, v);
      return;
    }
    name.elements.forEach((el, i) => {
      if (ts.isOmittedExpression(el)) return;
      let member: AVal;
      if (ts.isArrayBindingPattern(name)) {
        member = this.ev.members.indexOf(v, i);
      } else {
        const keyNode = el.propertyName ?? el.name;
        let key: string | undefined;
        if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode)) key = keyNode.text;
        if (key === undefined || el.dotDotDotToken) member = unknown('computed destructuring key');
        else member = this.ev.members.memberOf(v, key, undefined);
      }
      if (el.initializer) member = union([member, this.ev.eval(el.initializer)]);
      this.bindName(el.name, member, bindings);
    });
  }
}
