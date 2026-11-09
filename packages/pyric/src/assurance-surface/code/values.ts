/**
 * Abstract values for the access-site evaluator.
 *
 * The evaluator does not run code. It maps each expression to the set of
 * things it could be at run time, as far as path and auth provenance are
 * concerned: a database handle, a ref with a path, a string with named
 * holes, the signed-in user, an object literal, a function, or `unknown`
 * with the reason the trace stopped.
 */
import type ts from 'typescript';
import type {
  ConstraintOperand,
  FieldValueName,
  RefKind,
  SdkQueryConstraint,
} from './service-models/types.js';
import type { AccessService, AuthSource } from './types.js';

export type { RefKind } from './service-models/types.js';

/** A piece of a string value: literal text, or a named hole. */
export type StrPart =
  | { kind: 'lit'; text: string }
  | { kind: 'hole'; name: string; auth: AuthMark[]; reason?: string };

/** Auth provenance carried on a hole while evaluating. */
export interface AuthMark {
  source: AuthSource;
  exact: boolean;
}

/** One segment of a ref path; a segment may join literal text and holes. */
export type Segment = StrPart[];

/** A query constraint captured while evaluating `query(...)`. */
export type ConstraintValue = SdkQueryConstraint;

export type AVal =
  | { k: 'unknown'; reason: string }
  /** No run-time value reaches here (an infeasible branch): dropped from unions. */
  | { k: 'never' }
  | { k: 'str'; parts: StrPart[] }
  | { k: 'num'; value?: number }
  | { k: 'bool'; value?: boolean }
  | { k: 'null' }
  | { k: 'undefined' }
  | {
      k: 'db';
      service: AccessService;
      resourceId: string;
      notes?: string[];
      fromCallers?: boolean;
      admin?: boolean;
    }
  | { k: 'auth' }
  | { k: 'authUser'; exact: boolean }
  | { k: 'authTokenResult'; exact: boolean }
  | { k: 'authClaims'; exact: boolean }
  | { k: 'credential' }
  | {
      k: 'ref';
      service: AccessService;
      resourceId: string;
      refKind: RefKind;
      segments: Segment[];
      /** Construction calls that built this ref, outermost last. */
      built: ts.Node[];
      /** Assumptions made while building it (reported on partial sites). */
      notes: string[];
      constraints?: ConstraintValue[];
      /** True when part of the path was expanded from the values callers pass for a parameter. */
      fromCallers?: boolean;
      /** True when built from an Admin SDK handle or Admin module export. */
      admin?: boolean;
      /** Underlying base ref when this ref was produced by `query(...)`. */
      baseRef?: Extract<AVal, { k: 'ref' }>;
      /** First `query()` call in a chained `query(query(base, ...), ...)` sequence. */
      firstQueryCall?: ts.CallExpression;
      /** Outermost `query()` call, when this ref is a query. */
      queryCall?: ts.CallExpression;
    }
  | { k: 'constraint'; value: ConstraintValue }
  | { k: 'receiver'; service: AccessService; receiverKind: string; ref?: AVal; admin?: boolean }
  | { k: 'fieldValue'; name: FieldValueName }
  | { k: 'obj'; props: Map<string, AVal>; computed: { key: AVal; value: AVal }[]; open: boolean; optional: Set<string> }
  | { k: 'arr'; items: AVal[]; open?: boolean }
  /** A function value; `props` holds properties assigned onto it (`Object.assign(fn, {...})`). */
  | { k: 'fn'; decl: ts.SignatureDeclaration; env: Env | undefined; props?: Map<string, AVal> }
  | { k: 'class'; decl: ts.ClassLikeDeclaration }
  | { k: 'instance'; decl: ts.ClassLikeDeclaration | undefined }
  /** An SDK export: `doc`, `setDoc`, `ref`, `onAuthStateChanged`, a React hook. */
  | { k: 'api'; module: ApiModule; name: string; admin?: boolean }
  /** A namespace import of an SDK module: `import * as fs from 'firebase/firestore'`. */
  | { k: 'ns'; module: ApiModule; admin?: boolean }
  /** A value with a name whose possible values are computed on demand (a parameter). */
  | { k: 'sym'; name: string; node: ts.Node; resolve: () => AVal }
  | { k: 'union'; alts: AVal[] };

/** Which SDK an `api`/`ns` value belongs to. */
export type ApiModule =
  | AccessService
  | 'auth'
  | 'react'
  | 'auth-hooks'
  | 'sandbox-firestore'
  | 'sandbox-rtdb'
  | 'sandbox-storage'
  | 'rules-testing';

/** Lexical bindings for parameters of an inlined call. */
export interface Env {
  bindings: Map<ts.Symbol, AVal>;
  parent: Env | undefined;
  stepSymbol?: ts.Symbol;
  initialBindings?: ReadonlyMap<ts.Symbol, AVal>;
}

