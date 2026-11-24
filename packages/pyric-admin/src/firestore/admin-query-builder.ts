/**
 * Admin-SDK `Query` constraint builder (`where`, `applyFilter`, `orderBy`,
 * `limit`, `limitToLast`, `offset`, `select`, `withConverter`, and cursor
 * bounds) with `replayOnRoot` tracking and numeric gRPC error translation.
 */

import { SandboxError } from 'pyric/sandbox';
import type {
  DocumentSnapshot,
  Filter as CompatFilter,
  Query,
  SnapshotFieldPath,
} from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import {
  assertValidConverterOrNull,
  type AdminFirestoreDataConverter,
} from './admin-converter-and-discovery.js';
import {
  applyAdminCursorArgs,
  compileAdminFilter,
  isAdminFilterInstance,
} from './admin-filter-aggregate-cursors.js';
import { runWithAdminErrorsSync } from './admin-grpc-errors.js';
import { isAppBackedRoot } from './admin-handle-registry.js';
import { resolveTerminalQueryMethod } from './admin-query-execution.js';
import {
  parseSelectFieldPaths,
  validateAdminOffsetInteger,
} from './admin-query-extensions.js';
import {
  normalizeCompositeFilter,
  normalizeLegacyQueryOperand,
  resolveDocumentIdCursorString,
  serializeCursorOperandForSignature,
  unwrapCursorSnapshotForAdmin,
  validateAdminLimitInteger,
  validateAndNormalizeOrderByArgs,
  validateAndNormalizeWhereArgs,
  type AdminQueryMetadata,
} from './admin-query-validation.js';
import { isAdminQueryEqual } from './admin-reference-and-snapshot-equality.js';
import type { DocRefBuilder } from './admin-snapshot-adapter.js';

export type QueryWrapperFn = (
  rawQuery: Query,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  meta: AdminQueryMetadata,
  converter?: AdminFirestoreDataConverter,
) => Query;

function chainReplay(
  meta: AdminQueryMetadata,
  step: (q: Query, db: SandboxFirestore) => Query,
): ((db: SandboxFirestore) => Query) | undefined {
  const prev = meta.replayOnRoot;
  if (prev === undefined) {
    return undefined;
  }
  return (db: SandboxFirestore) => step(prev(db), db);
}

