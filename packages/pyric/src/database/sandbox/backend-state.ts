import type { Sandbox } from 'pyric/sandbox';
import { SandboxClock } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { sdkActivity } from '../../sandbox/internal/sdk-activity.js';
import { DataTree, joinPath, pathSegments, type JsonValue } from './data-tree.js';
import { withPriorities, type InlinePriority } from './normalize.js';
import { priorityBucketIdForSegments } from '../../sandbox/persistence/rtdb-records.js';
import type { QuerySpec } from '../internal/query-projection.js';
import { loadsAllData, logDatabaseWarning, unspecifiedIndexWarning } from './query-index.js';
import type { ChildListener, ValueListener } from './listener-types.js';
import { MutationHistory } from './mutation-history.js';
import { OperationEvents } from './operation-events.js';
import { PriorityState } from './priority-state.js';
import { RulesEvaluator } from './rules-eval.js';

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

function shallowCloneWithKey(source: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    defineOwn(out, k, v);
  }
  defineOwn(out, key, value);
  return Object.freeze(out);
}

function attachOwnPriority(node: unknown, priority: string | number): unknown {
  if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
    return shallowCloneWithKey(node as Record<string, unknown>, '.priority', priority);
  }
  return Object.freeze({ '.value': node, '.priority': priority });
}

function attachSpinePriority(
  node: unknown,
  segments: readonly string[],
  index: number,
  priority: string | number,
): unknown {
  if (index === segments.length) {
    return attachOwnPriority(node, priority);
  }
  if (typeof node !== 'object' || node === null || Array.isArray(node) || Object.hasOwn(node, '.value')) {
    return node;
  }
  const record = node as Record<string, unknown>;
  const seg = segments[index]!;
  if (!Object.hasOwn(record, seg)) return node;
  const child = record[seg];
  if (child === null) return node;
  const nextChild = attachSpinePriority(child, segments, index + 1, priority);
  if (nextChild === child) return node;
  return shallowCloneWithKey(record, seg, nextChild);
}

export class BackendState {
  readonly tree = new DataTree();
  readonly rules: RulesEvaluator;
  activeRules: { rules: Record<string, unknown> } | null = null;
  readonly valueListeners = new Set<ValueListener>();
  readonly childListeners = new Set<ChildListener>();
  readonly priorities = new PriorityState();
  readonly mutations = new MutationHistory();
  readonly events: OperationEvents;
  readonly writeSubscribers = new Set<() => void>();
  resetGeneration = 0;
  private cachedRulesTreeGen = -1;
  private cachedRulesPriorityGen = -1;
  private cachedRulesView: Record<string, unknown> | null = null;
  /**
   * The sandbox's clock. Every server-set time this backend produces reads it:
   * `ServerValue.TIMESTAMP`, the rules engine's `now`, push-id keys, and the
   * operation-event stamps. A backend with no sandbox keeps its own wall clock.
   */
  readonly clock: SandboxClock;

  constructor(sandbox?: Sandbox, instance?: string) {
    this.events = new OperationEvents(sandbox, instance);
    this.clock = sandbox ? getClock(sandbox) : new SandboxClock();
    this.rules = new RulesEvaluator(this.clock);
  }

  /**
   * The stored tree as rules read it: each stored priority is on its node as a
   * `.priority` key, so `data.getPriority()` and `root` lookups report it.
   *
   * Shares untouched subtrees directly from `DataTree` (the rules simulator
   * never mutates `mockData`) and caches the spine-cloned priority view until
   * either the tree or priority state advances its generation.
   */
  rulesSnapshot(): Record<string, unknown> {
    const treeGen = this.tree.generation;
    const prioGen = this.priorities.generation;
    if (
      this.cachedRulesView !== null
      && this.cachedRulesTreeGen === treeGen
      && this.cachedRulesPriorityGen === prioGen
    ) {
      return this.cachedRulesView;
    }
    let view: unknown = this.tree.peekRoot();
    if (view !== null && this.priorities.size > 0) {
      for (const [path, priority] of this.priorities.entries()) {
        view = attachSpinePriority(view, pathSegments(path), 0, priority);
      }
    }
    this.cachedRulesTreeGen = treeGen;
    this.cachedRulesPriorityGen = prioGen;
    this.cachedRulesView = view as Record<string, unknown>;
    return this.cachedRulesView;
  }

  /**
   * The stored subtree at `path` with its own and descendant `.priority`
   * metadata attached, so sentinel resolution reads prior priorities too.
   */
  rulesSnapshotAt(path: string): JsonValue {
    const value = this.tree.read(path);
    const entries = [{ segments: [], priority: this.priorities.get(path) }, ...this.prioritiesBelow(path)];
    return withPriorities(value, entries);
  }

  /**
   * Clear `.priority` on any proper ancestor of `path` that holds a primitive
   * leaf before a non-null descendant write promotes that ancestor to an object.
   */
  clearPromotedAncestorPriorities(path: string, value: JsonValue): void {
    if (value === null || this.priorities.size === 0) return;
    const segments = pathSegments(path);
    for (let depth = 0; depth < segments.length; depth += 1) {
      const ancestorSegs = segments.slice(0, depth);
      const current = this.tree.peekSegments(ancestorSegs);
      if (current !== undefined && current !== null && typeof current !== 'object') {
        this.priorities.set(joinPath(ancestorSegs), null);
      }
    }
  }

  /** The stored priorities strictly below `path`, relative to it. */
  prioritiesBelow(path: string): InlinePriority[] {
    if (this.priorities.size === 0) return [];
    const base = pathSegments(path);
    const bucketId = priorityBucketIdForSegments(base);
    const source = bucketId !== null ? this.priorities.entriesInBucket(bucketId) : this.priorities.entries();
    const below: InlinePriority[] = [];
    for (const [stored, priority] of source) {
      const segments = pathSegments(stored);
      const isBelow = segments.length > base.length && base.every((segment, i) => segments[i] === segment);
      if (isBelow) below.push({ segments: segments.slice(base.length), priority });
    }
    return below;
  }

  /**
   * The warning a listener on this query logs because the rules declare no
   * matching `.indexOn`, or `null` when the query reads the whole location or
   * is indexed.
   */
  unspecifiedIndexWarning(path: string, spec: QuerySpec): string | null {
    if (loadsAllData(spec)) return null;
    const index = this.rules.missingQueryIndex(path, spec);
    return index === null ? null : unspecifiedIndexWarning(path, index);
  }

  /**
   * Log the unspecified-index warning for a listener the rules allowed. A
   * host-side mirror call leaves the warning to the page that made the SDK call.
   */
  warnOnUnspecifiedIndex(path: string, spec: QuerySpec | undefined): void {
    if (spec === undefined || sdkActivity.isSilenced()) return;
    const warning = this.unspecifiedIndexWarning(path, spec);
    if (warning !== null) logDatabaseWarning(warning);
  }

  notifyWrite(): void {
    for (const subscriber of this.writeSubscribers) {
      try { subscriber(); } catch { /* persistence scheduling is observational */ }
    }
  }
}
