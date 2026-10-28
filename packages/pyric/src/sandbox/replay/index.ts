import { assertCompleteHistory } from '../internal/history-integrity.js';
/**
 * Replay — capture a session via `sandbox.history()` and re-issue
 * every write against a fresh sandbox; the engine classifies any
 * divergences.
 *
 * Exported from the main `pyric/sandbox` entry. The file lives at
 * `src/replay/index.ts` as an organizational unit; importers use
 * the public bare-package import path.
 *
 * Usage:
 * ```ts
 * import { initializeSandbox, replay, type SandboxEvent } from 'pyric/sandbox';
 *
 * const original = initializeSandbox();
 * // ... do work, capture events via original.history() ...
 * const events = original.history();
 *
 * const { sandbox: replayed, divergences } = replay(events, rulesSource);
 * // `replayed` is a fresh sandbox with every captured write re-applied.
 * // `divergences` classifies any field-level differences.
 * ```
 *
 * Each captured `WriteSandboxEvent` is re-issued on the fresh sandbox.
 * The engine consults the captured `sentinels`, `autoId`, and
 * `requestTime` fields so:
 *   - `serverTimestamp()` sentinels re-resolve to the captured time
 *     (when `pinRequestTime: true`, the default).
 *   - `collection.add()` minted IDs alias to fresh mints on replay;
 *     `pathAliases` maps the original path → the replayed path.
 *   - rules that branch on `request.time` re-evaluate identically
 *     (pinned time).
 *
 * Divergence classification (deterministic — no shape inference):
 *   - `autoid-alias`    — path differs because of fresh ID minting,
 *                          otherwise content matches.
 *   - `sentinel-drift`  — a captured sentinel sits at this exact field
 *                          path (e.g. an `increment` at `tags`) and the
 *                          subtree differs.
 *   - `time-drift`      — like `sentinel-drift` but specifically a
 *                          captured `serverTimestamp`. Surfaces when
 *                          `pinRequestTime: false` and the sandbox clock
 *                          advanced between capture and replay.
 *   - `real-divergence` — anything else. If the captured metadata
 *                          doesn't license drift at this exact leaf,
 *                          the engine flags it.
 *
 * Field-level diffs use a recursive walk producing dotted/bracket
 * leaf paths (`profile.lastSeen`, `tags[0]`, `arr[2].nested`). A
 * sentinel match is *exact-path*, not prefix — a sibling field
 * changing inside a sentinel-bearing parent surfaces independently as
 * `real-divergence`.
 */
import {
  initializeSandbox,
  type LocalSandbox,
  type SandboxEvent,
  type WriteSandboxEvent,
} from '../index.js';
import { getInternalEnv } from '../internal/sandbox-impl.js';
import { getClock } from '../clock.js';
import {
  Bytes,
  Duration,
  LatLng,
  Path,
  Reference,
  Timestamp,
  Vector,
} from 'pyric/rules/internal';
import { enginePayloadOf } from '../../firestore/sandbox/update-fields.js';
import type { BatchOperationInput } from '../../firestore/sandbox/writes.js';

type DocData = Record<string, unknown>;

export type Divergence =
  | {
      kind: 'sentinel-drift';
      path: string;
      field: string;
      sentinelKind:
        | 'serverTimestamp'
        | 'increment'
        | 'arrayUnion'
        | 'arrayRemove'
        | 'delete';
      before: unknown;
      after: unknown;
    }
  | { kind: 'autoid-alias'; originalPath: string; replayedPath: string }
  | { kind: 'time-drift'; path: string; field: string; before: unknown; after: unknown }
  | { kind: 'real-divergence'; path: string; field?: string; before: unknown; after: unknown };

export interface ReplayOptions {
  /** When true (default), re-issue the captured `requestTime` so
   *  `serverTimestamp()` sentinels resolve to the same value as
   *  capture and `request.time`-gated rules evaluate identically. */
  pinRequestTime?: boolean;
}

export interface ReplayResult {
  /** Fresh sandbox with the captured writes re-applied. */
  sandbox: LocalSandbox;
  /** Field- and path-level differences between original and replayed
   *  state, classified. */
  divergences: Divergence[];
  /** Maps captured auto-id paths → freshly-minted replay paths. The
   *  diff classifier uses this to skip `autoid-alias` paths when
   *  computing field-level differences. */
  pathAliases: Map<string, string>;
}

/**
 * Replay a captured SandboxEvent stream on a fresh sandbox.
 *
 * The `originalState` snapshot is optional — when provided, the engine
 * diffs the replayed sandbox's final state against it and returns
 * classified divergences. When omitted, divergences is `[]` (you still
 * get the replayed sandbox; you can inspect its state manually).
 */
