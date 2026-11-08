/**
 * Results of common JavaScript built-ins, so values built with them keep
 * a kind and their auth provenance: `title.trim()` is still a string,
 * `String(user.uid)` is still the uid, `Date.now()` is a number.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { expressionName, hole } from './paths.js';
import { ReferenceIndex } from './references.js';
import { evalBinaryBuiltin } from './storage-upload.js';
import { alternatives, authMarksOf, concatParts, definiteTruthiness, lit, literalText, union, type AVal, type Env, type StrPart } from './values.js';

const MAX_OBJECT_ENTRIES = 25;

/** String methods whose result keeps the receiver's provenance. */
const PRESERVING_STRING_METHODS = new Set(['trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'toString', 'valueOf', 'normalize']);
/** Methods and functions that return some string. */
const STRING_RESULTS = new Set([
  'slice', 'substring', 'substr', 'replace', 'replaceAll', 'padStart', 'padEnd', 'join', 'randomUUID', 'toFixed',
  'stringify', 'toISOString', 'toLocaleTimeString', 'toLocaleDateString', 'toLocaleString', 'toDateString',
  'toTimeString', 'toJSON', 'concat', 'charAt', 'repeat', 'encodeURIComponent', 'encodeURI', 'btoa',
]);
const NUMBER_RESULTS = new Set(['now', 'random', 'floor', 'ceil', 'round', 'getTime', 'parseInt', 'parseFloat', 'max', 'min', 'abs', 'trunc']);
const BOOLEAN_RESULTS = new Set(['includes', 'startsWith', 'endsWith', 'some', 'every', 'has', 'isArray']);

/** Model a call whose callee is not in the project, or undefined when nothing is known. */
export function builtinCall(ev: Evaluator, node: ts.CallExpression | ts.NewExpression, env: Env | undefined): AVal | undefined {
  const callee = node.expression;
  const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
  if (ts.isIdentifier(callee)) {
    if (callee.text === 'String' && args[0]) {
      const v = ev.force(ev.eval(args[0], env));
      if (v.k === 'str') return v;
      return { k: 'str', parts: [hole(expressionName(args[0]), authMarksOf(v))] };
    }
    if (callee.text === 'Number') return { k: 'num' };
    if (callee.text === 'Boolean') {
      if (args[0]) {
        const t = definiteTruthiness(ev.force(ev.eval(args[0], env)));
        if (t !== undefined) return { k: 'bool', value: t };
      }
      return { k: 'bool' };
    }
    if (callee.text === 'Date' && ts.isNewExpression(node)) return { k: 'num' };
    const binary = evalBinaryBuiltin(ev, node, env);
    if (binary) return binary;
    if (STRING_RESULTS.has(callee.text)) return { k: 'str', parts: [hole(callee.text)] };
    if (NUMBER_RESULTS.has(callee.text)) return { k: 'num' };
    return undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  const encoded = evalBinaryBuiltin(ev, node, env);
  if (encoded) return encoded;
  if (method === 'getIdTokenResult') {
    const recvAlts = alternatives(ev.force(ev.eval(callee.expression, env)));
    const authUsers = recvAlts.filter((a): a is Extract<AVal, { k: 'authUser' }> => a.k === 'authUser');
    if (authUsers.length > 0) {
      const exact = authUsers.length === recvAlts.length && authUsers.every((u) => u.exact);
      return { k: 'authTokenResult', exact };
    }
  }
  if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Array' && method === 'isArray' && args[0]) {
    return arrayIsArray(ev, args[0], env);
  }
  if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Object') {
    if (method === 'assign' && args[0]) return objectAssign(ev, args, env);
    if ((method === 'entries' || method === 'keys' || method === 'values' || method === 'fromEntries') && args[0]) {
      const modeled = objectCollection(ev, method, args[0], env);
      if (modeled) return modeled;
    }
  }
  const folded = foldStringMethod(ev, node, callee, env) ?? arrayMethod(ev, node, callee, env) ?? mapGet(ev, node, callee, env);
  if (folded) return folded;
  if (PRESERVING_STRING_METHODS.has(method)) {
    const receiver = ev.force(ev.eval(callee.expression, env));
    if (receiver.k === 'str') {
      if (receiver.parts.every((p) => p.kind === 'lit') && method !== 'toLowerCase' && method !== 'toUpperCase') return receiver;
      return { k: 'str', parts: [hole(expressionName(callee.expression), authMarksOf(receiver))] };
    }
    // `x.trim()` is a string whatever x was traced to; it keeps x's provenance.
    return { k: 'str', parts: [hole(expressionName(callee.expression), authMarksOf(receiver))] };
  }
  if (STRING_RESULTS.has(method)) return { k: 'str', parts: [hole(method)] };
  if (NUMBER_RESULTS.has(method)) return { k: 'num' };
  if (BOOLEAN_RESULTS.has(method)) return { k: 'bool' };
  return undefined;
}

/** A character sequence no path or regex in app code will contain, used to stand in for holes. */
const MARK = '\u0000';

/**
 * Apply a pure string transform to a string with holes: holes become
 * placeholders, the transform runs on the text, and the placeholders
 * become holes again. Returns undefined when the transform touched a
 * placeholder (it depended on a hole's unknown text).
 */
function withPlaceholders(parts: StrPart[], transform: (text: string) => string): StrPart[] | undefined {
  const holes: StrPart[] = [];
  let text = '';
  for (const p of parts) {
    if (p.kind === 'lit') text += p.text;
    else {
      text += `${MARK}${holes.length}${MARK}`;
      holes.push(p);
    }
  }
  return fromPlaceholders(transform(text), holes);
}

function fromPlaceholders(text: string, holes: StrPart[]): StrPart[] | undefined {
  const pieces = text.split(new RegExp(`${MARK}(\\d+)${MARK}`));
  const out: StrPart[] = [];
  let expected = 0;
  for (let i = 0; i < pieces.length; i++) {
    if (i % 2 === 0) {
      if (pieces[i].includes(MARK)) return undefined;
      out.push({ kind: 'lit', text: pieces[i] });
    } else {
      if (Number(pieces[i]) !== expected) return undefined;
      out.push(holes[expected]);
      expected += 1;
    }
  }
  if (expected !== holes.length) return undefined;
  return concatParts(out);
}

/** A regex or string literal argument, as a matcher. */
function patternOf(ev: Evaluator, arg: ts.Expression | undefined, env: Env | undefined): RegExp | string | undefined {
  if (!arg) return undefined;
  if (ts.isRegularExpressionLiteral(arg)) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(arg.text);
    if (!m) return undefined;
    try {
      return new RegExp(m[1], m[2]);
    } catch {
      return undefined;
    }
  }
  return literalText(ev.force(ev.eval(arg, env))) ?? undefined;
}

