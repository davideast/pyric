/**
 * Multi-service summary and bounded preview builder for `SandboxSnapshot`.
 *
 * Browser-clean (`AGENTS.md` Boundary #5): zero `node:*` imports and zero
 * `Buffer` calls.
 */
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  type SandboxSnapshot,
  type SnapshotStorageObject,
} from './snapshot-codec.js';
import type { EncodedMap } from './snapshot-value-codec.js';

const TEXT_ENCODER = new TextEncoder();
const DEFAULT_PREVIEW_LIMIT = 25;

export interface SummarizeSnapshotOptions {
  readonly includeData?: boolean;
  readonly maxPreviewItems?: number;
}

export interface FirestoreInspectionSummary {
  readonly rulesConfigured: boolean;
  readonly rulesSizeBytes: number;
  readonly databases: readonly string[];
  readonly totalDocuments: number;
  readonly byCollection: Readonly<Record<string, number>>;
  readonly preview?: {
    readonly truncated: boolean;
    readonly documents: Readonly<Record<string, EncodedMap>>;
  };
}

export interface DatabaseInspectionSummary {
  readonly rulesConfigured: boolean;
  readonly rulesSizeBytes: number;
  readonly instances: readonly string[];
  readonly hasData: boolean;
  readonly topLevelKeys: readonly string[];
  readonly nodeCount: number;
  readonly preview?: {
    readonly truncated: boolean;
    readonly instances: Readonly<Record<string, unknown>>;
  };
}

