/**
 * StorageReference + `ref()` factory.
 *
 * Mirrors the public shape `firebase/storage` exposes: `fullPath`,
 * `bucket`, `name`, `parent`, `root`, `storage`, plus `toString()`
 * returning `gs://<bucket>/<fullPath>`.
 *
 * References carry a sandbox handle and path, then compute the other fields.
 *
 * Identity model: references are value objects. Two refs with the
 * same `(storage, fullPath)` compare equal via `toString()` /
 * `fullPath`, NOT via `===` -- Firebase does not intern references
 * either, and consumer code that relies on identity for caching is
 * outside the contract.
 *
 * Client path normalization matches Firebase: leading slashes stripped,
 * trailing slashes stripped, repeated internal slashes collapsed. Empty path
 * is legal -- it is the root reference. On the admin plane (`target.admin`),
 * object names are kept verbatim as `@google-cloud/storage` stores them.
 */
import { rulesBucketName } from '@pyric/rules/internal/storage';
import {
  OPERATION_STORAGE_SYMBOL,
  operationStorageOf,
  resolveReferenceOperationStorage,
} from './sandbox/cross-bucket-target.js';
import { TARGET_SYMBOL, targetOf, type FirebaseStorage } from './service.js';
import { refLocationOf, refPathOf } from './url.js';

/**
 * Public reference shape. Methods are inherited from the impl
 * classes below; the interface is exported so consumer code can
 * name the type without depending on the impls.
 */
export interface StorageReference {
  readonly storage: FirebaseStorage;
  readonly bucket: string;
  readonly fullPath: string;
  readonly name: string;
  readonly parent: StorageReference | null;
  readonly root: StorageReference;
  toString(): string;
}

/**
 * Construct a reference. Two overloads matching Firebase:
 *
 *   `ref(storage, path?)`   -- `path` is bucket-rooted. Omit for root. A
 *                              `gs://` or download URL names its object on
 *                              client handles, as `./url.ts` describes.
 *   `ref(parent, path)`     -- `path` is relative to `parent.fullPath`.
 */
export function ref(storage: FirebaseStorage, path?: string): StorageReference;
export function ref(parent: StorageReference, path: string): StorageReference;
export function ref(
  target: FirebaseStorage | StorageReference,
  path?: string,
): StorageReference {
  if (isStorageReference(target)) {
    // Relative-to-parent overload.
    targetOf(target.storage);
    const parentOperationStorage = operationStorageOf(target);
    targetOf(parentOperationStorage);
    const joinedPath = joinStorageRefPaths(target.fullPath, refPathOf(path, false));
    return new SandboxStorageReference(target.storage, joinedPath, parentOperationStorage);
  }
  // Storage-rooted overload.
  const resolvedTarget = targetOf(target);
  if (resolvedTarget.admin === true) {
    return new SandboxStorageReference(target, path ?? '', target);
  }
  const location = refLocationOf(path, true);
  const operationStorage = resolveReferenceOperationStorage(target, location.bucket);
  return new SandboxStorageReference(target, normalizePath(location.path), operationStorage);
}

/** Construct a reference on the same public handle and operational bucket as `source`. */
export function referenceAtPath(
  source: StorageReference,
  fullPath: string,
  literal = false,
): StorageReference {
  targetOf(source.storage);
  const operationStorage = operationStorageOf(source);
  targetOf(operationStorage);
  let resolvedPath = normalizePath(fullPath);
  if (literal) {
    resolvedPath = fullPath;
  }
  return new SandboxStorageReference(source.storage, resolvedPath, operationStorage);
}

// --- Sandbox impl -------------------------------------------------

class SandboxStorageReference implements StorageReference {
  readonly storage: FirebaseStorage;
  readonly [OPERATION_STORAGE_SYMBOL]: FirebaseStorage;
  readonly bucket: string;
  readonly fullPath: string;

  constructor(
    storage: FirebaseStorage,
    fullPath: string,
    operationStorage: FirebaseStorage = storage,
  ) {
    this.storage = storage;
    this[OPERATION_STORAGE_SYMBOL] = operationStorage;
    // Sandbox handles always have a sandbox target; expose the caller-known
    // bucket name when present while keeping the store's internal key intact.
    const t = targetOf(operationStorage);
    if (t.bucketName === '') {
      this.bucket = '';
    } else if (t.bucketName !== undefined) {
      this.bucket = rulesBucketName(t.bucket, t.bucketName);
    } else {
      this.bucket = t.bucket;
    }
    this.fullPath = fullPath;
  }

  get name(): string {
    return storageLastComponent(this.fullPath);
  }

  get parent(): StorageReference | null {
    if (this.fullPath === '') return null;
    const idx = this.fullPath.lastIndexOf('/');
    let parentPath = '';
    if (idx !== -1) {
      parentPath = this.fullPath.slice(0, idx);
    }
    return new SandboxStorageReference(this.storage, parentPath, this[OPERATION_STORAGE_SYMBOL]);
  }

  get root(): StorageReference {
    return new SandboxStorageReference(this.storage, '', this[OPERATION_STORAGE_SYMBOL]);
  }

  toString(): string {
    return `gs://${this.bucket}/${this.fullPath}`;
  }
}

// --- Path utilities -----------------------------------------------

/**
 * Normalize a single path: strip leading/trailing slashes, collapse
 * repeated internal slashes. Empty stays empty (the root).
 *
 * Matches Firebase's behavior -- relevant when consumer code passes
 * `/sessions/s1.json` or `sessions//s1.json`; both end up at
 * `sessions/s1.json`.
 */
export function normalizePath(path: string): string {
  if (path === '') return '';
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
}

/**
 * Return the final component of a Storage reference path, matching
 * `@firebase/storage`'s `lastComponent`: scans from `path.length - 2` so a
 * trailing slash (`users/u1/` from `ref(folderRef, '')`) stays part of `name`
 * (`u1/`).
 */
export function storageLastComponent(path: string): string {
  if (path.length < 2) return path;
  const idx = path.lastIndexOf('/', path.length - 2);
  if (idx === -1) return path;
  return path.slice(idx + 1);
}

/**
 * Join a parent path with a child path, normalizing `child`. Matches
 * `@firebase/storage`'s `child(path, childPath)`: when `parent` is non-empty
 * and `child` normalizes to `""`, returns `${parent}/`.
 */
export function joinStorageRefPaths(parent: string, child: string): string {
  const childNorm = normalizePath(child);
  if (parent === '') return childNorm;
  return `${parent}/${childNorm}`;
}

/** Structural test -- references all expose `fullPath` + `storage`. */
function isStorageReference(target: unknown): target is StorageReference {
  if (target === null || typeof target !== 'object') return false;
  // Distinguish from a FirebaseStorage handle (which has TARGET_SYMBOL
  // but no `fullPath`). The handle has the symbol; refs do not.
  if (TARGET_SYMBOL in target) return false;
  const obj = target as { fullPath?: unknown; storage?: unknown };
  return typeof obj.fullPath === 'string' && obj.storage !== undefined;
}
