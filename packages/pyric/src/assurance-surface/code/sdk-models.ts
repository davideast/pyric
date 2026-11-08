/**
 * Models of the SDK calls the evaluator understands: how `doc`,
 * `collection`, `ref`, `child`, `query`, `push`, `onDisconnect`,
 * `getAuth`, sign-in calls, and a few React hooks transform their
 * arguments into abstract values.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { expressionName, hole, segmentsOf } from './paths.js';
import { AUTH_USER_FUNCTION } from './sdk-imports.js';
import { alternatives, literalText, union, unknown, type AVal, type ConstraintValue, type Env, type RefKind, type Segment } from './values.js';

type Api = Extract<AVal, { k: 'api' }>;
type RefVal = Extract<AVal, { k: 'ref' }>;

const FIRESTORE_FIELD_VALUES = new Set(['serverTimestamp', 'increment', 'arrayUnion', 'arrayRemove', 'deleteField']);
const FIRESTORE_CONSTRAINTS = new Set([
  'where', 'orderBy', 'limit', 'limitToLast', 'startAt', 'startAfter', 'endAt', 'endBefore', 'and', 'or',
]);
const RTDB_CONSTRAINTS = new Set([
  'orderByChild', 'orderByKey', 'orderByValue', 'orderByPriority', 'equalTo', 'startAt', 'startAfter', 'endAt', 'endBefore',
  'limitToFirst', 'limitToLast',
]);
const SIGN_IN_CALLS = /^(?:signIn\w*|createUserWithEmailAndPassword|getRedirectResult|link\w*|reauthenticate\w*)$/;

/** Evaluate a call to an SDK export. */
export function apiCall(ev: Evaluator, api: Api, call: ts.CallExpression, env: Env | undefined): AVal {
  const arg = (i: number): AVal => {
    const a = call.arguments[i];
    if (!a) return { k: 'undefined' };
    if (ts.isSpreadElement(a)) return unknown('spread argument');
    return ev.eval(a, env);
  };
  switch (api.module) {
    case 'firestore':
      return firestoreCall(ev, api.name, call, arg);
    case 'rtdb':
      return rtdbCall(ev, api.name, call, arg);
    case 'auth':
      if (api.name === 'getAuth' || api.name === 'initializeAuth') return { k: 'auth' };
      if (SIGN_IN_CALLS.test(api.name)) return { k: 'credential' };
      return unknown(`result of ${api.name}()`);
    case 'auth-hooks':
      if (api.name === AUTH_USER_FUNCTION) return { k: 'authUser', exact: true };
      if (api.name === 'useAuthState' || api.name === 'useIdToken') return { k: 'arr', items: [{ k: 'authUser', exact: true }, { k: 'bool' }, unknown('auth error')] };
      return unknown(`result of ${api.name}()`);
    case 'react':
      return reactCall(ev, api.name, call, arg);
    case 'sandbox-firestore':
    case 'sandbox-rtdb':
    case 'rules-testing':
      return unknown(`result of ${api.name}()`);
  }
}

function reactCall(ev: Evaluator, name: string, call: ts.CallExpression, arg: (i: number) => AVal): AVal {
  switch (name) {
    case 'useMemo': {
      const fn = ev.force(arg(0));
      return fn.k === 'fn' ? ev.callFunction(fn, []) : unknown('useMemo factory not traced');
    }
    case 'useCallback':
    case 'memo':
    case 'forwardRef':
      return arg(0);
    case 'useState':
      return { k: 'arr', items: [arg(0), unknown('React state setter')] };
    case 'useRef':
      return { k: 'obj', props: new Map([['current', arg(0)]]), computed: [], open: false, optional: new Set() };
    case 'useContext':
    case 'use':
      return ev.contextValue(call.arguments[0]);
    default:
      return unknown(`result of React ${name}()`);
  }
}

