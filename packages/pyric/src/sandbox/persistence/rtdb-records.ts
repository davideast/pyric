/**
 * Partitioned persistence records for Realtime Database state.
 *
 * Instead of storing every RTDB instance's full data tree, priorities, and
 * rules inside the single `meta` record, each RTDB instance persists as:
 *   - one lightweight header record (`rtdb:i:<slot>`) carrying active rules,
 *     shallow priorities (depth < RTDB_SHARD_DEPTH), and any non-object root;
 *   - up to BUCKET_COUNT (`00`..`ff`) bucket records (`rtdb:b:<slot>:<hex>`)
 *     holding prefix-free shard subtrees hashed by `pathToBucketId(shardPath)`
 *     plus priorities at or below depth `RTDB_SHARD_DEPTH`.
 *
 * Pure functions over plain JSON values so `chunk-format.ts` and
 * `import-bundle.ts` remain decoupled from the RTDB sandbox backend.
 */
import { FirebaseError } from '../internal/firebase-error.js';
import { isPlainObject } from '../../firestore/plain-object.js';
import { checksumDocs, pathToBucketId } from './chunk-format.js';

export const RTDB_RECORD_PREFIX = 'rtdb:';
export const RTDB_INSTANCE_RECORD_PREFIX = 'rtdb:i:';
export const RTDB_BUCKET_RECORD_PREFIX = 'rtdb:b:';
export const RTDB_DEFAULT_INSTANCE_SLOT = '(default)';
export const RTDB_SHARD_DEPTH = 4;

const BUCKET_HEX_PATTERN = /^[0-9a-f]{2}$/;

export interface RtdbInstanceRecord {
  version: 1;
  instance: string;
  rootValue?: unknown;
  priorities: Record<string, string | number>;
  rules?: { rules: Record<string, unknown> };
}

export interface RtdbBucketRecord {
  version: 1;
  instance: string;
  nodes: Record<string, unknown>;
  priorities: Record<string, string | number>;
  checksum: number;
}

export type RtdbPersistedRecord = RtdbInstanceRecord | RtdbBucketRecord;

export interface PersistedRtdbInstanceEnvelope {
  '.pyricRtdbPersistence': 1;
  data: unknown;
  priorities: Record<string, string | number>;
  rules?: { rules: Record<string, unknown> };
  instances?: Record<string, PersistedRtdbInstanceEnvelope>;
}

function defineOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function canonicalizePath(segments: readonly string[]): string {
  if (segments.length === 0) return '/';
  return `/${segments.join('/')}`;
}

