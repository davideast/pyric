/**
 * Dirty-tracked incremental persistence records for Realtime Database instances.
 *
 * Mirrors Firestore's `ChangedBuckets`: keeps shard-path membership per bucket
 * (`00`..`ff`) and tracks which buckets or instance headers mutated since the
 * previous flush so a small write only clones, checksums, and persists its own
 * shard bucket record.
 */
import { isPlainObject } from '../../firestore/plain-object.js';
import type { DatabaseInstanceRegistry } from '../../sandbox/internal/instances.js';
import { pathToBucketId } from '../../sandbox/persistence/chunk-format.js';
import {
  RTDB_DEFAULT_INSTANCE_SLOT,
  RTDB_RECORD_PREFIX,
  RTDB_SHARD_DEPTH,
  checksumRtdbBucket,
  parseRtdbBucketRecordId,
  parseRtdbInstanceRecordId,
  rtdbBucketRecordId,
  rtdbInstanceRecordId,
  type RtdbInstanceRecord,
  type RtdbPersistedRecord,
} from '../../sandbox/persistence/rtdb-records.js';
import type { BackendState } from './backend-state.js';
import type { RtdbBackend } from './backend.js';
import { cloneJson, jsonValuesEqual, pathSegments, type JsonValue } from './data-tree.js';

interface ShardEntry {
  path: string;
  top: string;
  depth: number;
}

function defineOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function collectShardPathsFromNode(
  node: Record<string, unknown>,
  prefixSegs: readonly string[],
  out: ShardEntry[],
): void {
  for (const [key, child] of Object.entries(node)) {
    if (child === null || child === undefined) continue;
    const nextSegs = [...prefixSegs, key];
    const depth = nextSegs.length;
    const top = nextSegs[0]!;
    const childIsPlain = isPlainObject(child);
    const childIsEmptyObject = childIsPlain && Object.keys(child).length === 0;
    if (depth >= RTDB_SHARD_DEPTH || !childIsPlain || childIsEmptyObject) {
      out.push({ path: `/${nextSegs.join('/')}`, top, depth });
    } else {
      collectShardPathsFromNode(child, nextSegs, out);
    }
  }
}

class InstanceRecordTracker {
  private readonly bucketShards = new Map<string, Set<string>>();
  private readonly shardsByTop = new Map<string, Set<string>>();
  private readonly shallowShards = new Set<string>();
  private persistedBuckets = new Set<string>();
  private persistedHeader = false;
  private lastHasRootValue = false;
  private lastRootValue: JsonValue = null;
  private lastRulesRef: { rules: Record<string, unknown> } | null = null;
  private lastShallowPriorityGen = -1;
  private dirtyBuckets = new Set<string>();
  private needsFullScan = true;

  constructor(
    readonly slot: string,
    private readonly state: BackendState,
  ) {
    this.state.mutations.onMark((paths) => this.onMutationMark(paths));
    this.state.priorities.onBucketChange((bucketId) => {
      this.dirtyBuckets.add(bucketId);
    });
  }

  private addShardPath(shardPath: string, top: string, depth: number): string {
    const bucketId = pathToBucketId(shardPath);
    let bucketSet = this.bucketShards.get(bucketId);
    if (bucketSet === undefined) {
      bucketSet = new Set();
      this.bucketShards.set(bucketId, bucketSet);
    }
    bucketSet.add(shardPath);

    let topSet = this.shardsByTop.get(top);
    if (topSet === undefined) {
      topSet = new Set();
      this.shardsByTop.set(top, topSet);
    }
    topSet.add(shardPath);

    if (depth < RTDB_SHARD_DEPTH) {
      this.shallowShards.add(shardPath);
    }
    return bucketId;
  }

  private removeShardPath(shardPath: string, top: string): string {
    const bucketId = pathToBucketId(shardPath);
    const bucketSet = this.bucketShards.get(bucketId);
    if (bucketSet !== undefined) {
      bucketSet.delete(shardPath);
      if (bucketSet.size === 0) this.bucketShards.delete(bucketId);
    }
    const topSet = this.shardsByTop.get(top);
    if (topSet !== undefined) {
      topSet.delete(shardPath);
      if (topSet.size === 0) this.shardsByTop.delete(top);
    }
    this.shallowShards.delete(shardPath);
    return bucketId;
  }

