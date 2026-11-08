import type { AuthState, RtdbDenialContext } from 'pyric/sandbox';
import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import { joinPath, pathSegments, type JsonValue } from './data-tree.js';
import type { ChildListener, ValueListener } from './listener-types.js';
import { errorPrefix, normalizeWrite, withPriorities, writePriority, type InlinePriority } from './normalize.js';
import { canonicalPath, denyResultFor, rtdbDenialContext, rtdbRulesDetail } from './operation-events.js';
import { validatePriority } from './priority-state.js';
import { PriorityWrites } from './priority-writes.js';
import { executeQuery, type Priority, type QueryRow, type QuerySpec } from './query.js';
import { indexNotDefined } from './query-index.js';
import { permissionDenied, type RuleEvaluationDetails } from './rules-eval.js';
import { resolveSentinels } from './sentinels.js';
import { listenerPermissionDenied, type ValueListeners } from './value-listeners.js';

function rowsToVal(rows: QueryRow[]): JsonValue {
  if (rows.length === 0) return null;
  return Object.fromEntries(rows.map(({ key, value }) => [key, value])) as JsonValue;
}

function updateDenialRank(evaluation: RuleEvaluationDetails): 0 | 1 | 2 | 3 | null {
  if (evaluation.check === 'allow') return null;
  const isValidate = evaluation.trace?.some((t) => t.kind === 'validate') ?? false;
  if (!isValidate) return evaluation.check !== 'unsupported' ? 0 : 2;
  return evaluation.check !== 'unsupported' ? 1 : 3;
}

/**
 * Select the highest-precedence non-allow result across an atomic multi-path
 * update: confirmed `.write` deny > confirmed `.validate` deny > `.write`
 * unsupported > `.validate` unsupported, breaking ties by first occurrence and
 * short-circuiting immediately on a confirmed `.write` deny.
 */