function isValidPriorityValue(value: unknown): value is string | number {
  if (typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return false;
}

function isValidPriorityMap(value: unknown): value is Record<string, string | number> {
  if (!isPlainObject(value)) return false;
  for (const entry of Object.values(value)) {
    if (!isValidPriorityValue(entry)) return false;
  }
  return true;
}

function isValidRulesEnvelope(value: unknown): value is { rules: Record<string, unknown> } {
  if (!isPlainObject(value)) return false;
  return isPlainObject(value.rules);
}

export function isValidPersistedRtdbInstance(value: unknown): value is PersistedRtdbInstanceEnvelope {
  if (!isPlainObject(value)) return false;
  if (value['.pyricRtdbPersistence'] !== 1) return false;
  if (!Object.hasOwn(value, 'data') || value.data === undefined) return false;
  if (!isValidPriorityMap(value.priorities)) return false;
  if (value.rules !== undefined && !isValidRulesEnvelope(value.rules)) return false;
  if (value.instances !== undefined) {
    if (!isPlainObject(value.instances)) return false;
    for (const inst of Object.values(value.instances)) {
      if (!isValidPersistedRtdbInstance(inst)) return false;
    }
  }
  return true;
}

export function isRtdbRecordId(id: string): boolean {
  return id.startsWith(RTDB_RECORD_PREFIX);
}

export function rtdbInstanceRecordId(slot: string): string {
  return `${RTDB_INSTANCE_RECORD_PREFIX}${slot}`;
}

export function rtdbBucketRecordId(slot: string, bucketId: string): string {
  return `${RTDB_BUCKET_RECORD_PREFIX}${slot}:${bucketId}`;
}

export function parseRtdbBucketRecordId(id: string): { slot: string; bucketId: string } | null {
  if (!id.startsWith(RTDB_BUCKET_RECORD_PREFIX)) return null;
  const rest = id.slice(RTDB_BUCKET_RECORD_PREFIX.length);
  const colonAt = rest.lastIndexOf(':');
  if (colonAt <= 0) return null;
  const slot = rest.slice(0, colonAt);
  const bucketId = rest.slice(colonAt + 1);
  if (!BUCKET_HEX_PATTERN.test(bucketId)) return null;
  return { slot, bucketId };
}

export function parseRtdbInstanceRecordId(id: string): string | null {
  if (!id.startsWith(RTDB_INSTANCE_RECORD_PREFIX)) return null;
  const slot = id.slice(RTDB_INSTANCE_RECORD_PREFIX.length);
  if (slot.length === 0) return null;
  return slot;
}

export function checksumRtdbBucket(
  nodes: Record<string, unknown>,
  priorities: Record<string, string | number>,
): number {
  return checksumDocs({ nodes, priorities });
}

export function priorityBucketIdForSegments(segments: readonly string[]): string | null {
  if (segments.length < RTDB_SHARD_DEPTH) return null;
  const shardPrefix = canonicalizePath(segments.slice(0, RTDB_SHARD_DEPTH));
  return pathToBucketId(shardPrefix);
}

function collectShardEntries(
  node: Record<string, unknown>,
  prefixSegments: readonly string[],
  out: Array<[string, unknown]>,
): void {
  for (const [key, child] of Object.entries(node)) {
    if (child === null || child === undefined) continue;
    const nextSegments = [...prefixSegments, key];
    const reachedShardDepth = nextSegments.length >= RTDB_SHARD_DEPTH;
    const childIsPlain = isPlainObject(child);
    const childIsEmptyObject = childIsPlain && Object.keys(child).length === 0;
    if (reachedShardDepth || !childIsPlain || childIsEmptyObject) {
      out.push([canonicalizePath(nextSegments), child]);
    } else {
      collectShardEntries(child, nextSegments, out);
    }
  }
}

function serializeSingleInstance(
  slot: string,
  envelope: PersistedRtdbInstanceEnvelope,
  records: Map<string, RtdbPersistedRecord>,
): void {
  const shallowPriorities: Record<string, string | number> = {};
  const buckets = new Map<string, { nodes: Record<string, unknown>; priorities: Record<string, string | number> }>();

  const ensureBucket = (bucketId: string) => {
    let existing = buckets.get(bucketId);
    if (existing === undefined) {
      existing = { nodes: {}, priorities: {} };
      buckets.set(bucketId, existing);
    }
    return existing;
  };

  const data = envelope.data;
  let hasRootValue = false;
  let rootValue: unknown;
  if (data !== null && data !== undefined) {
    if (isPlainObject(data)) {
      const shards: Array<[string, unknown]> = [];
      collectShardEntries(data, [], shards);
      shards.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [shardPath, shardValue] of shards) {
        const bucketId = pathToBucketId(shardPath);
        defineOwnProperty(ensureBucket(bucketId).nodes, shardPath, shardValue);
      }
    } else {
      hasRootValue = true;
      rootValue = data;
    }
  }

  const sortedPriorities = Object.entries(envelope.priorities)
    .map(([rawPath, priority]) => {
      const segments = splitPath(rawPath);
      return { segments, canonical: canonicalizePath(segments), priority };
    })
    .sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0));

  for (const { segments, canonical, priority } of sortedPriorities) {
    const bucketId = priorityBucketIdForSegments(segments);
    if (bucketId === null) {
      defineOwnProperty(shallowPriorities, canonical, priority);
    } else {
      defineOwnProperty(ensureBucket(bucketId).priorities, canonical, priority);
    }
  }

  const header: RtdbInstanceRecord = {
    version: 1,
    instance: slot,
    priorities: shallowPriorities,
  };
  if (hasRootValue) header.rootValue = rootValue;
  if (envelope.rules !== undefined) header.rules = envelope.rules;
  records.set(rtdbInstanceRecordId(slot), header);

  for (const [bucketId, bucket] of buckets) {
    records.set(rtdbBucketRecordId(slot, bucketId), {
      version: 1,
      instance: slot,
      nodes: bucket.nodes,
      priorities: bucket.priorities,
      checksum: checksumRtdbBucket(bucket.nodes, bucket.priorities),
    });
  }
}

