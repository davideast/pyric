/**
 * Lexical function-scope substitution, inlining, and document-dependence
 * classifiers for Firestore `list` query proofs.
 */
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import {
  getFunctionScope,
  getValidFunctionLexicalScope,
  type FunctionScopeBindings,
} from './match-resolution.js';

export function lexicalCaptureLiteralBindings(
  fn: FunctionDef,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
): Map<string, Expression> {
  const bindings = new Map<string, Expression>();
  const scope = functionScopes?.get(fn);
  if (!scope) return bindings;
  const candSet = new Set(scope.candidateVariables);
  const recSet = new Set(scope.recursiveVariables);
  const declaredCaptures = getFunctionScope(fn)?.captures;
  for (const [k, v] of Object.entries(scope.pathVariables)) {
    if (declaredCaptures && !declaredCaptures.has(k)) continue;
    if (!candSet.has(k)) {
      if (recSet.has(k)) {
        const segments = v.split('/').filter(Boolean);
        bindings.set(k, { type: 'pathLiteral', raw: `/${segments.join('/')}`, segments });
      } else {
        bindings.set(k, { type: 'literal', value: v, raw: JSON.stringify(v) });
      }
    }
  }
  return bindings;
}

function memberStep(
  expr: Expression,
): { object: Expression; property: string } | null {
  if (expr.type === 'memberAccess') {
    return { object: expr.object, property: expr.property };
  }
  if (
    expr.type === 'bracketAccess' &&
    expr.index.type === 'literal' &&
    typeof expr.index.value === 'string'
  ) {
    return { object: expr.object, property: expr.index.value };
  }
  return null;
}

export function isResourceData(expr: Expression): boolean {
  const step = memberStep(expr);
  if (!step || step.property !== 'data') return false;
  return step.object.type === 'identifier' && step.object.name === 'resource';
}

/**
 * If `expr` is a single-segment `resource.data.<field>` or `resource.data['<field>']`
 * access (including `resource['data']`), return `<field>`; otherwise null.
 */
export function dataFieldPath(expr: Expression): string | null {
  const step = memberStep(expr);
  if (!step || step.property.length === 0 || step.property.includes('.')) {
    return null;
  }
  if (!isResourceData(step.object)) return null;
  return step.property;
}

/** True for `request.auth.uid` (dot or bracket access). */
export function isRequestAuthUid(expr: Expression): boolean {
  const uidStep = memberStep(expr);
  if (!uidStep || uidStep.property !== 'uid') return false;
  const authStep = memberStep(uidStep.object);
  if (!authStep || authStep.property !== 'auth') return false;
  return authStep.object.type === 'identifier' && authStep.object.name === 'request';
}

/**
 * Return a copy of `expr` with every free `identifier` whose name is a key in
 * `bindings` replaced by the bound expression. Used to inline a function body:
 * its parameters and `let` names are identifiers, and this substitutes the
 * call's argument expressions for them. Pure structural map; the shared AST is
 * never mutated.
 */
export function substituteIdentifiers(
  expr: Expression,
  bindings: ReadonlyMap<string, Expression>,
): Expression {
  const sub = (e: Expression): Expression => {
    switch (e.type) {
      case 'identifier':
        return bindings.get(e.name) ?? e;
      case 'literal':
        return e;
      case 'memberAccess':
        return { ...e, object: sub(e.object) };
      case 'methodCall':
        return { ...e, object: sub(e.object), args: e.args.map(sub) };
      case 'bracketAccess':
        return { ...e, object: sub(e.object), index: sub(e.index) };
      case 'sliceAccess':
        return { ...e, object: sub(e.object), start: sub(e.start), end: sub(e.end) };
      case 'binaryOp':
        return { ...e, left: sub(e.left), right: sub(e.right) };
      case 'unaryOp':
        return { ...e, operand: sub(e.operand) };
      case 'ternary':
        return {
          ...e,
          condition: sub(e.condition),
          consequent: sub(e.consequent),
          alternate: sub(e.alternate),
        };
      case 'inExpr':
        return { ...e, element: sub(e.element), collection: sub(e.collection) };
      case 'isExpr':
        return { ...e, value: sub(e.value) };
      case 'listLiteral':
        return { ...e, elements: e.elements.map(sub) };
      case 'mapLiteral':
        return {
          ...e,
          entries: e.entries.map((en) => ({ key: sub(en.key), value: sub(en.value) })),
        };
      case 'pathLiteral':
        return {
          ...e,
          segments: e.segments.map((s) => {
            if (typeof s === 'string') return s;
            return sub(s);
          }),
        };
      case 'functionCall':
        return { ...e, args: e.args.map(sub) };
    }
  };
  return sub(expr);
}