export interface StorageObjectSummaryEntry {
  readonly bucket: string;
  readonly path: string;
  readonly size: number;
  readonly contentType?: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface StorageInspectionSummary {
  readonly rulesConfigured: boolean;
  readonly rulesSizeBytes: number;
  readonly buckets: readonly string[];
  readonly totalObjects: number;
  readonly totalBytes: number;
  readonly preview?: {
    readonly truncated: boolean;
    readonly objects: readonly StorageObjectSummaryEntry[];
  };
}

export interface AuthUserSummaryEntry {
  readonly uid: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly disabled: boolean;
  readonly tenantId?: string;
  readonly customClaims?: Readonly<Record<string, unknown>>;
}

export interface AuthInspectionSummary {
  readonly totalUsers: number;
  readonly verifiedUsers: number;
  readonly disabledUsers: number;
  readonly tenants: readonly string[];
  readonly preview?: {
    readonly truncated: boolean;
    readonly users: readonly AuthUserSummaryEntry[];
  };
}

export interface MultiServiceInspectionSummary {
  readonly firestore: FirestoreInspectionSummary;
  readonly database: DatabaseInspectionSummary;
  readonly storage: StorageInspectionSummary;
  readonly auth: AuthInspectionSummary;
}

function utf8ByteLength(text: string): number {
  return TEXT_ENCODER.encode(text).byteLength;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defineOwnField<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function unwrapPriorityValue(node: unknown): unknown {
  if (isPlainRecord(node) && Object.hasOwn(node, '.value')) {
    return node['.value'];
  }
  return node;
}

function countDescendantNodes(node: unknown): number {
  const unwrapped = unwrapPriorityValue(node);
  if (unwrapped === null || unwrapped === undefined || typeof unwrapped !== 'object') {
    return 0;
  }
  if (Array.isArray(unwrapped)) {
    let arrayTotal = 0;
    for (const item of unwrapped) {
      if (item === null || item === undefined) continue;
      arrayTotal += 1 + countDescendantNodes(item);
    }
    return arrayTotal;
  }
  let recordTotal = 0;
  for (const [key, child] of Object.entries(unwrapped)) {
    if (key === '.priority' || child === null || child === undefined) continue;
    recordTotal += 1 + countDescendantNodes(child);
  }
  return recordTotal;
}

function countTreeNodes(tree: unknown): number {
  if (tree === null || tree === undefined) return 0;
  const unwrapped = unwrapPriorityValue(tree);
  if (unwrapped === null || unwrapped === undefined) return 0;
  if (typeof unwrapped !== 'object') return 1;
  return countDescendantNodes(unwrapped);
}

function topLevelKeysOf(tree: unknown): string[] {
  const unwrapped = unwrapPriorityValue(tree);
  if (!isPlainRecord(unwrapped)) return [];
  return Object.keys(unwrapped)
    .filter((key) => key !== '.priority')
    .sort();
}

function summarizeFirestore(
  snapshot: SandboxSnapshot,
  includeData: boolean,
  limit: number,
): FirestoreInspectionSummary {
  const rulesMap = snapshot.rules.firestore ?? {};
  let rulesSizeBytes = 0;
  let rulesConfigured = false;
  for (const source of Object.values(rulesMap)) {
    rulesSizeBytes += utf8ByteLength(source);
    if (source.trim().length > 0) rulesConfigured = true;
  }

  const databases = [...new Set([...Object.keys(snapshot.firestore), ...Object.keys(rulesMap)])].sort();
  const collectionCounts = new Map<string, number>();
  const previewCandidates: Array<[string, EncodedMap]> = [];
  let totalDocuments = 0;

  for (const dbKey of databases) {
    let docs: Readonly<Record<string, EncodedMap>> = {};
    if (Object.hasOwn(snapshot.firestore, dbKey)) {
      docs = snapshot.firestore[dbKey] ?? {};
    }
    for (const docPath of Object.keys(docs).sort()) {
      if (!Object.hasOwn(docs, docPath)) continue;
      totalDocuments++;
      const slashIndex = docPath.lastIndexOf('/');
      let collectionPath = docPath;
      if (slashIndex > 0) {
        collectionPath = docPath.slice(0, slashIndex);
      }
      collectionCounts.set(collectionPath, (collectionCounts.get(collectionPath) ?? 0) + 1);
      if (includeData) {
        let previewKey = docPath;
        if (dbKey !== DEFAULT_SNAPSHOT_RESOURCE) {
          previewKey = `${dbKey}:${docPath}`;
        }
        previewCandidates.push([previewKey, docs[docPath]!]);
      }
    }
  }

  const byCollection: Record<string, number> = {};
  for (const [collectionPath, count] of collectionCounts.entries()) {
    defineOwnField(byCollection, collectionPath, count);
  }

  const summary: {
    rulesConfigured: boolean;
    rulesSizeBytes: number;
    databases: string[];
    totalDocuments: number;
    byCollection: Record<string, number>;
    preview?: { truncated: boolean; documents: Record<string, EncodedMap> };
  } = {
    rulesConfigured,
    rulesSizeBytes,
    databases,
    totalDocuments,
    byCollection,
  };

  if (includeData) {
    const bounded: Record<string, EncodedMap> = {};
    for (const [key, docData] of previewCandidates.slice(0, limit)) {
      defineOwnField(bounded, key, docData);
    }
    summary.preview = {
      truncated: previewCandidates.length > limit,
      documents: bounded,
    };
  }

  return summary;
}

function summarizeDatabase(
  snapshot: SandboxSnapshot,
  includeData: boolean,
  limit: number,
): DatabaseInspectionSummary {
  const rulesMap = snapshot.rules.rtdb ?? {};
  let rulesSizeBytes = 0;
  for (const source of Object.values(rulesMap)) {
    rulesSizeBytes += utf8ByteLength(source);
  }
  const rulesConfigured = Object.keys(rulesMap).length > 0;
  const instances = [...new Set([...Object.keys(snapshot.rtdb), ...Object.keys(rulesMap)])].sort();
  let defaultTree: unknown;
  if (Object.hasOwn(snapshot.rtdb, DEFAULT_SNAPSHOT_RESOURCE)) {
    defaultTree = snapshot.rtdb[DEFAULT_SNAPSHOT_RESOURCE];
  }
  const topLevelKeys = topLevelKeysOf(defaultTree);

  let nodeCount = 0;
  for (const tree of Object.values(snapshot.rtdb)) {
    nodeCount += countTreeNodes(tree);
  }

  const summary: {
    rulesConfigured: boolean;
    rulesSizeBytes: number;
    instances: string[];
    hasData: boolean;
    topLevelKeys: string[];
    nodeCount: number;
    preview?: { truncated: boolean; instances: Record<string, unknown> };
  } = {
    rulesConfigured,
    rulesSizeBytes,
    instances,
    hasData: nodeCount > 0,
    topLevelKeys,
    nodeCount,
  };

  if (includeData) {
    const previewInstances: Record<string, unknown> = {};
    let totalKeysIncluded = 0;
    let truncated = false;
    for (const instanceKey of Object.keys(snapshot.rtdb).sort()) {
      if (!Object.hasOwn(snapshot.rtdb, instanceKey)) continue;
      const tree = snapshot.rtdb[instanceKey];
      const unwrapped = unwrapPriorityValue(tree);
      if (!isPlainRecord(unwrapped)) {
        if (totalKeysIncluded < limit) {
          defineOwnField(previewInstances, instanceKey, tree);
          totalKeysIncluded++;
        } else {
          truncated = true;
        }
        continue;
      }
      const childPreview: Record<string, unknown> = {};
      for (const key of Object.keys(unwrapped).sort()) {
        if (!Object.hasOwn(unwrapped, key)) continue;
        if (totalKeysIncluded >= limit) {
          truncated = true;
          break;
        }
        defineOwnField(childPreview, key, unwrapped[key]);
        totalKeysIncluded++;
      }
      defineOwnField(previewInstances, instanceKey, childPreview);
    }
    summary.preview = { truncated, instances: previewInstances };
  }

  return summary;
}

function summarizeStorage(
  snapshot: SandboxSnapshot,
  includeData: boolean,
  limit: number,
): StorageInspectionSummary {
  const rulesMap = snapshot.rules.storage ?? {};
  let rulesSizeBytes = 0;
  let rulesConfigured = false;
  for (const source of Object.values(rulesMap)) {
    rulesSizeBytes += utf8ByteLength(source);
    if (source.trim().length > 0) rulesConfigured = true;
  }

  const activeBuckets = new Set<string>(Object.keys(rulesMap));
  for (const [bucketKey, items] of Object.entries(snapshot.storage)) {
    if (items.length > 0) activeBuckets.add(bucketKey);
  }
  const buckets = [...activeBuckets].sort();

  let totalObjects = 0;
  let totalBytes = 0;
  const previewObjects: StorageObjectSummaryEntry[] = [];

  for (const bucketKey of Object.keys(snapshot.storage).sort()) {
    let items: readonly SnapshotStorageObject[] = [];
    if (Object.hasOwn(snapshot.storage, bucketKey)) {
      items = snapshot.storage[bucketKey] ?? [];
    }
    for (const item of items) {
      totalObjects++;
      totalBytes += item.size;
      if (includeData && previewObjects.length < limit) {
        const entry: {
          bucket: string;
          path: string;
          size: number;
          contentType?: string;
          customMetadata?: Readonly<Record<string, string>>;
        } = {
          bucket: bucketKey,
          path: item.path,
          size: item.size,
        };
        if (item.contentType !== undefined) entry.contentType = item.contentType;
        if (item.customMetadata !== undefined) entry.customMetadata = item.customMetadata;
        previewObjects.push(entry);
      }
    }
  }

  const summary: {
    rulesConfigured: boolean;
    rulesSizeBytes: number;
    buckets: string[];
    totalObjects: number;
    totalBytes: number;
    preview?: { truncated: boolean; objects: StorageObjectSummaryEntry[] };
  } = {
    rulesConfigured,
    rulesSizeBytes,
    buckets,
    totalObjects,
    totalBytes,
  };

  if (includeData) {
    summary.preview = {
      truncated: totalObjects > limit,
      objects: previewObjects,
    };
  }

  return summary;
}

function summarizeAuth(
  snapshot: SandboxSnapshot,
  includeData: boolean,
  limit: number,
): AuthInspectionSummary {
  let verifiedUsers = 0;
  let disabledUsers = 0;
  const tenantSet = new Set<string>();

  for (const user of snapshot.auth.users) {
    if (user.emailVerified === true) verifiedUsers++;
    if (user.disabled === true) disabledUsers++;
    if (user.tenantId !== undefined) tenantSet.add(user.tenantId);
  }

  const totalUsers = snapshot.auth.users.length;
  const summary: {
    totalUsers: number;
    verifiedUsers: number;
    disabledUsers: number;
    tenants: string[];
    preview?: { truncated: boolean; users: AuthUserSummaryEntry[] };
  } = {
    totalUsers,
    verifiedUsers,
    disabledUsers,
    tenants: [...tenantSet].sort(),
  };

  if (includeData) {
    const users: AuthUserSummaryEntry[] = snapshot.auth.users.slice(0, limit).map((user) => {
      const entry: {
        uid: string;
        email?: string;
        emailVerified: boolean;
        disabled: boolean;
        tenantId?: string;
        customClaims?: Readonly<Record<string, unknown>>;
      } = {
        uid: user.uid,
        emailVerified: user.emailVerified === true,
        disabled: user.disabled === true,
      };
      if (user.email !== undefined) entry.email = user.email;
      if (user.tenantId !== undefined) entry.tenantId = user.tenantId;
      if (user.customClaims !== undefined) entry.customClaims = user.customClaims;
      return entry;
    });
    summary.preview = {
      truncated: totalUsers > limit,
      users,
    };
  }

  return summary;
}

/** Build a structured multi-service summary from a `SandboxSnapshot`. */
export function summarizeSandboxSnapshot(
  snapshot: SandboxSnapshot,
  options?: SummarizeSnapshotOptions,
): MultiServiceInspectionSummary {
  const includeData = options?.includeData === true;
  let limit = DEFAULT_PREVIEW_LIMIT;
  if (typeof options?.maxPreviewItems === 'number' && options.maxPreviewItems > 0) {
    limit = Math.floor(options.maxPreviewItems);
  }
  return {
    firestore: summarizeFirestore(snapshot, includeData, limit),
    database: summarizeDatabase(snapshot, includeData, limit),
    storage: summarizeStorage(snapshot, includeData, limit),
    auth: summarizeAuth(snapshot, includeData, limit),
  };
}