export function serializeRtdbServiceToRecords(rtdbService: unknown): Map<string, RtdbPersistedRecord> | null {
  if (!isValidPersistedRtdbInstance(rtdbService)) return null;
  const records = new Map<string, RtdbPersistedRecord>();
  serializeSingleInstance(RTDB_DEFAULT_INSTANCE_SLOT, rtdbService, records);
  if (rtdbService.instances !== undefined) {
    for (const [name, instanceEnvelope] of Object.entries(rtdbService.instances)) {
      if (name === RTDB_DEFAULT_INSTANCE_SLOT) continue;
      serializeSingleInstance(name, instanceEnvelope, records);
    }
  }
  return records;
}

function writeSubtreeAt(root: Record<string, unknown>, canonicalPath: string, value: unknown): void {
  const segments = splitPath(canonicalPath);
  if (segments.length === 0) return;
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    const existing = Object.hasOwn(cursor, seg) ? cursor[seg] : undefined;
    if (isPlainObject(existing)) {
      cursor = existing;
    } else {
      const next: Record<string, unknown> = {};
      defineOwnProperty(cursor, seg, next);
      cursor = next;
    }
  }
  defineOwnProperty(cursor, segments[segments.length - 1]!, value);
}

export function validateRtdbImportRecord(id: string, record: unknown): void {
  const instanceSlot = parseRtdbInstanceRecordId(id);
  if (instanceSlot !== null) {
    if (!isPlainObject(record) || record.version !== 1 || record.instance !== instanceSlot) {
      throw new FirebaseError('invalid-argument', `State import RTDB instance record '${id}' is malformed.`);
    }
    if (!isValidPriorityMap(record.priorities)) {
      throw new FirebaseError('invalid-argument', `State import RTDB instance record '${id}' requires a priority map.`);
    }
    if (record.rules !== undefined && !isValidRulesEnvelope(record.rules)) {
      throw new FirebaseError('invalid-argument', `State import RTDB instance record '${id}' has invalid rules.`);
    }
    return;
  }

  const parsedBucket = parseRtdbBucketRecordId(id);
  if (parsedBucket === null) {
    throw new FirebaseError('invalid-argument', `State import RTDB record '${id}' has an unrecognized id.`);
  }
  if (!isPlainObject(record) || record.version !== 1 || record.instance !== parsedBucket.slot) {
    throw new FirebaseError('invalid-argument', `State import RTDB bucket '${id}' is malformed.`);
  }
  if (!isPlainObject(record.nodes)) {
    throw new FirebaseError('invalid-argument', `State import RTDB bucket '${id}' requires a nodes map.`);
  }
  if (!isValidPriorityMap(record.priorities)) {
    throw new FirebaseError('invalid-argument', `State import RTDB bucket '${id}' requires a priority map.`);
  }
  for (const nodePath of Object.keys(record.nodes)) {
    if (!nodePath.startsWith('/') || nodePath === '/') {
      throw new FirebaseError('invalid-argument', `State import RTDB bucket '${id}' contains invalid shard path '${nodePath}'.`);
    }
  }
  if (record.checksum !== undefined) {
    const expected = checksumRtdbBucket(record.nodes, record.priorities);
    if (record.checksum !== expected) {
      throw new FirebaseError('invalid-argument', `State import RTDB bucket '${id}' has an invalid checksum.`);
    }
  }
}

