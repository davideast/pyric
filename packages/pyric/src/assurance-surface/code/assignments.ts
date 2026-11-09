/**
 * Declaration, reassignment, property-mutation, destructuring, and React
 * `useState` resolution for the abstract evaluator.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { applyObjectLoopAssignments, findEnclosingObjectLoop, mergeProp, type ObjectLoopSpec } from './loop-unroller.js';
import { hole } from './paths.js';
import { propertyNameText } from './references.js';
import {
  combineAssignmentValue,
  evalWithBinding,
  identifierSequentialValue,
  trySequentialReassignments,
} from './sequential-assignments.js';
import {
  alternatives,
  literalText,
  union,
  unknown,
  withDefaultInitializer,
  type AVal,
  type Env,
} from './values.js';

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
    const flowed = trySequentialReassignments(this.ev, sym, decl, assigns, initial, env);
    if (flowed !== undefined) return flowed;
    const declFn = ts.findAncestor(decl, ts.isFunctionLike);
    let cur = initial;
    for (const a of assigns) {
      const rhsVal = this.pathInto(evalWithBinding(this.ev, sym, cur, a.rhs, env), a.path);
      const stmtParent = a.binary.parent;
      let isTopLevelStmt = false;
      if (a.path.length === 0 && ts.isExpressionStatement(stmtParent)) {
        if (declFn) isTopLevelStmt = stmtParent.parent === (declFn as FunctionLike).body;
        else isTopLevelStmt = ts.isSourceFile(stmtParent.parent);
      }
      cur = combineAssignmentValue(this.ev, cur, rhsVal, a.operator, isTopLevelStmt);
    }
    return cur;
  }

  private initialValueForSequential(
    decl: ts.Declaration,
    env: Env | undefined,
    paramInitial: AVal | undefined,
  ): AVal | undefined {
    if (paramInitial !== undefined) return paramInitial;
    if (ts.isParameter(decl)) return this.ev.callers.parameterValue(decl);
    if (ts.isVariableDeclaration(decl)) {
      const list = decl.parent;
      if ((list.flags & ts.NodeFlags.Const) !== 0) return undefined;
      const loop = list.parent;
      if (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) return undefined;
      if (decl.initializer) return this.ev.eval(decl.initializer, env);
      return { k: 'undefined' };
    }
    if (ts.isBindingElement(decl)) return this.initialBindingElementValue(decl, env);
    return undefined;
  }

  identifierValue(
    sym: ts.Symbol,
    id: ts.Identifier,
    env: Env | undefined,
    paramInitial?: AVal,
  ): AVal | undefined {
    return identifierSequentialValue(this.ev, sym, id, env, (decl) =>
      this.initialValueForSequential(decl, env, paramInitial),
    );
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
      const assigns = this.ev.refs.assignmentsTo(sym);
      if (!isConst && assigns.length > 0) {
        const flowed = trySequentialReassignments(this.ev, sym, decl, assigns, { k: 'undefined' }, env);
        if (flowed !== undefined) values.push(flowed);
      }
      if (values.length === 0) {
        for (const a of assigns) values.push(this.pathInto(this.ev.eval(a.rhs, env), a.path));
      }
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

  private initialBindingElementValue(be: ts.BindingElement, env: Env | undefined): AVal {
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
    const forcedSource = this.ev.force(source);
    let v: AVal;
    let isOptionalProp = false;
    if (typeof key === 'number') {
      v = this.ev.members.indexOf(forcedSource, key);
    } else {
      v = this.ev.members.memberOf(forcedSource, key, undefined);
      isOptionalProp = alternatives(forcedSource).some(
        (a) => a.k === 'obj' && a.optional.has(key),
      );
    }
    if (be.initializer) {
      v = withDefaultInitializer(
        v,
        () => this.ev.eval(be.initializer!, env),
        (val) => this.ev.force(val),
        isOptionalProp,
      );
    }
    return v;
  }

  bindingElementValue(be: ts.BindingElement, env: Env | undefined): AVal {
    let v = this.initialBindingElementValue(be, env);
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
      if (first.k === 'fn') {
        values.push(this.ev.callFunction(first, []));
      } else {
        values.push(first);
      }
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

  bindName(name: ts.BindingName, v: AVal, bindings: Map<ts.Symbol, AVal>, env?: Env): void {
    if (ts.isIdentifier(name)) {
      const sym = this.ev.checker.getSymbolAtLocation(name);
      if (sym) bindings.set(sym, v);
      return;
    }
    const forcedSource = this.ev.force(v);
    name.elements.forEach((el, i) => {
      if (ts.isOmittedExpression(el)) return;
      let member: AVal;
      let isOptionalProp = false;
      if (ts.isArrayBindingPattern(name)) {
        member = this.ev.members.indexOf(forcedSource, i);
      } else {
        const keyNode = el.propertyName ?? el.name;
        let key: string | undefined;
        if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode)) key = keyNode.text;
        if (key === undefined || el.dotDotDotToken) {
          member = unknown('computed destructuring key');
        } else {
          member = this.ev.members.memberOf(forcedSource, key, undefined);
          isOptionalProp = alternatives(forcedSource).some(
            (a) => a.k === 'obj' && a.optional.has(key),
          );
        }
      }
      if (el.initializer) {
        member = withDefaultInitializer(
          member,
          () => this.ev.eval(el.initializer!, env),
          (val) => this.ev.force(val),
          isOptionalProp,
        );
      }
      this.bindName(el.name, member, bindings, env);
    });
  }
}
