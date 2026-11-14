/**
 * Snapshot-to-`AssuranceAttachment` target cloning, inventory counting, and
 * missing-rules coverage gap computation for `attachment.ts`.
 */
import { getClock, type LocalSandbox, type Sandbox } from "pyric/sandbox";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  captureSandboxSnapshot,
  type SnapshotStorageObject,
} from "pyric/sandbox/internal";
import {
  ASSURANCE_TARGET_SCHEMA,
  type AssuranceAttachmentInventory,
  type AssuranceAttachmentSource,
  type AssuranceCoverageGap,
  type AuthFixtureUser,
  type LocalFirebaseTarget,
  type StorageObjectFixture,
} from "./types.js";

export interface ClonedSandboxAttachment {
  target: LocalFirebaseTarget;
  source: AssuranceAttachmentSource;
  inventory: AssuranceAttachmentInventory;
  coverageGaps: AssuranceCoverageGap[];
}

export function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function cloneOwnRecord<V>(source: Record<string, V>): Record<string, V> {
  const copy: Record<string, V> = {};
  for (const [key, value] of Object.entries(source)) {
    Object.defineProperty(copy, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function hasRtdbState(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return true;
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function stripStorageRuleComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
}

function singleStorageRulesCoversBucket(
  source: string,
  bucketKey: string,
): boolean {
  const stripped = stripStorageRuleComments(source);
  const bucketMatchRe = /\bmatch\s+\/b\/([^/\s]+)\/o\b/g;
  const matchedSegments: string[] = [];
  let match = bucketMatchRe.exec(stripped);
  while (match !== null) {
    if (match[1] !== undefined) {
      matchedSegments.push(match[1]);
    }
    match = bucketMatchRe.exec(stripped);
  }
  if (matchedSegments.length === 0) {
    return true;
  }
  for (const segment of matchedSegments) {
    if (segment.startsWith("{") && segment.endsWith("}")) {
      return true;
    }
    if (segment === bucketKey) {
      return true;
    }
  }
  return false;
}

export function hasUnruledStorageObjects(options: {
  defaultObjectCount: number;
  populatedNamedBuckets: readonly string[];
  defaultStorageRules: string | undefined;
  storageBucketRules: Readonly<Record<string, string>> | undefined;
}): boolean {
  const hasDefaultRules =
    typeof options.defaultStorageRules === "string" &&
    options.defaultStorageRules.trim().length > 0;
  const bucketRuleMap = options.storageBucketRules ?? {};
  const hasNamedBucketRules = Object.keys(bucketRuleMap).length > 0;

  if (options.defaultObjectCount > 0 && !hasDefaultRules) {
    return true;
  }

  for (const bucketKey of options.populatedNamedBuckets) {
    let namedSource: string | undefined;
    if (Object.hasOwn(bucketRuleMap, bucketKey)) {
      namedSource = bucketRuleMap[bucketKey];
    }
    if (typeof namedSource === "string" && namedSource.trim().length > 0) {
      continue;
    }
    if (hasNamedBucketRules) {
      return true;
    }
    if (!hasDefaultRules || options.defaultStorageRules === undefined) {
      return true;
    }
    if (!singleStorageRulesCoversBucket(options.defaultStorageRules, bucketKey)) {
      return true;
    }
  }

  return false;
}

function parseSnapshotRtdbRules(
  raw: string | undefined,
): { rules: Record<string, unknown> } | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as { rules?: unknown };
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.rules &&
      typeof parsed.rules === "object" &&
      !Array.isArray(parsed.rules)
    ) {
      return {
        rules: cloneOwnRecord(parsed.rules as Record<string, unknown>),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function mapStorageObjectEntry(
  item: SnapshotStorageObject,
  preserveTimestamps: boolean,
): StorageObjectFixture {
  const entry: StorageObjectFixture & {
    cacheControl?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    contentLanguage?: string;
    timeCreated?: string;
    updated?: string;
  } = {
    path: item.path,
    dataBase64: item.contentBase64,
  };
  if (item.contentType !== undefined) {
    entry.contentType = item.contentType;
  }
  if (item.customMetadata !== undefined) {
    entry.customMetadata = cloneOwnRecord(item.customMetadata);
  }
  if (item.cacheControl !== undefined) {
    entry.cacheControl = item.cacheControl;
  }
  if (item.contentDisposition !== undefined) {
    entry.contentDisposition = item.contentDisposition;
  }
  if (item.contentEncoding !== undefined) {
    entry.contentEncoding = item.contentEncoding;
  }
  if (item.contentLanguage !== undefined) {
    entry.contentLanguage = item.contentLanguage;
  }
  if (preserveTimestamps || item.timeCreated !== item.updated) {
    if (item.timeCreated !== undefined) {
      entry.timeCreated = item.timeCreated;
    }
    if (item.updated !== undefined) {
      entry.updated = item.updated;
    }
  }
  return entry;
}

/** The campaign target, inventory, and coverage gaps one sandbox's state produces. */
export async function cloneSandboxTarget(
  sandbox: Sandbox,
  rules: LocalFirebaseTarget["rules"],
  source: AssuranceAttachmentSource,
): Promise<ClonedSandboxAttachment> {
  const snapshot = await captureSandboxSnapshot(sandbox as LocalSandbox);
  let manualClock = false;
  try {
    manualClock = getClock(sandbox as LocalSandbox).mode !== "wall";
  } catch {
    manualClock = false;
  }

  const rawFirestoreDocs = snapshot.firestore[DEFAULT_SNAPSHOT_RESOURCE] ?? {};
  const firestoreDocs: Record<string, Record<string, unknown>> = {};
  for (const [docPath, encodedData] of Object.entries(rawFirestoreDocs)) {
    setOwn(firestoreDocs, docPath, cloneOwnRecord(encodedData));
  }
  const rtdbState = snapshot.rtdb[DEFAULT_SNAPSHOT_RESOURCE] ?? null;
  const rawStorageObjects = snapshot.storage[DEFAULT_SNAPSHOT_RESOURCE] ?? [];

  const effectiveRules: LocalFirebaseTarget["rules"] & {
    storageBuckets?: Record<string, string>;
  } = { ...rules };

  const activeFirestoreRules =
    snapshot.rules.firestore?.[DEFAULT_SNAPSHOT_RESOURCE];
  if (
    !effectiveRules.firestore &&
    typeof activeFirestoreRules === "string" &&
    activeFirestoreRules.trim().length > 0
  ) {
    effectiveRules.firestore = activeFirestoreRules;
  }

  const activeRtdbRules = parseSnapshotRtdbRules(
    snapshot.rules.rtdb?.[DEFAULT_SNAPSHOT_RESOURCE],
  );
  if (!effectiveRules.rtdb && activeRtdbRules) {
    effectiveRules.rtdb = activeRtdbRules;
  }

  let mergedRtdbInstances: Record<
    string,
    { rules: Record<string, unknown> }
  > = {};
  if (effectiveRules.rtdbInstances) {
    mergedRtdbInstances = cloneOwnRecord(effectiveRules.rtdbInstances);
  }
  for (const [instanceKey, rawRules] of Object.entries(
    snapshot.rules.rtdb ?? {},
  )) {
    if (instanceKey === DEFAULT_SNAPSHOT_RESOURCE) continue;
    if (Object.hasOwn(mergedRtdbInstances, instanceKey)) continue;
    const parsedRtdb = parseSnapshotRtdbRules(rawRules);
    if (parsedRtdb) {
      setOwn(mergedRtdbInstances, instanceKey, parsedRtdb);
    }
  }
  if (Object.keys(mergedRtdbInstances).length > 0) {
    effectiveRules.rtdbInstances = mergedRtdbInstances;
  }

  const namedRtdbState: Record<string, unknown> = {};
  let unruledNamedRtdbHasState = false;
  for (const [instanceKey, tree] of Object.entries(snapshot.rtdb ?? {})) {
    if (instanceKey === DEFAULT_SNAPSHOT_RESOURCE) continue;
    if (!hasRtdbState(tree)) continue;
    if (Object.hasOwn(mergedRtdbInstances, instanceKey)) {
      setOwn(namedRtdbState, instanceKey, tree);
    } else {
      unruledNamedRtdbHasState = true;
    }
  }

  const activeStorageRules =
    snapshot.rules.storage?.[DEFAULT_SNAPSHOT_RESOURCE];
  if (
    !effectiveRules.storage &&
    typeof activeStorageRules === "string" &&
    activeStorageRules.trim().length > 0
  ) {
    effectiveRules.storage = activeStorageRules;
  }

  let mergedStorageBucketRules: Record<string, string> = {};
  if (effectiveRules.storageBuckets) {
    mergedStorageBucketRules = cloneOwnRecord(effectiveRules.storageBuckets);
  }
  for (const [bucketKey, rawRules] of Object.entries(
    snapshot.rules.storage ?? {},
  )) {
    if (bucketKey === DEFAULT_SNAPSHOT_RESOURCE) continue;
    if (Object.hasOwn(mergedStorageBucketRules, bucketKey)) continue;
    if (typeof rawRules === "string" && rawRules.trim().length > 0) {
      setOwn(mergedStorageBucketRules, bucketKey, rawRules);
    }
  }
  if (Object.keys(mergedStorageBucketRules).length > 0) {
    effectiveRules.storageBuckets = mergedStorageBucketRules;
  }

  const storageEntries: StorageObjectFixture[] = rawStorageObjects.map((item) =>
    mapStorageObjectEntry(item, manualClock),
  );
  const namedStorageBuckets: Record<string, StorageObjectFixture[]> = {};
  let namedStorageObjectCount = 0;
  for (const [bucketKey, items] of Object.entries(snapshot.storage ?? {})) {
    if (bucketKey === DEFAULT_SNAPSHOT_RESOURCE || items.length === 0) continue;
    namedStorageObjectCount += items.length;
    setOwn(
      namedStorageBuckets,
      bucketKey,
      items.map((item) => mapStorageObjectEntry(item, manualClock)),
    );
  }

  const authUsers: AuthFixtureUser[] = snapshot.auth.users.map((user) => {
    const entry: AuthFixtureUser = { uid: user.uid };
    if (user.email !== undefined) {
      entry.email = user.email;
    }
    if (user.password !== undefined) {
      entry.password = user.password;
    }
    if (user.displayName !== undefined) {
      entry.displayName = user.displayName;
    }
    if (user.photoUrl !== undefined) {
      entry.photoUrl = user.photoUrl;
    }
    if (user.phoneNumber !== undefined) {
      entry.phoneNumber = user.phoneNumber;
    }
    if (user.tenantId !== undefined) {
      entry.tenantId = user.tenantId;
    }
    if (user.providerId !== undefined) {
      entry.providerId = user.providerId;
    }
    if (
      Array.isArray(user.providerUserInfo) &&
      user.providerUserInfo.length > 0
    ) {
      entry.providerUserInfo = user.providerUserInfo.map((provider) => {
        const clone: NonNullable<AuthFixtureUser["providerUserInfo"]>[number] = {
          providerId: provider.providerId,
        };
        const raw = provider as unknown as Record<string, unknown>;
        if (typeof raw.rawId === "string") clone.rawId = raw.rawId;
        if (typeof raw.uid === "string") clone.uid = raw.uid;
        if (typeof raw.email === "string") clone.email = raw.email;
        if (typeof raw.displayName === "string") clone.displayName = raw.displayName;
        if (typeof raw.photoUrl === "string") clone.photoUrl = raw.photoUrl;
        if (typeof raw.phoneNumber === "string") clone.phoneNumber = raw.phoneNumber;
        return clone;
      });
    }
    if (user.customClaims !== undefined) {
      entry.customClaims = cloneOwnRecord(user.customClaims);
    }
    if (user.emailVerified !== undefined) {
      entry.emailVerified = user.emailVerified;
    }
    if (user.disabled === true) {
      entry.disabled = true;
    }
    return entry;
  });

  const coverageGaps: AssuranceCoverageGap[] = [];
  if (!effectiveRules.firestore && Object.keys(firestoreDocs).length > 0) {
    coverageGaps.push({
      service: "firestore",
      code: "firestore-rules-unavailable",
      reason:
        "The running sandbox has Firestore data but no explicit project rules source.",
    });
  }
  if (
    (!effectiveRules.rtdb && hasRtdbState(rtdbState)) ||
    unruledNamedRtdbHasState
  ) {
    coverageGaps.push({
      service: "rtdb",
      code: "rtdb-rules-unavailable",
      reason:
        "The running sandbox has RTDB data but no explicit database rules source.",
    });
  }
  if (
    hasUnruledStorageObjects({
      defaultObjectCount: storageEntries.length,
      populatedNamedBuckets: Object.keys(namedStorageBuckets),
      defaultStorageRules: effectiveRules.storage,
      storageBucketRules: effectiveRules.storageBuckets,
    })
  ) {
    coverageGaps.push({
      service: "storage",
      code: "storage-rules-unavailable",
      reason:
        "The running sandbox has Storage objects but no explicit Storage rules source.",
    });
  }

  let hasDisabledProvider = false;
  if (snapshot.auth.providers) {
    hasDisabledProvider = Object.values(snapshot.auth.providers).some(
      (enabled) => enabled === false,
    );
  }
  const authState: {
    users: AuthFixtureUser[];
    providers?: Record<string, boolean>;
  } = { users: authUsers };
  if (hasDisabledProvider && snapshot.auth.providers) {
    authState.providers = cloneOwnRecord(snapshot.auth.providers);
  }

  const state: LocalFirebaseTarget["state"] & {
    storageBuckets?: Record<string, StorageObjectFixture[]>;
    storageConfig?: {
      crossServiceIam?: "granted" | "denied";
      undeployedBucketPolicy?: "allow" | "deny";
    };
  } = {
    firestore: firestoreDocs,
    auth: authState,
  };
  if (effectiveRules.rtdb || hasRtdbState(rtdbState)) {
    state.rtdb = rtdbState;
  }
  if (Object.keys(namedRtdbState).length > 0) {
    state.rtdbInstances = namedRtdbState;
  }
  if (storageEntries.length > 0) {
    state.storage = storageEntries;
  }
  if (Object.keys(namedStorageBuckets).length > 0) {
    state.storageBuckets = namedStorageBuckets;
  }
  if (snapshot.storageConfig !== undefined) {
    state.storageConfig = { ...snapshot.storageConfig };
  }

  const anyRtdbState =
    hasRtdbState(rtdbState) || Object.values(namedRtdbState).some(hasRtdbState);

  return {
    target: {
      schema: ASSURANCE_TARGET_SCHEMA,
      network: "forbid",
      rules: effectiveRules,
      state,
    },
    source,
    inventory: {
      firestoreDocuments: Object.keys(firestoreDocs).length,
      rtdbPresent: anyRtdbState,
      authUsers: authUsers.length,
      storageObjects: storageEntries.length + namedStorageObjectCount,
    },
    coverageGaps,
  };
}
