/**
 * Evaluates SDK exports against registered {@link SdkServiceModel} tables,
 * plus Firebase Auth, auth hooks, and React state/memo/context helpers.
 */
import ts from 'typescript';
import type { AssuranceService } from '../../sandbox/internal/resource-pattern.js';
import { DEFAULT_RESOURCE_ID } from '../../sandbox/internal/resource-pattern-header.js';
import type { Evaluator } from './evaluator.js';
import { timestampWrapperFromMillis } from './builtins.js';
import { expressionName, hole, segmentsOf } from './paths.js';
import { evalConstraintCall, evalQueryCall } from './query-constraints.js';
import {
  containsCallerSymbol,
  evalHandleFactory,
  splitHeaderAlternatives,
  type HeaderAlternative,
} from './resource-headers.js';
import { AUTH_USER_FUNCTION } from './sdk-imports.js';
import type { RefConstructorSpec, SdkServiceModel } from './service-models/types.js';
import { decodeBase64Bytes, literalUint8Bytes } from './storage-upload.js';
import {
  alternatives,
  lit,
  literalText,
  ownRecordValue,
  union,
  unknown,
  type AVal,
  type Env,
  type RefKind,
  type Segment,
} from './values.js';

type Api = Extract<AVal, { k: 'api' }>;
type RefVal = Extract<AVal, { k: 'ref' }>;

interface BaseRefOrigin {
  prefix: Segment[];
  resourceId: string;
  built: ts.Node[];
  notes: string[];
  refKind?: RefKind;
  fromCallers?: boolean;
  admin?: boolean;
}

const SIGN_IN_CALLS = /^(?:signIn\w*|createUserWithEmailAndPassword|getRedirectResult|link\w*|reauthenticate\w*)$/;

/** Evaluate a call to an SDK export. */
export function apiCall(ev: Evaluator, api: Api, call: ts.CallExpression, env: Env | undefined): AVal {
  const arg = (i: number): AVal => {
    const a = call.arguments[i];
    if (!a) return { k: 'undefined' };
    if (ts.isSpreadElement(a)) return unknown('spread argument');
    return ev.eval(a, env);
  };
  const serviceModel = ev.sdk.serviceModel(api.module);
  if (serviceModel !== undefined) {
    return serviceCall(ev, serviceModel, api.name, Boolean(api.admin), call, arg, env);
  }
  switch (api.module) {
    case 'auth': {
      if (api.name === 'getAuth' || api.name === 'initializeAuth') return { k: 'auth' };
      if (api.name === 'getIdTokenResult') {
        const userAlts = alternatives(ev.force(arg(0)));
        const authUsers = userAlts.filter(
          (a): a is Extract<AVal, { k: 'authUser' }> => a.k === 'authUser',
        );
        let exact = true;
        if (authUsers.length > 0) {
          exact = authUsers.every((u) => u.exact);
        }
        return { k: 'authTokenResult', exact };
      }
      if (SIGN_IN_CALLS.test(api.name)) return { k: 'credential' };
      return unknown(`result of ${api.name}()`);
    }
    case 'auth-hooks':
      if (api.name === AUTH_USER_FUNCTION) return { k: 'authUser', exact: true };
      if (api.name === 'useAuthState' || api.name === 'useIdToken') {
        return { k: 'arr', items: [{ k: 'authUser', exact: true }, { k: 'bool' }, unknown('auth error')] };
      }
      return unknown(`result of ${api.name}()`);
    case 'react':
      return reactCall(ev, api.name, call, arg);
    case 'sandbox-firestore':
    case 'sandbox-rtdb':
    case 'sandbox-storage':
    case 'rules-testing':
      return unknown(`result of ${api.name}()`);
    default:
      return unknown(`result of ${api.name}()`);
  }
}

