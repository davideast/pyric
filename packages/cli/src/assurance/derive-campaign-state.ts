/**
 * State seeding, sentinel materialization, and `ProbeStep` -> `FirebaseOperation`
 * translation helpers for `derive-campaign.ts`.
 */
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  encodeBytesToBase64,
  parseResourcePattern,
  unifyPatterns,
  type SandboxSnapshot,
} from "pyric/sandbox/internal";
import type { Probe, ProbeActor, ProbeStep } from "pyric/rules/internal/usage";
import type {
  AuthFixtureUser,
  FirebaseOperation,
  FirestoreOperation,
  LocalFirebaseTarget,
  RtdbOperation,
  StorageObjectFixture,
  StorageOperation,
} from "./types.js";

interface SentinelLike {
  readonly __sentinel: string;
  readonly by?: number;
}

export function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

export function defineOwn<V>(
  target: Record<string, V>,
  key: string,
  value: V,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function getOwn<V>(
  target: Record<string, V> | undefined,
  key: string,
): V | undefined {
  if (target !== undefined && Object.hasOwn(target, key)) {
    return target[key];
  }
  return undefined;
}

function isSentinelLike(value: unknown): value is SentinelLike {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.hasOwn(value, "__sentinel");
}

export function materializeDataValue(
  value: unknown,
  existingField?: unknown,
): unknown {
  if (isSentinelLike(value)) {
    if (value.__sentinel === "serverTimestamp") return 1_700_000_000_000;
    if (value.__sentinel === "increment") {
      let base = 0;
      if (typeof existingField === "number") base = existingField;
      let delta = 1;
      if (typeof value.by === "number") delta = value.by;
      return base + delta;
    }
    if (value.__sentinel === "arrayUnion" || value.__sentinel === "arrayRemove") {
      return [];
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => materializeDataValue(item));
  }
  if (value && typeof value === "object") {
    let existingRecord: Record<string, unknown> | undefined;
    if (existingField && typeof existingField === "object" && !Array.isArray(existingField)) {
      existingRecord = existingField as Record<string, unknown>;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSentinelLike(v) && v.__sentinel === "deleteField") continue;
      const prev = getOwn(existingRecord, k);
      const next = materializeDataValue(v, prev);
      if (next !== undefined) defineOwn(out, k, next);
    }
    return out;
  }
  return value;
}

export function replaceIdentityDeep<T>(
  input: T,
  replacements: ReadonlyArray<readonly [string, string]>,
): T {
  if (typeof input === "string") {
    let out: string = input;
    for (const [from, to] of replacements) {
      if (from.length > 0 && from !== to && out.includes(from)) {
        out = out.split(from).join(to);
      }
    }
    return out as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => replaceIdentityDeep(item, replacements)) as unknown as T;
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [rawKey, rawVal] of Object.entries(input)) {
      const nextKey = replaceIdentityDeep(rawKey, replacements);
      defineOwn(out, nextKey, replaceIdentityDeep(rawVal, replacements));
    }
    return out as T;
  }
  return input;
}

export function buildPeerReplacements(
  probe: Probe,
  owner: ProbeActor,
  peer: ProbeActor,
): Array<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [
    [owner.uid, peer.uid],
    [owner.email, peer.email],
    [owner.displayName, peer.displayName],
  ];

  const attackPath = probe.attack.path;
  if (attackPath.length > 0 && !attackPath.includes(owner.uid)) {
    const pattern = parseResourcePattern(probe.service, probe.template);
    const concreteSegs = attackPath
      .split("/")
      .filter((s) => s.length > 0)
      .map((text) => ({ kind: "lit" as const, text }));
    const unified = unifyPatterns(pattern, {
      service: probe.service,
      resourceId: pattern.resourceId,
      segments: concreteSegs,
    });
    if (unified !== null) {
      const seedJoined = probe.seed.map((s) => s.path).join("|");
      const varEntries = [...unified.entries()];
      let replacedAny = false;
      for (const [, seg] of varEntries) {
        if (
          seg.kind === "lit" &&
          seg.text !== owner.uid &&
          seg.text !== peer.uid &&
          seedJoined.includes(seg.text)
        ) {
          pairs.push([seg.text, `${seg.text}-peer`]);
          replacedAny = true;
        }
      }
      if (!replacedAny && varEntries.length > 0) {
        const lastSeg = varEntries[varEntries.length - 1]![1];
        if (
          lastSeg.kind === "lit" &&
          lastSeg.text !== owner.uid &&
          lastSeg.text !== peer.uid
        ) {
          pairs.push([lastSeg.text, `${lastSeg.text}-peer`]);
        }
      }
    }
  }
  return pairs;
}