/**
 * Fold pure string methods over strings with holes, so a path helper that
 * trims or collapses slashes keeps the caller's template:
 * `replace`/`replaceAll` with literal arguments, `trim*`, and `split`.
 */
function foldStringMethod(ev: Evaluator, node: ts.CallExpression | ts.NewExpression, callee: ts.PropertyAccessExpression, env: Env | undefined): AVal | undefined {
  const method = callee.name.text;
  if (!['replace', 'replaceAll', 'trim', 'trimStart', 'trimEnd', 'split'].includes(method)) return undefined;
  const receiver = ev.force(ev.eval(callee.expression, env));
  const strs = alternatives(receiver);
  if (strs.length === 0 || !strs.every((a) => a.k === 'str')) return undefined;
  const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
  const results: AVal[] = [];
  for (const a of strs) {
    if (a.k !== 'str') return undefined;
    let transformed: AVal | undefined;
    if (method === 'split') {
      const sep = patternOf(ev, args[0], env);
      if (sep === undefined) return undefined;
      transformed = splitParts(a.parts, sep);
    } else {
      let fn: ((t: string) => string) | undefined;
      if (method === 'trim') fn = (t) => t.trim();
      else if (method === 'trimStart') fn = (t) => t.trimStart();
      else if (method === 'trimEnd') fn = (t) => t.trimEnd();
      else {
        const pattern = patternOf(ev, args[0], env);
        const replacement = args[1] ? literalText(ev.force(ev.eval(args[1], env))) : null;
        if (pattern === undefined || replacement === null) return undefined;
        fn = method === 'replaceAll' ? (t) => t.replaceAll(pattern as string, replacement) : (t) => t.replace(pattern, replacement);
      }
      const parts = withPlaceholders(a.parts, fn);
      if (!parts) return undefined;
      transformed = { k: 'str', parts };
    }
    if (!transformed) return undefined;
    results.push(transformed);
  }
  return union(results);
}

function splitParts(parts: StrPart[], sep: RegExp | string): AVal | undefined {
  const holes: StrPart[] = [];
  let text = '';
  for (const p of parts) {
    if (p.kind === 'lit') text += p.text;
    else {
      text += `${MARK}${holes.length}${MARK}`;
      holes.push(p);
    }
  }
  const items: AVal[] = [];
  for (const piece of text.split(sep as string)) {
    const restored = restorePiece(piece, holes);
    if (!restored) return undefined;
    items.push({ k: 'str', parts: restored });
  }
  return { k: 'arr', items };
}