export function replay(
  events: readonly SandboxEvent[],
  rules: string,
  options: ReplayOptions = {},
  originalState?: Record<string, DocData>,
): ReplayResult {
  assertCompleteHistory(events);
  const pinRequestTime = options.pinRequestTime !== false; // default true
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.seed({ rules });

  const pathAliases = new Map<string, string>();
  const deniedWrites: Array<{ path: string; before: unknown }> = [];
  const consumedRequestIndices = new Set<number>();
  const writes = events.filter((e): e is WriteSandboxEvent => e.kind === 'write');
  const clock = getClock(sandbox);
  let clockPinned = false;
  // A batch and an auto-id create read the server time from the clock rather
  // than from an operation field, so a pinned replay freezes the clock at the
  // captured instant around them.
  const pinClockTo = (wEv: WriteSandboxEvent) => {
    if (!pinRequestTime) return;
    clock.set(wEv.requestTime.seconds * 1000 + Math.floor(wEv.requestTime.nanoseconds / 1e6));
    clockPinned = true;
  };
  // Each write's payload comes from the `request` event paired with it (the
  // pre-resolution `request.resourceData`), or else from the write's own
  // `data` (post-resolution).
  const dataFor = (wEv: WriteSandboxEvent): DocData | undefined => {
    const requested = preResolutionDataFor(wEv, events, consumedRequestIndices);
    const raw = requested !== undefined
      ? requested
      : (enginePayloadOf({ resourceData: wEv.data, updateMask: wEv.updateMask }) as DocData | undefined);
    return raw !== undefined ? (rehydrateReplayValue(raw) as DocData) : undefined;
  };
  const remap = aliasRemapper(pathAliases);

  for (let index = 0; index < writes.length;) {
    const wEv = writes[index]!;
    // A batch or transaction commits atomically: its ops see one pre-state
    // and one shared post-write projection (getAfter/existsAfter), so it is
    // replayed as one batch, not op by op (FS-MET-2).
    const group = groupAt(writes, index);
    if (group.length > 0) {
      pinClockTo(wEv);
      replayGroup(env, group, dataFor, remap, deniedWrites);
      index += group.length;
      continue;
    }
    index += 1;
    const bypassRules = isAdminWrite(wEv);
    const data = dataFor(wEv);
    const requestTime = pinRequestTime
      ? new Timestamp(wEv.requestTime.seconds, wEv.requestTime.nanoseconds)
      : undefined;

    const hasAutoId = Boolean(wEv.autoId);
    if (hasAutoId) {
      // Auto-id create: split path, mint a fresh id, record the alias. The
      // captured request time reaches the rules through the clock, since
      // createWithAutoId takes none.
      const targetPath = remap(wEv.path);
      const collection = targetPath.slice(0, targetPath.lastIndexOf('/'));
      pinClockTo(wEv);
      try {
        const { path: mintedPath, result } = env.createWithAutoId(
          collection,
          (data ?? {}) as DocData,
          wEv.auth,
          bypassRules,
        );
        if (result.allowed) {
          pathAliases.set(wEv.path, mintedPath);
        } else {
          deniedWrites.push({ path: wEv.path, before: wEv.nextState ?? wEv.data ?? {} });
        }
      } catch {
        deniedWrites.push({ path: wEv.path, before: wEv.nextState ?? wEv.data ?? {} });
      }
      continue;
    }

    try {
      const operation: Parameters<typeof env.execute>[0] = {
        method: wEv.method,
        path: remap(wEv.path),
        auth: wEv.auth,
      };
      const hasData = data !== undefined;
      const hasRequestTime = requestTime !== undefined;
      if (hasData) operation.data = data as DocData;
      if (hasRequestTime) operation.requestTime = requestTime;
      if (bypassRules) operation.bypassRules = true;
      if (wEv.merge !== undefined) operation.merge = wEv.merge;
      const res = env.execute(operation);
      if (!res.allowed) {
        deniedWrites.push({ path: wEv.path, before: wEv.nextState ?? wEv.data ?? wEv.priorState ?? {} });
      }
    } catch {
      // Replay denials surface as state divergence below; keep going
      // to surface as much as possible in one pass.
      deniedWrites.push({ path: wEv.path, before: wEv.nextState ?? wEv.data ?? wEv.priorState ?? {} });
    }
  }
  if (clockPinned) clock.reset();

  const replayedState = getInternalEnv(sandbox).snapshot();
  const hasOriginalState = originalState !== undefined;
  const divergences = hasOriginalState
    ? computeDivergences(writes, originalState, replayedState, pathAliases, deniedWrites)
    : [];

  return { sandbox, divergences, pathAliases };
}