  initFromPersisted(persistedBucketIds: ReadonlySet<string>, hasHeader: boolean): void {
    this.bucketShards.clear();
    this.shardsByTop.clear();
    this.shallowShards.clear();
    this.dirtyBuckets.clear();
    this.persistedBuckets = new Set(persistedBucketIds);
    this.persistedHeader = hasHeader;

    if (!hasHeader && persistedBucketIds.size === 0) {
      this.needsFullScan = true;
      return;
    }

    const root = this.state.tree.peekRoot();
    if (root !== null && root !== undefined && isPlainObject(root)) {
      const entries: ShardEntry[] = [];
      collectShardPathsFromNode(root, [], entries);
      for (const entry of entries) {
        this.addShardPath(entry.path, entry.top, entry.depth);
      }
      this.lastHasRootValue = false;
      this.lastRootValue = null;
    } else if (root !== null && root !== undefined) {
      this.lastHasRootValue = true;
      this.lastRootValue = cloneJson(root);
    } else {
      this.lastHasRootValue = false;
      this.lastRootValue = null;
    }

    this.lastRulesRef = this.state.activeRules;
    this.lastShallowPriorityGen = this.state.priorities.shallowGeneration;
    this.needsFullScan = false;
  }

  markAll(): void {
    this.persistedBuckets.clear();
    this.persistedHeader = false;
    this.needsFullScan = true;
  }

  private onMutationMark(canonicalPaths: readonly string[]): void {
    if (this.needsFullScan) return;
    const root = this.state.tree.peekRoot();
    const rootIsPlain = isPlainObject(root);
    if (!rootIsPlain || this.lastHasRootValue) {
      this.needsFullScan = true;
      return;
    }

    for (const canonicalPath of canonicalPaths) {
      if (canonicalPath === '/') {
        this.needsFullScan = true;
        return;
      }
      const segs = pathSegments(canonicalPath);
      if (segs.length === 0) {
        this.needsFullScan = true;
        return;
      }
      const top = segs[0]!;

      // If a shallower ancestor previously stored a primitive/array/empty-obj
      // shard and was promoted to a non-empty object, evict its old shard entry.
      if (this.shallowShards.size > 0) {
        const limit = Math.min(segs.length, RTDB_SHARD_DEPTH);
        for (let depth = 1; depth < limit; depth += 1) {
          const ancSegs = segs.slice(0, depth);
          const ancPath = `/${ancSegs.join('/')}`;
          if (!this.shallowShards.has(ancPath)) continue;
          const ancVal = this.state.tree.peekSegments(ancSegs);
          const stillShallowLeaf =
            ancVal !== undefined
            && ancVal !== null
            && (!isPlainObject(ancVal) || Object.keys(ancVal).length === 0);
          if (!stillShallowLeaf) {
            const oldBucket = this.removeShardPath(ancPath, top);
            this.dirtyBuckets.add(oldBucket);
          }
        }
      }

      if (segs.length >= RTDB_SHARD_DEPTH) {
        const shardSegs = segs.slice(0, RTDB_SHARD_DEPTH);
        const shardPath = `/${shardSegs.join('/')}`;
        const shardVal = this.state.tree.peekSegments(shardSegs);
        if (shardVal === undefined || shardVal === null) {
          const oldBucket = this.removeShardPath(shardPath, top);
          this.dirtyBuckets.add(oldBucket);
        } else {
          const bucketId = this.addShardPath(shardPath, top, RTDB_SHARD_DEPTH);
          this.dirtyBuckets.add(bucketId);
        }
        continue;
      }

      // Shallow write (depth 1..3): refresh shards under `canonicalPath`.
      const topSet = this.shardsByTop.get(top);
      if (topSet !== undefined) {
        const prefix = `${canonicalPath}/`;
        for (const existingPath of [...topSet]) {
          if (existingPath === canonicalPath || existingPath.startsWith(prefix)) {
            const oldBucket = this.removeShardPath(existingPath, top);
            this.dirtyBuckets.add(oldBucket);
          }
        }
      }

      const subVal = this.state.tree.peekSegments(segs);
      if (subVal !== undefined && subVal !== null) {
        const subIsPlain = isPlainObject(subVal);
        const subIsEmptyObj = subIsPlain && Object.keys(subVal).length === 0;
        if (!subIsPlain || subIsEmptyObj) {
          const bucketId = this.addShardPath(canonicalPath, top, segs.length);
          this.dirtyBuckets.add(bucketId);
        } else {
          const found: ShardEntry[] = [];
          collectShardPathsFromNode(subVal, segs, found);
          for (const entry of found) {
            const bucketId = this.addShardPath(entry.path, entry.top, entry.depth);
            this.dirtyBuckets.add(bucketId);
          }
        }
      }
    }
  }

