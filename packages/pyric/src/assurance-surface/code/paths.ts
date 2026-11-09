/**
 * Strings and paths: how evaluated values become path segments and
 * rendered templates.
 *
 * A string value is a list of parts, literal text or named holes. A path
 * is a list of segments, each one or more parts. Rendering turns a hole
 * segment into `{name}` (Firestore) or `$name` (RTDB), so templates line
 * up with rules match patterns.
 */
import ts from 'typescript';
import {
  parseResourcePattern,
  type PatternSegment,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import type { AccessService, AuthProvenance, PathVariable } from './types.js';
import {
  alternatives,
  authMarksOf,
  concatParts,
  type AuthMark,
  type AVal,
  type Segment,
  type StrPart,
  union,
} from './values.js';

/** Most alternative paths one argument may expand to. */
const MAX_PATH_ALTERNATIVES = 32;

/** A readable name for the expression a value came from. */
export function expressionName(node: ts.Node | undefined): string {
  let e: ts.Node | undefined = node;
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e))) {
    e = e.expression;
  }
  if (!e) return 'value';
  if (ts.isIdentifier(e)) return sanitize(e.text);
  if (ts.isPropertyAccessExpression(e)) return sanitize(e.name.text);
  if (ts.isElementAccessExpression(e)) {
    if (ts.isStringLiteralLike(e.argumentExpression)) return sanitize(e.argumentExpression.text);
    return expressionName(e.expression);
  }
  if (ts.isConditionalExpression(e)) {
    const t = expressionName(e.whenTrue);
    return t !== 'value' ? t : expressionName(e.whenFalse);
  }
  if (ts.isBinaryExpression(e)) {
    const l = expressionName(e.left);
    return l !== 'value' ? l : expressionName(e.right);
  }
  if (ts.isCallExpression(e)) {
    // `x.toString()`, `String(x)`: name it after the receiver or argument.
    const callee = e.expression;
    if (ts.isPropertyAccessExpression(callee) && STRINGIFY_METHODS.has(callee.name.text)) return expressionName(callee.expression);
    if (ts.isIdentifier(callee) && callee.text === 'String' && e.arguments[0]) return expressionName(e.arguments[0]);
    return expressionName(callee);
  }
  return 'value';
}

const STRINGIFY_METHODS = new Set(['toString', 'trim', 'toLowerCase', 'toUpperCase', 'valueOf']);

function sanitize(name: string): string {
  if (name.endsWith('=**')) return `${sanitize(name.slice(0, -3))}=**`;
  const s = name.replace(/[^A-Za-z0-9_]/g, '_');
  return s.length > 0 ? s : 'value';
}

/** A readable name for a function, for reasons. */
export function functionName(fn: ts.SignatureDeclaration): string {
  if (fn.name && ts.isIdentifier(fn.name)) return `'${fn.name.text}'`;
  if (ts.isConstructorDeclaration(fn)) return `the constructor of '${fn.parent.name?.text ?? 'class'}'`;
  let host: ts.Node = fn;
  while (ts.isParenthesizedExpression(host.parent) || ts.isAsExpression(host.parent)) host = host.parent;
  const p = host.parent;
  if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && ts.isIdentifier(p.name)) return `'${p.name.text}'`;
  const sf = fn.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(fn.getStart());
  return `the function at line ${line + 1}`;
}

/** A hole part. */
export function hole(name: string, auth: AuthMark[] = [], resolveValue?: () => AVal): StrPart {
  const part: StrPart = { kind: 'hole', name: sanitize(name), auth };
  if (resolveValue) Object.defineProperty(part, 'resolveValue', { value: resolveValue, enumerable: false });
  return part;
}

/** The deferred value behind a hole, when interpolation kept one. */
function holeValue(part: StrPart): (() => AVal) | undefined {
  return (part as { resolveValue?: () => AVal }).resolveValue;
}

const UNION_HOLES = new WeakSet<StrPart>();

/** True when an alternative is a concrete literal path segment (not a parameter or dynamic hole). */
function isConcreteSegmentAlt(a: AVal): boolean {
  if (a.k === 'str') return a.parts.every((p) => p.kind === 'lit');
  if (a.k === 'num') return a.value !== undefined;
  return false;
}