/** Root of a ref built from a base argument: a parent ref, or the database root. */
function baseRefs(ev: Evaluator, base: AVal, service: 'firestore' | 'rtdb', fnName: string): { prefix: Segment[]; built: ts.Node[]; notes: string[]; refKind?: RefKind; fromCallers?: boolean }[] {
  const out: { prefix: Segment[]; built: ts.Node[]; notes: string[]; refKind?: RefKind; fromCallers?: boolean }[] = [];
  for (const b of alternatives(ev.force(base))) {
    if (b.k === 'ref' && b.service === service) out.push({ prefix: b.segments, built: b.built, notes: b.notes, refKind: b.refKind, fromCallers: b.fromCallers });
    else if (b.k === 'db' || b.k === 'instance') out.push({ prefix: [], built: [], notes: [] });
    else if (b.k === 'unknown') out.push({ prefix: [], built: [], notes: [`first argument of ${fnName}() was not traced (${b.reason}); assumed to be the database`] });
    // null, undefined, or a value of another kind: infeasible alternative.
  }
  return out;
}

/** Cartesian product of the segment alternatives of several path arguments. */
function pathProducts(ev: Evaluator, call: ts.CallExpression, from: number, to: number, arg: (i: number) => AVal): { segments: Segment[]; notes: string[]; fromCallers?: boolean }[] {
  let acc: { segments: Segment[]; notes: string[]; fromCallers?: boolean }[] = [{ segments: [], notes: [] }];
  const count = to - from;
  for (let i = from; i < to; i++) {
    const alts = segmentsOf(arg(i), call.arguments[i], count === 1, (v) => ev.force(v));
    const next: { segments: Segment[]; notes: string[]; fromCallers?: boolean }[] = [];
    for (const a of acc) {
      for (const s of alts) {
        next.push({ segments: [...a.segments, ...s.segments], notes: s.note ? [...a.notes, s.note] : a.notes, fromCallers: a.fromCallers || s.fromCallers });
      }
    }
    acc = next.slice(0, 32);
  }
  return acc;
}

function makeRefs(
  ev: Evaluator,
  service: 'firestore' | 'rtdb',
  refKind: RefKind,
  call: ts.CallExpression,
  arg: (i: number) => AVal,
  fnName: string,
  append?: Segment,
  pathArgsEnd: number = call.arguments.length,
): AVal {
  const out: AVal[] = [];
  for (const base of baseRefs(ev, arg(0), service, fnName)) {
    for (const p of pathProducts(ev, call, 1, pathArgsEnd, arg)) {
      const segments = [...base.prefix, ...p.segments];
      if (append) segments.push(append);
      const ref: Extract<AVal, { k: 'ref' }> = { k: 'ref', service, refKind, segments, built: [...base.built, call], notes: [...base.notes, ...p.notes] };
      if (p.fromCallers || base.fromCallers) ref.fromCallers = true;
      out.push(ref);
    }
  }
  if (out.length === 0) return unknown(`${fnName}() on a value that is not a ${service === 'rtdb' ? 'database ref' : 'Firestore ref'}`);
  return union(out);
}

function firestoreCall(ev: Evaluator, name: string, call: ts.CallExpression, arg: (i: number) => AVal): AVal {
  switch (name) {
    case 'getFirestore':
    case 'initializeFirestore':
      return { k: 'db', service: 'firestore' };
    case 'collection':
      return makeRefs(ev, 'firestore', 'collection', call, arg, name);
    case 'doc': {
      // doc(collectionRef) creates a ref with a generated id.
      if (call.arguments.length === 1) return makeRefs(ev, 'firestore', 'doc', call, arg, name, [hole('autoId')]);
      return makeRefs(ev, 'firestore', 'doc', call, arg, name);
    }
    case 'collectionGroup': {
      const idVal = ev.force(arg(1));
      const id = literalText(idVal) ?? expressionName(call.arguments[1]);
      const segments: Segment[] = [[hole('path=**')], [{ kind: 'lit', text: id }]];
      return { k: 'ref', service: 'firestore', refKind: 'collectionGroup', segments, built: [call], notes: literalText(idVal) === null ? [`collection group id '${id}' was not traced`] : [] };
    }
    case 'query':
      return queryOf(ev, 'firestore', call, arg);
    case 'addDoc':
      return makeRefs(ev, 'firestore', 'doc', call, arg, name, [hole('autoId')], 1);
    case 'writeBatch':
      return { k: 'batch' };
    case 'documentId':
      return { k: 'str', parts: [{ kind: 'lit', text: '__name__' }] };
    default:
      if (FIRESTORE_FIELD_VALUES.has(name)) return { k: 'fieldValue', name: name as 'serverTimestamp' };
      if (FIRESTORE_CONSTRAINTS.has(name)) return { k: 'constraint', value: constraintOf(ev, name, arg) };
      return unknown(`result of Firestore ${name}()`);
  }
}