export function inlineFunctionsInExpr(
  expr: Expression,
  functions: ReadonlyMap<string, FunctionDef>,
  visiting: ReadonlySet<FunctionDef> = new Set(),
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
): Expression | null {
  let budget = 500;
  const inline = (
    e: Expression,
    currentFunctions: ReadonlyMap<string, FunctionDef>,
    seen: ReadonlySet<FunctionDef>,
  ): Expression | null => {
    if (--budget < 0) return null;
    if (e.type === 'functionCall' && currentFunctions.has(e.name)) {
      const fn = currentFunctions.get(e.name)!;
      if (seen.has(fn)) return null;
      if (fn.parameters.length !== e.args.length) return null;
      const nextFunctions = getValidFunctionLexicalScope(fn, currentFunctions);
      if (!nextFunctions) return null;
      const bindings = lexicalCaptureLiteralBindings(fn, functionScopes);
      for (let i = 0; i < fn.parameters.length; i++) {
        const inlinedArg = inline(e.args[i]!, currentFunctions, seen);
        if (!inlinedArg) return null;
        bindings.set(fn.parameters[i]!, inlinedArg);
      }
      const nextSeen = new Set(seen).add(fn);
      for (const b of fn.lets) {
        const inlinedLet = inline(substituteIdentifiers(b.value, bindings), nextFunctions, nextSeen);
        if (!inlinedLet) return null;
        bindings.set(b.name, inlinedLet);
      }
      return inline(substituteIdentifiers(fn.body, bindings), nextFunctions, nextSeen);
    }
    switch (e.type) {
      case 'literal':
      case 'identifier':
        return e;
      case 'memberAccess': {
        const object = inline(e.object, currentFunctions, seen);
        if (!object) return null;
        return { ...e, object };
      }
      case 'bracketAccess': {
        const object = inline(e.object, currentFunctions, seen);
        const index = inline(e.index, currentFunctions, seen);
        if (!object || !index) return null;
        return { ...e, object, index };
      }
      case 'binaryOp': {
        const left = inline(e.left, currentFunctions, seen);
        const right = inline(e.right, currentFunctions, seen);
        if (!left || !right) return null;
        return { ...e, left, right };
      }
      case 'unaryOp': {
        const operand = inline(e.operand, currentFunctions, seen);
        if (!operand) return null;
        return { ...e, operand };
      }
      case 'sliceAccess': {
        const object = inline(e.object, currentFunctions, seen);
        const start = inline(e.start, currentFunctions, seen);
        const end = inline(e.end, currentFunctions, seen);
        if (!object || !start || !end) return null;
        return { ...e, object, start, end };
      }
      case 'ternary': {
        const condition = inline(e.condition, currentFunctions, seen);
        const consequent = inline(e.consequent, currentFunctions, seen);
        const alternate = inline(e.alternate, currentFunctions, seen);
        if (!condition || !consequent || !alternate) return null;
        return { ...e, condition, consequent, alternate };
      }
      case 'inExpr': {
        const element = inline(e.element, currentFunctions, seen);
        const collection = inline(e.collection, currentFunctions, seen);
        if (!element || !collection) return null;
        return { ...e, element, collection };
      }
      case 'isExpr': {
        const value = inline(e.value, currentFunctions, seen);
        if (!value) return null;
        return { ...e, value };
      }
      case 'listLiteral': {
        const elements: Expression[] = [];
        for (const el of e.elements) {
          const inlined = inline(el, currentFunctions, seen);
          if (!inlined) return null;
          elements.push(inlined);
        }
        return { ...e, elements };
      }
      case 'mapLiteral': {
        const entries: { key: Expression; value: Expression }[] = [];
        for (const entry of e.entries) {
          const key = inline(entry.key, currentFunctions, seen);
          const value = inline(entry.value, currentFunctions, seen);
          if (!key || !value) return null;
          entries.push({ key, value });
        }
        return { ...e, entries };
      }
      case 'pathLiteral': {
        const segments: (string | Expression)[] = [];
        for (const seg of e.segments) {
          if (typeof seg === 'string') {
            segments.push(seg);
          } else {
            const inlined = inline(seg, currentFunctions, seen);
            if (!inlined) return null;
            segments.push(inlined);
          }
        }
        return { ...e, segments };
      }
      case 'methodCall': {
        const object = inline(e.object, currentFunctions, seen);
        if (!object) return null;
        const args: Expression[] = [];
        for (const arg of e.args) {
          const inlined = inline(arg, currentFunctions, seen);
          if (!inlined) return null;
          args.push(inlined);
        }
        return { ...e, object, args };
      }
      case 'functionCall': {
        const args: Expression[] = [];
        for (const arg of e.args) {
          const inlined = inline(arg, currentFunctions, seen);
          if (!inlined) return null;
          args.push(inlined);
        }
        return { ...e, args };
      }
    }
  };
  return inline(expr, functions, visiting);
}

