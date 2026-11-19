import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import { jsonValuesEqual, joinPath, pathSegments, type JsonValue } from './data-tree.js';
import type { ChildListener, ChildParentSnapshot, ValueListener } from './listener-types.js';
import {
  evaluateQueryRead,
  type QueryReadResult,
  type QueryRow,
  type QuerySpec,
} from '../internal/query-projection.js';
import type { ValueListeners } from './value-listeners.js';

const CANONICAL_CHILD_EVENTS = [
  'child_removed',
  'child_added',
  'child_moved',
  'child_changed',
] as const;

interface QueryViewGroup {
  readonly spec: QuerySpec;
  readonly children: ChildListener[];
  readonly values: ValueListener[];
}

function isValueListenerEvent(listener: ValueListener): boolean {
  return listener.event === undefined || listener.event === 'value';
}

function resolvePriorQueryWindow(view: QueryViewGroup): readonly QueryRow[] | undefined {
  for (const listener of view.children) {
    if (listener.lastWindow !== undefined) {
      return listener.lastWindow;
    }
  }
  for (const listener of view.values) {
    const tracksChildEvent = !isValueListenerEvent(listener);
    if (tracksChildEvent && listener.lastWindow !== undefined) {
      return listener.lastWindow;
    }
  }
  return undefined;
}

/**
 * Mirrors Firebase RTDB `ViewProcessor` + `LimitedFilter` two-phase window
 * reconciliation when an existing window member mutates its value or priority
 * such that it still satisfies query bounds locally (`projected`) yet is
 * displaced by an out-of-window sibling in the full window (`full`).
 */
function computeProjectedEvictionStep(
  state: BackendState,
  listenerPath: string,
  spec: QuerySpec,
  prior: readonly QueryRow[],
): { projected: QueryReadResult; full: QueryReadResult } | null {
  if (spec.limit === null || prior.length === 0) {
    return null;
  }
  const rawTree = state.tree.read(listenerPath);
  const isChildRecord =
    rawTree !== null && typeof rawTree === 'object' && !Array.isArray(rawTree);
  if (!isChildRecord) {
    return null;
  }
  const priorityForKey = state.priorities.forChild(listenerPath);
  const full = evaluateQueryRead(rawTree, spec, priorityForKey);
  const fullKeys = new Set(full.rows.map((row) => row.key));

  const treeRecord = rawTree as Record<string, JsonValue>;
  const priorSubset: Record<string, JsonValue> = {};
  let hasSurvivingPriorChild = false;
  for (const priorRow of prior) {
    if (Object.hasOwn(treeRecord, priorRow.key)) {
      const currentVal = treeRecord[priorRow.key];
      if (currentVal !== undefined && currentVal !== null) {
        priorSubset[priorRow.key] = currentVal;
        hasSurvivingPriorChild = true;
      }
    }
  }
  if (!hasSurvivingPriorChild) {
    return null;
  }

  const projected = evaluateQueryRead(priorSubset, spec, priorityForKey);
  const priorByKey = new Map(prior.map((row) => [row.key, row]));
  let hasMutatedEvictedMember = false;
  for (const projRow of projected.rows) {
    if (fullKeys.has(projRow.key)) {
      continue;
    }
    const beforeRow = priorByKey.get(projRow.key);
    if (beforeRow === undefined) {
      continue;
    }
    const valueMutated = !jsonValuesEqual(beforeRow.value, projRow.value);
    const priorityMutated = beforeRow.priority !== projRow.priority;
    if (valueMutated || priorityMutated) {
      hasMutatedEvictedMember = true;
      break;
    }
  }
  if (!hasMutatedEvictedMember) {
    return null;
  }
  return { projected, full };
}

function fanOutQueryChildStep(
  children: ChildListeners,
  values: ValueListeners,
  view: QueryViewGroup,
  paths: string[],
  stepResult?: QueryReadResult,
): void {
  let stepRows: QueryRow[] | undefined;
  if (stepResult !== undefined) {
    stepRows = stepResult.rows;
  }
  for (const eventKind of CANONICAL_CHILD_EVENTS) {
    for (const childListener of view.children) {
      if (childListener.event === eventKind) {
        children.fanOutQueryListener(childListener, stepRows);
      }
    }
    const matchingValues = view.values.filter((listener) => listener.event === eventKind);
    if (matchingValues.length > 0) {
      values.fanOutListeners(matchingValues, paths, stepResult);
    }
  }
}

