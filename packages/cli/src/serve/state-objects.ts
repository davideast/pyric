import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { StorageObjectState } from 'pyric/sandbox';
import { DEFAULT_BUCKET, rulesBucketName, type StorageStateRecord } from 'pyric/storage/internal';
import { hashFile } from './hosted/persistence/blob-store.js';
import {
  isStorageReference,
  objectFileIn,
  StateFileError,
  type StorageObjectReference,
  type StorageStateEntry,
} from './state-file.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function normalizeBucketField(bucket: string | undefined): string | undefined {
  if (bucket === undefined || bucket === '' || bucket === DEFAULT_BUCKET) {
    return undefined;
  }
  const normalized = rulesBucketName(bucket, bucket);
  if (normalized === DEFAULT_BUCKET) {
    return undefined;
  }
  return normalized;
}

function fsyncPathBestEffort(targetPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(targetPath, 'r');
    fsyncSync(fd);
  } catch (error) {
    // Directory fsync is unsupported on some virtual filesystems; propagate unexpected non-OS throws.
    if (!(error instanceof Error)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The file a reference names in `directory`, after checking it holds exactly those bytes. */
export function verifiedObjectFile(
  entry: Pick<StorageObjectReference, 'path' | 'sha256' | 'size'>,
  directory: string,
): string {
  if (!SHA256_HEX_PATTERN.test(entry.sha256)) {
    throw new StateFileError(`Storage object '${entry.path}' carries an invalid SHA-256 hash '${entry.sha256}'.`);
  }
  const file = objectFileIn(directory, entry.sha256);
  const missing = !existsSync(file);
  if (missing) throw new StateFileError(`Storage object '${entry.path}' refers to ${file}, which does not exist.`);
  const intact = statSync(file).size === entry.size && hashFile(file) === entry.sha256;
  const rotted = !intact;
  if (rotted) throw new StateFileError(`Storage object '${entry.path}' refers to ${file}, whose bytes do not match its hash.`);
  return file;
}

/** Check every file a document refers to before any of it is written anywhere. */
export function verifyReferencedObjects(entries: readonly StorageStateEntry[], directory: string): void {
  for (const entry of entries) {
    const referenced = isStorageReference(entry);
    if (referenced) verifiedObjectFile(entry, directory);
  }
}

/** The document's Storage with every reference read back inline, for stores that keep bytes in the document. */
export function inlineStorage(entries: readonly StorageStateEntry[], directory: string): StorageStateRecord[] {
  return entries.map((entry) => {
    const inline = !isStorageReference(entry);
    if (inline) return entry;
    const bytes = readFileSync(verifiedObjectFile(entry, directory));
    return { dataBase64: bytes.toString('base64'), blobType: entry.blobType, metadata: entry.metadata };
  });
}

/**
 * Write `bytes` into `directory/objects/<ab>/<sha256>` atomically (ADR 0018):
 * temp file, `fsync`, `rename`, then directory `fsync`. Deduplicates when an
 * intact file with the same SHA-256 already exists.
 */
export function writeObjectFile(
  bytes: Uint8Array,
  directory: string,
): { sha256: string; size: number; file: string } {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const size = bytes.byteLength;
  const file = objectFileIn(directory, sha256);
  if (existsSync(file)) {
    const intact = statSync(file).size === size && hashFile(file) === sha256;
    if (intact) {
      return { sha256, size, file };
    }
  }
  const shardDir = dirname(file);
  mkdirSync(shardDir, { recursive: true });
  const tempFile = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tempFile, bytes);
    fsyncPathBestEffort(tempFile);
    renameSync(tempFile, file);
    fsyncPathBestEffort(shardDir);
  } catch (error) {
    rmSync(tempFile, { force: true });
    throw error;
  }
  return { sha256, size, file };
}

/**
 * Convert `entries` into SHA-256 `StorageObjectReference` records backed by
 * `directory/objects/<ab>/<sha256>`, verifying existing references and writing
 * inline entries once by content hash.
 */
export function referenceStorage(
  entries: readonly StorageStateEntry[],
  directory: string,
): StorageObjectReference[] {
  return entries.map((entry) => {
    if (isStorageReference(entry)) {
      verifiedObjectFile(entry, directory);
      return {
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
        blobType: entry.blobType,
        metadata: structuredClone(entry.metadata),
      };
    }
    const bytes = Buffer.from(entry.dataBase64, 'base64');
    const written = writeObjectFile(bytes, directory);
    const metadata = {
      ...structuredClone(entry.metadata),
      size: written.size,
    };
    return {
      path: metadata.fullPath,
      sha256: written.sha256,
      size: written.size,
      blobType: entry.blobType,
      metadata,
    };
  });
}

/**
 * Lift a `StorageStateEntry` (inline or file reference) into a SHA-256
 * reference `StorageObjectState` suitable for `FullSandboxState['storage']`
 * and branch manifests without retaining base64 payloads.
 */
export function storageEntryToObjectReferenceState(
  entry: StorageStateEntry,
  directory?: string,
): Extract<StorageObjectState, { sha256: string; size: number }> {
  let sha256: string;
  let size: number;
  if (isStorageReference(entry)) {
    if (directory !== undefined) {
      verifiedObjectFile(entry, directory);
    } else if (!SHA256_HEX_PATTERN.test(entry.sha256)) {
      throw new StateFileError(`Storage object '${entry.path}' carries an invalid SHA-256 hash '${entry.sha256}'.`);
    }
    sha256 = entry.sha256;
    size = entry.size;
  } else {
    const bytes = Buffer.from(entry.dataBase64, 'base64');
    if (directory !== undefined) {
      const written = writeObjectFile(bytes, directory);
      sha256 = written.sha256;
      size = written.size;
    } else {
      sha256 = createHash('sha256').update(bytes).digest('hex');
      size = bytes.byteLength;
    }
  }

  const { fullPath, contentType, customMetadata, ...restMetadata } = entry.metadata;
  const bucket = normalizeBucketField(entry.metadata.bucket);
  const state: Extract<StorageObjectState, { sha256: string; size: number }> = {
    path: fullPath,
    sha256,
    size,
    customMetadata: customMetadata !== undefined ? { ...customMetadata } : {},
    metadata: { ...structuredClone(restMetadata), size },
    blobType: entry.blobType,
  };
  if (bucket !== undefined) state.bucket = bucket;
  if (contentType !== undefined) state.contentType = contentType;
  return state;
}

/**
 * Resolve and verify the content-addressed file for `entry` across the
 * project's state directories (`.pyric/state/hosted` and `.pyric/state`), or
 * return `undefined` when neither store holds the referenced hash.
 */
export function resolveProjectObjectFile(
  projectDir: string,
  entry: Pick<StorageObjectReference, 'path' | 'sha256' | 'size'>,
): string | undefined {
  if (!SHA256_HEX_PATTERN.test(entry.sha256)) {
    throw new StateFileError(`Storage object '${entry.path}' carries an invalid SHA-256 hash '${entry.sha256}'.`);
  }
  const candidateRoots = [
    join(projectDir, '.pyric', 'state', 'hosted'),
    join(projectDir, '.pyric', 'state'),
  ];
  for (const root of candidateRoots) {
    const candidate = objectFileIn(root, entry.sha256);
    if (existsSync(candidate)) {
      return verifiedObjectFile(entry, root);
    }
  }
  return undefined;
}