/** True when a string value's literal text contains a path separator. */
function hasSeparator(v: AVal): boolean {
  return v.k === 'str' && v.parts.some((p) => p.kind === 'lit' && p.text.includes('/'));
}

/**
 * Split string parts into path segments on `/` in literal text. Holes
 * whose deferred value is a multi-segment string or an expression union
 * with concrete branches are expanded, one alternative per possible value.
 */
export function partsToSegmentAlternatives(parts: StrPart[], force: (v: AVal) => AVal): Segment[][] {
  let partials: StrPart[][] = [[]];
  for (const p of parts) {
    const deferred = p.kind === 'hole' ? holeValue(p) : undefined;
    if (deferred) {
      const alts = alternatives(force(deferred()));
      const shouldExpand =
        alts.length > 0
        && alts.every((a) => a.k === 'str')
        && (alts.some(hasSeparator) || (UNION_HOLES.has(p) && alts.some(isConcreteSegmentAlt)));
      if (shouldExpand) {
        const next: StrPart[][] = [];
        for (const prefix of partials) {
          for (const a of alts) {
            if (a.k === 'str') next.push(concatParts(prefix, a.parts));
          }
        }
        partials = next.slice(0, MAX_PATH_ALTERNATIVES);
        continue;
      }
    }
    partials = partials.map((prefix) => concatParts(prefix, [p]));
  }
  return partials.map(splitSegments);
}

function splitSegments(parts: StrPart[]): Segment[] {
  const segments: Segment[] = [];
  let current: StrPart[] = [];
  const flush = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  for (const p of parts) {
    if (p.kind !== 'lit') {
      current.push(p);
      continue;
    }
    const pieces = p.text.split('/');
    pieces.forEach((piece, i) => {
      if (i > 0) flush();
      if (piece.length > 0) current.push({ kind: 'lit', text: piece });
    });
  }
  flush();
  return segments;
}

/** Path segments contributed by one evaluated path argument. */
export interface SegmentAlternative {
  segments: Segment[];
  /** True when the segments were expanded from the values callers pass for a parameter. */
  fromCallers?: boolean;
  /** Assumption made, when the argument was not fully traced. */
  note?: string;
}

/**
 * Turn the value of a path argument (`ref(db, PATH)`, `doc(db, A, B)`)
 * into segment alternatives. `wholePath` is true when this argument is
 * the entire path, so an untraced value can't be assumed to be one
 * segment.
 */
export function segmentsOf(v: AVal, argNode: ts.Node | undefined, wholePath: boolean, force: (v: AVal) => AVal): SegmentAlternative[] {
  const out: SegmentAlternative[] = [];
  let alts = alternatives(v);
  // `let path: string | undefined` guarded before use: an absent alternative beside real ones is not a root path.
  if (wholePath && alts.some((a) => a.k !== 'null' && a.k !== 'undefined')) alts = alts.filter((a) => a.k !== 'null' && a.k !== 'undefined');
  if (alts.length > 1 && !wholePath && !alts.some(isConcreteSegmentAlt) && isOneSegmentChoice(alts, force)) {
    // `presence?.clientId || \`\${uid}:\${tab}\``: one variable segment, carrying every alternative's provenance.
    return [{ segments: [[hole(expressionName(argNode), authMarksOf(union(alts.map((a) => force(a)))), () => union(alts.map((a) => force(a))))]] }];
  }
  for (const a of alts) {
    if (out.length >= MAX_PATH_ALTERNATIVES) break;
    switch (a.k) {
      case 'sym': {
        // A parameter: keep it as a named variable unless its values are multi-segment paths.
        const forced = force(a);
        if (alternatives(forced).some(hasSeparator)) {
          // The path's shape comes from the callers: mark it so the site can be attributed to them.
          for (const alt of segmentsOf(forced, argNode, wholePath, force)) out.push({ ...alt, fromCallers: true });
        }
        else out.push({ segments: [[hole(a.name, authMarksOf(forced), () => forced)]] });
        break;
      }
      case 'str':
        if (a.parts.every((p) => p.kind === 'lit') || hasSeparator(a)) {
          for (const segs of partsToSegmentAlternatives(a.parts, force)) out.push({ segments: segs });
        } else if (a.parts.length === 1 && holeValue(a.parts[0])) {
          // A deferred hole may still expand to several segments.
          for (const segs of partsToSegmentAlternatives(a.parts, force)) out.push({ segments: segs });
        } else {
          out.push({ segments: [[renamedHole(a, expressionName(argNode))]] });
        }
        break;
      case 'num':
        out.push({ segments: [[a.value === undefined ? hole(expressionName(argNode)) : { kind: 'lit', text: String(a.value) }]] });
        break;
      case 'undefined':
      case 'null':
        out.push({ segments: [] });
        break;
      case 'unknown': {
        const name = expressionName(argNode);
        let note: string | undefined;
        if (wholePath) note = `path argument '${name}' was not traced (${a.reason}); assumed to be one segment`;
        out.push({ segments: [[hole(name)]], note });
        break;
      }
      default: {
        const name = expressionName(argNode);
        out.push({ segments: [[hole(name)]], note: `path argument '${name}' is a ${a.k}, not a string` });
      }
    }
  }
  if (wholePath) {
    for (const alt of out) {
      if (alt.note || !isLoneHole(alt.segments)) continue;
      const only = alt.segments[0][0];
      const known = only.kind === 'hole' && knownSingleSegment(only, force);
      if (!known) alt.note = `the whole path is the variable '${expressionName(argNode)}'; its depth is not known`;
    }
  }
  return out;
}

