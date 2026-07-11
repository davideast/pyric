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
 *                          `pinRequestTime: false` and the wall clock
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
  type Sandbox,
  type SandboxEvent,
  type WriteSandboxEvent,
} from '../index.js';
import { getInternalEnv } from '../internal/sandbox-impl.js';
import { Timestamp } from '../../rules/internal/index.js';

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
  sandbox: Sandbox;
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
  const pinRequestTime = options.pinRequestTime !== false; // default true
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.seed({ rules });

  const pathAliases = new Map<string, string>();
  const writes = events.filter((e): e is WriteSandboxEvent => e.kind === 'write');

  // Re-issue every write. For each, look up the matching `request`
  // event (one before each write in onEvent order — gives us the
  // pre-resolution `request.resourceData`). Fall back to the write's
  // own `data` (post-resolution) when the request event isn't
  // available.
  for (const wEv of writes) {
    const bypassRules = isAdminWrite(wEv);
    const data = preResolutionDataFor(wEv, events) ?? wEv.data;
    const requestTime = pinRequestTime
      ? new Timestamp(wEv.requestTime.seconds, wEv.requestTime.nanoseconds)
      : undefined;

    if (wEv.autoId) {
      // Auto-id create: split path, mint a fresh id, record the alias.
      const collection = wEv.path.slice(0, wEv.path.lastIndexOf('/'));
      const { path: mintedPath } = env.createWithAutoId(
        collection,
        (data ?? {}) as DocData,
        wEv.auth,
        bypassRules,
      );
      pathAliases.set(wEv.path, mintedPath);
      continue;
    }

    try {
      env.execute({
        method: wEv.method,
        path: wEv.path,
        auth: wEv.auth,
        ...(data !== undefined ? { data: data as DocData } : {}),
        ...(requestTime ? { requestTime } : {}),
        ...(bypassRules ? { bypassRules: true } : {}),
      });
    } catch {
      // Replay denials surface as state divergence below; keep going
      // to surface as much as possible in one pass.
    }
  }

  const replayedState = sandbox.snapshot().firestore;
  const divergences = originalState
    ? computeDivergences(writes, originalState, replayedState, pathAliases)
    : [];

  return { sandbox, divergences, pathAliases };
}

function isAdminWrite(event: WriteSandboxEvent): boolean {
  return event.detail?.admin === true;
}

/**
 * Best-effort pre-resolution data extraction. The `request` event that
 * precedes a `write` event in onEvent order carries `request.resourceData`
 * with sentinels intact. Match by path + method + groupId (best-effort)
 * and take the closest preceding request event.
 *
 * When the captured stream doesn't include a paired request event,
 * fall back to the write's post-resolution `data` (which won't have
 * sentinel markers but is structurally correct for plain writes).
 */
function preResolutionDataFor(
  wEv: WriteSandboxEvent,
  allEvents: readonly SandboxEvent[],
): DocData | undefined {
  // Find the latest request event AT OR BEFORE this write that matches.
  const wIdx = allEvents.indexOf(wEv);
  if (wIdx < 0) return undefined;
  for (let i = wIdx; i >= 0; i--) {
    const e = allEvents[i];
    if (!e || e.kind !== 'request') continue;
    if (e.path !== wEv.path) continue;
    return e.request?.resourceData as DocData | undefined;
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
): Divergence[] {
  const out: Divergence[] = [];

  const aliasedOriginals = new Set(pathAliases.keys());
  const aliasedReplays = new Set(pathAliases.values());
  for (const [originalPath, replayedPath] of pathAliases) {
    out.push({ kind: 'autoid-alias', originalPath, replayedPath });
  }

  type SentinelKind = 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete';
  const sentinelsByPath = new Map<string, Map<string, SentinelKind>>();
  for (const w of writes) {
    if (w.sentinels && w.sentinels.length > 0) {
      const m = new Map<string, SentinelKind>();
      for (const s of w.sentinels) m.set(s.field, s.kind as SentinelKind);
      sentinelsByPath.set(w.path, m);
    }
  }

  const allPaths = new Set([...Object.keys(originalState), ...Object.keys(replayedState)]);
  for (const path of allPaths) {
    if (aliasedOriginals.has(path) && !(path in replayedState)) continue;
    if (aliasedReplays.has(path) && !(path in originalState)) continue;

    const origDoc = originalState[path];
    const replDoc = replayedState[path];

    if (origDoc === undefined && replDoc !== undefined) {
      out.push({ kind: 'real-divergence', path, before: undefined, after: replDoc });
      continue;
    }
    if (origDoc !== undefined && replDoc === undefined) {
      out.push({ kind: 'real-divergence', path, before: origDoc, after: undefined });
      continue;
    }
    if (origDoc === undefined || replDoc === undefined) continue;

    diffDoc(path, origDoc, replDoc, sentinelsByPath.get(path) ?? new Map(), out);
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

    const aIsObj = a !== null && typeof a === 'object' && !Array.isArray(a);
    const bIsObj = b !== null && typeof b === 'object' && !Array.isArray(b);
    if (aIsObj && bIsObj) {
      const ao = a as Record<string, unknown>;
      const bo = b as Record<string, unknown>;
      const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
      for (const k of keys) {
        const next = fieldPath ? `${fieldPath}.${k}` : k;
        walk(ao[k], bo[k], next);
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