function encodeStorageStepBytes(step: ProbeStep): string {
  let byteLength = 11;
  if (
    typeof step.sizeBytes === "number" &&
    step.sizeBytes > 0 &&
    step.sizeBytes <= 65_536
  ) {
    byteLength = step.sizeBytes;
  }
  const bytes = new Uint8Array(byteLength);
  bytes.fill(97);
  return encodeBytesToBase64(bytes);
}

export function stepToFirebaseOperation(
  step: ProbeStep,
  existingDoc?: Record<string, unknown>,
): FirebaseOperation {
  if (step.service === "firestore") {
    let method: FirestoreOperation["method"] = "set";
    if (step.method === "get") method = "get";
    else if (step.method === "list") method = "list";
    else if (step.method === "create") method = "create";
    else if (step.method === "update") method = "update";
    else if (step.method === "delete" || step.method === "remove") method = "delete";
    else if (step.merge === true) method = "merge";

    const op: FirestoreOperation = {
      service: "firestore",
      method,
      path: step.path,
    };
    if (
      method === "create" ||
      method === "set" ||
      method === "merge" ||
      method === "update"
    ) {
      const materialized = materializeDataValue(step.data ?? {}, existingDoc);
      if (materialized && typeof materialized === "object" && !Array.isArray(materialized)) {
        op.data = materialized as Record<string, unknown>;
      } else {
        op.data = {};
      }
    }
    return op;
  }

  if (step.service === "rtdb") {
    let method: RtdbOperation["method"] = "set";
    if (step.method === "get") method = "get";
    else if (step.method === "update") method = "update";
    else if (step.method === "remove" || step.method === "delete") method = "remove";

    const op: RtdbOperation = {
      service: "rtdb",
      method,
      path: step.path,
    };
    if (step.resourceId !== undefined && step.resourceId !== DEFAULT_SNAPSHOT_RESOURCE) {
      op.instance = step.resourceId;
    }
    if (method === "set" || method === "update") {
      op.data = materializeDataValue(step.data ?? {});
    }
    return op;
  }

  let method: StorageOperation["method"] = "upload";
  if (step.method === "get") method = "get";
  else if (step.method === "list") method = "list";
  else if (step.method === "update") method = "updateMetadata";
  else if (step.method === "delete" || step.method === "remove") method = "delete";

  const op: StorageOperation = {
    service: "storage",
    method,
    path: step.path,
  };
  if (step.resourceId !== undefined && step.resourceId !== DEFAULT_SNAPSHOT_RESOURCE) {
    op.instance = step.resourceId;
  }
  if (method === "upload") {
    op.dataBase64 = encodeStorageStepBytes(step);
  }
  if (step.contentType !== undefined) op.contentType = step.contentType;
  if (step.customMetadata !== undefined) {
    op.customMetadata = { ...step.customMetadata };
  }
  return op;
}

function setRtdbPath(
  root: Record<string, unknown>,
  rawPath: string,
  value: unknown,
  merge: boolean,
): void {
  const segments = rawPath.split("/").filter((s) => s.length > 0);
  if (segments.some(isUnsafeObjectKey)) {
    return;
  }
  if (segments.length === 0) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (!isUnsafeObjectKey(k)) {
          setRtdbPath(root, k, v, false);
        }
      }
    }
    return;
  }
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    const current = getOwn(cursor, seg);
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      defineOwn(cursor, seg, {});
    }
    cursor = getOwn(cursor, seg) as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1]!;
  const existingLeaf = getOwn(cursor, leaf);
  if (
    merge &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    existingLeaf &&
    typeof existingLeaf === "object" &&
    !Array.isArray(existingLeaf)
  ) {
    const targetRecord = existingLeaf as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) {
      if (!isUnsafeObjectKey(k)) {
        defineOwn(targetRecord, k, v);
      }
    }
    return;
  }
  defineOwn(cursor, leaf, value);
}

