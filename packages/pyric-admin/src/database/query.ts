/**
 * Backend-agnostic `Query` constraint builder, identity check, and wire
 * spec serializer shared by the local and remote `pyric-admin/database` arms.
 */

import {
  applyConstraint,
  isDefaultQuerySpec,
  normalizeOptionalEndpointValue,
  queryIdentifier,
  validateCursorKey,
  validateLimit,
  validateOrderByChildPath,
  validateQuerySpec,
  type Bound,
  type Constraint,
  type LimitKind,
  type OrderBy,
  type QuerySpec,
} from 'pyric/database/internal';
import type {
  DataSnapshot,
  EventType,
  JsonValue,
  Query,
  Reference,
  SnapshotCallback,
} from './types.js';

const ADMIN_QUERY_META = Symbol.for('pyric.admin.database.queryMeta');

interface AdminQueryMetadata {
  readonly repoToken: object;
  readonly canonicalPath: string;
  readonly spec: QuerySpec;
}

export interface WireQuerySpec {
  readonly orderBy: OrderBy | null;
  readonly bounds: Array<{
    readonly kind: Bound['kind'];
    readonly value: JsonValue;
    readonly key?: string;
  }>;
  readonly limit: { readonly kind: LimitKind; readonly n: number } | null;
}

export interface QueryExecutionHooks {
  readonly repoToken: object;
  readonly canonicalPath: string;
  readonly formattedUrl: string;
  readonly getBaseRef: () => Reference;
  readonly get: (spec: QuerySpec) => Promise<DataSnapshot>;
  readonly once: (
    spec: QuerySpec,
    eventType: EventType,
    successCb?: unknown,
    failureCallbackOrContext?: unknown,
    context?: unknown,
  ) => Promise<DataSnapshot>;
  readonly on: (
    spec: QuerySpec,
    eventType: EventType,
    callback: SnapshotCallback,
    cancelCallbackOrContext?: ((error: Error) => unknown) | object | null,
    context?: object | null,
  ) => SnapshotCallback;
  readonly off: (
    spec: QuerySpec,
    eventType?: EventType,
    callback?: SnapshotCallback,
    context?: object | null,
  ) => void;
}

function readQueryMetadata(candidate: unknown): AdminQueryMetadata | undefined {
  const isObject = candidate !== null && typeof candidate === 'object';
  if (!isObject) return undefined;
  return (candidate as { [ADMIN_QUERY_META]?: AdminQueryMetadata })[ADMIN_QUERY_META];
}

function extendQuery(
  hooks: QueryExecutionHooks,
  currentSpec: QuerySpec,
  constraint: Constraint,
): Query {
  const nextSpec = applyConstraint(currentSpec, constraint);
  validateQuerySpec(nextSpec, hooks.canonicalPath);
  return buildAdminQuery(hooks, nextSpec);
}

/**
 * Creates the query methods shared by both standalone `Query` objects and
 * unconstrained `Reference` objects (which carry `emptySpec()`).
 */