function rtdbCall(ev: Evaluator, name: string, call: ts.CallExpression, arg: (i: number) => AVal): AVal {
  switch (name) {
    case 'getDatabase':
      return { k: 'db', service: 'rtdb' };
    case 'ref':
    case 'child':
      return makeRefs(ev, 'rtdb', 'node', call, arg, name);
    case 'push':
      return makeRefs(ev, 'rtdb', 'node', call, arg, name, [hole('pushId')], 1);
    case 'query':
      return queryOf(ev, 'rtdb', call, arg);
    case 'onDisconnect':
      return { k: 'onDisconnect', ref: arg(0) };
    case 'serverTimestamp':
      return { k: 'fieldValue', name: 'serverTimestamp' };
    case 'increment':
      return { k: 'fieldValue', name: 'increment' };
    default:
      if (RTDB_CONSTRAINTS.has(name)) return { k: 'constraint', value: constraintOf(ev, name, arg) };
      return unknown(`result of Realtime Database ${name}()`);
  }
}

function queryOf(ev: Evaluator, service: 'firestore' | 'rtdb', call: ts.CallExpression, arg: (i: number) => AVal): AVal {
  const constraints: ConstraintValue[] = [];
  for (let i = 1; i < call.arguments.length; i++) {
    for (const c of alternatives(ev.force(arg(i)))) {
      if (c.k === 'constraint') constraints.push(c.value);
      else constraints.push({ kind: 'unknown' });
    }
  }
  const out: AVal[] = [];
  for (const b of alternatives(ev.force(arg(0)))) {
    if (b.k === 'ref' && b.service === service) {
      out.push({ ...b, built: [...b.built, call], constraints: [...(b.constraints ?? []), ...constraints], queryCall: call } satisfies RefVal);
    } else if (b.k === 'unknown') {
      out.push(unknown(`query() base was not traced: ${b.reason}`));
    }
  }
  if (out.length === 0) return unknown('query() on a value that is not a ref');
  return union(out);
}

function constraintOf(ev: Evaluator, name: string, arg: (i: number) => AVal): ConstraintValue {
  const field = literalText(ev.force(arg(0))) ?? undefined;
  if (name === 'where') {
    const op = literalText(ev.force(arg(1))) ?? undefined;
    return { kind: name, field, op };
  }
  if (name === 'orderBy') {
    const dir = literalText(ev.force(arg(1)));
    return { kind: name, field, direction: dir === 'desc' ? 'desc' : 'asc' };
  }
  if (name === 'orderByChild') return { kind: name, field };
  return { kind: name };
}

/** The value an SDK passes to a callback's parameter. */
export function apiCallbackParameter(api: Api, paramIndex: number): AVal {
  if (api.module === 'auth' && /^(?:onAuthStateChanged|onIdTokenChanged|beforeAuthStateChanged)$/.test(api.name) && paramIndex === 0) {
    return { k: 'authUser', exact: true };
  }
  if (api.module === 'firestore' && api.name === 'runTransaction' && paramIndex === 0) return { k: 'tx' };
  if (api.module === 'rtdb' && api.name === 'runTransaction') return unknown('current value inside a transaction');
  if (api.module === 'react') return unknown(`argument React passes to a ${api.name} callback`);
  return unknown(`argument ${api.name} passes to its callback`);
}
