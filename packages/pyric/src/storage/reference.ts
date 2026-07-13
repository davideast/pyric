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
 * `fullPath`, NOT via `===` — Firebase doesn't intern references
 * either, and consumer code that relies on identity for caching is
 * outside the contract.
 *
 * Path normalization matches Firebase exactly: leading slashes
 * stripped, trailing slashes stripped, repeated internal slashes
 * collapsed. Empty path is legal — it's the root reference.
 */
import { TARGET_SYMBOL, targetOf, type FirebaseStorage } from './service.js';

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
 *   `ref(storage, path?)`   — `path` is bucket-rooted. Omit for root.
 *   `ref(parent, path)`     — `path` is relative to `parent.fullPath`.
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
    return new SandboxStorageReference(target.storage, joinPaths(target.fullPath, path ?? ''));
  }
  // Storage-rooted overload.
  targetOf(target);
  return new SandboxStorageReference(target, normalizePath(path ?? ''));
}

// ─── Sandbox impl ──────────────────────────────────────────────────

class SandboxStorageReference implements StorageReference {
  readonly storage: FirebaseStorage;
  readonly bucket: string;
  readonly fullPath: string;

  constructor(storage: FirebaseStorage, fullPath: string) {
    this.storage = storage;
    // Sandbox handles always have a sandbox target; pull bucket from it.
    const t = targetOf(storage);
    this.bucket = t.bucket;
    this.fullPath = fullPath;
  }

  get name(): string {
    if (this.fullPath === '') return '';
    const idx = this.fullPath.lastIndexOf('/');
    return idx === -1 ? this.fullPath : this.fullPath.slice(idx + 1);
  }

  get parent(): StorageReference | null {
    if (this.fullPath === '') return null;
    const idx = this.fullPath.lastIndexOf('/');
    const parentPath = idx === -1 ? '' : this.fullPath.slice(0, idx);
    return new SandboxStorageReference(this.storage, parentPath);
  }

  get root(): StorageReference {
    if (this.fullPath === '') return this;
    return new SandboxStorageReference(this.storage, '');
  }

  toString(): string {
    return `gs://${this.bucket}/${this.fullPath}`;
  }
}

// ─── Path utilities ────────────────────────────────────────────────

/**
 * Normalize a single path: strip leading/trailing slashes, collapse
 * repeated internal slashes. Empty stays empty (the root).
 *
 * Matches Firebase's behavior — relevant when consumer code passes
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
 * Join a parent path with a child path, normalizing the result.
 * Used by the `ref(parent, path)` overload and by `child` helpers.
 */
export function joinPaths(parent: string, child: string): string {
  const childNorm = normalizePath(child);
  if (parent === '') return childNorm;
  if (childNorm === '') return parent;
  return `${parent}/${childNorm}`;
}

/** Structural test — references all expose `fullPath` + `storage`. */
function isStorageReference(target: unknown): target is StorageReference {
  if (target === null || typeof target !== 'object') return false;
  // Distinguish from a FirebaseStorage handle (which has TARGET_SYMBOL
  // but no `fullPath`). The handle has the symbol; refs don't.
  if (TARGET_SYMBOL in target) return false;
  const obj = target as { fullPath?: unknown; storage?: unknown };
  return typeof obj.fullPath === 'string' && obj.storage !== undefined;
}
