/**
 * The Studio-side reader of Live mode's observed session data: it validates
 * the untrusted JSON the host answers on `GET /__pyric/live/session-data` into
 * the host's own wire type, and builds the portable seed payload Studio offers
 * for download.
 *
 * The wire shapes are owned by `@pyric/cli` and imported as types only; this
 * file keeps just the runtime parser, since the JSON crosses a process
 * boundary and must not be trusted structurally.
 */
import type {
  ObservedSessionDataSnapshot,
  ObservedSessionSkipStats,
  ObservedSessionSources,
  ObservedSessionStats,
} from '@pyric/cli/vite/internal/supplied-rows';
import { withObservedStorageSection } from './observed-storage-parse.js';

export type {
  ObservedSessionDataSnapshot,
  ObservedSessionSkipStats,
  ObservedSessionSources,
};

/** The seed JSON `pyric sandbox --seed <file>` reads. */
export interface ObservedSeedPayload {
  firestore: Record<string, Record<string, unknown>>;
  database?: Record<string, unknown>;
}

export const EMPTY_OBSERVED_SNAPSHOT: ObservedSessionDataSnapshot = {
  revision: 0,
  updatedAt: null,
  projectId: '',
  firestore: {},
  rtdb: {},
  defaultRtdbInstance: null,
  stats: {
    firestoreDocs: 0,
    rtdbInstances: 0,
    byteEstimate: 0,
    truncated: false,
    droppedCount: 0,
  },
};

/** Keys never copied out of host JSON, so a payload cannot reach an object's prototype. */
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A finite count from host JSON, or `fallback` when the field is absent or not a number. */
function countOr(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value;
  return fallback;
}

function parseFirestoreDocs(raw: unknown): Record<string, Record<string, unknown>> {
  const firestore: Record<string, Record<string, unknown>> = {};
  if (!isPlainRecord(raw)) return firestore;
  for (const [docPath, docData] of Object.entries(raw)) {
    if (FORBIDDEN_KEYS.has(docPath) || !isPlainRecord(docData)) continue;
    firestore[docPath] = docData;
  }
  return firestore;
}

function parseRtdbTrees(raw: unknown): Record<string, unknown> {
  const rtdb: Record<string, unknown> = {};
  if (!isPlainRecord(raw)) return rtdb;
  for (const [instance, tree] of Object.entries(raw)) {
    if (FORBIDDEN_KEYS.has(instance) || tree === null || tree === undefined) continue;
    rtdb[instance] = tree;
  }
  return rtdb;
}

function parseStats(
  raw: unknown,
  firestore: Record<string, unknown>,
  rtdb: Record<string, unknown>,
): ObservedSessionStats {
  const rawStats = isPlainRecord(raw) ? raw : {};
  return {
    firestoreDocs: countOr(rawStats.firestoreDocs, Object.keys(firestore).length),
    rtdbInstances: countOr(rawStats.rtdbInstances, Object.keys(rtdb).length),
    byteEstimate: countOr(rawStats.byteEstimate, 0),
    truncated: rawStats.truncated === true,
    droppedCount: countOr(rawStats.droppedCount, 0),
  };
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

function parseSources(raw: unknown): ObservedSessionSources | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const client = raw.client === true;
  const admin = raw.admin === true;
  if (!client && !admin) return undefined;
  return { client, admin };
}

function parseSkips(raw: unknown): ObservedSessionSkipStats | undefined {
  if (!isPlainRecord(raw)) return undefined;
  return {
    oversized: countOr(raw.oversized, 0),
    unsupported: countOr(raw.unsupported, 0),
    truncated: countOr(raw.truncated, 0),
    failed: countOr(raw.failed, 0),
    admin: countOr(raw.admin, 0),
  };
}

/** Whether any call or item was left out of the snapshot (the host omits all-zero skips). */
function hasSkippedItems(skips: ObservedSessionSkipStats | undefined): skips is ObservedSessionSkipStats {
  if (skips === undefined) return false;
  return (
    skips.oversized > 0 ||
    skips.unsupported > 0 ||
    skips.truncated > 0 ||
    skips.failed > 0 ||
    skips.admin > 0
  );
}

export function parseObservedSessionSnapshot(raw: unknown): ObservedSessionDataSnapshot {
  if (!isPlainRecord(raw)) {
    throw new Error('Invalid observed session snapshot: expected JSON object.');
  }
  const firestore = parseFirestoreDocs(raw.firestore);
  const rtdb = parseRtdbTrees(raw.rtdb);
  const snapshot: {
    -readonly [K in keyof ObservedSessionDataSnapshot]: ObservedSessionDataSnapshot[K];
  } = {
    revision: countOr(raw.revision, 0),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    firestore,
    rtdb,
    defaultRtdbInstance: stringOrNull(raw.defaultRtdbInstance),
    stats: parseStats(raw.stats, firestore, rtdb),
  };
  const sources = parseSources(raw.sources);
  if (sources !== undefined) {
    snapshot.sources = sources;
  }
  const skips = parseSkips(raw.skips);
  if (hasSkippedItems(skips)) {
    snapshot.skips = skips;
  }
  return withObservedStorageSection(snapshot, raw);
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function isEscapedSessionMap(
  value: Record<string, unknown>,
): value is { type: 'pyric/map/1.0'; fields: Record<string, unknown> } {
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    Object.hasOwn(value, 'type') &&
    value.type === 'pyric/map/1.0' &&
    isPlainRecord(value.fields)
  );
}

