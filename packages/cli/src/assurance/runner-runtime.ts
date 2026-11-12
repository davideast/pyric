import { getAuth, sandbox as authSandbox, type SeedUser } from "pyric/auth";
import {
  getAdminDatabase,
  getDatabase,
  get as getRtdb,
  ref as rtdbRef,
  sandbox as rtdbSandbox,
  type Database,
} from "pyric/database";
import { getFirestore, type Firestore } from "pyric/firestore";
import { rtdbRulesSourceRejection } from "pyric/rules/internal/rtdb";
import {
  getClock,
  initializeSandbox,
  type AuthState,
  type LocalSandbox,
  type SandboxContext,
} from "pyric/sandbox";
import type { RtdbRulesJson } from "pyric/sandbox/database";
import { seedDocuments, setRules, snapshotDocuments } from "pyric/sandbox/firestore";
import {
  decodeSnapshotMap,
  decodeSnapshotMapForEnv,
  resolveDatabaseInstance,
  type ReferenceDecoder,
} from "pyric/sandbox/internal";
import { normalizeStorageBucketInstance } from "./validation-target.js";
import {
  getBlob,
  getMetadata,
  getStorageSandbox,
  listAll,
  ref as storageRef,
  uploadBytes,
  type FirebaseStorage,
} from "pyric/storage";
import {
  arrayBufferToBase64,
  deployStorageBucketRules,
  generationIssuer,
  getAdminStorageSandbox,
  getStorageService,
  lockUndeployedStorageBuckets,
  nameStorageBucket,
  replaceCrossServiceIam,
  targetOf,
  type StoredMetadata,
} from "pyric/storage/internal";
import type {
  ActorEvidence,
  AssuranceActor,
  FirebaseOperation,
  LocalFirebaseTarget,
  StorageOperation,
} from "./types.js";

export interface ActorRuntime {
  evidence: ActorEvidence;
  auth: AuthState | null;
}

export interface ServiceRuntime {
  sandbox: LocalSandbox;
  actor: ActorRuntime;
  context: SandboxContext;
  firestore?: Firestore;
  rtdb?: Database;
  rtdbAdmin?: Database;
  storage?: FirebaseStorage;
  storageAdmin?: FirebaseStorage;
  storageDbName?: string;
  storageDefaultBucket?: string;
}

let storageRunSequence = 0;