export function applyStepToTargetState(
  state: LocalFirebaseTarget["state"],
  step: ProbeStep,
): void {
  if (step.method === "get" || step.method === "list") return;

  if (step.service === "firestore") {
    if (!state.firestore) state.firestore = {};
    if (step.method === "delete" || step.method === "remove") {
      if (Object.hasOwn(state.firestore, step.path)) {
        Reflect.deleteProperty(state.firestore, step.path);
      }
      return;
    }
    const existing = getOwn(state.firestore, step.path);
    const materialized = materializeDataValue(step.data ?? {}, existing);
    let nextFields: Record<string, unknown> = {};
    if (materialized && typeof materialized === "object" && !Array.isArray(materialized)) {
      nextFields = materialized as Record<string, unknown>;
    }
    if ((step.method === "update" || step.merge === true) && existing) {
      defineOwn(state.firestore, step.path, { ...existing, ...nextFields });
    } else {
      defineOwn(state.firestore, step.path, { ...nextFields });
    }
    return;
  }

  if (step.service === "rtdb") {
    let rtdbRoot: Record<string, unknown>;
    if (
      step.resourceId !== undefined &&
      step.resourceId !== DEFAULT_SNAPSHOT_RESOURCE &&
      !isUnsafeObjectKey(step.resourceId)
    ) {
      if (!state.rtdbInstances) state.rtdbInstances = {};
      let instTree = getOwn(state.rtdbInstances, step.resourceId);
      if (!instTree || typeof instTree !== "object" || Array.isArray(instTree)) {
        instTree = {};
        defineOwn(state.rtdbInstances, step.resourceId, instTree);
      }
      rtdbRoot = instTree as Record<string, unknown>;
    } else {
      if (!state.rtdb || typeof state.rtdb !== "object" || Array.isArray(state.rtdb)) {
        state.rtdb = {};
      }
      rtdbRoot = state.rtdb as Record<string, unknown>;
    }
    if (step.method === "remove" || step.method === "delete") {
      setRtdbPath(rtdbRoot, step.path, null, false);
      return;
    }
    const materialized = materializeDataValue(step.data ?? {});
    setRtdbPath(rtdbRoot, step.path, materialized, step.method === "update");
    return;
  }

  let bucketObjects: StorageObjectFixture[];
  if (
    step.resourceId !== undefined &&
    step.resourceId !== DEFAULT_SNAPSHOT_RESOURCE &&
    !isUnsafeObjectKey(step.resourceId)
  ) {
    if (!state.storageBuckets) state.storageBuckets = {};
    let namedList = getOwn(state.storageBuckets, step.resourceId);
    if (!namedList) {
      namedList = [];
      defineOwn(state.storageBuckets, step.resourceId, namedList);
    }
    bucketObjects = namedList;
  } else {
    if (!state.storage) state.storage = [];
    bucketObjects = state.storage;
  }

  if (step.method === "delete" || step.method === "remove") {
    const remaining = bucketObjects.filter((item) => item.path !== step.path);
    bucketObjects.length = 0;
    bucketObjects.push(...remaining);
    return;
  }
  const existingIdx = bucketObjects.findIndex((item) => item.path === step.path);
  if (step.method === "update" && existingIdx >= 0) {
    const prev = bucketObjects[existingIdx]!;
    const updated: StorageObjectFixture = { ...prev };
    if (step.contentType !== undefined) updated.contentType = step.contentType;
    if (step.customMetadata !== undefined) {
      updated.customMetadata = { ...step.customMetadata };
    }
    bucketObjects[existingIdx] = updated;
    return;
  }
  const entry: StorageObjectFixture = {
    path: step.path,
    dataBase64: encodeStorageStepBytes(step),
  };
  if (step.contentType !== undefined) entry.contentType = step.contentType;
  if (step.customMetadata !== undefined) {
    entry.customMetadata = { ...step.customMetadata };
  }
  if (existingIdx >= 0) {
    bucketObjects[existingIdx] = entry;
  } else {
    bucketObjects.push(entry);
  }
}