/** Restore the holes in one split piece (pieces hold a subsequence of the placeholders). */
function restorePiece(piece: string, holes: StrPart[]): StrPart[] | undefined {
  const out: StrPart[] = [];
  const re = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');
  let last = 0;
  for (let m = re.exec(piece); m; m = re.exec(piece)) {
    out.push({ kind: 'lit', text: piece.slice(last, m.index) });
    const h = holes[Number(m[1])];
    if (!h) return undefined;
    out.push(h);
    last = m.index + m[0].length;
  }
  const tail = piece.slice(last);
  if (tail.includes(MARK)) return undefined;
  out.push({ kind: 'lit', text: tail });
  return concatParts(out);
}

/** True when a filter callback keeps exactly the non-empty strings (`Boolean`, `(s) => s`, `(s) => s.length > 0`, `(s) => s !== ''`). */
function keepsNonEmpty(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  if (ts.isIdentifier(arg)) return arg.text === 'Boolean';
  if (!ts.isArrowFunction(arg) || arg.parameters.length !== 1 || !ts.isIdentifier(arg.parameters[0].name)) return false;
  const p = arg.parameters[0].name.text;
  const body = arg.body;
  const text = ts.isBlock(body) ? '' : body.getText().replace(/\s+/g, '');
  return [p, `!!${p}`, `${p}.length>0`, `${p}.length`, `${p}!==''`, `${p}!==""`, `${p}!=''`].includes(text);
}

/** `filter`, `map`, `join`, and `pop`/`at(-1)` over bounded arrays. */
function arrayMethod(ev: Evaluator, node: ts.CallExpression | ts.NewExpression, callee: ts.PropertyAccessExpression, env: Env | undefined): AVal | undefined {
  const method = callee.name.text;
  if (!['filter', 'map', 'join', 'pop', 'at'].includes(method)) return undefined;
  const receiver = ev.force(ev.eval(callee.expression, env));
  if (receiver.k !== 'arr') return undefined;
  const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
  if (method === 'filter') {
    if (keepsNonEmpty(args[0])) {
      return { k: 'arr', items: receiver.items.filter((i) => literalText(i) !== '') };
    }
    if (args[0] && receiver.items.length <= MAX_OBJECT_ENTRIES) {
      const cb = ev.force(ev.eval(args[0], env));
      const fnAlt = alternatives(cb).find((c): c is Extract<AVal, { k: 'fn' }> => c.k === 'fn');
      if (fnAlt) {
        const items: AVal[] = [];
        receiver.items.forEach((item, idx) => {
          const pred = ev.force(ev.callFunction(fnAlt, [item, { k: 'num', value: idx }, receiver]));
          if (definiteTruthiness(pred) !== false) items.push(item);
        });
        return { k: 'arr', items };
      }
    }
    return undefined;
  }
  if (method === 'map') {
    if (!args[0] || receiver.items.length > MAX_OBJECT_ENTRIES) return undefined;
    const cb = ev.force(ev.eval(args[0], env));
    const fnAlt = alternatives(cb).find((c): c is Extract<AVal, { k: 'fn' }> => c.k === 'fn');
    if (!fnAlt) return undefined;
    return {
      k: 'arr',
      items: receiver.items.map((item, idx) => ev.callFunction(fnAlt, [item, { k: 'num', value: idx }, receiver])),
    };
  }
  if (method === 'pop' || method === 'at') return receiver.items[receiver.items.length - 1] ?? { k: 'undefined' };
  const sep = args[0] ? literalText(ev.force(ev.eval(args[0], env))) : ',';
  if (sep === null || !receiver.items.every((i) => i.k === 'str')) return undefined;
  let parts: StrPart[] = [];
  receiver.items.forEach((item, i) => {
    if (item.k !== 'str') return;
    parts = concatParts(parts, i > 0 ? [{ kind: 'lit', text: sep }] : [], item.parts);
  });
  return { k: 'str', parts };
}

function arrayIsArray(ev: Evaluator, arg: ts.Expression, env: Env | undefined): AVal {
  const alts = alternatives(ev.force(ev.eval(arg, env)));
  if (alts.length === 0) return { k: 'bool' };
  if (alts.every((a) => a.k === 'arr')) return { k: 'bool', value: true };
  if (alts.every((a) => a.k !== 'arr' && a.k !== 'unknown')) return { k: 'bool', value: false };
  return { k: 'bool' };
}