export function inlineIfNeeded(
  expr: Expression,
  functions: ReadonlyMap<string, FunctionDef>,
  visiting?: ReadonlySet<FunctionDef>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
): Expression | null {
  if (functions.size === 0) return expr;
  return inlineFunctionsInExpr(expr, functions, visiting, functionScopes);
}

export function callsResolveInOuterScope(
  expr: Expression,
  currentFunctions: ReadonlyMap<string, FunctionDef>,
  outerFunctions: ReadonlyMap<string, FunctionDef>,
): boolean {
  if (currentFunctions === outerFunctions) return true;
  const check = (e: Expression): boolean => {
    switch (e.type) {
      case 'literal':
      case 'identifier':
        return true;
      case 'unaryOp':
        return check(e.operand);
      case 'binaryOp':
        return check(e.left) && check(e.right);
      case 'ternary':
        return check(e.condition) && check(e.consequent) && check(e.alternate);
      case 'inExpr':
        return check(e.element) && check(e.collection);
      case 'isExpr':
        return check(e.value);
      case 'listLiteral':
        return e.elements.every(check);
      case 'mapLiteral':
        return e.entries.every((en) => check(en.key) && check(en.value));
      case 'memberAccess':
        return check(e.object);
      case 'bracketAccess':
        return check(e.object) && check(e.index);
      case 'sliceAccess':
        return check(e.object) && check(e.start) && check(e.end);
      case 'pathLiteral':
        return e.segments.every((s) => typeof s === 'string' || check(s));
      case 'methodCall':
        return check(e.object) && e.args.every(check);
      case 'functionCall':
        return (
          currentFunctions.get(e.name) === outerFunctions.get(e.name) &&
          e.args.every(check)
        );
    }
  };
  return check(expr);
}

/**
 * True if the expression depends on `resource.data` (the per-document data of
 * the candidate doc) directly or via an inlined user function.
 * `request.resource.data` (the write payload) is excluded.
 *
 * Polarity warning: this detector fails open, so it must only gate deny-safe
 * decisions. Anything that gates an allow must use {@link isProvablyDocIndependent}.
 */