export function initializeTargetState(
  snapshot: SandboxSnapshot | undefined,
  baseState: LocalFirebaseTarget["state"] | undefined,
  actors: readonly ProbeActor[],
): LocalFirebaseTarget["state"] {
  const firestore: Record<string, Record<string, unknown>> = {};
  for (const [p, docData] of Object.entries(
    snapshot?.firestore[DEFAULT_SNAPSHOT_RESOURCE] ?? {},
  )) {
    defineOwn(firestore, p, { ...docData });
  }
  for (const [p, docData] of Object.entries(baseState?.firestore ?? {})) {
    defineOwn(firestore, p, { ...docData });
  }

  let rtdb: unknown;
  if (baseState?.rtdb !== undefined) {
    rtdb = structuredClone(baseState.rtdb);
  } else if (snapshot?.rtdb[DEFAULT_SNAPSHOT_RESOURCE] !== undefined) {
    rtdb = structuredClone(snapshot.rtdb[DEFAULT_SNAPSHOT_RESOURCE]);
  }

  const rtdbInstances: Record<string, Record<string, unknown>> = {};
  for (const [instKey, instVal] of Object.entries(snapshot?.rtdb ?? {})) {
    if (
      instKey === DEFAULT_SNAPSHOT_RESOURCE ||
      isUnsafeObjectKey(instKey) ||
      !instVal ||
      typeof instVal !== "object" ||
      Array.isArray(instVal)
    ) {
      continue;
    }
    defineOwn(
      rtdbInstances,
      instKey,
      structuredClone(instVal) as Record<string, unknown>,
    );
  }
  for (const [instKey, instVal] of Object.entries(baseState?.rtdbInstances ?? {})) {
    if (
      instKey === DEFAULT_SNAPSHOT_RESOURCE ||
      isUnsafeObjectKey(instKey) ||
      !instVal ||
      typeof instVal !== "object" ||
      Array.isArray(instVal)
    ) {
      continue;
    }
    defineOwn(
      rtdbInstances,
      instKey,
      structuredClone(instVal) as Record<string, unknown>,
    );
  }

  const mapSnapshotStorageItem = (
    item: NonNullable<SandboxSnapshot["storage"][string]>[number],
  ): StorageObjectFixture => {
    const entry: StorageObjectFixture = {
      path: item.path,
      dataBase64: item.contentBase64,
    };
    if (item.contentType !== undefined) entry.contentType = item.contentType;
    if (item.cacheControl !== undefined) entry.cacheControl = item.cacheControl;
    if (item.contentDisposition !== undefined) {
      entry.contentDisposition = item.contentDisposition;
    }
    if (item.contentEncoding !== undefined) {
      entry.contentEncoding = item.contentEncoding;
    }
    if (item.contentLanguage !== undefined) {
      entry.contentLanguage = item.contentLanguage;
    }
    if (item.timeCreated !== undefined) {
      entry.timeCreated = item.timeCreated;
    }
    if (item.updated !== undefined) {
      entry.updated = item.updated;
    }
    if (item.customMetadata !== undefined) {
      entry.customMetadata = { ...item.customMetadata };
    }
    return entry;
  };

  const storage: StorageObjectFixture[] = [];
  for (const item of snapshot?.storage[DEFAULT_SNAPSHOT_RESOURCE] ?? []) {
    storage.push(mapSnapshotStorageItem(item));
  }
  for (const item of baseState?.storage ?? []) {
    if (!storage.some((s) => s.path === item.path)) {
      storage.push({ ...item });
    }
  }

  const storageBuckets: Record<string, StorageObjectFixture[]> = {};
  for (const [bucketKey, items] of Object.entries(snapshot?.storage ?? {})) {
    if (bucketKey === DEFAULT_SNAPSHOT_RESOURCE || isUnsafeObjectKey(bucketKey)) {
      continue;
    }
    const list: StorageObjectFixture[] = [];
    for (const item of items) {
      list.push(mapSnapshotStorageItem(item));
    }
    if (list.length > 0) {
      defineOwn(storageBuckets, bucketKey, list);
    }
  }
  for (const [bucketKey, items] of Object.entries(baseState?.storageBuckets ?? {})) {
    if (bucketKey === DEFAULT_SNAPSHOT_RESOURCE || isUnsafeObjectKey(bucketKey)) {
      continue;
    }
    let list = getOwn(storageBuckets, bucketKey);
    if (list === undefined) {
      list = [];
      defineOwn(storageBuckets, bucketKey, list);
    }
    for (const item of items) {
      if (!list.some((s) => s.path === item.path)) {
        list.push({ ...item });
      }
    }
  }

  const usersByUid = new Map<string, AuthFixtureUser>();
  for (const u of snapshot?.auth.users ?? []) {
    const rec: AuthFixtureUser = {
      uid: u.uid,
      emailVerified: u.emailVerified === true,
    };
    if (u.email !== undefined) rec.email = u.email;
    if (u.password !== undefined) rec.password = u.password;
    if (u.displayName !== undefined) rec.displayName = u.displayName;
    if (u.photoUrl !== undefined) rec.photoUrl = u.photoUrl;
    if (u.phoneNumber !== undefined) rec.phoneNumber = u.phoneNumber;
    if (u.disabled !== undefined) rec.disabled = u.disabled;
    if (u.tenantId !== undefined) rec.tenantId = u.tenantId;
    if (u.providerId !== undefined) rec.providerId = u.providerId;
    if (Array.isArray(u.providerUserInfo) && u.providerUserInfo.length > 0) {
      rec.providerUserInfo = u.providerUserInfo.map((provider) => ({
        ...provider,
      }));
    }
    if (u.customClaims !== undefined) rec.customClaims = { ...u.customClaims };
    usersByUid.set(u.uid, rec);
  }
  for (const u of baseState?.auth?.users ?? []) {
    usersByUid.set(u.uid, {
      ...u,
      ...(u.providerUserInfo
        ? { providerUserInfo: u.providerUserInfo.map((p) => ({ ...p })) }
        : {}),
    });
  }
  for (const actor of actors) {
    const existing = usersByUid.get(actor.uid);
    const claims: Record<string, unknown> = { ...(existing?.customClaims ?? {}) };
    for (const [k, v] of Object.entries(actor.token)) {
      if (k !== "email_verified" && !isUnsafeObjectKey(k)) {
        defineOwn(claims, k, v);
      }
    }
    let emailVerified = true;
    if (existing !== undefined) {
      emailVerified = existing.emailVerified === true;
    } else if (typeof actor.token.email_verified === "boolean") {
      emailVerified = actor.token.email_verified;
    }
    const merged: AuthFixtureUser = {
      ...(existing ?? { uid: actor.uid }),
      uid: actor.uid,
      email:
        existing !== undefined && existing.email !== undefined
          ? existing.email
          : actor.email,
      displayName: existing?.displayName ?? actor.displayName,
      emailVerified,
    };
    if (Object.keys(claims).length > 0) merged.customClaims = claims;
    usersByUid.set(actor.uid, merged);
  }

  const mergedProviders: Record<string, boolean> = {};
  const snapshotHasDisabledProvider = snapshot?.auth.providers
    ? Object.values(snapshot.auth.providers).some((enabled) => enabled === false)
    : false;
  if (snapshotHasDisabledProvider && snapshot?.auth.providers) {
    for (const [k, v] of Object.entries(snapshot.auth.providers)) {
      if (!isUnsafeObjectKey(k) && typeof v === "boolean") {
        defineOwn(mergedProviders, k, v);
      }
    }
  }
  if (baseState?.auth?.providers !== undefined) {
    for (const [k, v] of Object.entries(baseState.auth.providers)) {
      if (!isUnsafeObjectKey(k) && typeof v === "boolean") {
        defineOwn(mergedProviders, k, v);
      }
    }
  }

  const out: LocalFirebaseTarget["state"] = {
    auth: {
      users: [...usersByUid.values()],
      ...(Object.keys(mergedProviders).length > 0
        ? { providers: mergedProviders }
        : {}),
    },
  };
  if (Object.keys(firestore).length > 0) out.firestore = firestore;
  if (rtdb !== undefined) out.rtdb = rtdb;
  if (Object.keys(rtdbInstances).length > 0) out.rtdbInstances = rtdbInstances;
  if (storage.length > 0) out.storage = storage;
  if (Object.keys(storageBuckets).length > 0) out.storageBuckets = storageBuckets;
  if (baseState?.storageConfig !== undefined) {
    out.storageConfig = { ...baseState.storageConfig };
  } else if (snapshot?.storageConfig !== undefined) {
    out.storageConfig = { ...snapshot.storageConfig };
  }
  return out;
}