  prepare(): {
    records: Map<string, RtdbPersistedRecord>;
    removed: string[];
    retry(): void;
  } {
    if (this.needsFullScan) {
      for (const bucketId of this.bucketShards.keys()) this.dirtyBuckets.add(bucketId);
      for (const bucketId of this.persistedBuckets) this.dirtyBuckets.add(bucketId);
      for (const bucketId of this.state.priorities.bucketIds()) this.dirtyBuckets.add(bucketId);
      this.bucketShards.clear();
      this.shardsByTop.clear();
      this.shallowShards.clear();

      const root = this.state.tree.peekRoot();
      if (root !== null && root !== undefined && isPlainObject(root)) {
        const found: ShardEntry[] = [];
        collectShardPathsFromNode(root, [], found);
        for (const entry of found) {
          const bucketId = this.addShardPath(entry.path, entry.top, entry.depth);
          this.dirtyBuckets.add(bucketId);
        }
      }
      this.needsFullScan = false;
    }

    const prevPersistedBuckets = new Set(this.persistedBuckets);
    const prevPersistedHeader = this.persistedHeader;
    const prevHasRootValue = this.lastHasRootValue;
    const prevRootValue = this.lastRootValue;
    const prevRulesRef = this.lastRulesRef;
    const prevShallowPriorityGen = this.lastShallowPriorityGen;

    const capturedDirty = this.dirtyBuckets;
    this.dirtyBuckets = new Set();

    const retry = (): void => {
      for (const bucketId of capturedDirty) this.dirtyBuckets.add(bucketId);
      this.persistedBuckets = prevPersistedBuckets;
      this.persistedHeader = prevPersistedHeader;
      this.lastHasRootValue = prevHasRootValue;
      this.lastRootValue = prevRootValue;
      this.lastRulesRef = prevRulesRef;
      this.lastShallowPriorityGen = prevShallowPriorityGen;
    };

    try {
      const records = new Map<string, RtdbPersistedRecord>();
      const removed: string[] = [];

      const root = this.state.tree.peekRoot();
      const hasRootValue = root !== null && root !== undefined && !isPlainObject(root);
      const rootValueChanged =
        hasRootValue !== this.lastHasRootValue
        || (hasRootValue && !jsonValuesEqual(root, this.lastRootValue));
      const rulesChanged = this.state.activeRules !== this.lastRulesRef;
      const shallowPrioritiesChanged = this.state.priorities.shallowGeneration !== this.lastShallowPriorityGen;
      const needHeader = !this.persistedHeader || rootValueChanged || rulesChanged || shallowPrioritiesChanged;

      if (needHeader) {
        const header: RtdbInstanceRecord = {
          version: 1,
          instance: this.slot,
          priorities: this.state.priorities.shallowRecord(),
        };
        if (hasRootValue) header.rootValue = cloneJson(root);
        if (this.state.activeRules !== null) {
          header.rules = structuredClone(this.state.activeRules);
        }
        records.set(rtdbInstanceRecordId(this.slot), header);
        this.persistedHeader = true;
        this.lastHasRootValue = hasRootValue;
        this.lastRootValue = hasRootValue ? cloneJson(root) : null;
        this.lastRulesRef = this.state.activeRules;
        this.lastShallowPriorityGen = this.state.priorities.shallowGeneration;
      }

      for (const bucketId of capturedDirty) {
        const nodes: Record<string, unknown> = {};
        if (!hasRootValue) {
          const shardPaths = this.bucketShards.get(bucketId);
          if (shardPaths !== undefined) {
            for (const shardPath of [...shardPaths].sort()) {
              const segs = pathSegments(shardPath);
              const val = this.state.tree.peekSegments(segs);
              if (val === undefined || val === null) {
                this.removeShardPath(shardPath, segs[0]!);
              } else {
                defineOwnProperty(nodes, shardPath, cloneJson(val));
              }
            }
          }
        }
        const priorities = this.state.priorities.bucketRecord(bucketId);
        const isEmpty = Object.keys(nodes).length === 0 && Object.keys(priorities).length === 0;
        const recordId = rtdbBucketRecordId(this.slot, bucketId);
        if (isEmpty) {
          if (this.persistedBuckets.has(bucketId)) {
            this.persistedBuckets.delete(bucketId);
            removed.push(recordId);
          }
        } else {
          this.persistedBuckets.add(bucketId);
          records.set(recordId, {
            version: 1,
            instance: this.slot,
            nodes,
            priorities,
            checksum: checksumRtdbBucket(nodes, priorities),
          });
        }
      }

      return { records, removed, retry };
    } catch (error) {
      retry();
      throw error;
    }
  }
}