function objectCollection(
  ev: Evaluator,
  method: 'entries' | 'keys' | 'values' | 'fromEntries',
  arg: ts.Expression,
  env: Env | undefined,
): AVal | undefined {
  const alts = alternatives(ev.force(ev.eval(arg, env)));
  if (alts.length === 0) return undefined;
  if (method === 'fromEntries') {
    const out: AVal[] = [];
    for (const a of alts) {
      if (a.k !== 'arr' || a.items.length > MAX_OBJECT_ENTRIES) return undefined;
      const props = new Map<string, AVal>();
      const computed: { key: AVal; value: AVal }[] = [];
      const optional = new Set<string>();
      let open = false;
      for (const item of a.items) {
        const entryAlts = alternatives(ev.force(item));
        if (entryAlts.length === 0) continue;
        if (entryAlts.every((ea) => ea.k === 'arr' && ea.items.length >= 2)) {
          const tuples = entryAlts as Extract<AVal, { k: 'arr' }>[];
          const key = ev.force(union(tuples.map((t) => t.items[0])));
          const val = union(tuples.map((t) => t.items[1]));
          const kText = literalText(key);
          if (kText !== null) {
            props.set(kText, props.has(kText) ? union([props.get(kText)!, val]) : val);
            if (tuples.length > 1) optional.add(kText);
          } else {
            computed.push({ key, value: val });
          }
        } else {
          open = true;
        }
      }
      out.push({ k: 'obj', props, computed, open, optional });
    }
    return out.length > 0 ? union(out) : undefined;
  }
  const out: AVal[] = [];
  for (const a of alts) {
    if (a.k !== 'obj' || a.open || a.computed.length > 0 || a.props.size > MAX_OBJECT_ENTRIES) return undefined;
    if (method === 'keys') {
      out.push({ k: 'arr', items: [...a.props.keys()].map((k) => lit(k)) });
    } else if (method === 'values') {
      out.push({ k: 'arr', items: [...a.props.values()] });
    } else {
      out.push({
        k: 'arr',
        items: [...a.props.entries()].map(([k, val]) => ({ k: 'arr', items: [lit(k), val] })),
      });
    }
  }
  return out.length > 0 ? union(out) : undefined;
}

/** `m.get(k)` on a `new Map()` held in a variable or field: every value passed to `m.set(k, v)`. */
function mapGet(
  ev: Evaluator,
  node: ts.CallExpression | ts.NewExpression,
  callee: ts.PropertyAccessExpression,
  env: Env | undefined,
): AVal | undefined {
  if (callee.name.text !== 'get' || !ts.isCallExpression(node)) return undefined;
  const holder = callee.expression;
  const nameNode = ts.isPropertyAccessExpression(holder) ? holder.name : holder;
  if (!ts.isIdentifier(nameNode)) return undefined;
  const sym0 = ts.isPropertyAccessExpression(holder) ? ev.checker.getSymbolAtLocation(nameNode) : ev.refs.symbolOf(nameNode);
  const sym = sym0 ? ev.refs.resolveAlias(sym0) : undefined;
  const decl = sym?.valueDeclaration;
  const init = decl && (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) ? decl.initializer : undefined;
  if (!sym || !init || !ts.isNewExpression(init) || !ts.isIdentifier(init.expression) || !['Map', 'WeakMap'].includes(init.expression.text)) return undefined;
  const values: AVal[] = [];
  for (const id of ev.refs.referencesOf(sym)) {
    const use = ReferenceIndex.useExpression(id);
    const p = use.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === use && p.name.text === 'set' && ts.isCallExpression(p.parent) && p.parent.expression === p && p.parent.arguments[1]) {
      values.push(ev.eval(p.parent.arguments[1], env));
    }
  }
  if (values.length === 0) return undefined;
  // A miss returns undefined; callers that use the value already guard it.
  return union(values);
}

/** `Object.assign(target, ...sources)`: the target with the sources' fields merged in; works on function targets too. */
function objectAssign(ev: Evaluator, args: readonly ts.Expression[], env: Env | undefined): AVal {
  const target = ev.force(ev.eval(args[0], env));
  const extra = new Map<string, AVal>();
  for (const a of args.slice(1)) {
    for (const alt of alternatives(ev.force(ev.eval(a, env)))) {
      if (alt.k !== 'obj') continue;
      for (const [k, v] of alt.props) extra.set(k, extra.has(k) ? union([extra.get(k)!, v]) : v);
    }
  }
  return union(
    alternatives(target).map((t) => {
      if (t.k === 'fn') {
        const prev = t.props ?? new Map<string, AVal>();
        return { ...t, props: new Map([...prev, ...extra]) };
      }
      if (t.k === 'obj') return { ...t, props: new Map([...t.props, ...extra]) };
      return t;
    }),
  );
}