function needsSeedMapEscape(record: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(record, 'type') ||
    Object.hasOwn(record, '__type') ||
    Object.hasOwn(record, '__type__') ||
    Object.hasOwn(record, '__proto__')
  );
}

function sessionValueToSeedValue(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) return value.map((item) => sessionValueToSeedValue(item, depth + 1));
  if (!isPlainRecord(value)) return value;

  if (isEscapedSessionMap(value)) {
    const converted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value.fields)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      setOwn(converted, key, sessionValueToSeedValue(item, depth + 1));
    }
    if (depth === 0) {
      return isEscapedSessionMap(converted) ? { type: 'pyric/map/1.0', fields: converted } : converted;
    }
    return needsSeedMapEscape(converted) ? { type: 'pyric/map/1.0', fields: converted } : converted;
  }

  const keys = Object.keys(value);
  if (depth > 0) {
    if (
      keys.length === 2 &&
      typeof value.seconds === 'number' &&
      Number.isFinite(value.seconds) &&
      typeof value.nanoseconds === 'number' &&
      Number.isFinite(value.nanoseconds)
    ) {
      return {
        type: 'firestore/timestamp/1.0',
        seconds: Math.trunc(value.seconds),
        nanoseconds: Math.trunc(value.nanoseconds),
      };
    }
    if (
      keys.length === 2 &&
      typeof value.latitude === 'number' &&
      Number.isFinite(value.latitude) &&
      typeof value.longitude === 'number' &&
      Number.isFinite(value.longitude)
    ) {
      return {
        type: 'firestore/geoPoint/1.0',
        latitude: value.latitude,
        longitude: value.longitude,
      };
    }
    if (keys.length === 2 && value.type === 'firestore/bytes/1.0' && typeof value.bytes === 'string') {
      return { type: 'firestore/bytes/1.0', bytes: value.bytes };
    }
    if (
      keys.length === 2 &&
      value.type === 'pyric/number/1.0' &&
      (value.value === 'NaN' ||
        value.value === 'Infinity' ||
        value.value === '-Infinity' ||
        value.value === '-0')
    ) {
      return { type: 'pyric/number/1.0', value: value.value };
    }
    if (
      keys.length === 2 &&
      value.__type__ === '__vector__' &&
      Array.isArray(value.value) &&
      value.value.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      return { type: 'firestore/vectorValue/1.0', vectorValues: [...value.value] };
    }
    if (
      keys.length === 3 &&
      value.type === 'document' &&
      typeof value.path === 'string' &&
      value.path.length > 0 &&
      typeof value.id === 'string'
    ) {
      return {
        __type: 'reference',
        path: value.path.startsWith('/') ? value.path.slice(1) : value.path,
      };
    }
  }

  const converted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    setOwn(converted, key, sessionValueToSeedValue(item, depth + 1));
  }
  if (depth > 0 && needsSeedMapEscape(converted)) {
    return { type: 'pyric/map/1.0', fields: converted };
  }
  if (depth === 0 && isEscapedSessionMap(converted)) {
    return { type: 'pyric/map/1.0', fields: converted };
  }
  return converted;
}

function sessionFirestoreToSeedDocs(
  docs: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [docPath, rawDoc] of Object.entries(docs)) {
    if (FORBIDDEN_KEYS.has(docPath)) continue;
    setOwn(out, docPath, sessionValueToSeedValue(rawDoc, 0) as Record<string, unknown>);
  }
  return out;
}

/**
 * Build a portable `pyric sandbox --seed <file>` JSON object from the current
 * observed session snapshot without writing anything on the host. The RTDB
 * tree comes from `rtdbInstance` when given, else the snapshot's default
 * instance; it is included only when that tree is an object.
 */
export function buildObservedSeedPayload(
  snapshot: ObservedSessionDataSnapshot,
  rtdbInstance?: string | null,
): ObservedSeedPayload {
  const payload: ObservedSeedPayload = {
    firestore: sessionFirestoreToSeedDocs(snapshot.firestore),
  };
  const chosenInstance = rtdbInstance ?? snapshot.defaultRtdbInstance;
  if (!chosenInstance) return payload;
  const database = snapshot.rtdb[chosenInstance];
  if (isPlainRecord(database)) {
    payload.database = database;
  }
  return payload;
}