export function deserializeRtdbRecords(records: Iterable<[string, unknown]>): PersistedRtdbInstanceEnvelope | undefined {
  const headers = new Map<string, RtdbInstanceRecord>();
  const bucketsBySlot = new Map<string, RtdbBucketRecord[]>();
  let sawAnyRtdbRecord = false;

  for (const [id, raw] of records) {
    if (!isRtdbRecordId(id)) continue;
    sawAnyRtdbRecord = true;

    const instanceSlot = parseRtdbInstanceRecordId(id);
    if (instanceSlot !== null) {
      if (!isPlainObject(raw) || raw.version !== 1 || raw.instance !== instanceSlot || !isValidPriorityMap(raw.priorities)) {
        console.warn(`[sandbox/persistence] skipping malformed RTDB instance record '${id}'`);
        continue;
      }
      if (raw.rules !== undefined && !isValidRulesEnvelope(raw.rules)) {
        console.warn(`[sandbox/persistence] skipping malformed RTDB rules in '${id}'`);
        continue;
      }
      headers.set(instanceSlot, raw as unknown as RtdbInstanceRecord);
      continue;
    }

    const parsedBucket = parseRtdbBucketRecordId(id);
    if (parsedBucket === null || !isPlainObject(raw) || raw.version !== 1 || raw.instance !== parsedBucket.slot) {
      console.warn(`[sandbox/persistence] skipping malformed RTDB bucket '${id}'`);
      continue;
    }
    if (!isPlainObject(raw.nodes) || !isValidPriorityMap(raw.priorities)) {
      console.warn(`[sandbox/persistence] skipping malformed RTDB bucket '${id}'`);
      continue;
    }
    if (typeof raw.checksum === 'number' && checksumRtdbBucket(raw.nodes, raw.priorities) !== raw.checksum) {
      console.warn(`[sandbox/persistence] checksum mismatch for RTDB bucket '${id}'; skipping corrupt bucket`);
      continue;
    }
    let slotBuckets = bucketsBySlot.get(parsedBucket.slot);
    if (slotBuckets === undefined) {
      slotBuckets = [];
      bucketsBySlot.set(parsedBucket.slot, slotBuckets);
    }
    slotBuckets.push(raw as unknown as RtdbBucketRecord);
  }

  if (!sawAnyRtdbRecord) return undefined;

  const allSlots = new Set<string>([...headers.keys(), ...bucketsBySlot.keys()]);
  const buildEnvelope = (slot: string): PersistedRtdbInstanceEnvelope => {
    const header = headers.get(slot);
    const priorities: Record<string, string | number> = {};
    if (header !== undefined) {
      for (const [k, v] of Object.entries(header.priorities)) defineOwnProperty(priorities, k, v);
    }

    let data: unknown;
    if (header !== undefined && Object.hasOwn(header, 'rootValue')) {
      data = header.rootValue;
    } else {
      const rootObj: Record<string, unknown> = {};
      for (const bucket of bucketsBySlot.get(slot) ?? []) {
        for (const [nodePath, subtree] of Object.entries(bucket.nodes)) {
          writeSubtreeAt(rootObj, nodePath, subtree);
        }
        for (const [prioPath, prio] of Object.entries(bucket.priorities)) {
          defineOwnProperty(priorities, prioPath, prio);
        }
      }
      data = rootObj;
    }

    const envelope: PersistedRtdbInstanceEnvelope = {
      '.pyricRtdbPersistence': 1,
      data,
      priorities,
    };
    if (header?.rules !== undefined) {
      envelope.rules = header.rules;
    }
    return envelope;
  };

  const defaultEnvelope = buildEnvelope(RTDB_DEFAULT_INSTANCE_SLOT);
  const namedInstances: Record<string, PersistedRtdbInstanceEnvelope> = {};
  for (const slot of allSlots) {
    if (slot === RTDB_DEFAULT_INSTANCE_SLOT) continue;
    defineOwnProperty(namedInstances, slot, buildEnvelope(slot));
  }
  if (Object.keys(namedInstances).length > 0) {
    defaultEnvelope.instances = namedInstances;
  }
  return defaultEnvelope;
}