export const MAX_UNION = 64;

export function unknown(reason: string): AVal {
  return { k: 'unknown', reason };
}

/** Prototype-safe lookup on a plain string-keyed record. */
export function ownRecordValue<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  if (!record || !Object.hasOwn(record, key)) return undefined;
  return record[key];
}

export const NEVER: AVal = { k: 'never' };

export function lit(text: string): AVal {
  return { k: 'str', parts: [{ kind: 'lit', text }] };
}

/** Flatten nested unions, drop `never`, dedupe identical leaves, cap size. */
export function union(values: AVal[]): AVal {
  const alts: AVal[] = [];
  const seen = new Set<string>();
  const seenRefs = new Set<AVal>();
  const seenFns = new Map<ts.Node, Set<Env | undefined>>();
  const push = (v: AVal): void => {
    if (v.k === 'never') return;
    if (v.k === 'union') {
      for (const a of v.alts) push(a);
      return;
    }
    if (seenRefs.has(v)) return;
    seenRefs.add(v);
    if (v.k === 'fn' && !v.props?.size) {
      let envs = seenFns.get(v.decl);
      if (!envs) {
        envs = new Set();
        seenFns.set(v.decl, envs);
      }
      if (envs.has(v.env)) return;
      envs.add(v.env);
    }
    const key = leafKey(v);
    if (key !== null) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    alts.push(v);
  };
  for (const v of values) push(v);
  if (alts.length === 0) return NEVER;
  if (alts.length === 1) return alts[0];
  if (alts.length > MAX_UNION) {
    return unknown(`more than ${MAX_UNION} possible values`);
  }
  return { k: 'union', alts };
}

/** Alternatives of a value (a non-union is its own single alternative). */
export function alternatives(v: AVal): AVal[] {
  if (v.k === 'union') return v.alts.flatMap(alternatives);
  if (v.k === 'never') return [];
  return [v];
}

/**
 * Apply a parameter or destructuring default initializer only when the
 * supplied value can evaluate to `undefined` (or comes from an optional slot).
 */
export function withDefaultInitializer(
  val: AVal,
  evalInit: () => AVal,
  force: (v: AVal) => AVal,
  isOptionalProp = false,
): AVal {
  const alts = alternatives(force(val));
  const canBeUndefined =
    isOptionalProp
    || alts.length === 0
    || alts.some((a) => a.k === 'undefined' || a.k === 'unknown');
  if (!canBeUndefined) return val;
  const nonUndefined = alts.filter((a) => a.k !== 'undefined');
  return union([...nonUndefined, evalInit()]);
}

function literalOperandKey(value: string | number | boolean | null | undefined): string {
  if (value === null) return 'lit:null:null';
  return `lit:${typeof value}:${String(value)}`;
}

function operandKey(op: ConstraintOperand | undefined): string {
  if (!op) return '';
  if (op.kind === 'literal') return literalOperandKey(op.literal);
  if (op.kind === 'auth') {
    return `auth:${(op.auth ?? []).map((a) => `${a.source}:${a.certainty}`).join(',')}`;
  }
  if (op.kind === 'array') {
    return `arr:[${(op.items ?? []).map(operandKey).join(',')}]`;
  }
  return op.kind;
}

export function constraintKey(c: ConstraintValue): string {
  let kids = '';
  if (c.children) kids = `(${c.children.map(constraintKey).join(';')})`;
  return `${c.kind}:${c.field ?? ''}:${c.op ?? ''}:${c.direction ?? ''}:${operandKey(c.operand)}${kids}`;
}

/** A dedupe key for leaves that compare by content; null for identity-only values. */
function leafKey(v: AVal): string | null {
  switch (v.k) {
    case 'str':
      return `str:${renderParts(v.parts)}:${authKey(v.parts)}`;
    case 'null':
    case 'undefined':
    case 'auth':
    case 'credential':
      return v.k;
    case 'receiver':
      if (v.ref !== undefined) return null;
      return `receiver:${v.service}:${v.receiverKind}`;
    case 'num':
      return `num:${v.value ?? '?'}`;
    case 'bool':
      return `bool:${v.value ?? '?'}`;
    case 'db': {
      let callerTag = '';
      if (v.fromCallers) callerTag = 'c';
      let adminTag = '';
      if (v.admin) adminTag = 'a';
      return `db:${v.service}:${v.resourceId}:${(v.notes ?? []).join(';')}:${callerTag}:${adminTag}`;
    }
    case 'authUser':
    case 'authTokenResult':
    case 'authClaims':
      return `${v.k}:${v.exact}`;
    case 'constraint':
      return `constraint:${constraintKey(v.value)}`;
    case 'unknown':
      return `unknown:${v.reason}`;
    case 'ref': {
      const cKey = (v.constraints ?? []).map(constraintKey).join('|');
      let callerTag = '';
      if (v.fromCallers) callerTag = 'c';
      let adminTag = '';
      if (v.admin) adminTag = 'a';
      return `ref:${v.service}:${v.resourceId}:${v.refKind}:${v.segments.map(renderParts).join('/')}:${cKey}:${v.built.map(nodeId).join(',')}:${v.notes.join(';')}:${callerTag}:${adminTag}`;
    }
    default:
      return null;
  }
}

