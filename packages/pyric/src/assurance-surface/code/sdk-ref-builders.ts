/**
 * Reference construction, passthrough, and `collectionGroup` path composition
 * for declarative {@link SdkServiceModel} reference constructors.
 */
import ts from 'typescript';
import type { AssuranceService } from '../../sandbox/internal/resource-pattern.js';
import { DEFAULT_RESOURCE_ID } from '../../sandbox/internal/resource-pattern-header.js';
import type { Evaluator } from './evaluator.js';
import { expressionName, hole, segmentsOf } from './paths.js';
import {
  containsCallerSymbol,
  splitHeaderAlternatives,
  type HeaderAlternative,
} from './resource-headers.js';
import type { RefConstructorSpec } from './service-models/types.js';
import {
  alternatives,
  literalText,
  union,
  unknown,
  type AVal,
  type RefKind,
  type Segment,
} from './values.js';

type RefVal = Extract<AVal, { k: 'ref' }>;

export interface BaseRefOrigin {
  prefix: Segment[];
  resourceId: string;
  built: ts.Node[];
  notes: string[];
  refKind?: RefKind;
  fromCallers?: boolean;
  admin?: boolean;
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

export function buildRefsFromBases(
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

export function applyRefPassthrough(
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

export function evalCollectionGroupFromBases(
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
  let effectiveIdAlts: AVal[] = [unknown('empty collection group id')];
  if (idAlts.length > 0) effectiveIdAlts = idAlts;
  const fallbackId = expressionName(idExpr);
  const out: AVal[] = [];
  for (const base of bases) {
    for (const idAlt of effectiveIdAlts) {
      const litId = literalText(idAlt);
      let leafSeg: Segment = [hole(fallbackId)];
      if (litId !== null && litId.length > 0) {
        leafSeg = [{ kind: 'lit', text: litId }];
      }
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

export function evalRefConstructor(
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