/**
 * Fan out listener notifications in Firebase's SyncTree order:
 * deepest path first, plain-reference view before query views on the same
 * path, and within each view:
 * `child_removed` -> `child_added` -> `child_moved` -> `child_changed` -> `value`.
 */
export function fanOutAllListeners(
  state: BackendState,
  children: ChildListeners,
  values: ValueListeners,
  paths: string[],
  priors: ChildParentSnapshot,
): void {
  if (state.childListeners.size === 0 && state.valueListeners.size === 0) {
    return;
  }
  const pathOrder: string[] = [];
  const seenPaths = new Set<string>();
  for (const listener of state.childListeners) {
    const canonical = joinPath(pathSegments(listener.path));
    if (!seenPaths.has(canonical)) {
      seenPaths.add(canonical);
      pathOrder.push(canonical);
    }
  }
  for (const listener of state.valueListeners) {
    const canonical = joinPath(pathSegments(listener.path));
    if (!seenPaths.has(canonical)) {
      seenPaths.add(canonical);
      pathOrder.push(canonical);
    }
  }
  pathOrder.sort((left, right) => pathSegments(right).length - pathSegments(left).length);

  for (const listenerPath of pathOrder) {
    const plainChildren: ChildListener[] = [];
    const plainValues: ValueListener[] = [];
    const queryViews = new Map<string, QueryViewGroup>();
    const getQueryView = (spec: QuerySpec): QueryViewGroup => {
      const key = JSON.stringify(spec);
      let view = queryViews.get(key);
      if (view === undefined) {
        view = { spec, children: [], values: [] };
        queryViews.set(key, view);
      }
      return view;
    };

    for (const listener of state.childListeners) {
      if (joinPath(pathSegments(listener.path)) !== listenerPath) {
        continue;
      }
      if (listener.spec !== undefined) {
        getQueryView(listener.spec).children.push(listener);
      } else {
        plainChildren.push(listener);
      }
    }
    for (const listener of state.valueListeners) {
      if (joinPath(pathSegments(listener.path)) !== listenerPath) {
        continue;
      }
      if (listener.query !== undefined) {
        getQueryView(listener.query).values.push(listener);
      } else {
        plainValues.push(listener);
      }
    }

    if (plainChildren.length > 0 || plainValues.length > 0) {
      let plainEvents: ReturnType<ChildListeners['computePlainPathEvents']> | undefined;
      if (plainChildren.length > 0) {
        plainEvents = children.computePlainPathEvents(listenerPath, priors);
      }
      for (const eventKind of CANONICAL_CHILD_EVENTS) {
        if (plainEvents !== undefined) {
          children.deliverPlainPathEvents(plainChildren, plainEvents, eventKind);
        }
        const matchingValues = plainValues.filter((listener) => listener.event === eventKind);
        if (matchingValues.length > 0) {
          values.fanOutListeners(matchingValues, paths);
        }
      }
      const valueListeners = plainValues.filter(isValueListenerEvent);
      if (valueListeners.length > 0) {
        values.fanOutListeners(valueListeners, paths);
      }
    }

    for (const view of queryViews.values()) {
      const priorRows = resolvePriorQueryWindow(view);
      let twoPhase: { projected: QueryReadResult; full: QueryReadResult } | null = null;
      if (priorRows !== undefined) {
        twoPhase = computeProjectedEvictionStep(state, listenerPath, view.spec, priorRows);
      }
      if (twoPhase !== null) {
        fanOutQueryChildStep(children, values, view, paths, twoPhase.projected);
        fanOutQueryChildStep(children, values, view, paths, twoPhase.full);
      } else {
        fanOutQueryChildStep(children, values, view, paths);
      }
      const valueListeners = view.values.filter(isValueListenerEvent);
      if (valueListeners.length > 0) {
        values.fanOutListeners(valueListeners, paths);
      }
    }
  }
}
