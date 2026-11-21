/**
 * Admin-SDK `Query` constraint builder (`where`, `applyFilter`, `orderBy`,
 * `limit`, `limitToLast`, `offset`, `select`, `withConverter`, and cursor
 * bounds) with `replayOnRoot` tracking and numeric gRPC error translation.
 */

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
            const filterArg = args[0];
            const compiled = compileAdminFilter(filterArg, meta, rootDb);
            const nextMeta: AdminQueryMetadata = {
              ...meta,
              signature: [...meta.signature, `filter:${JSON.stringify(compiled)}`],
              replayOnRoot: chainReplay(meta, (q) =>
                (q as unknown as { where(f: unknown): Query }).where(filterArg),
              ),
            };
            if (compiled === null) return wrapQuery(target, rawDb, rootDb, nextMeta, converter);
            return wrapQuery(target.applyFilter(compiled), rawDb, rootDb, nextMeta, converter);
          }
          const normalized = validateAndNormalizeWhereArgs(args[0], args[1], args[2], meta, rootDb);
          const nextMeta: AdminQueryMetadata = {
            ...meta,
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
          const norm = normalizeCompositeFilter(filter, rootDb);
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            signature: [...meta.signature, `apply:${JSON.stringify(norm)}`],
            replayOnRoot: chainReplay(meta, (q) => q.applyFilter(filter)),
          };
          return wrapQuery(target.applyFilter(norm), rawDb, rootDb, nextMeta, converter);
        });
    case 'orderBy':
      return (field: SnapshotFieldPath, direction?: unknown) =>
        runWithAdminErrorsSync(appBacked, () => {
          const normalized = validateAndNormalizeOrderByArgs(field, direction);
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            signature: [...meta.signature, `order:${String(normalized.field)}:${normalized.direction}`],
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
            signature: [...meta.signature, `limit:${String(parsed)}`],
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
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            signature: [...meta.signature, `limitToLast:${String(parsed)}`],
            pendingLimitType: 'last',
            limitCount: parsed,
            replayOnRoot: chainReplay(meta, (q) => q.limitToLast(parsed)),
          };
          return wrapQuery(target.limitToLast(parsed), rawDb, rootDb, nextMeta, converter);
        });
    case 'offset':
      return (n: number) =>
        runWithAdminErrorsSync(appBacked, () => {
          const parsed = validateAdminOffsetInteger(n);
          let nextTarget = target;
          if (parsed > 0 && meta.pendingLimitType === 'first' && meta.limitCount !== undefined) {
            nextTarget = target.limit(parsed + meta.limitCount);
          }
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            signature: [...meta.signature, `offset:${String(parsed)}`],
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
            signature: [...meta.signature, `select:${JSON.stringify(selectedFields)}`],
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
          const nextTarget = applyAdminCursorArgs(target, prop, args, rootDb);
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            signature: [...meta.signature, `${prop}:${String(args.length)}`],
            replayOnRoot: chainReplay(meta, (q) =>
              (q as unknown as Record<typeof prop, (...a: unknown[]) => Query>)[prop](...args),
            ),
          };
          return wrapQuery(nextTarget, rawDb, rootDb, nextMeta, converter);
        });
    case 'startCursor':
      return (values: unknown[], inclusive: boolean, fromSnapshot?: boolean) =>
        runWithAdminErrorsSync(appBacked, () =>
          wrapQuery(
            target.startCursor(
              values.map((item) => normalizeLegacyQueryOperand(item, rootDb)),
              inclusive,
              fromSnapshot,
            ),
            rawDb,
            rootDb,
            {
              ...meta,
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
              values.map((item) => normalizeLegacyQueryOperand(item, rootDb)),
              inclusive,
              fromSnapshot,
            ),
            rawDb,
            rootDb,
            {
              ...meta,
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