export function createQuerySurface(
  hooks: QueryExecutionHooks,
  spec: QuerySpec,
): Omit<Query, 'ref'> {
  const metadata: AdminQueryMetadata = {
    repoToken: hooks.repoToken,
    canonicalPath: hooks.canonicalPath,
    spec,
  };

  const surface: Omit<Query, 'ref'> & { [ADMIN_QUERY_META]: AdminQueryMetadata } = {
    [ADMIN_QUERY_META]: metadata,

    toString(): string {
      return hooks.formattedUrl;
    },

    toJSON(): string {
      return hooks.formattedUrl;
    },

    isEqual(other: Query | null): boolean {
      const otherMeta = readQueryMetadata(other);
      if (otherMeta === undefined) return false;
      const isSameRepo = otherMeta.repoToken === metadata.repoToken;
      const isSamePath = otherMeta.canonicalPath === metadata.canonicalPath;
      const isSameSpec = queryIdentifier(otherMeta.spec) === queryIdentifier(metadata.spec);
      return isSameRepo && isSamePath && isSameSpec;
    },

    get(): Promise<DataSnapshot> {
      return hooks.get(spec);
    },

    once<T = unknown>(
      eventType: EventType,
      successCallback?: (this: T, snapshot: DataSnapshot, previousChildKey?: string | null) => unknown,
      failureCallbackOrContext?: ((this: T, error: Error) => unknown) | T | null,
      context?: T | null,
    ): Promise<DataSnapshot> {
      return hooks.once(spec, eventType, successCallback, failureCallbackOrContext, context);
    },

    on(
      eventType: EventType,
      callback: SnapshotCallback,
      cancelCallbackOrContext?: ((error: Error) => unknown) | object | null,
      context?: object | null,
    ): SnapshotCallback {
      return hooks.on(spec, eventType, callback, cancelCallbackOrContext, context);
    },

    off(
      eventType?: EventType,
      callback?: SnapshotCallback,
      context?: object | null,
    ): void {
      hooks.off(spec, eventType, callback, context);
    },

    orderByChild(path: string): Query {
      validateOrderByChildPath(path);
      return extendQuery(hooks, spec, {
        kind: 'orderBy',
        spec: { kind: 'child', path },
      });
    },

    orderByKey(): Query {
      return extendQuery(hooks, spec, {
        kind: 'orderBy',
        spec: { kind: 'key' },
      });
    },

    orderByPriority(): Query {
      return extendQuery(hooks, spec, {
        kind: 'orderBy',
        spec: { kind: 'priority' },
      });
    },

    orderByValue(): Query {
      return extendQuery(hooks, spec, {
        kind: 'orderBy',
        spec: { kind: 'value' },
      });
    },

    startAt(value?: unknown, key?: string): Query {
      validateCursorKey('startAt', key);
      const normalized = normalizeOptionalEndpointValue('startAt', value) as JsonValue;
      return extendQuery(hooks, spec, {
        kind: 'bound',
        bound: { kind: 'startAt', value: normalized, key },
      });
    },

    startAfter(value: unknown, key?: string): Query {
      validateCursorKey('startAfter', key);
      return extendQuery(hooks, spec, {
        kind: 'bound',
        bound: { kind: 'startAfter', value: value as JsonValue, key },
      });
    },

    endAt(value?: unknown, key?: string): Query {
      validateCursorKey('endAt', key);
      const normalized = normalizeOptionalEndpointValue('endAt', value) as JsonValue;
      return extendQuery(hooks, spec, {
        kind: 'bound',
        bound: { kind: 'endAt', value: normalized, key },
      });
    },

    endBefore(value: unknown, key?: string): Query {
      validateCursorKey('endBefore', key);
      return extendQuery(hooks, spec, {
        kind: 'bound',
        bound: { kind: 'endBefore', value: value as JsonValue, key },
      });
    },

    equalTo(value: unknown, key?: string): Query {
      validateCursorKey('equalTo', key);
      return extendQuery(hooks, spec, {
        kind: 'bound',
        bound: { kind: 'equalTo', value: value as JsonValue, key },
      });
    },

    limitToFirst(limit: number): Query {
      validateLimit('limitToFirst', limit);
      return extendQuery(hooks, spec, {
        kind: 'limit',
        limitKind: 'limitToFirst',
        n: limit,
      });
    },

    limitToLast(limit: number): Query {
      validateLimit('limitToLast', limit);
      return extendQuery(hooks, spec, {
        kind: 'limit',
        limitKind: 'limitToLast',
        n: limit,
      });
    },
  };

  return surface;
}

/**
 * Builds a constrained immutable `Query` view rooted at `hooks.getBaseRef()`.
 */
export function buildAdminQuery(hooks: QueryExecutionHooks, spec: QuerySpec): Query {
  const methods = createQuerySurface(hooks, spec);
  const query: Query = {
    ...methods,
    get ref(): Reference {
      return hooks.getBaseRef();
    },
  };
  return query;
}

/**
 * Serializes a non-default `QuerySpec` into the worker protocol's wire query
 * plan. Returns `undefined` for an unconstrained `Reference`.
 *
 * Firebase accepts `+Infinity` limits as unconstrained windows; JSON turns
 * `Infinity` into `null`, so infinite limits omit the wire `limit` clause
 * while keeping identical execution semantics.
 */
export function toWireQuerySpec(spec: QuerySpec): WireQuerySpec | undefined {
  if (isDefaultQuerySpec(spec)) return undefined;
  const bounds = spec.bounds.map((bound) => {
    if (bound.key === undefined) {
      return { kind: bound.kind, value: bound.value };
    }
    return { kind: bound.kind, value: bound.value, key: bound.key };
  });
  let limit: WireQuerySpec['limit'] = null;
  const hasFiniteLimit = spec.limit !== null && Number.isFinite(spec.limit.n);
  if (hasFiniteLimit && spec.limit !== null) {
    limit = { kind: spec.limit.kind, n: spec.limit.n };
  }
  return {
    orderBy: spec.orderBy,
    bounds,
    limit,
  };
}
