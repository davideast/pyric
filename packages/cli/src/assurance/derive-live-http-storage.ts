/**
 * Storage object hydration, sha256 verification, and bucket-key normalization
 * for `derive-live-http.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  encodeBytesToBase64,
  parseResourcePattern,
  type SnapshotStorageObject,
} from "pyric/sandbox/internal";
import { DEFAULT_BUCKET } from "pyric/storage/internal";
import {
  isStorageReference,
  type PyricStateFile,
} from "../serve/state-file.js";
import { defineOwn, getOwn, isUnsafeObjectKey } from "./derive-campaign-state.js";
import { AssuranceInputError, type StorageObjectFixture } from "./types.js";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const EXPLICIT_DEFAULT_STORAGE_SENTINELS: ReadonlySet<string> = new Set([
  DEFAULT_SNAPSHOT_RESOURCE,
  "default",
  "default-bucket",
  "pyric-default",
  DEFAULT_BUCKET,
  "pyric-sandbox.appspot.com",
]);

export function readDefaultProjectIdFromDir(
  projectDir: string | undefined,
): string | undefined {
  if (projectDir === undefined) return undefined;
  try {
    const rcPath = join(projectDir, ".firebaserc");
    if (!existsSync(rcPath) || lstatSync(rcPath).isSymbolicLink()) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(rcPath, "utf8")) as {
      projects?: Record<string, unknown>;
    };
    const defaultProj = parsed?.projects?.default;
    if (typeof defaultProj === "string" && defaultProj.trim().length > 0) {
      return defaultProj.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function inferProjectIdFromDefaultBucket(
  defaultBucket: string | undefined,
): string | undefined {
  if (defaultBucket === undefined) return undefined;
  if (EXPLICIT_DEFAULT_STORAGE_SENTINELS.has(defaultBucket)) return undefined;
  if (defaultBucket.endsWith(".firebasestorage.app")) {
    const prefix = defaultBucket.slice(0, -".firebasestorage.app".length);
    if (prefix.length > 0) return prefix;
  }
  if (defaultBucket.endsWith(".appspot.com")) {
    const prefix = defaultBucket.slice(0, -".appspot.com".length);
    if (prefix.length > 0) return prefix;
  }
  return undefined;
}

export function computeDefaultStorageBucketSet(options: {
  namedBuckets: ReadonlySet<string>;
  defaultBucket: string | undefined;
  projectId: string | undefined;
  storageEntries: PyricStateFile["storage"] | undefined;
}): Set<string> {
  const { namedBuckets, defaultBucket, storageEntries } = options;
  const defaultSet = new Set<string>();
  for (const sentinel of EXPLICIT_DEFAULT_STORAGE_SENTINELS) {
    if (!namedBuckets.has(sentinel)) {
      defaultSet.add(sentinel);
    }
  }
  if (defaultBucket !== undefined && !namedBuckets.has(defaultBucket)) {
    defaultSet.add(defaultBucket);
  }

  const observedBuckets = new Set<string>();
  let hasExplicitDefaultObject = false;
  for (const entry of storageEntries ?? []) {
    const rawBucket = entry.metadata.bucket;
    if (typeof rawBucket !== "string" || rawBucket.trim().length === 0) {
      hasExplicitDefaultObject = true;
      continue;
    }
    const normalized = parseResourcePattern("storage", "object", rawBucket).resourceId;
    if (isUnsafeObjectKey(normalized)) {
      hasExplicitDefaultObject = true;
      continue;
    }
    if (defaultSet.has(normalized)) {
      hasExplicitDefaultObject = true;
    }
    observedBuckets.add(normalized);
  }

  const effectiveProjectId =
    options.projectId ?? inferProjectIdFromDefaultBucket(defaultBucket);
  if (effectiveProjectId !== undefined) {
    const fbAppBucket = `${effectiveProjectId}.firebasestorage.app`;
    const appspotBucket = `${effectiveProjectId}.appspot.com`;
    const usedFbApp =
      observedBuckets.has(fbAppBucket) || namedBuckets.has(fbAppBucket);
    const usedAppspot =
      observedBuckets.has(appspotBucket) || namedBuckets.has(appspotBucket);
    if (usedFbApp && usedAppspot) {
      if (defaultBucket === undefined && !namedBuckets.has(fbAppBucket)) {
        defaultSet.add(fbAppBucket);
      }
    } else {
      if (!namedBuckets.has(fbAppBucket)) {
        defaultSet.add(fbAppBucket);
      }
      if (!namedBuckets.has(appspotBucket)) {
        defaultSet.add(appspotBucket);
      }
    }
    return defaultSet;
  }

  if (defaultBucket === undefined && !hasExplicitDefaultObject) {
    const nonSentinelObserved: string[] = [];
    for (const bucketId of observedBuckets) {
      if (!defaultSet.has(bucketId) && !namedBuckets.has(bucketId)) {
        nonSentinelObserved.push(bucketId);
      }
    }
    if (nonSentinelObserved.length === 1) {
      const soleBucket = nonSentinelObserved[0]!;
      if (
        soleBucket.endsWith(".appspot.com") ||
        soleBucket.endsWith(".firebasestorage.app")
      ) {
        defaultSet.add(soleBucket);
      }
    }
  }

  return defaultSet;
}

function resolveLiveStorageBucketKey(
  rawBucket: unknown,
  namedBuckets: ReadonlySet<string>,
  defaultBuckets: ReadonlySet<string>,
): string {
  if (typeof rawBucket !== "string" || rawBucket.trim().length === 0) {
    return DEFAULT_SNAPSHOT_RESOURCE;
  }
  const normalized = parseResourcePattern("storage", "object", rawBucket).resourceId;
  if (isUnsafeObjectKey(normalized)) {
    return DEFAULT_SNAPSHOT_RESOURCE;
  }
  if (namedBuckets.has(normalized)) {
    return normalized;
  }
  if (defaultBuckets.has(normalized)) {
    return DEFAULT_SNAPSHOT_RESOURCE;
  }
  return normalized;
}

export async function hydrateLiveStorageObjects(options: {
  origin: string;
  headers: Record<string, string>;
  getLoopback: (url: string, headers: Record<string, string>) => Promise<Response>;
  storageEntries: PyricStateFile["storage"] | undefined;
  namedStorageBuckets: ReadonlySet<string>;
  defaultStorageBuckets: ReadonlySet<string>;
}): Promise<{
  storageSnapshotsByBucket: Record<string, SnapshotStorageObject[]>;
  defaultStorageFixtures: StorageObjectFixture[];
  namedStorageFixtures: Record<string, StorageObjectFixture[]>;
}> {
  const storageSnapshotsByBucket: Record<string, SnapshotStorageObject[]> = {
    [DEFAULT_SNAPSHOT_RESOURCE]: [],
  };
  const defaultStorageFixtures: StorageObjectFixture[] = [];
  const namedStorageFixtures: Record<string, StorageObjectFixture[]> = {};

  for (const entry of options.storageEntries ?? []) {
    let base64 = "";
    let actualByteLength = entry.metadata.size;
    if (isStorageReference(entry)) {
      if (!SHA256_HEX_RE.test(entry.sha256)) {
        throw new AssuranceInputError(
          `Invalid Storage object sha256 digest '${entry.sha256}'.`,
        );
      }
      let objRes: Response;
      try {
        objRes = await options.getLoopback(
          `${options.origin}/__pyric/state/objects/${entry.sha256}`,
          options.headers,
        );
      } catch (error) {
        if (error instanceof AssuranceInputError) throw error;
        let detail = String(error);
        if (error instanceof Error) detail = error.message;
        throw new AssuranceInputError(
          `Unable to fetch Storage object '${entry.sha256}' from '${options.origin}': ${detail}`,
        );
      }
      if (objRes.status !== 200) {
        throw new AssuranceInputError(
          `Storage object '${entry.sha256}' returned HTTP ${objRes.status} at '${options.origin}'.`,
        );
      }
      const bytes = new Uint8Array(await objRes.arrayBuffer());
      if (bytes.byteLength !== entry.size) {
        throw new AssuranceInputError(
          `Storage object '${entry.sha256}' byte length mismatch: expected ${entry.size}, received ${bytes.byteLength}.`,
        );
      }
      const computedSha = createHash("sha256").update(bytes).digest("hex");
      if (computedSha !== entry.sha256) {
        throw new AssuranceInputError(
          `Storage object '${entry.sha256}' sha256 digest mismatch.`,
        );
      }
      actualByteLength = bytes.byteLength;
      base64 = encodeBytesToBase64(bytes);
    } else {
      base64 = entry.dataBase64;
    }

    const bucketKey = resolveLiveStorageBucketKey(
      entry.metadata.bucket,
      options.namedStorageBuckets,
      options.defaultStorageBuckets,
    );
    const fullPath = entry.metadata.fullPath;
    const snapObj: {
      path: string;
      contentBase64: string;
      size: number;
      generation?: string;
      metageneration?: string;
      contentType?: string;
      blobType?: string;
      cacheControl?: string;
      contentDisposition?: string;
      contentEncoding?: string;
      contentLanguage?: string;
      timeCreated?: string;
      updated?: string;
      downloadTokens?: string;
      md5Hash?: string;
      customMetadata?: Record<string, string>;
    } = {
      path: fullPath,
      contentBase64: base64,
      size: actualByteLength,
    };
    const fixObj: StorageObjectFixture = {
      path: fullPath,
      dataBase64: base64,
    };
    if (typeof entry.metadata.generation === "string") {
      snapObj.generation = entry.metadata.generation;
    }
    if (typeof entry.metadata.metageneration === "string") {
      snapObj.metageneration = entry.metadata.metageneration;
    }
    if (typeof entry.metadata.contentType === "string") {
      snapObj.contentType = entry.metadata.contentType;
      fixObj.contentType = entry.metadata.contentType;
    }
    if (
      typeof entry.blobType === "string" &&
      entry.blobType !== (entry.metadata.contentType ?? "")
    ) {
      snapObj.blobType = entry.blobType;
    }
    if (typeof entry.metadata.cacheControl === "string") {
      snapObj.cacheControl = entry.metadata.cacheControl;
      fixObj.cacheControl = entry.metadata.cacheControl;
    }
    if (typeof entry.metadata.contentDisposition === "string") {
      snapObj.contentDisposition = entry.metadata.contentDisposition;
      fixObj.contentDisposition = entry.metadata.contentDisposition;
    }
    if (typeof entry.metadata.contentEncoding === "string") {
      snapObj.contentEncoding = entry.metadata.contentEncoding;
      fixObj.contentEncoding = entry.metadata.contentEncoding;
    }
    if (typeof entry.metadata.contentLanguage === "string") {
      snapObj.contentLanguage = entry.metadata.contentLanguage;
      fixObj.contentLanguage = entry.metadata.contentLanguage;
    }
    if (typeof entry.metadata.timeCreated === "string") {
      snapObj.timeCreated = entry.metadata.timeCreated;
      fixObj.timeCreated = entry.metadata.timeCreated;
    }
    if (typeof entry.metadata.updated === "string") {
      snapObj.updated = entry.metadata.updated;
      fixObj.updated = entry.metadata.updated;
    }
    if (typeof entry.metadata.downloadTokens === "string") {
      snapObj.downloadTokens = entry.metadata.downloadTokens;
    }
    if (typeof entry.metadata.md5Hash === "string") {
      snapObj.md5Hash = entry.metadata.md5Hash;
    }
    if (entry.metadata.customMetadata) {
      const customCopy: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry.metadata.customMetadata)) {
        if (typeof v === "string") defineOwn(customCopy, k, v);
      }
      snapObj.customMetadata = { ...customCopy };
      fixObj.customMetadata = { ...customCopy };
    }
    let bucketSnapshots = getOwn(storageSnapshotsByBucket, bucketKey);
    if (bucketSnapshots === undefined) {
      bucketSnapshots = [];
      defineOwn(storageSnapshotsByBucket, bucketKey, bucketSnapshots);
    }
    bucketSnapshots.push(snapObj);

    if (bucketKey === DEFAULT_SNAPSHOT_RESOURCE) {
      defaultStorageFixtures.push(fixObj);
    } else {
      let bucketFixtures = getOwn(namedStorageFixtures, bucketKey);
      if (bucketFixtures === undefined) {
        bucketFixtures = [];
        defineOwn(namedStorageFixtures, bucketKey, bucketFixtures);
      }
      bucketFixtures.push(fixObj);
    }
  }

  return {
    storageSnapshotsByBucket,
    defaultStorageFixtures,
    namedStorageFixtures,
  };
}