export class ChangedRtdbRecords {
  readonly prefix = RTDB_RECORD_PREFIX;
  private readonly trackers = new Map<string, InstanceRecordTracker>();
  private orphanRecordIds = new Set<string>();

  constructor(private readonly registry: DatabaseInstanceRegistry<RtdbBackend>) {}

  private slotForKey(key: string): string {
    return key === this.registry.defaultKey ? RTDB_DEFAULT_INSTANCE_SLOT : key;
  }

  private ensureTrackers(): void {
    // Ensure default instance is always tracked once RTDB persistence is active.
    this.registry.getOrCreate(this.registry.defaultKey);
    for (const [key, backend] of this.registry.entries()) {
      const slot = this.slotForKey(key);
      if (!this.trackers.has(slot)) {
        this.trackers.set(slot, new InstanceRecordTracker(slot, backend.persistenceBackendState()));
      }
    }
  }

  attachBackend(key: string, backend: RtdbBackend): void {
    const slot = this.slotForKey(key);
    if (!this.trackers.has(slot)) {
      this.trackers.set(slot, new InstanceRecordTracker(slot, backend.persistenceBackendState()));
    }
  }

  init(persistedIds: Iterable<string>): void {
    this.ensureTrackers();
    const bucketsBySlot = new Map<string, Set<string>>();
    const headerSlots = new Set<string>();
    const orphans = new Set<string>();

    for (const id of persistedIds) {
      const instSlot = parseRtdbInstanceRecordId(id);
      if (instSlot !== null) {
        if (this.trackers.has(instSlot)) headerSlots.add(instSlot);
        else orphans.add(id);
        continue;
      }
      const bucket = parseRtdbBucketRecordId(id);
      if (bucket !== null) {
        if (this.trackers.has(bucket.slot)) {
          let set = bucketsBySlot.get(bucket.slot);
          if (set === undefined) {
            set = new Set();
            bucketsBySlot.set(bucket.slot, set);
          }
          set.add(bucket.bucketId);
        } else {
          orphans.add(id);
        }
        continue;
      }
      orphans.add(id);
    }

    this.orphanRecordIds = orphans;
    for (const [slot, tracker] of this.trackers) {
      tracker.initFromPersisted(bucketsBySlot.get(slot) ?? new Set(), headerSlots.has(slot));
    }
  }

  markAll(): void {
    this.orphanRecordIds.clear();
    for (const tracker of this.trackers.values()) {
      tracker.markAll();
    }
  }

  prepare(): {
    records: Map<string, unknown>;
    removed: string[];
    retry(): void;
  } {
    this.ensureTrackers();
    const records = new Map<string, unknown>();
    const removed: string[] = [];
    const retries: Array<() => void> = [];

    if (this.orphanRecordIds.size > 0) {
      const capturedOrphans = [...this.orphanRecordIds];
      this.orphanRecordIds.clear();
      removed.push(...capturedOrphans);
      retries.push(() => {
        for (const id of capturedOrphans) this.orphanRecordIds.add(id);
      });
    }

    try {
      for (const tracker of this.trackers.values()) {
        const prepared = tracker.prepare();
        retries.push(prepared.retry);
        for (const [id, rec] of prepared.records) records.set(id, rec);
        removed.push(...prepared.removed);
      }
      return {
        records,
        removed,
        retry: () => {
          for (const r of retries) r();
        },
      };
    } catch (error) {
      for (const r of retries) r();
      throw error;
    }
  }
}
