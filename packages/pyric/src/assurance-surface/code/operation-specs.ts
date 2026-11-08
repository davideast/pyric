/**
 * Declarative operation index derived from registered {@link SdkServiceModel}s,
 * plus call-name and write-classification helpers.
 */
import ts from 'typescript';
import { DEFAULT_SERVICE_MODELS } from './sdk-imports.js';
import type { OpSpec, SdkServiceModel } from './service-models/types.js';
import type { AccessService } from './types.js';

export type { OpSpec } from './service-models/types.js';

/** One recognised SDK operation call and how to re-evaluate it. */
export interface OpCall {
  call: ts.CallExpression;
  service: AccessService;
  spec: OpSpec;
  via?: 'batch' | 'transaction';
  /** For receiver-bound operations (`onDisconnect(ref).set(...)`): the receiver whose value carries the ref. */
  receiverExpr?: ts.Expression;
}

export interface TransactionMethodEntry {
  readonly service: AccessService;
  readonly spec: OpSpec;
}

export interface OperationIndex {
  readonly apiNames: ReadonlySet<string>;
  readonly methodNames: ReadonlySet<string>;
  readonly handleRefMethodNames: ReadonlySet<string>;
  readonly transactionMethods: ReadonlyMap<string, readonly TransactionMethodEntry[]>;
  readonly writeOps: ReadonlySet<string>;
  readonly readOps: ReadonlySet<string>;
}

/** Build fast call-site filter sets from declarative service models. */
export function buildOperationIndex(models: readonly SdkServiceModel[]): OperationIndex {
  const apiNames = new Set<string>();
  const methodNames = new Set<string>();
  const handleRefMethodNames = new Set<string>();
  const transactionMethods = new Map<string, TransactionMethodEntry[]>();
  const writeOps = new Set<string>();
  const readOps = new Set<string>(['get', 'query']);

  for (const model of models) {
    for (const [name, spec] of Object.entries(model.operations)) {
      apiNames.add(name);
      if (spec.write) writeOps.add(spec.op);
      if (spec.read || spec.readKind) readOps.add(spec.op);
    }
    for (const name of Object.keys(model.refConstructors)) {
      apiNames.add(name);
    }
    for (const name of Object.keys(model.handleRefMethods ?? {})) {
      handleRefMethodNames.add(name);
    }
    if (model.queryBuilder) {
      apiNames.add(model.queryBuilder);
    }
    for (const [methodName, spec] of Object.entries(model.refMethods ?? {})) {
      methodNames.add(methodName);
      if (spec.write) writeOps.add(spec.op);
      if (spec.read || spec.readKind) readOps.add(spec.op);
    }
    for (const [receiverKind, methods] of Object.entries(model.receiverMethods ?? {})) {
      for (const [methodName, spec] of Object.entries(methods)) {
        methodNames.add(methodName);
        if (spec.write) writeOps.add(spec.op);
        if (spec.read || spec.readKind) readOps.add(spec.op);
        if (receiverKind === 'transaction') {
          const list = transactionMethods.get(methodName) ?? [];
          list.push({ service: model.service, spec });
          transactionMethods.set(methodName, list);
        }
      }
    }
  }

  return { apiNames, methodNames, handleRefMethodNames, transactionMethods, writeOps, readOps };
}

const DEFAULT_OP_INDEX = buildOperationIndex(DEFAULT_SERVICE_MODELS);

/** Evaluation steps allowed per call site before its trace stops as `unknown`. */
export const STEP_BUDGET = 100_000;

export function isWriteOp(op: string, extraWriteOps?: ReadonlySet<string>): boolean {
  if (DEFAULT_OP_INDEX.writeOps.has(op)) return true;
  return extraWriteOps?.has(op) ?? false;
}

export function isReadOp(op: string, extraReadOps?: ReadonlySet<string>): boolean {
  if (DEFAULT_OP_INDEX.readOps.has(op)) return true;
  return extraReadOps?.has(op) ?? false;
}

export function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}
