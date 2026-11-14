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
import {
  copyStorageHttpFields,
  defineOwn,
  getOwn,
  isUnsafeObjectKey,
  seedAuthFromSnapshotAndActors,
  seedStorageBucketsFromSnapshot,
  setRtdbPath,
} from "./derive-target-state-seed.js";
import type {
  FirebaseOperation,
  FirestoreOperation,
  LocalFirebaseTarget,
  RtdbOperation,
  StorageObjectFixture,
  StorageOperation,
} from "./types.js";

export { defineOwn, getOwn, isUnsafeObjectKey };

interface SentinelLike {
  readonly __sentinel: string;
  readonly by?: number;
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
          seg.kind === "lit"
          && seg.text !== owner.uid
          && seg.text !== peer.uid
          && seedJoined.includes(seg.text)
        ) {
          pairs.push([seg.text, `${seg.text}-peer`]);
          replacedAny = true;
        }
      }
      if (!replacedAny && varEntries.length > 0) {
        const lastSeg = varEntries[varEntries.length - 1]![1];
        if (
          lastSeg.kind === "lit"
          && lastSeg.text !== owner.uid
          && lastSeg.text !== peer.uid
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
    typeof step.sizeBytes === "number"
    && step.sizeBytes > 0
    && step.sizeBytes <= 65_536
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
      method === "create"
      || method === "set"
      || method === "merge"
      || method === "update"
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
  copyStorageHttpFields(op, step);
  if (step.customMetadata !== undefined) {
    op.customMetadata = { ...step.customMetadata };
  }
  return op;
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
      step.resourceId !== undefined
      && step.resourceId !== DEFAULT_SNAPSHOT_RESOURCE
      && !isUnsafeObjectKey(step.resourceId)
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
    step.resourceId !== undefined
    && step.resourceId !== DEFAULT_SNAPSHOT_RESOURCE
    && !isUnsafeObjectKey(step.resourceId)
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
    copyStorageHttpFields(updated, step);
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
  copyStorageHttpFields(entry, step);
  if (step.customMetadata !== undefined) {
    entry.customMetadata = { ...step.customMetadata };
  }
  if (existingIdx >= 0) {
    if (step.actor === "admin" && step.method === "set") {
      const prev = bucketObjects[existingIdx]!;
      copyStorageHttpFields(entry, {
        cacheControl: entry.cacheControl ?? prev.cacheControl,
        contentDisposition: entry.contentDisposition ?? prev.contentDisposition,
        contentEncoding: entry.contentEncoding ?? prev.contentEncoding,
        contentLanguage: entry.contentLanguage ?? prev.contentLanguage,
      });
      if (prev.customMetadata !== undefined) {
        const mergedCustom: Record<string, string> = { ...prev.customMetadata };
        if (entry.customMetadata !== undefined) {
          Object.assign(mergedCustom, entry.customMetadata);
        }
        entry.customMetadata = mergedCustom;
      }
    }
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
      instKey === DEFAULT_SNAPSHOT_RESOURCE
      || isUnsafeObjectKey(instKey)
      || !instVal
      || typeof instVal !== "object"
      || Array.isArray(instVal)
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
      instKey === DEFAULT_SNAPSHOT_RESOURCE
      || isUnsafeObjectKey(instKey)
      || !instVal
      || typeof instVal !== "object"
      || Array.isArray(instVal)
    ) {
      continue;
    }
    defineOwn(
      rtdbInstances,
      instKey,
      structuredClone(instVal) as Record<string, unknown>,
    );
  }

  const { storage, storageBuckets } = seedStorageBucketsFromSnapshot(snapshot, baseState);
  const auth = seedAuthFromSnapshotAndActors(snapshot, baseState, actors);

  const out: LocalFirebaseTarget["state"] = { auth };
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