function isLoneHole(segments: Segment[]): boolean {
  return segments.length === 1 && segments[0].length === 1 && segments[0][0].kind === 'hole';
}

/** True when a hole's traced values are all literal strings without a separator. */
function knownSingleSegment(part: StrPart, force: (v: AVal) => AVal): boolean {
  const deferred = holeValue(part);
  if (!deferred) return false;
  const alts = alternatives(force(deferred()));
  return alts.length > 0 && alts.every((a) => a.k === 'str' && a.parts.every((p) => p.kind === 'lit') && !hasSeparator(a));
}

/**
 * A one-segment string as a single hole. A lone hole keeps its own name
 * when the expression has no better one; otherwise the expression names it.
 */
function renamedHole(v: Extract<AVal, { k: 'str' }>, exprName: string): StrPart {
  const only = v.parts.length === 1 ? v.parts[0] : undefined;
  const name = exprName === 'value' && only && only.kind === 'hole' ? only.name : exprName;
  const deferred = only && only.kind === 'hole' ? holeValue(only) : undefined;
  const out = hole(name, authMarksOf(v), deferred ?? (() => v));
  if (only && only.kind === 'hole' && UNION_HOLES.has(only)) UNION_HOLES.add(out);
  return out;
}

/** True when a hole's deferred value may be a multi-segment path. */
function deferredHasSeparator(part: StrPart, force: (v: AVal) => AVal): boolean {
  const deferred = part.kind === 'hole' ? holeValue(part) : undefined;
  return deferred !== undefined && alternatives(force(deferred())).some(hasSeparator);
}

/** True when none of the alternatives can contribute a path separator: they all fill one segment. */
function isOneSegmentChoice(alts: AVal[], force: (v: AVal) => AVal): boolean {
  return alts.every((a) => {
    if (a.k === 'str') return !hasSeparator(a) && a.parts.every((p) => !deferredHasSeparator(p, force));
    if (a.k === 'sym') return !alternatives(force(a)).some(hasSeparator);
    return a.k === 'unknown' || a.k === 'num';
  });
}

/** Interpolate a value into a template literal or `+` concatenation. */
export function interpolate(v: AVal, exprNode: ts.Node, force: (v: AVal) => AVal): StrPart[] {
  const name = expressionName(exprNode);
  if (v.k === 'str') {
    const allLiteral = v.parts.every((p) => p.kind === 'lit');
    if (allLiteral || hasSeparator(v)) return v.parts;
    // A one-segment value (`evt_${now}`, `crypto.randomUUID()`): one hole named after the expression.
    return [renamedHole(v, name)];
  }
  if (v.k === 'num' && v.value !== undefined) return [{ kind: 'lit', text: String(v.value) }];
  if (v.k === 'bool' && v.value !== undefined) return [{ kind: 'lit', text: String(v.value) }];
  if (v.k === 'sym') {
    return [hole(v.name, authMarksOf(force(v)), () => force(v))];
  }
  if (v.k === 'union') {
    const out = hole(name, authMarksOf(v), () => v);
    UNION_HOLES.add(out);
    return [out];
  }
  return [hole(name)];
}