function isAdminWrite(event: WriteSandboxEvent): boolean {
  return event.detail?.admin === true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const DOC_REF_KEYS = new Set(['id', 'path', 'bypassRules', 'auth', 'env']);

function isSerializedDocRef(obj: Record<string, unknown>): obj is { id: string; path: string } {
  const keys = Object.keys(obj);
  if (keys.length < 2 || !keys.every((k) => DOC_REF_KEYS.has(k))) return false;
  if (typeof obj.id !== 'string' || typeof obj.path !== 'string') return false;
  const segments = obj.path.split('/');
  return (
    segments.length >= 2
    && segments.length % 2 === 0
    && segments.every((s) => s.length > 0)
    && segments[segments.length - 1] === obj.id
  );
}

function base64UrlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4 === 0 ? '' : '='.repeat(4 - (std.length % 4));
  const bin = atob(std + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64StdDecode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Rehydrate JSON-roundtripped Firestore values (`Timestamp`, `Bytes`,
 * `GeoPoint`/`LatLng`, `Vector`, `Reference`, `Duration`, `Path`) and
 * preserve/normalize FieldValue sentinels so rules evaluation and state
 * diffing operate on canonical rules wrapper instances.
 */
function rehydrateReplayValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(rehydrateReplayValue);
  if (!isPlainRecord(value)) return value;

  if (typeof value._methodName === 'string') {
    switch (value._methodName) {
      case 'serverTimestamp':
      case 'FieldValue.serverTimestamp':
        return { __type: 'serverTimestamp' };
      case 'increment':
      case 'FieldValue.increment':
        return { __type: 'increment', value: Number(value._operand ?? value.value ?? 0) };
      case 'arrayUnion':
      case 'FieldValue.arrayUnion':
        return {
          __type: 'arrayUnion',
          values: Array.isArray(value._elements) ? value._elements.map(rehydrateReplayValue) : [],
        };
      case 'arrayRemove':
      case 'FieldValue.arrayRemove':
        return {
          __type: 'arrayRemove',
          values: Array.isArray(value._elements) ? value._elements.map(rehydrateReplayValue) : [],
        };
      case 'deleteField':
      case 'FieldValue.delete':
        return { __type: 'deleteField' };
    }
  }

  if (typeof value.__type === 'string') {
    switch (value.__type) {
      case 'serverTimestamp':
      case 'increment':
      case 'deleteField':
        return value;
      case 'arrayUnion':
      case 'arrayRemove':
        return {
          ...value,
          values: Array.isArray(value.values) ? value.values.map(rehydrateReplayValue) : value.values,
        };
      case 'timestamp':
        return new Timestamp(value.seconds as number, value.nanos as number);
      case 'bytes':
        return new Bytes(base64UrlDecode(value.base64 as string));
      case 'latlng':
        return new LatLng(value.lat as number, value.lng as number);
      case 'duration':
        return new Duration(value.seconds as number, value.nanos as number);
      case 'reference':
        return new Reference(value.path as string);
      case 'path':
        return new Path(value.segments as string[]);
    }
  }

  if (value.__type__ === '__vector__' && Array.isArray(value.value)) {
    return new Vector(Object.freeze((value.value as number[]).slice()));
  }

  if (typeof value.type === 'string') {
    switch (value.type) {
      case 'firestore/timestamp/1.0':
        return new Timestamp(value.seconds as number, value.nanoseconds as number);
      case 'firestore/bytes/1.0':
        return new Bytes(base64StdDecode(value.bytes as string));
      case 'firestore/geoPoint/1.0':
        return new LatLng(value.latitude as number, value.longitude as number);
      case 'firestore/vectorValue/1.0': {
        const vec = Array.isArray(value.vectorValues) ? (value.vectorValues as number[]) : [];
        return new Vector(Object.freeze(vec.slice()));
      }
    }
  }

  if (isSerializedDocRef(value)) {
    return new Reference(value.path);
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = rehydrateReplayValue(v);
  }
  return out;
}

/**
 * Rewrite a captured path through the auto-id aliases minted so far: a
 * later write to an `add()`ed document, or under it, lands on the replayed
 * id.
 */
function aliasRemapper(pathAliases: ReadonlyMap<string, string>): (path: string) => string {
  return (path) => {
    for (const [originalPath, replayedPath] of pathAliases) {
      if (path === originalPath) return replayedPath;
      if (path.startsWith(`${originalPath}/`)) return replayedPath + path.slice(originalPath.length);
    }
    return path;
  };
}

/** The writes of the batch or transaction starting at `index`, or `[]`
 *  when the write there is a single operation. */
function groupAt(writes: readonly WriteSandboxEvent[], index: number): WriteSandboxEvent[] {
  const groupId = writes[index]?.groupId;
  if (groupId === undefined) return [];
  const group: WriteSandboxEvent[] = [];
  for (let at = index; at < writes.length && writes[at]!.groupId === groupId; at++) {
    group.push(writes[at]!);
  }
  return group;
}

/**
 * The batch method that re-applies a committed atomic write. A batch event
 * records the rules method (`create`/`update`/`delete`), so an `update`
 * with neither a field mask nor a merge was a replacing `set` over an
 * existing document.
 */
function batchMethodOf(event: WriteSandboxEvent): BatchOperationInput['method'] {
  const isReplacingSet = event.method === 'update' && event.updateMask === undefined && event.merge === undefined;
  return isReplacingSet ? 'set' : event.method;
}

/** Re-commit one captured batch or transaction as a single batch. */
function replayGroup(
  env: ReturnType<typeof getInternalEnv>,
  group: readonly WriteSandboxEvent[],
  dataFor: (event: WriteSandboxEvent) => DocData | undefined,
  remap: (path: string) => string,
  deniedWrites: Array<{ path: string; before: unknown }>,
): void {
  const operations = group.map((event) => {
    const operation: BatchOperationInput = { method: batchMethodOf(event), path: remap(event.path) };
    if (event.method !== 'delete') {
      const data = dataFor(event);
      if (data !== undefined) operation.data = data;
    }
    if (event.merge !== undefined) operation.merge = event.merge;
    return operation;
  });
  try {
    const res = env.batch(operations, group[0]!.auth, isAdminWrite(group[0]!));
    if (!res.allowed) {
      for (const event of group) {
        deniedWrites.push({ path: event.path, before: event.nextState ?? event.data ?? event.priorState ?? {} });
      }
    }
  } catch {
    // A rejected batch surfaces as state divergence, like a denied write.
    for (const event of group) {
      deniedWrites.push({ path: event.path, before: event.nextState ?? event.data ?? event.priorState ?? {} });
    }
  }
}

/**
 * Best-effort pre-resolution data extraction. The `request` event that
 * precedes a `write` event in onEvent order carries `request.resourceData`
 * with sentinels intact. Match by path + method + groupId (best-effort)
 * and take the closest preceding allowed, unconsumed request event.
 *
 * When the captured stream doesn't include a paired request event,
 * fall back to the write's post-resolution `data` (which won't have
 * sentinel markers but is structurally correct for plain writes).
 */
function preResolutionDataFor(
  wEv: WriteSandboxEvent,
  allEvents: readonly SandboxEvent[],
  consumedRequestIndices: Set<number>,
): DocData | undefined {
  // Find the latest unconsumed allowed request event BEFORE this write that matches.
  const wIdx = allEvents.indexOf(wEv);
  if (wIdx < 0) return undefined;
  for (let i = wIdx - 1; i >= 0; i--) {
    const e = allEvents[i];
    if (!e) continue;
    if (e.kind === 'write') {
      if (!wEv.groupId && !e.groupId && e.path === wEv.path) break;
      continue;
    }
    if (e.kind !== 'request') continue;
    if (consumedRequestIndices.has(i)) continue;
    if (e.result !== 'allow') continue;
    if (e.path !== wEv.path) continue;
    const sameGroup = wEv.groupId !== undefined ? e.groupId === wEv.groupId : e.groupId === undefined;
    if (!sameGroup) continue;
    const methodMatches = e.method === wEv.method || e.method === 'set' || wEv.method === 'set';
    if (!methodMatches) continue;
    consumedRequestIndices.add(i);
    return enginePayloadOf(e.request) as DocData | undefined;
  }
  return undefined;
}

/**
 * Classify state-level differences against captured write metadata.
 *
 * Design:
 *   - Top level: iterate every doc path present in either snapshot.
 *     Doc-presence diffs (missing on one side) are `real-divergence`.
 *   - Inside a doc: recursively walk both objects, building leaf-level
 *     field paths (`profile.lastSeen`, `tags[0]`, `arr[2].nested`).
 *     Match captured sentinel paths *exactly* at each path during the
 *     walk; if a sentinel covers the current subtree, classify the
 *     whole subtree as drift and STOP recursing into it. Otherwise
 *     keep recursing until we reach a primitive leaf, then classify.
 *
 * Why exact-match instead of prefix-match: a sentinel at
 * `profile.lastSeen` should classify lastSeen's drift, but a separate
 * real change at sibling `profile.name` must still surface as
 * `real-divergence`. The recursive walk visits each sibling independently.
 *
 * No shape-based inference: anything not covered by a captured
 * sentinel and not an auto-id alias becomes `real-divergence`. The
 * engine reports only what the captured metadata licenses it to
 * report.
 */
function computeDivergences(
  writes: readonly WriteSandboxEvent[],
  originalState: Record<string, DocData>,
  replayedState: Record<string, DocData>,
  pathAliases: Map<string, string>,
  deniedWrites: ReadonlyArray<{ path: string; before: unknown }> = [],
): Divergence[] {
  const out: Divergence[] = [];

  for (const [originalPath, replayedPath] of pathAliases) {
    out.push({ kind: 'autoid-alias', originalPath, replayedPath });
  }

  type SentinelKind = 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete';
  const sentinelsByPath = new Map<string, Map<string, SentinelKind>>();
  for (const w of writes) {
    if (w.sentinels && w.sentinels.length > 0) {
      const m = sentinelsByPath.get(w.path) ?? new Map<string, SentinelKind>();
      for (const s of w.sentinels) m.set(s.field, s.kind as SentinelKind);
      sentinelsByPath.set(w.path, m);
    }
  }

  // Each original document is compared with the replayed document at its
  // replayed path. An alias licenses the path change only: a replayed
  // document that is missing or different is a real divergence, so an
  // alias can't hide a replay write that failed (FS-MET-2). Divergences
  // name the original path.
  const remap = aliasRemapper(pathAliases);
  const originalAt = new Map<string, string>();
  for (const path of Object.keys(originalState)) originalAt.set(remap(path), path);
  const allPaths = new Set([...originalAt.keys(), ...Object.keys(replayedState)]);
  for (const replayedPath of allPaths) {
    const path = originalAt.get(replayedPath) ?? replayedPath;
    const origDoc = originalAt.has(replayedPath) ? originalState[path] : undefined;
    const replDoc = replayedState[replayedPath];

    if (origDoc === undefined && replDoc !== undefined) {
      out.push({ kind: 'real-divergence', path, before: undefined, after: replDoc });
      continue;
    }
    if (origDoc !== undefined && replDoc === undefined) {
      out.push({ kind: 'real-divergence', path, before: origDoc, after: undefined });
      continue;
    }
    if (origDoc === undefined || replDoc === undefined) continue;

    diffDoc(
      path,
      rehydrateReplayValue(origDoc),
      rehydrateReplayValue(replDoc),
      sentinelsByPath.get(path) ?? new Map(),
      out,
    );
  }

  for (const denied of deniedWrites) {
    const alreadyReported = out.some(
      (d) => d.kind === 'real-divergence' && d.path === denied.path,
    );
    if (!alreadyReported) {
      out.push({
        kind: 'real-divergence',
        path: denied.path,
        before: denied.before,
        after: replayedState[remap(denied.path)],
      });
    }
  }

  return out;
}

function diffDoc(
  path: string,
  original: unknown,
  replayed: unknown,
  sentinelByField: Map<string, 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete'>,
  out: Divergence[],
): void {
  walk(original, replayed, '');

  function walk(a: unknown, b: unknown, fieldPath: string): void {
    // Sentinel-covered subtree: classify whole subtree and stop. This
    // also correctly handles Timestamps captured via serverTimestamp —
    // they're objects shaped like `{ seconds, nanos }`, and we must
    // NOT recurse past the sentinel into per-field leaves.
    if (fieldPath !== '') {
      const kind = sentinelByField.get(fieldPath);
      if (kind) {
        if (JSON.stringify(a) === JSON.stringify(b)) return;
        if (kind === 'serverTimestamp') {
          out.push({ kind: 'time-drift', path, field: fieldPath, before: a, after: b });
        } else {
          out.push({ kind: 'sentinel-drift', path, field: fieldPath, sentinelKind: kind, before: a, after: b });
        }
        return;
      }
    }

    if (a === b) return;

    if (isPlainRecord(a) && isPlainRecord(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        const next = fieldPath ? `${fieldPath}.${k}` : k;
        walk(a[k], b[k], next);
      }
      return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        walk(a[i], b[i], `${fieldPath}[${i}]`);
      }
      return;
    }

    if (JSON.stringify(a) === JSON.stringify(b)) return;

    out.push({ kind: 'real-divergence', path, field: fieldPath || undefined, before: a, after: b });
  }
}
