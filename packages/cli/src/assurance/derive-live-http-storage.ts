/**
 * Storage object hydration, sha256 verification, and bucket-key normalization
 * for `derive-live-http.ts`.
 */
import { createHash } from "node:crypto";
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

export function resolveLiveStorageBucketKey(
  rawBucket: unknown,
  namedBuckets: ReadonlySet<string>,
  defaultBucket: string | undefined,
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
  if (
    normalized === DEFAULT_SNAPSHOT_RESOURCE ||
    normalized === "default" ||
    normalized === "default-bucket" ||
    normalized === "pyric-default" ||
    normalized === DEFAULT_BUCKET ||
    (defaultBucket !== undefined && normalized === defaultBucket) ||
    normalized.endsWith(".appspot.com") ||
    normalized.endsWith(".firebasestorage.app")
  ) {
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
  defaultBucket: string | undefined;
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
      options.defaultBucket,
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