/** Build a {@link ResourcePattern} directly from evaluated segments so concrete `$`/`{...}` literals stay literals. */
export function segmentsToResourcePattern(
  service: AccessService,
  segments: readonly Segment[],
  resourceId?: string,
): ResourcePattern {
  const resolvedResourceId = parseResourcePattern(service, '', resourceId).resourceId;
  const used = new Map<string, number>();
  const out: PatternSegment[] = [];
  for (const seg of segments) {
    if (seg.every((p) => p.kind === 'lit')) {
      const text = seg.map((p) => (p.kind === 'lit' ? p.text : '')).join('');
      if (text.length > 0) out.push({ kind: 'lit', text });
      continue;
    }
    if (seg.length === 1 && seg[0]!.kind === 'hole' && seg[0]!.name.endsWith('=**')) {
      const rawName = seg[0]!.name.slice(0, -3);
      out.push({ kind: 'rest', name: rawName.length > 0 ? rawName : 'path' });
      continue;
    }
    const holes = seg.filter((p): p is Extract<StrPart, { kind: 'hole' }> => p.kind === 'hole');
    let name = holes.map((h) => h.name).join('_');
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name}${n}`;
    out.push({ kind: 'var', name });
  }
  return { service, resourceId: resolvedResourceId, segments: out };
}

/** Render a ref's segments as a template, with its variables. */
export function renderPath(service: AccessService, segments: Segment[], force?: (v: AVal) => AVal): { path: string; variables: PathVariable[] } {
  const used = new Map<string, number>();
  const variables: PathVariable[] = [];
  const rendered = segments.map((seg) => {
    if (seg.every((p) => p.kind === 'lit')) return seg.map((p) => (p.kind === 'lit' ? p.text : '')).join('');
    if (seg.length === 1 && seg[0].kind === 'hole' && seg[0].name.endsWith('=**')) {
      return service === 'rtdb' ? `$${seg[0].name}` : `{${seg[0].name}}`;
    }
    const holes = seg.filter((p): p is Extract<StrPart, { kind: 'hole' }> => p.kind === 'hole');
    let name = holes.map((h) => h.name).join('_');
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name}${n}`;
    const auth = mergeAuth(holes.flatMap((h) => h.auth), seg.length === 1);
    const variable: PathVariable = { name };
    if (auth.length > 0) variable.auth = auth;
    const pattern = auth.some((a) => a.source === 'auth.uid') && force ? uidPattern(seg, force, 0) : undefined;
    if (pattern && pattern !== '{auth.uid}') variable.pattern = pattern;
    variables.push(variable);
    return service === 'rtdb' ? `$${name}` : `{${name}}`;
  });
  return { path: rendered.join('/'), variables };
}

/**
 * How a uid-derived segment is built, for making concrete keys:
 * `{auth.uid}:{*}` for `${uid}:${tabId}`. `{*}` is any other value.
 */
function uidPattern(parts: StrPart[], force: (v: AVal) => AVal, depth: number): string {
  return parts
    .map((p) => {
      if (p.kind === 'lit') return p.text;
      const deferred = holeValue(p);
      if (deferred && depth < 3) {
        const alt = alternatives(force(deferred())).find((a) => a.k === 'str' && authMarksOf(a).some((m) => m.source === 'auth.uid'));
        if (alt && alt.k === 'str') return uidPattern(alt.parts, force, depth + 1);
      }
      return p.auth.some((m) => m.source === 'auth.uid') ? '{auth.uid}' : '{*}';
    })
    .join('');
}

/** Collapse auth marks to provenance records; a hole that is only part of its segment is partial. */
export function mergeAuth(marks: AuthMark[], wholeSegment: boolean): AuthProvenance[] {
  const bySource = new Map<string, boolean>();
  for (const m of marks) {
    const exact = m.exact && wholeSegment;
    const prev = bySource.get(m.source);
    bySource.set(m.source, prev === undefined ? exact : prev && exact);
  }
  return [...bySource.entries()].map(([source, exact]) => ({
    source: source as AuthProvenance['source'],
    certainty: exact ? 'exact' : 'partial',
  }));
}
