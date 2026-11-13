/**
 * Evaluates SDK exports against registered {@link SdkServiceModel} tables,
 * plus Firebase Auth, auth hooks, and React state/memo/context helpers.
 */
import ts from 'typescript';
import { decodeBase64Bytes, literalUint8Bytes } from './binary-constructors.js';
import { timestampWrapperFromMillis } from './builtins.js';
import type { Evaluator } from './evaluator.js';
import { hole } from './paths.js';
import { evalConstraintCall, evalQueryCall } from './query-constraints.js';
import { evalHandleFactory } from './resource-headers.js';
import { AUTH_USER_FUNCTION } from './sdk-imports.js';
import {
  applyRefPassthrough,
  buildRefsFromBases,
  evalCollectionGroupFromBases,
  evalRefConstructor,
  type BaseRefOrigin,
} from './sdk-ref-builders.js';
import type { ConstraintSpec, SdkServiceModel } from './service-models/types.js';
import {
  alternatives,
  lit,
  literalText,
  ownRecordValue,
  union,
  unknown,
  type AVal,
  type Env,
  type Segment,
} from './values.js';

type Api = Extract<AVal, { k: 'api' }>;
type RefVal = Extract<AVal, { k: 'ref' }>;

const SIGN_IN_CALLS = /^(?:signIn\w*|createUserWithEmailAndPassword|getRedirectResult|link\w*|reauthenticate\w*)$/;
const MIN_TIMESTAMP_SECONDS = -62_135_596_800;
const MAX_TIMESTAMP_SECONDS = 253_402_300_799;

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
    let firstArgAlts: AVal[] = [];
    if (call.arguments.length > 0) firstArgAlts = alternatives(ev.force(arg(0)));
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
      let wrapped: ReturnType<typeof timestampWrapperFromMillis>;
      if (ms !== undefined) wrapped = timestampWrapperFromMillis(ms);
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
      let constraintSpec: ConstraintSpec | undefined;
      if (model?.chainedConstraints && !methodName.includes('.')) {
        constraintSpec = ownRecordValue(model.constraints, methodName);
      }
      if (constraintSpec) {
        const cVal = evalConstraintCall(ev, constraintSpec, call, arg, env);
        for (const cAlt of alternatives(ev.force(cVal))) {
          let c: NonNullable<RefVal['constraints']>[number] = { kind: 'unknown' };
          if (cAlt.k === 'constraint') c = cAlt.value;
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
  if (out.length === 0) return undefined;
  return union(out);
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