export function stableStringify(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return '"__pyric_num__:NaN"';
    if (value === Number.POSITIVE_INFINITY) return '"__pyric_num__:Infinity"';
    if (value === Number.NEGATIVE_INFINITY) return '"__pyric_num__:-Infinity"';
    if (Object.is(value, -0)) return '"__pyric_num__:-0"';
    return JSON.stringify(value);
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function targetHash(target: LocalFirebaseTarget): string {
  const input = stableStringify(target);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32-${hash.toString(16).padStart(8, "0")}`;
}

export function formatThrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error !== null &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function normalizeFirestorePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function toStandardBase64(raw: string): string {
  const normalized = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  if (remainder === 0) return normalized;
  return normalized + "=".repeat(4 - remainder);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isEscapedFirestoreMap(
  record: Record<string, unknown>,
): record is { type: "pyric/map/1.0"; fields: Record<string, unknown> } {
  return (
    Object.keys(record).length === 2 &&
    Object.hasOwn(record, "type") &&
    record.type === "pyric/map/1.0" &&
    Object.hasOwn(record, "fields") &&
    isPlainObject(record.fields)
  );
}

function hasOwnNumber(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && typeof record[key] === "number";
}

function hasOwnString(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && typeof record[key] === "string";
}

function hasOwnNumberArray(
  record: Record<string, unknown>,
  key: string,
): number[] | undefined {
  if (!Object.hasOwn(record, key) || !Array.isArray(record[key])) {
    return undefined;
  }
  const items = record[key] as unknown[];
  return items.every((item) => typeof item === "number")
    ? (items as number[])
    : undefined;
}

function canonicalizeExactEnvelope(
  value: Record<string, unknown>,
  keyCount: number,
): Record<string, unknown> | undefined {
  const tag = Object.hasOwn(value, "type") ? value.type : undefined;
  if (
    (tag === "pyric/geopoint/1.0" ||
      tag === "pyric/geoPoint/1.0" ||
      tag === "firestore/geoPoint/1.0") &&
    keyCount === 3
  ) {
    if (hasOwnNumber(value, "latitude") && hasOwnNumber(value, "longitude")) {
      return {
        type: "firestore/geoPoint/1.0",
        latitude: value.latitude as number,
        longitude: value.longitude as number,
      };
    }
    if (hasOwnNumber(value, "lat") && hasOwnNumber(value, "lng")) {
      return {
        type: "firestore/geoPoint/1.0",
        latitude: value.lat as number,
        longitude: value.lng as number,
      };
    }
  }
  if ((tag === "pyric/bytes/1.0" || tag === "firestore/bytes/1.0") && keyCount === 2) {
    const rawBytes = hasOwnString(value, "bytes")
      ? (value.bytes as string)
      : hasOwnString(value, "base64")
        ? (value.base64 as string)
        : tag === "pyric/bytes/1.0" && hasOwnString(value, "value")
          ? (value.value as string)
          : undefined;
    if (rawBytes !== undefined) {
      return { type: "firestore/bytes/1.0", bytes: toStandardBase64(rawBytes) };
    }
  }
  if (
    tag === "pyric/ref/1.0" ||
    tag === "pyric/reference/1.0" ||
    tag === "firestore/documentReference/1.0"
  ) {
    if (hasOwnString(value, "path") && keyCount === 2) {
      return { __type: "reference", path: value.path as string };
    }
    if (
      hasOwnString(value, "path") &&
      hasOwnString(value, "databaseId") &&
      keyCount === 3
    ) {
      return {
        __type: "reference",
        path: value.path as string,
        databaseId: value.databaseId as string,
      };
    }
  }
  if (
    (tag === "pyric/vector/1.0" || tag === "firestore/vectorValue/1.0") &&
    keyCount === 2
  ) {
    const vectorValues =
      hasOwnNumberArray(value, "vectorValues") ??
      hasOwnNumberArray(value, "values") ??
      hasOwnNumberArray(value, "value");
    if (vectorValues !== undefined) {
      return {
        type: "firestore/vectorValue/1.0",
        vectorValues: [...vectorValues],
      };
    }
  }
  if (tag === "pyric/timestamp/1.0" || tag === "firestore/timestamp/1.0") {
    if (tag === "pyric/timestamp/1.0" && hasOwnNumber(value, "seconds") && keyCount === 2) {
      return {
        type: "firestore/timestamp/1.0",
        seconds: value.seconds as number,
        nanoseconds: 0,
      };
    }
    if (
      hasOwnNumber(value, "seconds") &&
      hasOwnNumber(value, "nanoseconds") &&
      keyCount === 3
    ) {
      return {
        type: "firestore/timestamp/1.0",
        seconds: value.seconds as number,
        nanoseconds: value.nanoseconds as number,
      };
    }
    if (
      hasOwnNumber(value, "seconds") &&
      hasOwnNumber(value, "nanos") &&
      keyCount === 3
    ) {
      return {
        type: "firestore/timestamp/1.0",
        seconds: value.seconds as number,
        nanoseconds: value.nanos as number,
      };
    }
  }
  return undefined;
}

function canonicalizeFirestoreEnvelopes(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeFirestoreEnvelopes(entry));
  }
  if (!isPlainObject(value)) return value;

  if (isEscapedFirestoreMap(value)) {
    const inner: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value.fields)) {
      Object.defineProperty(inner, k, {
        value: canonicalizeFirestoreEnvelopes(v),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { type: "pyric/map/1.0", fields: inner };
  }

  const keyCount = Object.keys(value).length;
  const envelope = canonicalizeExactEnvelope(value, keyCount);
  if (envelope !== undefined) {
    return envelope;
  }

  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(next, key, {
      value: canonicalizeFirestoreEnvelopes(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return next;
}

function canonicalizeFirestoreMap(
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (isEscapedFirestoreMap(data)) {
    return canonicalizeFirestoreEnvelopes(data) as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(data)) {
    Object.defineProperty(next, key, {
      value: canonicalizeFirestoreEnvelopes(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return next;
}

export function decodeFirestoreMapForEnv(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return decodeSnapshotMapForEnv(canonicalizeFirestoreMap(data));
}

export function decodeFirestoreMapForSdk(
  data: Record<string, unknown>,
  references: ReferenceDecoder,
): Record<string, unknown> {
  return decodeSnapshotMap(canonicalizeFirestoreMap(data), references);
}

export function decodeFirestoreValueForSdk(
  value: unknown,
  references: ReferenceDecoder,
): unknown {
  return decodeSnapshotMap(
    { value: canonicalizeFirestoreEnvelopes(value) },
    references,
  ).value;
}

export function normalizeFirestoreDocuments(
  docs: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  if (!docs) return {};
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [path, data] of Object.entries(docs)) {
    const cleanPath = normalizeFirestorePath(path);
    if (!cleanPath) continue;
    Object.defineProperty(normalized, cleanPath, {
      value: decodeFirestoreMapForEnv(data),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return normalized;
}

function authUsers(target: LocalFirebaseTarget): SeedUser[] {
  return (target.state.auth?.users ?? []).map((user): SeedUser => {
    const record: SeedUser = { uid: user.uid };
    if (typeof user.email === "string") record.email = user.email;
    if (user.password !== undefined) record.password = user.password;
    if (user.displayName !== undefined) record.displayName = user.displayName;
    if (user.photoUrl !== undefined) record.photoUrl = user.photoUrl;
    if (user.phoneNumber !== undefined) record.phoneNumber = user.phoneNumber;
    if (user.tenantId !== undefined) record.tenantId = user.tenantId;
    if (user.providerId !== undefined) record.providerId = user.providerId;
    if (user.providerUserInfo !== undefined) {
      record.providerUserInfo = user.providerUserInfo.map((provider) => ({
        ...provider,
      }));
    }
    if (user.customClaims !== undefined) {
      record.customClaims = { ...user.customClaims };
    }
    if (user.disabled !== undefined) record.disabled = user.disabled;
    if (user.emailVerified !== undefined) {
      record.emailVerified = user.emailVerified;
    }
    return record;
  });
}

export function seedAuth(
  sandbox: LocalSandbox,
  target: LocalFirebaseTarget,
): ReturnType<typeof getAuth> {
  const auth = getAuth(sandbox);
  if (target.state.auth?.providers !== undefined) {
    authSandbox.restoreProviderConfig(auth, {
      ...authSandbox.exportProviderConfig(auth),
      ...target.state.auth.providers,
    });
  }
  authSandbox.seedUsers(auth, authUsers(target));
  return auth;
}

export function acquireActor(
  sandbox: LocalSandbox,
  target: LocalFirebaseTarget,
  actor: AssuranceActor,
): ActorRuntime {
  const auth = seedAuth(sandbox, target);
  try {
    switch (actor.acquisition.kind) {
      case "anonymous-request":
        return {
          auth: null,
          evidence: {
            actorId: actor.id,
            acquisition: actor.acquisition.kind,
            reachability: "reachable",
          },
        };
      case "anonymous-account": {
        const session = authSandbox.mintSession(auth, { kind: "anonymous" });
        return {
          auth: session.state,
          evidence: {
            actorId: actor.id,
            acquisition: actor.acquisition.kind,
            reachability: "reachable",
            uid: session.user.uid,
          },
        };
      }
      case "password": {
        const acqEmail = actor.acquisition.email;
        const acqEmailLower = acqEmail.toLowerCase();
        const acqPassword = actor.acquisition.password;
        const matchedUser = (target.state.auth?.users ?? []).find(
          (u) =>
            typeof u.email === "string" &&
            u.email.toLowerCase() === acqEmailLower,
        );
        const req: {
          kind: "password";
          email: string;
          password: string;
          tenantId?: string;
        } = {
          kind: "password",
          email: acqEmail,
          password: acqPassword,
        };
        if (matchedUser?.tenantId !== undefined) {
          req.tenantId = matchedUser.tenantId;
        }
        const session = authSandbox.mintSession(auth, req);
        return {
          auth: session.state,
          evidence: {
            actorId: actor.id,
            acquisition: actor.acquisition.kind,
            reachability: "reachable",
            uid: session.user.uid,
          },
        };
      }
      case "fixture-user": {
        const acqUid = actor.acquisition.uid;
        const matchedUser = (target.state.auth?.users ?? []).find(
          (u) => u.uid === acqUid,
        );
        const req: {
          kind: "uid";
          uid: string;
          tenantId?: string;
        } = {
          kind: "uid",
          uid: acqUid,
        };
        if (matchedUser?.tenantId !== undefined) {
          req.tenantId = matchedUser.tenantId;
        }
        const session = authSandbox.mintSession(auth, req);
        return {
          auth: session.state,
          evidence: {
            actorId: actor.id,
            acquisition: actor.acquisition.kind,
            reachability: "reachable",
            uid: session.user.uid,
          },
        };
      }
      case "synthetic":
        return {
          auth: {
            uid: actor.acquisition.uid,
            token: actor.acquisition.token ?? {},
          },
          evidence: {
            actorId: actor.id,
            acquisition: actor.acquisition.kind,
            reachability: "synthetic",
            uid: actor.acquisition.uid,
          },
        };
    }
  } catch (error) {
    const message = formatThrownMessage(error);
    return {
      auth: null,
      evidence: {
        actorId: actor.id,
        acquisition: actor.acquisition.kind,
        reachability: "unreachable",
        error: message,
      },
    };
  }
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function createRuntime(
  campaignId: string,
  probeId: string,
  phase: "control" | "mutation",
  target: LocalFirebaseTarget,
  actorRuntime: ActorRuntime,
  service: FirebaseOperation["service"],
): Promise<ServiceRuntime> {
  const sandbox = initializeSandbox();
  seedAuth(sandbox, target);
  const context = sandbox.withAuth(actorRuntime.auth);
  const runtime: ServiceRuntime = { sandbox, actor: actorRuntime, context };

  if (service === "firestore") {
    const firestore = getFirestore(context);
    setRules(sandbox, target.rules.firestore!);
    seedDocuments(sandbox, normalizeFirestoreDocuments(target.state.firestore));
    runtime.firestore = firestore;
    return runtime;
  }

  if (service === "rtdb") {
    const rtdb = getDatabase(context);
    const admin = getAdminDatabase(sandbox);
    if (target.rules.rtdb) {
      const rootRules: RtdbRulesJson = target.rules.rtdb;
      const refusal = rtdbRulesSourceRejection(rootRules);
      if (refusal !== null) {
        throw new Error(
          `The assurance target's database rules would not deploy. ${refusal.message}`,
        );
      }
      rtdbSandbox.setRules(rtdb, rootRules);
      rtdbSandbox.setData(admin, { "/": target.state.rtdb ?? {} });
    }
    runtime.rtdb = rtdb;
    runtime.rtdbAdmin = admin;

    if (target.rules.rtdbInstances) {
      const stateByResolved = new Map<string, unknown>();
      if (target.state.rtdbInstances) {
        for (const [key, val] of Object.entries(target.state.rtdbInstances)) {
          stateByResolved.set(resolveDatabaseInstance(key)!.name, val);
        }
      }
      for (const [instanceName, instanceValue] of Object.entries(
        target.rules.rtdbInstances,
      )) {
        const instanceRefusal = rtdbRulesSourceRejection(instanceValue);
        if (instanceRefusal !== null) {
          throw new Error(
            `The assurance target's database rules for instance '${instanceName}' would not deploy. ${instanceRefusal.message}`,
          );
        }
        const resolved = resolveDatabaseInstance(instanceName)!;
        const instDb = getDatabase(context, resolved.url);
        const instAdmin = getAdminDatabase(sandbox, resolved.url);
        rtdbSandbox.setRules(instDb, instanceValue);
        const instData = stateByResolved.get(resolved.name);
        rtdbSandbox.setData(instAdmin, { "/": instData ?? {} });
      }
    }
    return runtime;
  }

  if (target.state.firestore) {
    seedDocuments(sandbox, normalizeFirestoreDocuments(target.state.firestore));
  }
  const dbName = [
    "pyric-assurance",
    campaignId,
    probeId,
    phase,
    Date.now(),
    storageRunSequence++,
  ]
    .join("-")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  const LOCKED_STORAGE_RULES =
    "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if false; } } }";
  const defaultBucketRulesFromMap = Object.entries(
    target.rules.storageBuckets ?? {},
  ).find(
    ([bucketName]) => normalizeStorageBucketInstance(bucketName) === undefined,
  )?.[1];
  const effectiveDefaultStorageRules =
    typeof target.rules.storage === "string" &&
    target.rules.storage.trim().length > 0
      ? target.rules.storage
      : defaultBucketRulesFromMap;
  const hasNamedBucketRules =
    Object.keys(target.rules.storageBuckets ?? {}).length > 0;
  const lockUndeployedDefault =
    effectiveDefaultStorageRules === undefined &&
    target.state.storageConfig?.undeployedBucketPolicy !== "allow" &&
    (hasNamedBucketRules ||
      target.state.storageConfig?.undeployedBucketPolicy === "deny");
  const initialDefaultStorageRules =
    typeof effectiveDefaultStorageRules === "string" &&
    effectiveDefaultStorageRules.trim().length > 0
      ? effectiveDefaultStorageRules
      : lockUndeployedDefault
        ? LOCKED_STORAGE_RULES
        : undefined;
  let admin: FirebaseStorage;
  try {
    admin = getAdminStorageSandbox(sandbox, {
      dbName,
      ...(initialDefaultStorageRules !== undefined
        ? { rules: initialDefaultStorageRules }
        : {}),
    });
  } catch {
    admin = getAdminStorageSandbox(sandbox, {
      dbName,
      rules: LOCKED_STORAGE_RULES,
    });
  }
  for (const [bucketName, bucketRules] of Object.entries(
    target.rules.storageBuckets ?? {},
  )) {
    const normalizedBucket = normalizeStorageBucketInstance(bucketName);
    if (normalizedBucket !== undefined) {
      try {
        deployStorageBucketRules(sandbox, normalizedBucket, bucketRules);
      } catch {
        deployStorageBucketRules(sandbox, normalizedBucket, LOCKED_STORAGE_RULES);
      }
    }
  }
  if (target.state.storageConfig?.crossServiceIam !== undefined) {
    await replaceCrossServiceIam(sandbox, target.state.storageConfig.crossServiceIam);
  }
  if (target.state.storageConfig?.undeployedBucketPolicy !== undefined) {
    lockUndeployedStorageBuckets(
      sandbox,
      target.state.storageConfig.undeployedBucketPolicy,
    );
  }
  const seedBucketObjects = async (
    bucketHandle: FirebaseStorage,
    objects: NonNullable<LocalFirebaseTarget["state"]["storage"]>,
  ): Promise<void> => {
    for (const object of objects) {
      const objectRef = storageRef(bucketHandle, object.path);
      const bytes = decodeBase64(object.dataBase64);
      const hasRichMetadata =
        object.cacheControl !== undefined ||
        object.contentDisposition !== undefined ||
        object.contentEncoding !== undefined ||
        object.contentLanguage !== undefined ||
        object.timeCreated !== undefined ||
        object.updated !== undefined;
      if (hasRichMetadata) {
        const blob = new Blob([bytes as BlobPart], {
          type: object.contentType ?? "",
        });
        const storageTarget = targetOf(bucketHandle);
        const fallbackDate = getClock(storageTarget.sandbox).date();
        const timeCreated = object.timeCreated ?? fallbackDate.toISOString();
        const updated = object.updated ?? timeCreated;
        const parsedMs = Date.parse(updated);
        const generationMs = Number.isFinite(parsedMs)
          ? parsedMs
          : fallbackDate.getTime();
        const stored: StoredMetadata = {
          fullPath: objectRef.fullPath,
          name: objectRef.name,
          bucket: objectRef.bucket,
          generation: "1",
          metageneration: "1",
          timeCreated,
          updated,
          size: blob.size,
          contentType:
            object.contentType && object.contentType.length > 0
              ? object.contentType
              : "application/octet-stream",
        };
        if (object.cacheControl !== undefined) {
          stored.cacheControl = object.cacheControl;
        }
        if (object.contentDisposition !== undefined) {
          stored.contentDisposition = object.contentDisposition;
        }
        if (object.contentEncoding !== undefined) {
          stored.contentEncoding = object.contentEncoding;
        }
        if (object.contentLanguage !== undefined) {
          stored.contentLanguage = object.contentLanguage;
        }
        if (object.customMetadata !== undefined) {
          const customCopy: Record<string, string> = {};
          for (const [k, v] of Object.entries(object.customMetadata)) {
            Object.defineProperty(customCopy, k, {
              value: v,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
          stored.customMetadata = customCopy;
        }
        const serviceInstance = await getStorageService(bucketHandle);
        await serviceInstance.backend.put(
          objectRef.fullPath,
          blob,
          stored,
          generationIssuer(generationMs),
        );
        continue;
      }
      const metadata: {
        contentType?: string;
        customMetadata?: Record<string, string>;
      } = {};
      if (object.contentType) {
        metadata.contentType = object.contentType;
      }
      if (object.customMetadata) {
        const customCopy: Record<string, string> = {};
        for (const [k, v] of Object.entries(object.customMetadata)) {
          Object.defineProperty(customCopy, k, {
            value: v,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        metadata.customMetadata = customCopy;
      }
      await uploadBytes(objectRef, bytes, metadata);
    }
  };
  await seedBucketObjects(admin, target.state.storage ?? []);
  for (const [bucketName, objects] of Object.entries(
    target.state.storageBuckets ?? {},
  )) {
    const normalizedBucket = normalizeStorageBucketInstance(bucketName);
    const bucketAdmin = normalizedBucket
      ? getAdminStorageSandbox(sandbox, {
          dbName,
          bucket: normalizedBucket,
        })
      : admin;
    await seedBucketObjects(bucketAdmin, objects);
  }
  const concreteDefaultBucket = (() => {
    if (
      typeof effectiveDefaultStorageRules !== "string" ||
      effectiveDefaultStorageRules.length === 0
    ) {
      return undefined;
    }
    if (/match\s+\/b\/\{[^}]+\}\/o\b/.test(effectiveDefaultStorageRules)) {
      return undefined;
    }
    const concreteMatches = [
      ...effectiveDefaultStorageRules.matchAll(/match\s+\/b\/([^/\s{]+)\/o\b/g),
    ];
    return concreteMatches[0]?.[1];
  })();
  if (concreteDefaultBucket !== undefined) {
    admin = nameStorageBucket(admin, concreteDefaultBucket);
    runtime.storageDefaultBucket = concreteDefaultBucket;
  }
  runtime.storageDbName = dbName;
  runtime.storageAdmin = admin;
  let userStorage = getStorageSandbox(context, { dbName });
  if (concreteDefaultBucket !== undefined) {
    userStorage = nameStorageBucket(userStorage, concreteDefaultBucket);
  }
  runtime.storage = userStorage;
  return runtime;
}

export function projectStorageObject(
  buffer: ArrayBuffer,
  metadata: {
    contentType?: string;
    cacheControl?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    contentLanguage?: string;
    customMetadata?: Record<string, string>;
  },
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    dataBase64: arrayBufferToBase64(buffer),
    text: new TextDecoder().decode(buffer),
    contentType: metadata.contentType,
    customMetadata: metadata.customMetadata ?? {},
  };
  if (metadata.cacheControl !== undefined) {
    projected.cacheControl = metadata.cacheControl;
  }
  if (metadata.contentDisposition !== undefined) {
    projected.contentDisposition = metadata.contentDisposition;
  }
  if (metadata.contentEncoding !== undefined) {
    projected.contentEncoding = metadata.contentEncoding;
  }
  if (metadata.contentLanguage !== undefined) {
    projected.contentLanguage = metadata.contentLanguage;
  }
  return projected;
}

async function readStorageState(
  operation: StorageOperation,
  storage: FirebaseStorage,
): Promise<unknown> {
  if (operation.method === "list") {
    const result = await listAll(storageRef(storage, operation.path));
    return {
      items: result.items.map((item) => item.fullPath),
      prefixes: result.prefixes.map((item) => item.fullPath),
    };
  }
  const target = storageRef(storage, operation.path);
  try {
    const [blob, metadata] = await Promise.all([
      getBlob(target),
      getMetadata(target),
    ]);
    return projectStorageObject(await blob.arrayBuffer(), metadata);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "storage/object-not-found") return null;
    throw error;
  }
}

export async function readState(
  operation: FirebaseOperation,
  runtime: ServiceRuntime,
): Promise<unknown> {
  if (operation.service === "firestore") {
    const state = snapshotDocuments(runtime.sandbox);
    const normalizedPath = normalizeFirestorePath(operation.path);
    if (operation.method === "list") {
      const prefix = `${normalizedPath}/`;
      return Object.fromEntries(
        Object.entries(state).filter(([path]) => path.startsWith(prefix)),
      );
    }
    return state[normalizedPath] ?? null;
  }
  if (operation.service === "rtdb") {
    let admin = runtime.rtdbAdmin!;
    if (operation.instance && operation.instance !== "default") {
      const url = resolveDatabaseInstance(operation.instance)!.url;
      admin = getAdminDatabase(runtime.sandbox, url);
    }
    return (await getRtdb(rtdbRef(admin, operation.path))).exportVal();
  }
  const rawBucket = normalizeStorageBucketInstance(operation.instance);
  const normalizedBucket =
    rawBucket !== undefined && rawBucket === runtime.storageDefaultBucket
      ? undefined
      : rawBucket;
  if (runtime.storageDbName !== undefined) {
    let nextAdmin = getAdminStorageSandbox(
      runtime.sandbox,
      normalizedBucket
        ? { dbName: runtime.storageDbName, bucket: normalizedBucket }
        : { dbName: runtime.storageDbName },
    );
    let nextUser = getStorageSandbox(
      runtime.context,
      normalizedBucket
        ? { dbName: runtime.storageDbName, bucket: normalizedBucket }
        : { dbName: runtime.storageDbName },
    );
    if (normalizedBucket === undefined && runtime.storageDefaultBucket !== undefined) {
      nextAdmin = nameStorageBucket(nextAdmin, runtime.storageDefaultBucket);
      nextUser = nameStorageBucket(nextUser, runtime.storageDefaultBucket);
    }
    runtime.storageAdmin = nextAdmin;
    runtime.storage = nextUser;
  }
  return readStorageState(operation, runtime.storageAdmin!);
}