function selectUpdateDenial<T extends { evaluation: RuleEvaluationDetails }>(entries: Iterable<T>): T | null {
  let best: T | null = null;
  let bestRank = 4;
  for (const entry of entries) {
    const rank = updateDenialRank(entry.evaluation);
    if (rank === null) continue;
    if (rank === 0) return entry;
    if (rank < bestRank) {
      best = entry;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Capture the pre-write metadata needed to rewind a commit at `path` when
 * simple `set(path, priorState)` would lose descendant `.priority` metadata or
 * an ancestor scalar primitive overwritten by a deeper path write.
 */
export function captureRewindDetail(
  state: BackendState,
  path: string,
  before: JsonValue,
  priorNodePriority: Priority,
  includeOwnPriority = false,
): Record<string, unknown> {
  const segments = pathSegments(path);
  const ancestorPriorities: Array<{ path: string; priority: Priority }> = [];
  for (let depth = 0; depth < segments.length; depth++) {
    const ancestorPath = joinPath(segments.slice(0, depth));
    const ancestorVal = state.tree.read(ancestorPath);
    const ancestorPriority = state.priorities.get(ancestorPath);
    if (ancestorVal !== null && typeof ancestorVal !== 'object') {
      return {
        overwrittenAncestor: {
          path: ancestorPath,
          state: withPriorities(ancestorVal, [{ segments: [], priority: ancestorPriority }]),
        },
        ...(ancestorPriorities.length > 0 ? { ancestorPriorities } : {}),
      };
    }
    if (ancestorPriority !== null) {
      ancestorPriorities.push({ path: ancestorPath, priority: ancestorPriority });
    }
  }
  const extra = ancestorPriorities.length > 0 ? { ancestorPriorities } : {};
  const below = state.prioritiesBelow(path);
  if (below.length > 0) {
    return {
      priorExport: withPriorities(before, [{ segments: [], priority: priorNodePriority }, ...below]),
      ...extra,
    };
  }
  if (includeOwnPriority && priorNodePriority !== null) {
    return { priorPriority: priorNodePriority, ...extra };
  }
  return extra;
}

const ROOT_IDENTIFIER_PATTERN = /\broot\b/;
const DATA_IDENTIFIER_PATTERN = /\bdata\b/;
const PARENT_IDENTIFIER_PATTERN = /\bparent\b/;

function pathsTouch(left: string, right: string): boolean {
  if (left === right || left === '/' || right === '/') return true;
  return right.startsWith(`${left}/`) || left.startsWith(`${right}/`);
}

function isRuleObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nextRuleNode(node: Record<string, unknown>, segment: string): Record<string, unknown> | undefined {
  if (!segment.startsWith('.') && Object.hasOwn(node, segment) && isRuleObject(node[segment])) {
    return node[segment];
  }
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$') && isRuleObject(child)) return child;
  }
  return undefined;
}

function readRuleDependsOnWrite(rawRule: unknown, ancestorPath: string, changedPaths: readonly string[]): boolean {
  if (typeof rawRule !== 'string') return false;
  if (ROOT_IDENTIFIER_PATTERN.test(rawRule)) return true;
  if (!DATA_IDENTIFIER_PATTERN.test(rawRule)) return false;
  if (PARENT_IDENTIFIER_PATTERN.test(rawRule) || rawRule.includes('[')) return true;
  return changedPaths.some((changedPath) => pathsTouch(ancestorPath, changedPath));
}

function listenerReadDependsOnPaths(
  rulesRoot: Record<string, unknown>,
  listenerPath: string,
  changedPaths: readonly string[],
): boolean {
  const segments = pathSegments(listenerPath);
  let current: Record<string, unknown> | undefined = rulesRoot;
  for (let depth = 0; depth <= segments.length && current !== undefined; depth++) {
    const ancestorPath = joinPath(segments.slice(0, depth));
    if (readRuleDependsOnWrite(current['.read'], ancestorPath, changedPaths)) return true;
    if (depth < segments.length) current = nextRuleNode(current, segments[depth]!);
  }
  return false;
}

export class WritePlane {
  private readonly priorityWrites: PriorityWrites;

  constructor(
    private readonly state: BackendState,
    private readonly values: ValueListeners,
    private readonly children: ChildListeners,
  ) {
    this.priorityWrites = new PriorityWrites(state, children, (paths, priors) => this.changed(paths, priors));
  }

  setData(seed: Record<string, JsonValue>): void {
    const priors = this.children.snapshotParents();
    this.state.tree.restore({});
    this.state.priorities.clear();
    for (const [path, value] of Object.entries(seed)) {
      this.state.tree.write(path, normalizeWrite(
        resolveSentinels(value, this.state.clock.now()) as JsonValue, path === '/' ? '' : path,
      ));
      const { priority, nested } = writePriority(value, null);
      this.state.priorities.replace(path, this.state.tree.read(path) === null ? null : priority);
      this.storeNestedPriorities(path, nested);
    }
    this.state.mutations.mark('/');
    this.cancelDeniedListeners(['/']);
    this.values.fanOut(['/']);
    this.children.fanOut(priors);
    this.state.notifyWrite();
  }

  setRules(rules: { rules: Record<string, unknown> } | null): void {
    const isRulesNull = rules === null;
    if (isRulesNull) {
      this.state.activeRules = null;
    } else {
      this.state.activeRules = structuredClone(rules);
    }
    this.state.rules.setRules(rules);
    this.cancelDeniedListeners();
    this.state.notifyWrite();
  }

  setDefaultPolicy(policy: 'allow' | 'deny'): void {
    this.state.rules.setDefaultPolicy(policy);
    this.cancelDeniedListeners();
    this.state.notifyWrite();
  }

  getActiveRules(): { rules: Record<string, unknown> } | null {
    const isRulesNull = this.state.activeRules === null;
    let result: { rules: Record<string, unknown> } | null = null;
    if (!isRulesNull) {
      result = structuredClone(this.state.activeRules);
    }
    return result;
  }

  snapshotState(): JsonValue {
    return this.state.tree.snapshot();
  }

  adminGet(path: string): JsonValue {
    const value = this.state.tree.read(path);
    this.state.events.operation(null, 'get', path, 'not-applicable', undefined, {
      at: this.state.clock.now(),
      origin: 'admin', resourceBefore: { data: value, exists: value !== null },
    });
    return value;
  }

  adminGetQuery(path: string, spec: QuerySpec): QueryRow[] {
    // Admin access bypasses rules, not the index requirement.
    const missingIndex = this.state.rules.missingQueryIndex(path, spec);
    if (missingIndex !== null) {
      this.state.events.operation(null, 'get', path, 'error', undefined, {
        at: this.state.clock.now(),
        origin: 'admin', request: { query: spec }, detail: { failure: 'missing-index' },
      });
      throw indexNotDefined(path, missingIndex);
    }
    const rows = executeQuery(this.state.tree.read(path), spec, this.state.priorities.forChild(path));
    this.state.events.operation(null, 'get', path, 'not-applicable', undefined, {
      at: this.state.clock.now(),
      origin: 'admin', request: { query: spec },
      resourceBefore: { data: rowsToVal(rows), exists: rows.length > 0 },
    });
    return rows;
  }

  adminSet(path: string, value: JsonValue): void {
    this.adminSetWithPriority(path, value, null, false);
  }

  adminSetWithPriority(
    path: string,
    value: JsonValue,
    priority: Priority,
    prioritySupplied = true,
  ): void {
    const now = this.state.clock.now();
    const before = this.state.tree.read(path);
    const resolved = normalizeWrite(
      resolveSentinels(value, now, before) as JsonValue, path === '/' ? '' : path,
    );
    const written = writePriority(value, priority);
    priority = written.priority;
    prioritySupplied ||= written.inline;
    validatePriority(priority);
    const method = resolved === null ? 'remove' : 'set';
    this.state.events.operation(null, method, path, 'not-applicable', undefined, {
      at: now,
      origin: 'admin', request: { data: value, resourceData: value },
      resourceBefore: { data: before, exists: before !== null },
      resourceAfter: { data: resolved, exists: resolved !== null },
    });
    const priors = this.children.snapshotParents();
    const priorNodePriority = this.state.priorities.get(path);
    const rewindDetail = captureRewindDetail(this.state, path, before, priorNodePriority);
    this.state.tree.write(path, resolved);
    this.state.priorities.replace(path, resolved === null ? null : priority, (p) => this.state.tree.read(p) !== null);
    this.storeNestedPriorities(path, written.nested);
    this.changed([path], priors);
    const after = this.state.tree.read(path);
    const hasPriority = prioritySupplied || priorNodePriority !== null;
    this.state.events.commit(null, after === null ? 'remove' : 'set', path, {
      data: value, priorState: before, nextState: after, replay: { requestTime: now },
      detail: {
        admin: true,
        ...(hasPriority ? { priority, priorPriority: priorNodePriority } : {}),
        ...rewindDetail,
      },
    });
    this.state.notifyWrite();
  }

  adminUpdate(path: string, patch: Record<string, JsonValue>): void {
    const now = this.state.clock.now();
    const before = this.state.tree.read(path);
    const priorNodePriority = this.state.priorities.get(path);
    const rewindDetail = captureRewindDetail(this.state, path, before, priorNodePriority, true);
    const expanded = this.resolvePatch(path, patch, now);
    const inline = this.patchPriorities(path, patch);
    const multiPath = Object.keys(patch).some((key) => key.includes('/'));
    this.state.events.operation(null, 'update', path, 'not-applicable', undefined, {
      at: now,
      origin: 'admin', request: { data: patch, resourceData: patch },
      resourceBefore: { data: before, exists: before !== null },
      detail: multiPath
        ? { admin: true, multiPath: true, paths: Object.keys(expanded) }
        : { admin: true, multiPath: false, keys: Object.keys(patch) },
    });
    const priors = this.children.snapshotParents();
    const changedPaths = this.applyExpandedUpdate(path, expanded, multiPath, inline);
    this.changed(changedPaths, priors);
    const detail = multiPath
      ? { admin: true, multiPath: true, paths: Object.keys(expanded), ...rewindDetail }
      : { admin: true, multiPath: false, keys: Object.keys(patch), ...rewindDetail };
    this.state.events.commit(null, 'update', path, {
      data: patch, priorState: before, nextState: this.state.tree.read(path),
      replay: { requestTime: now }, detail,
    });
    this.state.notifyWrite();
  }

  adminRemove(path: string): void { this.adminSet(path, null); }

  adminSetPriority(path: string, priority: Priority): void {
    this.priorityWrites.adminSet(path, priority);
  }

  get(auth: AuthState, path: string): JsonValue {
    const at = this.state.clock.now();
    const value = this.state.tree.read(path);
    const evaluation = this.readEvaluation(auth, path);
    if (evaluation.check !== 'allow') {
      this.state.events.operation(auth, 'get', path, denyResultFor(evaluation.check), evaluation, {
        at, durationMs: this.state.clock.now() - at,
        resourceBefore: { data: value, exists: value !== null },
      });
      throw permissionDenied(rtdbDenialContext(evaluation, auth, 'get', path));
    }
    this.state.events.operation(auth, 'get', path, 'allow', evaluation, {
      at, durationMs: this.state.clock.now() - at,
      resourceBefore: { data: value, exists: value !== null },
    });
    return this.state.tree.read(path);
  }

  getQuery(auth: AuthState, path: string, spec: QuerySpec): QueryRow[] {
    const at = this.state.clock.now();
    const evaluation = this.readEvaluation(auth, path, spec);
    if (evaluation.check !== 'allow') {
      this.state.events.operation(auth, 'get', path, denyResultFor(evaluation.check), evaluation, {
        at, durationMs: this.state.clock.now() - at, request: { query: spec },
      });
      throw permissionDenied(rtdbDenialContext(evaluation, auth, 'get', path, { query: spec }));
    }
    const missingIndex = this.state.rules.missingQueryIndex(path, spec);
    if (missingIndex !== null) {
      this.state.events.operation(auth, 'get', path, 'error', undefined, {
        at, durationMs: this.state.clock.now() - at, request: { query: spec }, detail: { failure: 'missing-index' },
      });
      throw indexNotDefined(path, missingIndex);
    }
    const rows = executeQuery(this.state.tree.read(path), spec, this.state.priorities.forChild(path));
    this.state.events.operation(auth, 'get', path, 'allow', evaluation, {
      at, durationMs: this.state.clock.now() - at, request: { query: spec },
      resourceBefore: { data: rowsToVal(rows), exists: rows.length > 0 },
    });
    return rows;
  }

  set(auth: AuthState, path: string, value: JsonValue): void {
    this.setInternal(auth, path, value, 'set', null, false);
  }

  setWithPriority(auth: AuthState, path: string, value: JsonValue, priority: Priority): void {
    validatePriority(priority);
    this.setInternal(auth, path, value, 'set', priority, true);
  }

  remove(auth: AuthState, path: string): void {
    this.setInternal(auth, path, null, 'remove', null, false);
  }

  setPriority(auth: AuthState, path: string, priority: Priority): void {
    this.priorityWrites.set(auth, path, priority);
  }

  /** Decide a `setPriority` by `auth` without writing or emitting an event. */
  validatePriority(auth: AuthState, path: string, priority: Priority): void {
    this.priorityWrites.validate(auth, path, priority);
  }

  /**
   * Decide a read by `auth` at `path`, with its query when it carried one,
   * without reading, emitting an event, or attaching anything. Throws the
   * permission error the read would have thrown.
   */
  validateRead(auth: AuthState, path: string, spec?: QuerySpec): void {
    const evaluation = this.readEvaluation(auth, path, spec);
    if (evaluation.check !== 'allow') {
      throw permissionDenied(rtdbDenialContext(evaluation, auth, 'get', path, spec ? { query: spec } : {}));
    }
  }

  validateSet(auth: AuthState, path: string, value: unknown, priority: Priority = null): void {
    const { evaluation, resolved } = this.setCheck(auth, path, value, priority);
    if (evaluation.check !== 'allow') {
      throw permissionDenied(rtdbDenialContext(evaluation, auth, 'onDisconnect', path, { data: resolved }));
    }
  }

  validateUpdate(auth: AuthState, path: string, patch: Record<string, unknown>): void {
    const denied = this.updateCheck(auth, path, patch);
    if (denied !== null) {
      throw permissionDenied(rtdbDenialContext(denied.evaluation, auth, 'onDisconnect', denied.path, { data: denied.value }));
    }
  }

  /**
   * Decide an `onDisconnect` registration by `auth` as production does, when
   * it is registered, and record it as an `onDisconnect.set`,
   * `onDisconnect.update` or `onDisconnect.remove` operation, allowed or
   * denied, so a captured session carries it. Throws the permission error a
   * denied registration rejects with. Writes nothing.
   */
  registerDisconnect(
    auth: AuthState,
    operation: { kind: 'set'; path: string; value: unknown; priority: Priority } | { kind: 'remove'; path: string }
      | { kind: 'update'; path: string; values: Record<string, unknown> },
  ): void {
    const at = this.state.clock.now();
    const method = `onDisconnect.${operation.kind}`;
    const data = operation.kind === 'set' ? operation.value : operation.kind === 'update' ? operation.values : null;
    const detail = operation.kind === 'set' && operation.priority !== null ? { priority: operation.priority } : undefined;
    let evaluation: RuleEvaluationDetails;
    let deniedAt: { path: string; data: unknown } | null = null;
    if (operation.kind === 'update') {
      if (Object.keys(operation.values).length === 0) return;
      // Evaluate .write across every path before falling back to any .validate failure.
      const evaluations = this.updateEvaluations(auth, operation.path, operation.values);
      const denied = selectUpdateDenial(evaluations);
      evaluation = (denied ?? evaluations.at(-1)!).evaluation;
      if (denied !== null) deniedAt = { path: denied.update.path, data: denied.update.value };
    } else {
      const value = operation.kind === 'set' ? operation.value : null;
      const checked = this.setCheck(auth, operation.path, value, operation.kind === 'set' ? operation.priority : null);
      evaluation = checked.evaluation;
      if (evaluation.check !== 'allow') deniedAt = { path: operation.path, data: checked.resolved };
    }
    const fields = { at, durationMs: this.state.clock.now() - at, request: { data, resourceData: data }, detail };
    if (deniedAt !== null) {
      this.state.events.operation(auth, method, operation.path, denyResultFor(evaluation.check), evaluation, fields);
      throw permissionDenied(rtdbDenialContext(evaluation, auth, 'onDisconnect', deniedAt.path, { data: deniedAt.data }));
    }
    this.state.events.operation(auth, method, operation.path, 'allow', evaluation, fields);
  }

  private setCheck(auth: AuthState, path: string, value: unknown, priority: Priority) {
    const now = this.state.clock.now();
    const resolved = normalizeWrite(
      resolveSentinels(value, now, this.state.tree.read(path)) as JsonValue,
      path === '/' ? '' : path,
    );
    const written = writePriority(value, priority);
    validatePriority(written.priority);
    const newData = withPriorities(resolved, [{ segments: [], priority: written.priority }, ...written.nested]);
    return { evaluation: this.writeEvaluation(auth, path, newData, now), resolved };
  }

  /** The first path of an update the rules deny, with its evaluation, or null when they allow every path. */
  private updateCheck(auth: AuthState, path: string, patch: Record<string, unknown>) {
    // The SDK resolves an empty update without contacting the server.
    if (Object.keys(patch).length === 0) return null;
    const denied = selectUpdateDenial(this.updateEvaluations(auth, path, patch));
    if (denied !== null) {
      return { evaluation: denied.evaluation, path: denied.update.path, value: denied.update.value };
    }
    return null;
  }

  private updateEvaluations(auth: AuthState, path: string, patch: Record<string, unknown>) {
    const now = this.state.clock.now();
    const mockData = this.state.rulesSnapshot();
    const inline = this.patchPriorities(path, patch);
    const updates = Object.entries(patch).map(([key, value]) => {
      const [absolute, resolved] = this.resolvePatchEntry(path, key, value, now);
      return { path: absolute, value: withPriorities(resolved, inline.get(absolute) ?? []) };
    });
    return updates.map((update) => ({
      update,
      evaluation: this.state.rules.evaluate('write', update.path, { auth, mockData, newData: update.value, updates, now }),
    }));
  }

  update(auth: AuthState, path: string, patch: Record<string, JsonValue>): void {
    // The SDK resolves an empty update without contacting the server, so no
    // rule is evaluated and nothing is written.
    if (Object.keys(patch).length === 0) return;
    const now = this.state.clock.now();
    const expanded = this.resolvePatch(path, patch, now);
    const inline = this.patchPriorities(path, patch);
    const multiPath = Object.keys(patch).some((key) => key.includes('/'));
    const mockData = this.state.rulesSnapshot();
    const updates = Object.entries(expanded).map(([writePath, value]) => ({ path: writePath, value }));
    const ruleUpdates = updates.map((update) => ({
      path: update.path, value: withPriorities(update.value, inline.get(update.path) ?? []),
    }));
    const shallowPatch = Object.fromEntries(Object.entries(expanded).map(([absolute, value]) => [
      pathSegments(absolute).at(-1)!, value,
    ]));
    const groupId = this.state.events.nextGroupId('update');
    // The update is atomic: a path's allow is recorded only once every path
    // in it is allowed, so a denied update records its denial alone.
    const allowed: Array<() => void> = [];
    const evaluatePaths = function* (this: WritePlane) {
      for (const [index, update] of updates.entries()) {
        const at = this.state.clock.now();
        const before = this.state.tree.read(update.path);
        const evaluation = this.state.rules.evaluate('write', update.path, {
          auth, mockData, newData: ruleUpdates[index]!.value, updates: ruleUpdates, now,
        });
        const fields = {
          at, durationMs: this.state.clock.now() - at, origin: 'batch' as const,
          request: { data: update.value, resourceData: update.value },
          resourceBefore: { data: before, exists: before !== null },
          resourceAfter: { data: update.value, exists: update.value !== null },
          groupId, groupKind: 'batch' as const,
          detail: multiPath
            ? { multiPath: true, rootPath: canonicalPath(path) }
            : { multiPath: false, rootPath: canonicalPath(path), key: pathSegments(update.path).at(-1)! },
        };
        if (evaluation.check !== 'allow') {
          // The denial carries the whole patch as the caller wrote it, so the
          // update can be decided again as the one request production decides.
          const denied = { ...fields, detail: { ...fields.detail, patch } };
          yield {
            evaluation,
            failNow: (): never => {
              this.state.events.operation(auth, 'update', update.path, denyResultFor(evaluation.check), evaluation, denied);
              throw permissionDenied(rtdbDenialContext(evaluation, auth, 'update', update.path, { data: update.value }));
            },
          };
          continue;
        }
        allowed.push(() => this.state.events.operation(auth, 'update', update.path, 'allow', evaluation, fields));
      }
    }.bind(this);
    const denied = selectUpdateDenial(evaluatePaths());
    if (denied !== null) denied.failNow();
    for (const record of allowed) record();
    const before = this.state.tree.read(path);
    const priorNodePriority = this.state.priorities.get(path);
    const rewindDetail = captureRewindDetail(this.state, path, before, priorNodePriority, true);
    const priors = this.children.snapshotParents();
    const changedPaths = this.applyExpandedUpdate(path, expanded, multiPath, inline);
    this.changed(changedPaths, priors);
    const after = this.state.tree.read(path);
    this.state.events.commit(auth, 'update', path, {
      data: patch, priorState: before, nextState: after, groupId, groupKind: 'batch',
      replay: { requestTime: now },
      detail: multiPath
        ? { multiPath: true, paths: Object.keys(expanded), ...rewindDetail }
        : { multiPath: false, keys: Object.keys(shallowPatch), ...rewindDetail },
    });
    this.state.events.mutation(auth, 'update', canonicalPath(path), {
      after: multiPath ? expanded : shallowPatch,
      detail: multiPath
        ? { multiPath: true, paths: Object.keys(expanded) }
        : { multiPath: false, keys: Object.keys(shallowPatch) },
    });
    this.state.notifyWrite();
  }

  private setInternal(
    auth: AuthState, path: string, value: JsonValue,
    op: 'set' | 'remove', priority: Priority, prioritySupplied: boolean,
  ): void {
    const now = this.state.clock.now();
    const resolved = normalizeWrite(
      resolveSentinels(value, now, this.state.tree.read(path)) as JsonValue,
      path === '/' ? '' : path,
    );
    const written = writePriority(value, priority);
    priority = written.priority;
    prioritySupplied ||= written.inline;
    validatePriority(priority);
    const before = this.state.tree.read(path);
    const priorNodePriority = this.state.priorities.get(path);
    const at = this.state.clock.now();
    const newData = withPriorities(resolved, [{ segments: [], priority }, ...written.nested]);
    const evaluation = this.writeEvaluation(auth, path, newData, now);
    const common = {
      at, durationMs: this.state.clock.now() - at,
      request: { data: value, resourceData: value },
      resourceBefore: { data: before, exists: before !== null },
      resourceAfter: { data: resolved, exists: resolved !== null },
    };
    if (evaluation.check !== 'allow') {
      // The denial carries the priority the write would have set, so it can be decided again with it.
      const denied = prioritySupplied ? { ...common, detail: { priority } } : common;
      this.state.events.operation(auth, op, path, denyResultFor(evaluation.check), evaluation, denied);
      throw permissionDenied(rtdbDenialContext(evaluation, auth, op, path, { data: value }));
    }
    this.state.events.operation(auth, op, path, 'allow', evaluation, common);
    const priors = this.children.snapshotParents();
    const rewindDetail = captureRewindDetail(this.state, path, before, priorNodePriority);
    this.state.tree.write(path, resolved);
    this.state.priorities.replace(path, resolved === null ? null : priority, (p) => this.state.tree.read(p) !== null);
    this.storeNestedPriorities(path, written.nested);
    this.changed([path], priors);
    const after = this.state.tree.read(path);
    const effectiveOp = after === null ? 'remove' : op;
    const hasPriority = prioritySupplied || priorNodePriority !== null;
    const detail = {
      ...(hasPriority ? { priority, priorPriority: priorNodePriority } : {}),
      ...rewindDetail,
    };
    this.state.events.commit(auth, effectiveOp, path, {
      data: value, priorState: before, nextState: after, replay: { requestTime: now },
      detail: Object.keys(detail).length > 0 ? detail : undefined,
    });
    this.state.events.mutation(auth, effectiveOp, canonicalPath(path), { before, after });
    this.state.notifyWrite();
  }

  private resolvePatchEntry(path: string, key: string, value: unknown, now: number): [string, JsonValue] {
    const segs = [...pathSegments(path), ...pathSegments(key)];
    const absolute = joinPath(segs);
    const isPriorityWrite = segs.at(-1) === '.priority';
    const currentVal = isPriorityWrite
      ? this.state.priorities.get(joinPath(segs.slice(0, -1)))
      : this.state.tree.read(absolute);
    const resolved = normalizeWrite(
      resolveSentinels(value, now, currentVal) as JsonValue, absolute, errorPrefix('update', 'values'),
    );
    if (isPriorityWrite) validatePriority(resolved as Priority);
    return [absolute, resolved];
  }

  private resolvePatch(path: string, patch: Record<string, JsonValue>, now: number): Record<string, JsonValue> {
    return Object.fromEntries(Object.entries(patch).map(([key, value]) => this.resolvePatchEntry(path, key, value, now)));
  }

  private applyExpandedUpdate(
    path: string,
    expanded: Record<string, JsonValue>,
    multiPath: boolean,
    inline: ReadonlyMap<string, readonly InlinePriority[]>,
  ): string[] {
    const dataExpanded: Record<string, JsonValue> = {};
    const priorityUpdates: Array<{ nodePath: string; priority: Priority }> = [];
    const changedPaths: string[] = [];
    for (const [writePath, value] of Object.entries(expanded)) {
      const segs = pathSegments(writePath);
      if (segs.at(-1) === '.priority') {
        const nodePath = joinPath(segs.slice(0, -1));
        priorityUpdates.push({ nodePath, priority: value as Priority });
        changedPaths.push(nodePath);
      } else {
        dataExpanded[writePath] = value;
        changedPaths.push(writePath);
      }
    }
    if (Object.keys(dataExpanded).length > 0) {
      if (multiPath) {
        this.state.tree.multiUpdate(dataExpanded);
      } else {
        this.state.tree.shallowUpdate(path, Object.fromEntries(
          Object.entries(dataExpanded).map(([absolute, value]) => [pathSegments(absolute).at(-1)!, value]),
        ));
      }
    }
    const hasNode = (p: string): boolean => this.state.tree.read(p) !== null;
    this.state.priorities.applyUpdate(
      Object.entries(dataExpanded).map(([writePath, value]) => ({ path: writePath, value })),
      hasNode,
    );
    this.storePatchPriorities(inline);
    for (const { nodePath, priority } of priorityUpdates) {
      this.state.priorities.set(nodePath, hasNode(nodePath) ? priority : null);
    }
    return Array.from(new Set(changedPaths));
  }

  /**
   * Publish a data write already applied to the tree at `paths`: mark it for
   * transaction conflict checks, revoke the listeners whose `.read` it now
   * denies, then deliver it to the rest, so the write never reaches a
   * listener the rules no longer allow. Sets, updates, priority writes, their
   * admin forms and transaction commits all publish through here.
   */
  changed(paths: string[], priors: ReturnType<ChildListeners['snapshotParents']>): void {
    this.state.mutations.mark(paths);
    this.cancelDeniedListeners(paths);
    this.values.fanOut(paths);
    this.children.fanOut(priors);
  }

  cancelDeniedListeners(changedPaths?: readonly string[]): void {
    if (this.state.valueListeners.size === 0 && this.state.childListeners.size === 0) return;
    let candidateValues: ValueListener[];
    let candidateChildren: ChildListener[];
    if (changedPaths !== undefined) {
      if (this.state.activeRules === null) return;
      const canonicalChanged = changedPaths.map((path) => joinPath(pathSegments(path)));
      if (canonicalChanged.length === 0) return;
      const rulesRoot = this.state.activeRules.rules;
      candidateValues = [...this.state.valueListeners].filter(
        (listener) => !listener.admin && listenerReadDependsOnPaths(rulesRoot, listener.path, canonicalChanged),
      );
      candidateChildren = [...this.state.childListeners].filter(
        (listener) => !listener.admin && listenerReadDependsOnPaths(rulesRoot, listener.path, canonicalChanged),
      );
    } else {
      candidateValues = [...this.state.valueListeners].filter((listener) => !listener.admin);
      candidateChildren = [...this.state.childListeners].filter((listener) => !listener.admin);
    }
    if (candidateValues.length === 0 && candidateChildren.length === 0) return;
    const mockData = this.state.rulesSnapshot();
    const deniedValues: ValueListener[] = [];
    const contexts = new Map<ValueListener | ChildListener, RtdbDenialContext>();
    for (const listener of candidateValues) {
      const evaluation = this.state.rules.evaluate('read', listener.path, {
        auth: listener.auth, mockData, querySpec: listener.query,
      });
      if (evaluation.check === 'allow') continue;
      this.state.valueListeners.delete(listener);
      // A revocation: the rules no longer allow a listener that was attached.
      // It follows from a write or a rules change, not from a request.
      this.state.events.operation(listener.auth, 'listen', listener.path, denyResultFor(evaluation.check), evaluation, {
        origin: 'listener', request: listener.query ? { query: listener.query } : undefined, detail: { revoked: true },
      });
      const rulesObj = rtdbRulesDetail(evaluation);
      this.state.events.listener('errored', listener, listener.auth, {
        event: 'value', result: 'deny',
        error: { code: 'PERMISSION_DENIED', message: 'PERMISSION_DENIED: Permission denied', reasons: evaluation.reasons },
        reasons: evaluation.reasons,
        rules: rulesObj,
      });
      contexts.set(listener, rtdbDenialContext(evaluation, listener.auth, 'listen', listener.path));
      deniedValues.push(listener);
    }
    const deniedChildren: ChildListener[] = [];
    for (const listener of candidateChildren) {
      const evaluation = this.state.rules.evaluate('read', listener.path, {
        auth: listener.auth, mockData, querySpec: listener.spec,
      });
      if (evaluation.check === 'allow') continue;
      this.state.childListeners.delete(listener);
      this.state.events.operation(listener.auth, 'listen', listener.path, denyResultFor(evaluation.check), evaluation, {
        origin: 'listener', request: listener.spec ? { query: listener.spec } : undefined, detail: { event: listener.event, revoked: true },
      });
      const rulesObj = rtdbRulesDetail(evaluation);
      this.state.events.listener('errored', listener, listener.auth, {
        event: listener.event, result: 'deny',
        error: { code: 'PERMISSION_DENIED', message: 'PERMISSION_DENIED: Permission denied', reasons: evaluation.reasons },
        reasons: evaluation.reasons,
        rules: rulesObj,
      });
      contexts.set(listener, rtdbDenialContext(evaluation, listener.auth, 'listen', listener.path));
      deniedChildren.push(listener);
    }
    for (const listener of [...deniedValues, ...deniedChildren]) {
      try {
        if (listener.onCanceled) {
          listener.onCanceled();
        }
      } catch { /* isolated teardown */ }
      try {
        if (listener.cancelCallback) {
          listener.cancelCallback(listenerPermissionDenied(listener.path, contexts.get(listener)!));
        }
      } catch { /* isolated callback */ }
    }
  }

  private readEvaluation(auth: AuthState, path: string, spec?: QuerySpec) {
    return this.state.rules.evaluate('read', path === '/' ? '/' : path, {
      auth,
      mockData: this.state.rulesSnapshot(),
      querySpec: spec,
    });
  }

  /** `newData` carries its priorities as `.priority` keys (see `withPriorities`). */
  private writeEvaluation(auth: AuthState, path: string, newData: JsonValue, now: number) {
    return this.state.rules.evaluate('write', path === '/' ? '/' : path, {
      auth, mockData: this.state.rulesSnapshot(), newData, now,
    });
  }

  /** Store the priorities a written value carries below `base`, on nodes the write kept. */
  private storeNestedPriorities(base: string, nested: readonly InlinePriority[]): void {
    for (const { segments, priority } of nested) {
      const path = joinPath([...pathSegments(base), ...segments]);
      this.state.priorities.set(path, this.state.tree.read(path) === null ? null : priority);
    }
  }

  /** The `.priority` keys each value of an update patch carries, by absolute write path. */
  private patchPriorities(path: string, patch: Record<string, unknown>): Map<string, InlinePriority[]> {
    const byPath = new Map<string, InlinePriority[]>();
    for (const [key, value] of Object.entries(patch)) {
      const { priority, inline, nested } = writePriority(value, null);
      const absolute = joinPath([...pathSegments(path), ...pathSegments(key)]);
      byPath.set(absolute, inline ? [{ segments: [], priority }, ...nested] : nested);
    }
    return byPath;
  }

  /** Store the priorities an update patch carries, after the update is applied. */
  private storePatchPriorities(inline: ReadonlyMap<string, readonly InlinePriority[]>): void {
    for (const [path, entries] of inline) {
      const own = entries.find((entry) => entry.segments.length === 0);
      if (own) this.state.priorities.set(path, this.state.tree.read(path) === null ? null : own.priority);
      this.storeNestedPriorities(path, entries.filter((entry) => entry.segments.length > 0));
    }
  }
}