/** Stable identity of a node: file and start position. */
export function nodeId(node: ts.Node): string {
  return `${node.getSourceFile().fileName}:${node.pos}:${node.end}`;
}

function formatAuthMark(mark: AuthMark): string {
  const suffix = mark.exact ? '!' : '?';
  return `${mark.source}${suffix}`;
}

function partAuthKey(part: StrPart): string {
  if (part.kind !== 'hole') return '';
  return part.auth.map(formatAuthMark).join(',');
}

function authKey(parts: StrPart[]): string {
  return parts.map(partAuthKey).join('|');
}

/** Render string parts with `{name}` holes (used for keys and dedupe). */
export function renderParts(parts: StrPart[]): string {
  return parts.map((p) => (p.kind === 'lit' ? p.text : `{${p.name}}`)).join('');
}

/** True when the value is a string whose every part is literal. */
export function literalText(v: AVal): string | null {
  if (v.k !== 'str') return null;
  let out = '';
  for (const p of v.parts) {
    if (p.kind !== 'lit') return null;
    out += p.text;
  }
  return out;
}

function leafTruthiness(a: AVal): boolean | undefined {
  switch (a.k) {
    case 'bool':
      return a.value;
    case 'null':
    case 'undefined':
      return false;
    case 'num':
      if (a.value === undefined) return undefined;
      return a.value !== 0 && !Number.isNaN(a.value);
    case 'str': {
      const t = literalText(a);
      if (t !== null) return t.length > 0;
      if (a.parts.some((p) => p.kind === 'lit' && p.text.length > 0)) return true;
      return undefined;
    }
    case 'obj':
    case 'arr':
    case 'fn':
    case 'class':
    case 'instance':
    case 'ref':
    case 'db':
    case 'auth':
    case 'authUser':
    case 'authTokenResult':
    case 'authClaims':
    case 'credential':
    case 'receiver':
    case 'fieldValue':
    case 'api':
    case 'ns':
    case 'constraint':
      return true;
    default:
      return undefined;
  }
}

/** Definite JavaScript truthiness when all alternatives agree; undefined when indeterminate. */
export function definiteTruthiness(v: AVal): boolean | undefined {
  const alts = alternatives(v);
  if (alts.length === 0) return undefined;
  let allTrue = true;
  let allFalse = true;
  for (const a of alts) {
    const t = leafTruthiness(a);
    if (t !== true) allTrue = false;
    if (t !== false) allFalse = false;
  }
  if (allTrue) return true;
  if (allFalse) return false;
  return undefined;
}

/** Concatenate string parts, merging adjacent literals. */
export function concatParts(...lists: StrPart[][]): StrPart[] {
  const out: StrPart[] = [];
  for (const list of lists) {
    for (const p of list) {
      const last = out[out.length - 1];
      if (p.kind === 'lit' && last && last.kind === 'lit') {
        out[out.length - 1] = { kind: 'lit', text: last.text + p.text };
      } else if (p.kind !== 'lit' || p.text !== '') {
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * Auth marks found anywhere in a value (strings, unions of strings). A
 * source is exact only when every alternative is exactly that source:
 * `user.displayName || user.email` is partly each.
 */
export function authMarksOf(v: AVal): AuthMark[] {
  const alts = alternatives(v);
  const exactCount = new Map<AuthSource, number>();
  const seen = new Set<AuthSource>();
  for (const a of alts) {
    if (a.k !== 'str') continue;
    const wholeString = a.parts.length === 1;
    const inThisAlt = new Map<AuthSource, boolean>();
    for (const p of a.parts) {
      if (p.kind !== 'hole') continue;
      for (const m of p.auth) {
        const exact = m.exact && wholeString && p.auth.length === 1;
        inThisAlt.set(m.source, (inThisAlt.get(m.source) ?? false) || exact);
      }
    }
    for (const [source, exact] of inThisAlt) {
      seen.add(source);
      if (exact) exactCount.set(source, (exactCount.get(source) ?? 0) + 1);
    }
  }
  return [...seen].map((source) => ({ source, exact: (exactCount.get(source) ?? 0) === alts.length }));
}
