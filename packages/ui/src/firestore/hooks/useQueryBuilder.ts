import { useCallback, useMemo, useState } from 'react';
import {
  limit as limitFn,
  orderBy as orderByFn,
  query as queryFn,
  where as whereFn,
  type CollectionReference,
  type OrderDirection,
  type Query,
  type WhereFilterOp,
} from 'pyric/firestore';

export type QueryOp = WhereFilterOp;

export const QUERY_OPS: readonly QueryOp[] = [
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'not-in',
  'array-contains',
  'array-contains-any',
] as const;

/** Ops that accept an array of values. The value editor in the
 *  bundled <QueryBuilder> parses the input as JSON for these. */
export const MULTI_VALUE_OPS: ReadonlySet<QueryOp> = new Set<QueryOp>([
  'in',
  'not-in',
  'array-contains-any',
]);

export interface QueryCondition {
  id: string;
  field: string;
  op: QueryOp;
  value: unknown;
}

export interface QueryBuilderState {
  conditions: QueryCondition[];
  orderBy?: { field: string; direction: OrderDirection };
  limit?: number;
}

export interface QueryBuilderActions {
  addCondition: (c?: Partial<Omit<QueryCondition, 'id'>>) => void;
  updateCondition: (
    id: string,
    patch: Partial<Omit<QueryCondition, 'id'>>,
  ) => void;
  removeCondition: (id: string) => void;
  setOrderBy: (orderBy?: { field: string; direction: OrderDirection }) => void;
  setLimit: (limit?: number) => void;
  reset: () => void;
  /**
   * Compose the state into a Firestore `Query`. Returns the base
   * collection when there are no conditions / orderBy / limit.
   * Conditions with empty `field` are skipped — the builder UI
   * lets users add a row before they've filled it in.
   */
  buildQuery: (base: CollectionReference | Query) => Query;
}

export type UseQueryBuilderResult = QueryBuilderState & QueryBuilderActions;

const EMPTY_STATE: QueryBuilderState = { conditions: [] };

export interface UseQueryBuilderOptions {
  /** Pre-populate the builder. */
  initial?: Partial<QueryBuilderState>;
}

/**
 * Headless query-builder state machine. Single-level — no nested
 * `and()`/`or()` groups in v1. Consumers compose the state into a
 * Firestore `Query` via `buildQuery(base)` and feed that into
 * `useDocumentList` / `useFirestoreCollection`.
 */
export function useQueryBuilder(
  options: UseQueryBuilderOptions = {},
): UseQueryBuilderResult {
  const [state, setState] = useState<QueryBuilderState>(() => ({
    ...EMPTY_STATE,
    ...options.initial,
    conditions: options.initial?.conditions ?? [],
  }));

  const addCondition = useCallback<QueryBuilderActions['addCondition']>((c) => {
    setState((prev) => ({
      ...prev,
      conditions: [
        ...prev.conditions,
        {
          id: crypto.randomUUID(),
          field: c?.field ?? '',
          op: c?.op ?? '==',
          value: c?.value ?? '',
        },
      ],
    }));
  }, []);

  const updateCondition = useCallback<QueryBuilderActions['updateCondition']>(
    (id, patch) => {
      setState((prev) => ({
        ...prev,
        conditions: prev.conditions.map((c) =>
          c.id === id ? { ...c, ...patch } : c,
        ),
      }));
    },
    [],
  );

  const removeCondition = useCallback<QueryBuilderActions['removeCondition']>(
    (id) => {
      setState((prev) => ({
        ...prev,
        conditions: prev.conditions.filter((c) => c.id !== id),
      }));
    },
    [],
  );

  const setOrderBy = useCallback<QueryBuilderActions['setOrderBy']>((next) => {
    setState((prev) => ({ ...prev, orderBy: next }));
  }, []);

  const setLimit = useCallback<QueryBuilderActions['setLimit']>((next) => {
    setState((prev) => ({ ...prev, limit: next }));
  }, []);

  const reset = useCallback(() => {
    setState(EMPTY_STATE);
  }, []);

  const buildQuery = useCallback<QueryBuilderActions['buildQuery']>(
    (base) => {
      const constraints = [] as ReturnType<typeof whereFn>[];
      const orderByConstraints = [] as ReturnType<typeof orderByFn>[];
      const limitConstraints = [] as ReturnType<typeof limitFn>[];

      for (const cond of state.conditions) {
        if (!cond.field) continue;
        constraints.push(whereFn(cond.field, cond.op, cond.value));
      }
      if (state.orderBy && state.orderBy.field) {
        orderByConstraints.push(
          orderByFn(state.orderBy.field, state.orderBy.direction),
        );
      }
      if (typeof state.limit === 'number' && state.limit > 0) {
        limitConstraints.push(limitFn(state.limit));
      }
      const all = [...constraints, ...orderByConstraints, ...limitConstraints];
      if (all.length === 0) return base as Query;
      return queryFn(base, ...all);
    },
    [state],
  );

  return useMemo(
    () => ({
      ...state,
      addCondition,
      updateCondition,
      removeCondition,
      setOrderBy,
      setLimit,
      reset,
      buildQuery,
    }),
    [
      state,
      addCondition,
      updateCondition,
      removeCondition,
      setOrderBy,
      setLimit,
      reset,
      buildQuery,
    ],
  );
}
