import { getClock, type LocalSandbox, type Sandbox } from "pyric/sandbox";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  captureSandboxSnapshot,
  type SnapshotStorageObject,
} from "pyric/sandbox/internal";
import {
  ASSURANCE_TARGET_SCHEMA,
  AssuranceInputError,
  type AssuranceAttachmentInventory,
  type AssuranceAttachmentSource,
  type AssuranceCoverageGap,
  type AuthFixtureUser,
  type LocalFirebaseTarget,
  type StorageObjectFixture,
} from "./types.js";

export interface AssuranceAttachmentInput {
  url: string;
}

export interface AssuranceAttachment {
  target: LocalFirebaseTarget;
  source: AssuranceAttachmentSource;
  inventory: AssuranceAttachmentInventory;
  coverageGaps: AssuranceCoverageGap[];
}

export type AssuranceAttachmentProvider = (
  input: AssuranceAttachmentInput,
) => Promise<AssuranceAttachment>;

export interface SandboxAttachmentProviderOptions {
  origin?: string;
  fetchImpl?: typeof fetch;
}

export type {
  AssuranceAttachmentInventory,
  AssuranceAttachmentSource,
  AssuranceCoverageGap,
} from "./types.js";

interface PyricInitPayload {
  rules?: string | null;
  databaseRules?: { rules: Record<string, unknown> } | null;
  storageRules?: string | null;
  bridgeUrl?: string | null;
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1"
  ) {
    return true;
  }
  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function parseLocalOrigin(rawUrl: string, runtimeOrigin: string): URL {
  let requested: URL;
  let current: URL;
  try {
    requested = new URL(rawUrl);
    current = new URL(runtimeOrigin);
  } catch {
    throw new AssuranceInputError(
      `'${rawUrl}' is not a valid absolute Pyric URL.`,
    );
  }
  if (
    (requested.protocol !== "http:" && requested.protocol !== "https:") ||
    !isLoopbackHost(requested.hostname) ||
    requested.username ||
    requested.password
  ) {
    throw new AssuranceInputError(
      "firebase_assurance_attach accepts only credential-free HTTP(S) loopback URLs.",
    );
  }
  if (requested.origin !== current.origin) {
    throw new AssuranceInputError(
      `attachment URL origin '${requested.origin}' does not match the connected Pyric sandbox origin '${current.origin}'.`,
    );
  }
  return requested;
}

function hasRtdbState(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return true;
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function resolveRuntimeOrigin(explicitOrigin: string | undefined): string {
  if (explicitOrigin !== undefined) return explicitOrigin;
  if (typeof globalThis.location !== "undefined") {
    return globalThis.location.origin;
  }
  return "";
}

/**
 * Clone the sandbox currently hosting the connected bridge peer. The URL is an
 * origin assertion and source for explicit rules metadata; no arbitrary host is
 * contacted and the returned campaign target itself keeps networking forbidden.
 */
export function createSandboxAttachmentProvider(
  sandbox: Sandbox,
  options: SandboxAttachmentProviderOptions = {},
): AssuranceAttachmentProvider {
  return async ({ url }) => {
    const runtimeOrigin = resolveRuntimeOrigin(options.origin);
    if (!runtimeOrigin) {
      throw new AssuranceInputError(
        "localhost attachment is available only inside a served Pyric sandbox peer.",
      );
    }
    const requested = parseLocalOrigin(url, runtimeOrigin);
    const origin = requested.origin;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new AssuranceInputError(
        "localhost attachment requires the Fetch API.",
      );
    }

    const response = await fetchImpl(`${origin}/__pyric/init.json`, {
      redirect: "error",
    });
    if (!response.ok) {
      throw new AssuranceInputError(
        `Pyric initialization metadata returned HTTP ${response.status} at '${origin}'.`,
      );
    }
    const payload = (await response.json()) as PyricInitPayload;
    if (!payload || typeof payload !== "object" || !payload.bridgeUrl) {
      throw new AssuranceInputError(
        `No active Pyric bridge was advertised by '${origin}/__pyric/init.json'.`,
      );
    }

    const rules: LocalFirebaseTarget["rules"] = {};
    if (typeof payload.rules === "string" && payload.rules.trim()) {
      rules.firestore = payload.rules;
    }
    if (payload.databaseRules?.rules) rules.rtdb = payload.databaseRules;
    if (typeof payload.storageRules === "string" && payload.storageRules.trim()) {
      rules.storage = payload.storageRules;
    }

    return cloneSandboxTarget(sandbox, rules, {
      requestedUrl: url,
      origin,
      transport: "same-origin-shared-worker",
      readOnly: true,
      studioUrl: `${origin}/__pyric/ui/assurance`,
    });
  };
}

/**
 * Clone the sandbox this process owns, with no origin to assert and nothing
 * to contact.
 */
export function createOwnedSandboxAttachmentProvider(
  sandbox: Sandbox,
  rules: LocalFirebaseTarget["rules"],
  studioUrl: string,
): AssuranceAttachmentProvider {
  return async ({ url }) =>
    cloneSandboxTarget(sandbox, rules, {
      requestedUrl: url,
      origin: url,
      transport: "in-process-sandbox",
      readOnly: true,
      studioUrl,
    });
}

function setOwn(
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

function cloneOwnRecord<V>(source: Record<string, V>): Record<string, V> {
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
async function cloneSandboxTarget(
  sandbox: Sandbox,
  rules: LocalFirebaseTarget["rules"],
  source: AssuranceAttachmentSource,
): Promise<AssuranceAttachment> {
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

  const mergedRtdbInstances: Record<
    string,
    { rules: Record<string, unknown> }
  > = effectiveRules.rtdbInstances
    ? cloneOwnRecord(effectiveRules.rtdbInstances)
    : {};
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

  const mergedStorageBucketRules: Record<string, string> =
    effectiveRules.storageBuckets
      ? cloneOwnRecord(effectiveRules.storageBuckets)
      : {};
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
  if (!effectiveRules.storage && storageEntries.length > 0) {
    coverageGaps.push({
      service: "storage",
      code: "storage-rules-unavailable",
      reason:
        "The running sandbox has Storage objects but no explicit Storage rules source.",
    });
  }

  const hasDisabledProvider = snapshot.auth.providers
    ? Object.values(snapshot.auth.providers).some((enabled) => enabled === false)
    : false;
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
