/**
 * Snapshot-to-`LocalFirebaseTarget["state"]` seeding and RTDB tree mutation
 * routines for `derive-campaign-state.ts`.
 */
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  type SandboxSnapshot,
} from "pyric/sandbox/internal";
import type { ProbeActor } from "pyric/rules/internal/usage";
import { defineOwn, getOwn, isUnsafeObjectKey } from "./derive-campaign-state.js";
import type {
  AuthFixtureUser,
  LocalFirebaseTarget,
  StorageObjectFixture,
} from "./types.js";

export function setRtdbPath(
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

function mapSnapshotStorageItem(
  item: NonNullable<SandboxSnapshot["storage"][string]>[number],
): StorageObjectFixture {
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
}

export function seedStorageBucketsFromSnapshot(
  snapshot: SandboxSnapshot | undefined,
  baseState: LocalFirebaseTarget["state"] | undefined,
): {
  storage: StorageObjectFixture[];
  storageBuckets: Record<string, StorageObjectFixture[]>;
} {
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
  return { storage, storageBuckets };
}

export function seedAuthFromSnapshotAndActors(
  snapshot: SandboxSnapshot | undefined,
  baseState: LocalFirebaseTarget["state"] | undefined,
  actors: readonly ProbeActor[],
): NonNullable<LocalFirebaseTarget["state"]["auth"]> {
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
    const copy: AuthFixtureUser = { ...u };
    if (u.providerUserInfo) {
      copy.providerUserInfo = u.providerUserInfo.map((p) => ({ ...p }));
    }
    usersByUid.set(u.uid, copy);
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
    let email: AuthFixtureUser["email"] = actor.email;
    if (existing !== undefined && existing.email !== undefined) {
      email = existing.email;
    }
    const merged: AuthFixtureUser = {
      ...(existing ?? { uid: actor.uid }),
      uid: actor.uid,
      email,
      displayName: existing?.displayName ?? actor.displayName,
      emailVerified,
    };
    if (Object.keys(claims).length > 0) merged.customClaims = claims;
    usersByUid.set(actor.uid, merged);
  }

  const mergedProviders: Record<string, boolean> = {};
  let snapshotHasDisabledProvider = false;
  if (snapshot?.auth.providers) {
    snapshotHasDisabledProvider = Object.values(snapshot.auth.providers).some(
      (enabled) => enabled === false,
    );
  }
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

  const authState: NonNullable<LocalFirebaseTarget["state"]["auth"]> = {
    users: [...usersByUid.values()],
  };
  if (Object.keys(mergedProviders).length > 0) {
    authState.providers = mergedProviders;
  }
  return authState;
}
