/**
 * Member access on abstract values: object fields, the signed-in user's
 * fields, ref ids and parents, class fields (initializer, constructor
 * parameter, and every assignment), and `x[k]` with a computed key.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { expressionName, hole } from './paths.js';
import { alternatives, literalText, NEVER, ownRecordValue, union, unknown, type AVal, type Env } from './values.js';

const AUTH_USER_FIELDS: Record<string, 'auth.uid' | 'auth.displayName' | 'auth.email' | 'auth.photoURL' | 'auth.phoneNumber'> = {
  uid: 'auth.uid',
  displayName: 'auth.displayName',
  email: 'auth.email',
  photoURL: 'auth.photoURL',
  phoneNumber: 'auth.phoneNumber',
};

export class MemberResolver {
  private readonly memberCache = new Map<ts.Symbol, AVal>();

  constructor(private readonly ev: Evaluator) {}

  evalMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, env: Env | undefined): AVal {
    const objVal = this.ev.eval(node.expression, env);
    if (ts.isPropertyAccessExpression(node)) return this.memberOf(objVal, node.name.text, node);
    const keyVal = this.ev.force(this.ev.eval(node.argumentExpression, env));
    const key = literalText(keyVal);
    if (key !== null) return this.memberOf(objVal, key, node);
    if (keyVal.k === 'num' && keyVal.value !== undefined) return this.indexOf(objVal, keyVal.value);
    return this.dynamicElement(node, objVal);
  }

  /** `x[k]` with a computed key: every value stored in x, including `x[k] = v` assignments. */
  private dynamicElement(node: ts.ElementAccessExpression, objVal: AVal): AVal {
    const values: AVal[] = [];
    for (const alt of alternatives(this.ev.force(objVal))) {
      if (alt.k === 'obj') values.push(...alt.props.values(), ...alt.computed.map((c) => c.value));
      else if (alt.k === 'arr') values.push(...alt.items);
    }
    const holder = node.expression;
    const nameNode = ts.isPropertyAccessExpression(holder) ? holder.name : holder;
    const sym = ts.isIdentifier(nameNode) ? this.ev.refs.symbolOf(nameNode) : undefined;
    if (sym) for (const rhs of this.ev.refs.elementAssignments(sym)) values.push(this.ev.eval(rhs));
    if (values.length === 0) return unknown(`element of '${expressionName(holder)}' with a computed key`);
    return union(values);
  }

  /** Member `name` of a value. `node` is the access expression, used to ask the checker about class members. */
  memberOf(v: AVal, name: string, node: ts.PropertyAccessExpression | ts.ElementAccessExpression | undefined): AVal {
    const out: AVal[] = [];
    for (const alt of alternatives(this.ev.force(v))) out.push(this.memberOfLeaf(alt, name, node));
    return union(out);
  }

  private memberOfLeaf(v: AVal, name: string, node: ts.PropertyAccessExpression | ts.ElementAccessExpression | undefined): AVal {
    switch (v.k) {
      case 'ns': {
        const out: Extract<AVal, { k: 'api' }> = { k: 'api', module: v.module, name };
        if (v.admin) out.admin = true;
        return out;
      }
      case 'api': {
        const out: Extract<AVal, { k: 'api' }> = { k: 'api', module: v.module, name: `${v.name}.${name}` };
        if (v.admin) out.admin = true;
        return out;
      }
      case 'auth':
        if (name === 'currentUser') return { k: 'authUser', exact: true };
        return unknown(`auth.${name}`);
      case 'credential':
        if (name === 'user') return { k: 'authUser', exact: true };
        return unknown(`credential.${name}`);
      case 'authUser': {
        const source = ownRecordValue(AUTH_USER_FIELDS, name);
        if (source) return { k: 'str', parts: [hole(name, [{ source, exact: v.exact }])] };
        return unknown(`user.${name}`);
      }
      case 'authTokenResult':
        if (name === 'claims') return { k: 'authClaims', exact: v.exact };
        return unknown(`idTokenResult.${name}`);
      case 'authClaims':
        return { k: 'str', parts: [hole(name, [{ source: `auth.token.${name}`, exact: v.exact }])] };
      case 'obj': {
        if (v.props.has(name)) return v.props.get(name)!;
        if (v.open || v.computed.length > 0) return unknown(`property '${name}' of an object with spread or computed keys`);
        return { k: 'undefined' };
      }
      case 'arr':
        if (name === 'length') return { k: 'num' };
        return unknown(`array.${name}`);
      case 'str':
        if (name === 'length') return { k: 'num' };
        return unknown(`string.${name}`);
      case 'null':
      case 'undefined':
        return NEVER;
      case 'ref':
        if (name === 'id' || name === 'key') {
          const last = v.segments[v.segments.length - 1];
          return last ? { k: 'str', parts: last } : unknown('id of a root ref');
        }
        if (name === 'parent') {
          if (v.service === 'firestore') {
            if (v.queryCall !== undefined || v.refKind === 'collectionGroup') {
              return unknown('ref.parent');
            }
            if (v.refKind === 'doc') {
              if (v.segments.length >= 2) {
                return { ...v, segments: v.segments.slice(0, -1), refKind: 'collection' };
              }
              if (v.segments.length === 1 && v.notes.length > 0) {
                return { ...v, refKind: 'collection' };
              }
              return { k: 'null' };
            }
            if (v.refKind === 'collection') {
              if (v.segments.length >= 2) {
                return { ...v, segments: v.segments.slice(0, -1), refKind: 'doc' };
              }
              if (v.segments.length === 1 && v.notes.length > 0) {
                return union([{ k: 'null' }, { ...v, refKind: 'doc' }]);
              }
              return { k: 'null' };
            }
            return unknown('ref.parent');
          }
          if (v.segments.length === 0) return { k: 'null' };
          return { ...v, segments: v.segments.slice(0, -1) };
        }
        return unknown(`ref.${name}`);
      case 'fn': {
        const own = this.functionProperty(v, name);
        if (own) return own;
        const viaChecker = this.classMemberFallback(node);
        return viaChecker ?? unknown(`member '${name}' not traced`);
      }
      case 'instance':
      case 'class':
      case 'unknown': {
        const viaChecker = this.classMemberFallback(node);
        if (viaChecker) return viaChecker;
        if (v.k === 'unknown') return v;
        return unknown(`member '${name}' not traced`);
      }
      default:
        return unknown(`member '${name}' of a ${v.k}`);
    }
  }

  /**
   * A property of a function value: one merged in with `Object.assign`, or
   * assigned onto the variable holding it (`const fn = () => ...; fn.sub = ...`),
   * evaluated in the function's closure so factory parameters stay bound.
   */
  private functionProperty(v: Extract<AVal, { k: 'fn' }>, name: string): AVal | undefined {
    const own = v.props?.get(name);
    if (own) return own;
    let host: ts.Node = v.decl;
    while (ts.isParenthesizedExpression(host.parent) || ts.isAsExpression(host.parent)) host = host.parent;
    const holder = host.parent;
    let nameNode: ts.DeclarationName | undefined;
    if (ts.isVariableDeclaration(holder)) nameNode = holder.name;
    else if (ts.isFunctionDeclaration(v.decl)) nameNode = v.decl.name;
    if (!nameNode || !ts.isIdentifier(nameNode)) return undefined;
    const sym = this.ev.checker.getSymbolAtLocation(nameNode);
    if (!sym) return undefined;
    const values = this.ev.refs.propertyAssignments(sym).filter((p) => p.name === name).map((p) => this.ev.eval(p.rhs, v.env));
    return values.length > 0 ? union(values) : undefined;
  }

  /** Ask the checker which in-project declaration a member access names, and evaluate it. */
  private classMemberFallback(node: ts.PropertyAccessExpression | ts.ElementAccessExpression | undefined): AVal | undefined {
    if (!node) return undefined;
    const nameNode = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
    const sym = this.ev.checker.getSymbolAtLocation(nameNode);
    if (!sym?.declarations?.length) return undefined;
    const valueDecl = sym.declarations.find(
      (d) =>
        ts.isPropertyDeclaration(d) ||
        ts.isPropertyAssignment(d) ||
        ts.isShorthandPropertyAssignment(d) ||
        ts.isMethodDeclaration(d) ||
        ts.isGetAccessorDeclaration(d) ||
        ts.isEnumMember(d) ||
        (ts.isParameter(d) && ts.isConstructorDeclaration(d.parent)),
    );
    if (!valueDecl) return undefined;
    if (ts.isPropertyAssignment(valueDecl)) return this.ev.eval(valueDecl.initializer);
    if (ts.isShorthandPropertyAssignment(valueDecl)) return this.ev.eval(valueDecl.name);
    if (ts.isEnumMember(valueDecl)) return this.ev.symbolValue(sym, undefined);
    return this.classMemberValue(sym);
  }

  /** A class member's values: its initializer, constructor parameter, and every assignment to it. */
  classMemberValue(sym: ts.Symbol): AVal {
    return this.ev.memo(this.memberCache, sym, () =>
      this.ev.guard(`m${this.ev.idOf(sym)}`, () => {
        const values: AVal[] = [];
        for (const d of sym.declarations ?? []) {
          if (ts.isPropertyDeclaration(d) && d.initializer) values.push(this.ev.eval(d.initializer));
          else if (ts.isParameter(d)) values.push(this.ev.callers.parameterValue(d));
          else if (ts.isMethodDeclaration(d)) values.push({ k: 'fn', decl: d, env: undefined });
          else if (ts.isGetAccessorDeclaration(d)) values.push(this.ev.returnsOf(d, undefined));
        }
        for (const a of this.ev.refs.assignmentsTo(sym)) values.push(this.ev.pathInto(this.ev.eval(a.rhs), a.path));
        if (values.length === 0) return unknown(`no value is ever assigned to '${sym.name}'`);
        return union(values);
      }),
    );
  }

  indexOf(v: AVal, index: number): AVal {
    const out: AVal[] = [];
    for (const alt of alternatives(this.ev.force(v))) {
      if (alt.k === 'arr') {
        if (alt.open) out.push(this.elementOf(alt), { k: 'undefined' });
        else out.push(alt.items[index] ?? { k: 'undefined' });
      } else if (alt.k === 'unknown') out.push(alt);
      else if (alt.k !== 'null' && alt.k !== 'undefined') out.push(unknown(`element ${index} of a ${alt.k}`));
    }
    return union(out);
  }

  elementOf(v: AVal): AVal {
    const out: AVal[] = [];
    for (const alt of alternatives(this.ev.force(v))) {
      if (alt.k === 'arr') out.push(...alt.items);
      else if (alt.k === 'unknown') out.push(unknown(`element of a collection: ${alt.reason}`));
      else out.push(unknown(`element of a ${alt.k}`));
    }
    return union(out);
  }
}