function reactCall(ev: Evaluator, name: string, call: ts.CallExpression, arg: (i: number) => AVal): AVal {
  switch (name) {
    case 'useMemo': {
      const fn = ev.force(arg(0));
      if (fn.k === 'fn') return ev.callFunction(fn, []);
      return unknown('useMemo factory not traced');
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

/** Root of a ref built from a base argument: a parent ref, or a service handle. */
function baseRefs(
  ev: Evaluator,
  base: AVal,
  service: AssuranceService,
  fnName: string,
  admin = false,
): BaseRefOrigin[] {
  const callerBase = containsCallerSymbol(base);
  const forcedAlts = alternatives(ev.force(base));
  const hasConcreteBase = forcedAlts.some(
    (b) =>
      (b.k === 'ref' && b.service === service)
      || (b.k === 'db' && b.service === service)
      || b.k === 'instance',
  );
  const out: BaseRefOrigin[] = [];
  for (const b of forcedAlts) {
    if (b.k === 'ref' && b.service === service) {
      out.push({
        prefix: b.segments,
        resourceId: b.resourceId,
        built: b.built,
        notes: b.notes,
        refKind: b.refKind,
        fromCallers: Boolean(b.fromCallers || callerBase),
        admin: Boolean(b.admin || admin),
      });
    } else if (b.k === 'db' && b.service === service) {
      out.push({
        prefix: [],
        resourceId: b.resourceId,
        built: [],
        notes: b.notes ?? [],
        fromCallers: Boolean(b.fromCallers || callerBase),
        admin: Boolean(b.admin || admin),
      });
    } else if (b.k === 'instance') {
      out.push({ prefix: [], resourceId: DEFAULT_RESOURCE_ID, built: [], notes: [], admin });
    } else if (b.k === 'unknown') {
      if (hasConcreteBase && b.reason.startsWith('no in-project caller of ')) {
        continue;
      }
      out.push({
        prefix: [],
        resourceId: DEFAULT_RESOURCE_ID,
        built: [],
        notes: [`first argument of ${fnName}() was not traced (${b.reason}); assumed to be the database`],
        fromCallers: callerBase,
        admin,
      });
    }
  }
  return out;
}

function pathProducts(
  ev: Evaluator,
  service: AssuranceService,
  fnName: string,
  baseResourceId: string,
  isRootBase: boolean,
  forceUrlHeader: boolean,
  call: ts.CallExpression,
  from: number,
  to: number,
  arg: (i: number) => AVal,
): { resourceId: string; segments: Segment[]; notes: string[]; fromCallers?: boolean }[] {
  let acc: { resourceId: string; segments: Segment[]; notes: string[]; fromCallers?: boolean }[] = [
    { resourceId: baseResourceId, segments: [], notes: [] },
  ];
  const count = to - from;
  for (let i = from; i < to; i++) {
    const next: { resourceId: string; segments: Segment[]; notes: string[]; fromCallers?: boolean }[] = [];
    for (const a of acc) {
      const checkHeader = (isRootBase && i === from) || forceUrlHeader;
      let splitInputs: HeaderAlternative[];
      if (checkHeader) {
        splitInputs = splitHeaderAlternatives(
          service,
          fnName,
          arg(i),
          a.resourceId,
          (v) => ev.force(v),
          forceUrlHeader,
        );
      } else {
        splitInputs = [{ resourceId: a.resourceId, value: arg(i) }];
      }
      for (const input of splitInputs) {
        const alts = segmentsOf(input.value, call.arguments[i], count === 1, (v) => ev.force(v));
        for (const s of alts) {
          let notes = a.notes;
          if (input.note !== undefined || s.note !== undefined) {
            notes = [...a.notes];
            if (input.note !== undefined) notes.push(input.note);
            if (s.note !== undefined) notes.push(s.note);
          }
          next.push({
            resourceId: input.resourceId,
            segments: [...a.segments, ...s.segments],
            notes,
            fromCallers: a.fromCallers || s.fromCallers || input.fromCallers,
          });
        }
      }
    }
    acc = next.slice(0, 32);
  }
  return acc;
}

function buildRefsFromBases(
  ev: Evaluator,
  bases: readonly BaseRefOrigin[],
  service: AssuranceService,
  refKind: RefKind,
  call: ts.CallExpression,
  arg: (i: number) => AVal,
  fnName: string,
  fromArg: number,
  pathArgsEnd: number,
  forceUrlHeader: boolean,
  append?: Segment,
): AVal {
  const out: AVal[] = [];
  for (const base of bases) {
    const products = pathProducts(
      ev,
      service,
      fnName,
      base.resourceId,
      base.prefix.length === 0,
      forceUrlHeader,
      call,
      fromArg,
      pathArgsEnd,
      arg,
    );
    for (const p of products) {
      const segments = [...base.prefix, ...p.segments];
      if (append) segments.push(append);
      const ref: RefVal = {
        k: 'ref',
        service,
        resourceId: p.resourceId,
        refKind,
        segments,
        built: [...base.built, call],
        notes: [...base.notes, ...p.notes],
      };
      if (p.fromCallers || base.fromCallers) ref.fromCallers = true;
      if (base.admin) ref.admin = true;
      out.push(ref);
    }
  }
  if (out.length === 0) return unknown(`${fnName}() on a value that is not a ${service} ref`);
  return union(out);
}

function applyRefPassthrough(
  ev: Evaluator,
  targetVal: AVal,
  service: AssuranceService,
  name: string,
  call: ts.CallExpression,
  admin = false,
): AVal {
  const out: AVal[] = [];
  for (const alt of alternatives(ev.force(targetVal))) {
    if (alt.k === 'ref' && alt.service === service) {
      const next: RefVal = {
        ...alt,
        built: [...alt.built, call],
      };
      if (admin || alt.admin) next.admin = true;
      if (alt.baseRef && (admin || alt.baseRef.admin)) {
        next.baseRef = { ...alt.baseRef, admin: true };
      }
      out.push(next);
    } else if (alt.k === 'unknown') {
      out.push(unknown(`${name}() base was not traced: ${alt.reason}`));
    }
  }
  if (out.length === 0) return unknown(`${name}() on a value that is not a ${service} ref`);
  return union(out);
}

function evalCollectionGroupFromBases(
  ev: Evaluator,
  bases: readonly BaseRefOrigin[],
  service: AssuranceService,
  name: string,
  spec: RefConstructorSpec,
  call: ts.CallExpression,
  rawId: AVal,
  idExpr: ts.Expression | undefined,
): AVal {
  const idFromCallers = containsCallerSymbol(rawId);
  const idAlts = alternatives(ev.force(rawId)).slice(0, 32);
  const effectiveIdAlts: AVal[] = idAlts.length > 0 ? idAlts : [unknown('empty collection group id')];
  const fallbackId = expressionName(idExpr);
  const out: AVal[] = [];
  for (const base of bases) {
    for (const idAlt of effectiveIdAlts) {
      const litId = literalText(idAlt);
      const leafSeg: Segment =
        litId !== null && litId.length > 0 ? [{ kind: 'lit', text: litId }] : [hole(fallbackId)];
      const segments: Segment[] = [[hole('path=**')], leafSeg];
      const notes = [...base.notes];
      if (litId === null || litId.length === 0) {
        notes.push(`collection group id '${fallbackId}' was not traced`);
      }
      const ref: RefVal = {
        k: 'ref',
        service,
        resourceId: base.resourceId,
        refKind: spec.refKind,
        segments,
        built: [...base.built, call],
        notes,
      };
      if (base.fromCallers || idFromCallers) ref.fromCallers = true;
      if (base.admin) ref.admin = true;
      out.push(ref);
    }
  }
  if (out.length === 0) return unknown(`${name}() on a value that is not a ${service} handle`);
  return union(out);
}

function evalRefConstructor(
  ev: Evaluator,
  service: AssuranceService,
  name: string,
  spec: RefConstructorSpec,
  call: ts.CallExpression,
  arg: (i: number) => AVal,
  admin = false,
): AVal {
  if (spec.mode === 'passthrough') {
    return applyRefPassthrough(ev, arg(0), service, name, call, admin);
  }
  if (spec.mode === 'collectionGroup') {
    const bases = baseRefs(ev, arg(0), service, name, admin);
    return evalCollectionGroupFromBases(ev, bases, service, name, spec, call, arg(1), call.arguments[1]);
  }
  if (spec.mode === 'url') {
    if (call.arguments.length === 1) {
      const defaultBase: BaseRefOrigin = { prefix: [], resourceId: DEFAULT_RESOURCE_ID, built: [], notes: [], admin };
      return buildRefsFromBases(ev, [defaultBase], service, spec.refKind, call, arg, name, 0, 1, true);
    }
    const bases = baseRefs(ev, arg(0), service, name, admin);
    return buildRefsFromBases(ev, bases, service, spec.refKind, call, arg, name, 1, Math.min(2, call.arguments.length), true);
  }
  const bases = baseRefs(ev, arg(0), service, name, admin);
  if (call.arguments.length === 1 && spec.singleArgAppendHole) {
    return buildRefsFromBases(ev, bases, service, spec.refKind, call, arg, name, 1, 1, false, [hole(spec.singleArgAppendHole)]);
  }
  let append: Segment | undefined;
  if (spec.appendHole) {
    append = [hole(spec.appendHole)];
  }
  let end = call.arguments.length;
  if (spec.pathArgsEnd !== undefined) {
    end = Math.min(call.arguments.length, spec.pathArgsEnd);
  }
  return buildRefsFromBases(ev, bases, service, spec.refKind, call, arg, name, 1, end, false, append);
}

const MIN_TIMESTAMP_SECONDS = -62_135_596_800;
const MAX_TIMESTAMP_SECONDS = 253_402_300_799;

function finiteNumberArg(
  ev: Evaluator,
  argExpr: ts.Expression | undefined,
  env: Env | undefined,
): number | undefined {
  if (!argExpr || ts.isSpreadElement(argExpr)) return undefined;
  const forced = ev.force(ev.eval(argExpr, env));
  if (forced.k === 'num' && forced.value !== undefined && Number.isFinite(forced.value)) {
    return forced.value;
  }
  return undefined;
}

/** Evaluate `new Export(...)` on an SDK export (such as `new FieldPath('a', 'b')`). */
export function apiNew(ev: Evaluator, api: Api, node: ts.NewExpression, env: Env | undefined): AVal {
  if (api.name === 'FieldPath' && node.arguments && node.arguments.length > 0) {
    const segments: string[] = [];
    for (const argExpr of node.arguments) {
      if (ts.isSpreadElement(argExpr)) return unknown('new FieldPath(...spread)');
      const text = literalText(ev.force(ev.eval(argExpr, env)));
      if (text === null) return unknown('new FieldPath() segment not literal');
      segments.push(text);
    }
    return lit(segments.join('.'));
  }
  if (api.module === 'firestore' && api.name === 'Timestamp' && node.arguments?.length === 2) {
    const seconds = finiteNumberArg(ev, node.arguments[0], env);
    const nanoseconds = finiteNumberArg(ev, node.arguments[1], env);
    if (
      seconds !== undefined
      && nanoseconds !== undefined
      && Number.isInteger(seconds)
      && Number.isInteger(nanoseconds)
      && seconds >= MIN_TIMESTAMP_SECONDS
      && seconds <= MAX_TIMESTAMP_SECONDS
      && nanoseconds >= 0
      && nanoseconds < 1_000_000_000
    ) {
      return {
        k: 'wrapper',
        value: {
          wrapperKind: 'timestamp',
          seconds,
          nanoseconds: Math.floor(nanoseconds / 1_000) * 1_000,
        },
      };
    }
  }
  if (api.module === 'firestore' && api.name === 'GeoPoint' && node.arguments?.length === 2) {
    const latitude = finiteNumberArg(ev, node.arguments[0], env);
    const longitude = finiteNumberArg(ev, node.arguments[1], env);
    if (
      latitude !== undefined
      && longitude !== undefined
      && latitude >= -90
      && latitude <= 90
      && longitude >= -180
      && longitude <= 180
    ) {
      return {
        k: 'wrapper',
        value: { wrapperKind: 'latlng', latitude, longitude },
      };
    }
  }
  return unknown(`new ${api.name}()`);
}

function serviceCall(
  ev: Evaluator,
  model: SdkServiceModel,
  name: string,
  admin: boolean,
  call: ts.CallExpression,
  arg: (i: number) => AVal,
  env: Env | undefined,
): AVal {
  const handleSpec = ownRecordValue(model.handleFactories, name);
  if (handleSpec) {
    return evalHandleFactory(ev, model.service, name, handleSpec, call, arg, admin);
  }
  const refSpec = ownRecordValue(model.refConstructors, name);
  if (refSpec) {
    return evalRefConstructor(ev, model.service, name, refSpec, call, arg, admin);
  }
  if (model.queryBuilder === name) {
    const queryVal = evalQueryCall(ev, model.service, call, arg, env);
    if (!admin) return queryVal;
    return union(
      alternatives(queryVal).map((alt) => {
        if (alt.k !== 'ref') return alt;
        const next: RefVal = { ...alt, admin: true };
        if (alt.baseRef) next.baseRef = { ...alt.baseRef, admin: true };
        return next;
      }),
    );
  }
  const receiverSpec = ownRecordValue(model.receiverFactories, name);
  if (receiverSpec) {
    let ref: AVal | undefined;
    if (receiverSpec.refArgIndex !== undefined) ref = arg(receiverSpec.refArgIndex);
    const firstArgAlts = call.arguments.length > 0 ? alternatives(ev.force(arg(0))) : [];
    const argIsAdmin = firstArgAlts.some((a) => (a.k === 'db' || a.k === 'ref') && Boolean(a.admin));
    const outReceiver: Extract<AVal, { k: 'receiver' }> = {
      k: 'receiver',
      service: model.service,
      receiverKind: receiverSpec.receiverKind,
      ref,
    };
    if (admin || argIsAdmin) outReceiver.admin = true;
    return outReceiver;
  }
  const fieldValue = ownRecordValue(model.fieldValues, name);
  if (fieldValue) {
    return { k: 'fieldValue', name: fieldValue };
  }
  const special = ownRecordValue(model.specialStrings, name);
  if (special !== undefined) {
    return { k: 'str', parts: [{ kind: 'lit', text: special }] };
  }
  const constraintSpec = ownRecordValue(model.constraints, name);
  if (constraintSpec) {
    return evalConstraintCall(ev, constraintSpec, call, arg, env);
  }
  if (model.service === 'firestore') {
    if (name === 'Timestamp.fromMillis' && call.arguments.length === 1) {
      const ms = finiteNumberArg(ev, call.arguments[0], env);
      const wrapped = ms !== undefined ? timestampWrapperFromMillis(ms) : undefined;
      if (wrapped !== undefined) return { k: 'wrapper', value: wrapped };
    }
    if (name === 'Timestamp.fromDate' && call.arguments.length === 1) {
      const forcedDate = ev.force(arg(0));
      if (forcedDate.k === 'wrapper' && forcedDate.value.wrapperKind === 'timestamp') {
        return forcedDate;
      }
    }
    if (name === 'Bytes.fromUint8Array' && call.arguments.length === 1) {
      const bytes = literalUint8Bytes(ev.force(arg(0)));
      if (bytes !== undefined) {
        return { k: 'wrapper', value: { wrapperKind: 'bytes', bytes } };
      }
    }
    if (name === 'Bytes.fromBase64String' && call.arguments.length === 1) {
      const b64 = literalText(ev.force(arg(0)));
      if (b64 !== null) {
        const bytes = decodeBase64Bytes(b64);
        if (bytes !== undefined) {
          return { k: 'wrapper', value: { wrapperKind: 'bytes', bytes } };
        }
      }
    }
  }
  return unknown(`result of ${model.service} ${name}()`);
}

/** Evaluate a declarative handle/ref method call (`adminStorage.bucket(...)`, `bucket.file(...)`). */
export function serviceMemberCall(
  ev: Evaluator,
  call: ts.CallExpression,
  env: Env | undefined,
): AVal | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const methodName = call.expression.name.text;
  const receiverVal = ev.force(ev.eval(call.expression.expression, env));
  const arg = (i: number): AVal => {
    const a = call.arguments[i];
    if (!a) return { k: 'undefined' };
    if (ts.isSpreadElement(a)) return unknown('spread argument');
    return ev.eval(a, env);
  };
  const out: AVal[] = [];
  for (const r of alternatives(receiverVal)) {
    if (r.k === 'db') {
      const model = ev.sdk.serviceModel(r.service);
      const subSpec = ownRecordValue(model?.handleSubFactories, methodName);
      if (subSpec) {
        if (call.arguments.length === 0) {
          out.push(r);
          continue;
        }
        const firstAlts = alternatives(ev.force(arg(0)));
        if (firstAlts.length === 1 && firstAlts[0]?.k === 'undefined') {
          out.push(r);
          continue;
        }
        out.push(evalHandleFactory(ev, r.service, methodName, subSpec, call, arg, Boolean(r.admin)));
        continue;
      }
      const receiverSpec = ownRecordValue(model?.handleReceiverMethods, methodName);
      if (receiverSpec) {
        const outReceiver: Extract<AVal, { k: 'receiver' }> = {
          k: 'receiver',
          service: r.service,
          receiverKind: receiverSpec.receiverKind,
        };
        if (r.admin) outReceiver.admin = true;
        out.push(outReceiver);
        continue;
      }
      const refSpec = ownRecordValue(model?.handleRefMethods, methodName);
      if (refSpec && refSpec.allowOnHandle !== false) {
        const origin: BaseRefOrigin = {
          prefix: [],
          resourceId: r.resourceId,
          built: [],
          notes: r.notes ?? [],
          fromCallers: Boolean(r.fromCallers),
          admin: Boolean(r.admin),
        };
        if (refSpec.mode === 'collectionGroup') {
          out.push(
            evalCollectionGroupFromBases(
              ev,
              [origin],
              r.service,
              methodName,
              refSpec,
              call,
              arg(0),
              call.arguments[0],
            ),
          );
          continue;
        }
        if (call.arguments.length === 0 && refSpec.singleArgAppendHole) {
          out.push(
            buildRefsFromBases(ev, [origin], r.service, refSpec.refKind, call, arg, methodName, 0, 0, false, [
              hole(refSpec.singleArgAppendHole),
            ]),
          );
          continue;
        }
        let end = call.arguments.length;
        if (refSpec.pathArgsEnd !== undefined) end = Math.min(call.arguments.length, refSpec.pathArgsEnd);
        let append: Segment | undefined;
        if (refSpec.appendHole) append = [hole(refSpec.appendHole)];
        out.push(
          buildRefsFromBases(ev, [origin], r.service, refSpec.refKind, call, arg, methodName, 0, end, refSpec.mode === 'url', append),
        );
      }
    } else if (r.k === 'ref') {
      const model = ev.sdk.serviceModel(r.service);
      const receiverSpec = ownRecordValue(model?.handleReceiverMethods, methodName);
      if (receiverSpec) {
        const outReceiver: Extract<AVal, { k: 'receiver' }> = {
          k: 'receiver',
          service: r.service,
          receiverKind: receiverSpec.receiverKind,
          ref: r,
        };
        if (r.admin) outReceiver.admin = true;
        out.push(outReceiver);
        continue;
      }
      const refSpec = ownRecordValue(model?.handleRefMethods, methodName);
      if (refSpec && refSpec.allowOnRef !== false) {
        if (refSpec.mode === 'passthrough') {
          out.push(applyRefPassthrough(ev, r, r.service, methodName, call, Boolean(r.admin)));
          continue;
        }
        const origin: BaseRefOrigin = {
          prefix: r.segments,
          resourceId: r.resourceId,
          built: r.built,
          notes: r.notes,
          refKind: r.refKind,
          fromCallers: Boolean(r.fromCallers),
          admin: Boolean(r.admin),
        };
        if (call.arguments.length === 0 && refSpec.singleArgAppendHole) {
          out.push(
            buildRefsFromBases(ev, [origin], r.service, refSpec.refKind, call, arg, methodName, 0, 0, false, [
              hole(refSpec.singleArgAppendHole),
            ]),
          );
          continue;
        }
        let end = call.arguments.length;
        if (refSpec.pathArgsEnd !== undefined) end = Math.min(call.arguments.length, refSpec.pathArgsEnd);
        let append: Segment | undefined;
        if (refSpec.appendHole) append = [hole(refSpec.appendHole)];
        out.push(
          buildRefsFromBases(ev, [origin], r.service, refSpec.refKind, call, arg, methodName, 0, end, refSpec.mode === 'url', append),
        );
        continue;
      }
      const constraintSpec =
        model?.chainedConstraints && !methodName.includes('.')
          ? ownRecordValue(model.constraints, methodName)
          : undefined;
      if (constraintSpec) {
        const cVal = evalConstraintCall(ev, constraintSpec, call, arg, env);
        for (const cAlt of alternatives(ev.force(cVal))) {
          const c = cAlt.k === 'constraint' ? cAlt.value : { kind: 'unknown' };
          out.push({
            ...r,
            built: [...r.built, call],
            constraints: [...(r.constraints ?? []), c],
            baseRef: r.baseRef ?? r,
            firstQueryCall: r.firstQueryCall ?? call,
            queryCall: call,
          } satisfies RefVal);
        }
      }
    } else if (r.k === 'receiver') {
      const receiverTable = ownRecordValue(ev.sdk.serviceModel(r.service)?.receiverMethods, r.receiverKind);
      const methodSpec = ownRecordValue(receiverTable, methodName);
      if (methodSpec && methodSpec.write && !methodSpec.usesReceiverRef) {
        out.push(r);
      }
    }
  }
  if (out.length === 0) return undefined;
  return union(out);
}

/** The value a handle method (`db.runTransaction(...)`, `ref.transaction(...)`) passes to its callback parameter. */
export function memberCallbackParameter(
  ev: Evaluator,
  call: ts.CallExpression,
  argIndex: number,
  paramIndex: number,
): AVal | undefined {
  if (!ts.isPropertyAccessExpression(call.expression) || argIndex !== 0) return undefined;
  const methodName = call.expression.name.text;
  const receiverVal = ev.force(ev.eval(call.expression.expression));
  const out: AVal[] = [];
  for (const r of alternatives(receiverVal)) {
    if (r.k === 'db') {
      const model = ev.sdk.serviceModel(r.service);
      const callbackSpecs = ownRecordValue(model?.callbackReceivers, methodName);
      if (callbackSpecs && Object.hasOwn(callbackSpecs, paramIndex)) {
        const receiverKind = callbackSpecs[paramIndex];
        if (receiverKind !== undefined) {
          const rec: Extract<AVal, { k: 'receiver' }> = {
            k: 'receiver',
            service: r.service,
            receiverKind,
          };
          if (r.admin) rec.admin = true;
          out.push(rec);
        }
      } else if (methodName === 'runTransaction') {
        out.push(unknown('current value inside a transaction'));
      }
    } else if (r.k === 'ref' && methodName === 'transaction') {
      out.push(unknown('current value inside a transaction'));
    }
  }
  return out.length > 0 ? union(out) : undefined;
}

/** The value an SDK passes to a callback's parameter. */
export function apiCallbackParameter(ev: Evaluator, api: Api, paramIndex: number): AVal {
  if (
    api.module === 'auth'
    && /^(?:onAuthStateChanged|onIdTokenChanged|beforeAuthStateChanged)$/.test(api.name)
    && paramIndex === 0
  ) {
    return { k: 'authUser', exact: true };
  }
  const model = ev.sdk.serviceModel(api.module);
  if (model !== undefined) {
    const callbackSpecs = ownRecordValue(model.callbackReceivers, api.name);
    if (callbackSpecs && Object.hasOwn(callbackSpecs, paramIndex)) {
      const receiverKind = callbackSpecs[paramIndex];
      if (receiverKind !== undefined) {
        const rec: Extract<AVal, { k: 'receiver' }> = {
          k: 'receiver',
          service: model.service,
          receiverKind,
        };
        if (api.admin) rec.admin = true;
        return rec;
      }
    }
    if (api.name === 'runTransaction') return unknown('current value inside a transaction');
  }
  if (api.module === 'react') return unknown(`argument React passes to a ${api.name} callback`);
  return unknown(`argument ${api.name} passes to its callback`);
}