export function resolveWrappedQueryProperty(
  target: Query,
  receiverQuery: Query,
  prop: PropertyKey,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  docRefOnRoot: DocRefBuilder,
  wrapQuery: QueryWrapperFn,
  meta: AdminQueryMetadata,
  converter?: AdminFirestoreDataConverter,
): unknown | undefined {
  const terminal = resolveTerminalQueryMethod(
    target,
    receiverQuery,
    prop,
    rawDb,
    rootDb,
    docRefOnRoot,
    meta,
    converter,
  );
  if (terminal !== undefined) return terminal;

  const appBacked = isAppBackedRoot(rootDb);

  switch (prop) {
    case 'firestore':
      return rootDb;
    case 'isEqual':
      return (other: unknown) => isAdminQueryEqual(receiverQuery, other);
    case 'where':
      return (...args: unknown[]) =>
        runWithAdminErrorsSync(appBacked, () => {
          if (isAdminFilterInstance(args[0])) {
            if (meta.hasCursorBound === true) {
              throw new SandboxError(
                'invalid-argument',
                'Cannot specify a where() filter after calling startAt(), startAfter(), endBefore() or endAt().',
              );
            }
            const filterArg = args[0];
            const compiled = compileAdminFilter(filterArg, meta, rootDb);
            if (compiled === null) {
              const emptyMeta: AdminQueryMetadata = {
                ...meta,
                isCollectionGroupRoot: false,
                replayOnRoot: chainReplay(meta, (q) =>
                  (q as unknown as { where(f: unknown): Query }).where(filterArg),
                ),
              };
              return wrapQuery(target, rawDb, rootDb, emptyMeta, converter);
            }
            const nextMeta: AdminQueryMetadata = {
              ...meta,
              isCollectionGroupRoot: false,
              signature: [...meta.signature, `filter:${JSON.stringify(compiled)}`],
              replayOnRoot: chainReplay(meta, (q) =>
                (q as unknown as { where(f: unknown): Query }).where(filterArg),
              ),
            };
            return wrapQuery(target.applyFilter(compiled), rawDb, rootDb, nextMeta, converter);
          }
          if (meta.hasCursorBound === true) {
            throw new SandboxError(
              'invalid-argument',
              'Cannot specify a where() filter after calling startAt(), startAfter(), endBefore() or endAt().',
            );
          }
          const normalized = validateAndNormalizeWhereArgs(args[0], args[1], args[2], meta, rootDb);
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            isCollectionGroupRoot: false,
            signature: [
              ...meta.signature,
              `where:${String(normalized.field)}:${normalized.op}:${JSON.stringify(normalized.value)}`,
            ],
            replayOnRoot: chainReplay(meta, (q) =>
              q.where(args[0] as SnapshotFieldPath, normalized.op, args[2]),
            ),
          };
          return wrapQuery(
            target.where(normalized.field, normalized.op, normalized.value),
            rawDb,
            rootDb,
            nextMeta,
            converter,
          );
        });
    case 'applyFilter':
      return (filter: CompatFilter) =>
        runWithAdminErrorsSync(appBacked, () => {
          const norm = normalizeCompositeFilter(filter, meta, rootDb);
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            isCollectionGroupRoot: false,
            signature: [...meta.signature, `apply:${JSON.stringify(norm)}`],
            replayOnRoot: chainReplay(meta, (q) => q.applyFilter(filter)),
          };
          return wrapQuery(target.applyFilter(norm), rawDb, rootDb, nextMeta, converter);
        });
    case 'orderBy':
      return (field: SnapshotFieldPath, direction?: unknown) =>
        runWithAdminErrorsSync(appBacked, () => {
          const normalized = validateAndNormalizeOrderByArgs(field, direction);
          if (meta.hasCursorBound === true) {
            throw new SandboxError(
              'invalid-argument',
              'Cannot specify an orderBy() constraint after calling startAt(), startAfter(), endBefore() or endAt().',
            );
          }
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            isCollectionGroupRoot: false,
            signature: [
              ...meta.signature,
              `order:${normalized.segments.join('.')}:${normalized.direction}`,
            ],
            orderByFields: [...meta.orderByFields, normalized.segments],
            hasExplicitOrderBy: true,
            replayOnRoot: chainReplay(meta, (q) => q.orderBy(field, normalized.direction)),
          };
          return wrapQuery(
            target.orderBy(normalized.field, normalized.direction),
            rawDb,
            rootDb,
            nextMeta,
            converter,
          );
        });
    case 'limit':
      return (n: number) =>
        runWithAdminErrorsSync(appBacked, () => {
          const parsed = validateAdminLimitInteger('limit', n);
          let targetLimit = parsed;
          if (meta.offsetCount !== undefined && meta.offsetCount > 0) {
            targetLimit = meta.offsetCount + parsed;
          }
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            isCollectionGroupRoot: false,
            pendingLimitType: 'first',
            limitCount: parsed,
            replayOnRoot: chainReplay(meta, (q) => q.limit(parsed)),
          };
          return wrapQuery(target.limit(targetLimit), rawDb, rootDb, nextMeta, converter);
        });
    case 'limitToLast':
      return (n: number) =>
        runWithAdminErrorsSync(appBacked, () => {
          const parsed = validateAdminLimitInteger('limitToLast', n);
          let targetLimit = parsed;
          if (meta.offsetCount !== undefined && meta.offsetCount > 0) {
            targetLimit = meta.offsetCount + parsed;
          }
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            isCollectionGroupRoot: false,
            pendingLimitType: 'last',
            limitCount: parsed,
            replayOnRoot: chainReplay(meta, (q) => q.limitToLast(parsed)),
          };
          return wrapQuery(target.limitToLast(targetLimit), rawDb, rootDb, nextMeta, converter);
        });
    case 'offset':
      return (n: number) =>
        runWithAdminErrorsSync(appBacked, () => {
          const parsed = validateAdminOffsetInteger(n);
          let nextTarget = target;
          if (parsed >= 0 && meta.limitCount !== undefined) {
            if (meta.pendingLimitType === 'first') {
              nextTarget = target.limit(parsed + meta.limitCount);
            } else if (meta.pendingLimitType === 'last') {
              nextTarget = target.limitToLast(parsed + meta.limitCount);
            }
          }
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            isCollectionGroupRoot: false,
            offsetCount: parsed,
            replayOnRoot: chainReplay(meta, (q) =>
              (q as unknown as { offset(k: number): Query }).offset(parsed),
            ),
          };
          return wrapQuery(nextTarget, rawDb, rootDb, nextMeta, converter);
        });
    case 'select':
      return (...fields: unknown[]) =>
        runWithAdminErrorsSync(appBacked, () => {
          const selectedFields = parseSelectFieldPaths(fields);
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            isCollectionGroupRoot: false,
            selectedFields,
            replayOnRoot: chainReplay(meta, (q) =>
              (q as unknown as { select(...f: unknown[]): Query }).select(...fields),
            ),
          };
          return wrapQuery(target, rawDb, rootDb, nextMeta, undefined);
        });
    case 'withConverter':
      return (nextConv: unknown) =>
        runWithAdminErrorsSync(appBacked, () =>
          wrapQuery(target, rawDb, rootDb, meta, assertValidConverterOrNull(nextConv)),
        );
    case 'startAt':
    case 'startAfter':
    case 'endAt':
    case 'endBefore':
      return (...args: unknown[]) =>
        runWithAdminErrorsSync(appBacked, () => {
          const applied = applyAdminCursorArgs(target, prop, args, meta, rootDb);
          const isStart = prop === 'startAt' || prop === 'startAfter';
          let nextMeta: AdminQueryMetadata;
          if (isStart) {
            nextMeta = {
              ...meta,
              isCollectionGroupRoot: false,
              hasCursorBound: true,
              startSignature: applied.cursorSignature,
              replayOnRoot: chainReplay(meta, (q) =>
                (q as unknown as Record<typeof prop, (...a: unknown[]) => Query>)[prop](...args),
              ),
            };
          } else {
            nextMeta = {
              ...meta,
              isCollectionGroupRoot: false,
              hasCursorBound: true,
              endSignature: applied.cursorSignature,
              replayOnRoot: chainReplay(meta, (q) =>
                (q as unknown as Record<typeof prop, (...a: unknown[]) => Query>)[prop](...args),
              ),
            };
          }
          return wrapQuery(applied.nextTarget, rawDb, rootDb, nextMeta, converter);
        });
    case 'startCursor':
      return (values: unknown[], inclusive: boolean, fromSnapshot?: boolean) =>
        runWithAdminErrorsSync(appBacked, () =>
          wrapQuery(
            target.startCursor(
              values.map((item, idx) => {
                const orderField = meta.orderByFields[idx];
                const isDocIdOrder =
                  !fromSnapshot &&
                  orderField !== undefined &&
                  orderField.length === 1 &&
                  orderField[0] === '__name__';
                if (isDocIdOrder) {
                  return resolveDocumentIdCursorString(item, meta.source, rootDb);
                }
                return normalizeLegacyQueryOperand(item, rootDb);
              }),
              inclusive,
              fromSnapshot,
            ),
            rawDb,
            rootDb,
            {
              ...meta,
              isCollectionGroupRoot: false,
              startSignature: `rawVals:${String(inclusive)}:${values.map(serializeCursorOperandForSignature).join('|')}`,
              replayOnRoot: chainReplay(meta, (q) =>
                q.startCursor(values, inclusive, fromSnapshot),
              ),
            },
            converter,
          ),
        );
    case 'endCursor':
      return (values: unknown[], inclusive: boolean, fromSnapshot?: boolean) =>
        runWithAdminErrorsSync(appBacked, () =>
          wrapQuery(
            target.endCursor(
              values.map((item, idx) => {
                const orderField = meta.orderByFields[idx];
                const isDocIdOrder =
                  !fromSnapshot &&
                  orderField !== undefined &&
                  orderField.length === 1 &&
                  orderField[0] === '__name__';
                if (isDocIdOrder) {
                  return resolveDocumentIdCursorString(item, meta.source, rootDb);
                }
                return normalizeLegacyQueryOperand(item, rootDb);
              }),
              inclusive,
              fromSnapshot,
            ),
            rawDb,
            rootDb,
            {
              ...meta,
              isCollectionGroupRoot: false,
              endSignature: `rawVals:${String(inclusive)}:${values.map(serializeCursorOperandForSignature).join('|')}`,
              replayOnRoot: chainReplay(meta, (q) =>
                q.endCursor(values, inclusive, fromSnapshot),
              ),
            },
            converter,
          ),
        );
    case 'startCursorFromSnapshot':
      return (snapshot: DocumentSnapshot, inclusive: boolean) =>
        runWithAdminErrorsSync(appBacked, () =>
          wrapQuery(
            target.startCursorFromSnapshot(unwrapCursorSnapshotForAdmin(snapshot, rootDb), inclusive),
            rawDb,
            rootDb,
            {
              ...meta,
              isCollectionGroupRoot: false,
              startSignature: `rawSnap:${String(inclusive)}:${snapshot.ref?.path ?? snapshot.id}`,
              replayOnRoot: chainReplay(meta, (q) =>
                q.startCursorFromSnapshot(snapshot, inclusive),
              ),
            },
            converter,
          ),
        );
    case 'endCursorFromSnapshot':
      return (snapshot: DocumentSnapshot, inclusive: boolean) =>
        runWithAdminErrorsSync(appBacked, () =>
          wrapQuery(
            target.endCursorFromSnapshot(unwrapCursorSnapshotForAdmin(snapshot, rootDb), inclusive),
            rawDb,
            rootDb,
            {
              ...meta,
              isCollectionGroupRoot: false,
              endSignature: `rawSnap:${String(inclusive)}:${snapshot.ref?.path ?? snapshot.id}`,
              replayOnRoot: chainReplay(meta, (q) =>
                q.endCursorFromSnapshot(snapshot, inclusive),
              ),
            },
            converter,
          ),
        );
    default:
      return undefined;
  }
}