export function referencesResourceData(
  expr: Expression,
  fnMap: ReadonlyMap<string, FunctionDef> = new Map(),
  visited: ReadonlySet<FunctionDef> = new Set(),
): boolean {
  const check = (e: Expression): boolean => {
    if (isResourceData(e)) return true;
    switch (e.type) {
      case 'memberAccess':
        return check(e.object);
      case 'bracketAccess':
        return check(e.object) || check(e.index);
      case 'functionCall': {
        const fn = fnMap.get(e.name);
        if (fn && !visited.has(fn)) {
          const nextVisited = new Set(visited).add(fn);
          const nextFnMap = getValidFunctionLexicalScope(fn, fnMap) ?? fnMap;
          if (referencesResourceData(fn.body, nextFnMap, nextVisited)) return true;
          if (fn.lets.some((b) => referencesResourceData(b.value, nextFnMap, nextVisited))) return true;
        }
        return e.args.some(check);
      }
      case 'binaryOp':
        return check(e.left) || check(e.right);
      case 'unaryOp':
        return check(e.operand);
      case 'methodCall':
        return check(e.object) || e.args.some(check);
      case 'ternary':
        return check(e.condition) || check(e.consequent) || check(e.alternate);
      case 'inExpr':
        return check(e.element) || check(e.collection);
      case 'isExpr':
        return check(e.value);
      case 'listLiteral':
        return e.elements.some(check);
      case 'mapLiteral':
        return e.entries.some((en) => check(en.key) || check(en.value));
      default:
        return false;
    }
  };
  return check(expr);
}

/**
 * Fail-closed doc-independence classifier and the only check allowed to gate an allow.
 * Returns true only for expressions positively known not to depend on the candidate doc.
 */
export function isProvablyDocIndependent(
  expr: Expression,
  fnMap: ReadonlyMap<string, FunctionDef> = new Map(),
  visited: ReadonlySet<FunctionDef> = new Set(),
): boolean {
  const safe = (e: Expression): boolean => {
    switch (e.type) {
      case 'literal':
        return true;
      case 'identifier':
        return e.name !== 'resource';
      case 'memberAccess':
        return safe(e.object);
      case 'bracketAccess':
        return safe(e.object) && safe(e.index);
      case 'sliceAccess':
        return safe(e.object) && safe(e.start) && safe(e.end);
      case 'binaryOp':
        return safe(e.left) && safe(e.right);
      case 'unaryOp':
        return safe(e.operand);
      case 'ternary':
        return safe(e.condition) && safe(e.consequent) && safe(e.alternate);
      case 'inExpr':
        return safe(e.element) && safe(e.collection);
      case 'isExpr':
        return safe(e.value);
      case 'listLiteral':
        return e.elements.every(safe);
      case 'mapLiteral':
        return e.entries.every((en) => safe(en.key) && safe(en.value));
      case 'pathLiteral':
        return e.segments.every((s) => typeof s === 'string' || safe(s));
      case 'methodCall':
        return safe(e.object) && e.args.every(safe);
      case 'functionCall': {
        if (!e.args.every(safe)) return false;
        const fn = fnMap.get(e.name);
        if (!fn) return true;
        if (visited.has(fn)) return false;
        const nextFnMap = getValidFunctionLexicalScope(fn, fnMap);
        if (!nextFnMap) return false;
        const nextVisited = new Set(visited).add(fn);
        const bindings = new Map<string, Expression>();
        fn.parameters.forEach((p, i) => {
          const arg = e.args[i];
          if (arg) bindings.set(p, arg);
        });
        for (const b of fn.lets) {
          const bound = substituteIdentifiers(b.value, bindings);
          if (!isProvablyDocIndependent(bound, nextFnMap, nextVisited)) return false;
          bindings.set(b.name, bound);
        }
        return isProvablyDocIndependent(
          substituteIdentifiers(fn.body, bindings),
          nextFnMap,
          nextVisited,
        );
      }
      default:
        return false;
    }
  };
  return safe(expr);
}
