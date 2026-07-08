/**
 * StorageReference + `ref()` factory.
 *
 * Mirrors the public shape `firebase/storage` exposes: `fullPath`,
 * `bucket`, `name`, `parent`, `root`, `storage`, plus `toString()`
 * returning `gs://<bucket>/<fullPath>`.
 *
 * Two ref impls — sandbox (carries path + storage, computes the
 * other fields) and prod (proxies to an underlying
 * `firebase/storage` ref via a WeakMap). Both implement the same
 * `StorageReference` shape so consumer code is target-blind.
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
import * as fb from 'firebase/storage';
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
 * Internal — map from prod-target StorageReferences to their backing
 * `firebase/storage` references. Ops use this to delegate. WeakMap
 * keys let entries GC alongside the refs that produced them.
 */
const PROD_FB_REF = new WeakMap<StorageReference, fb.StorageReference>();

/** Internal — extract the underlying `fb.StorageReference` for a prod ref. */
export function fbRefOf(ref: StorageReference): fb.StorageReference {
  const r = PROD_FB_REF.get(ref);
  if (!r) {
    throw new Error(
      'pyric/storage: expected a prod-target reference but the WeakMap had no entry. ' +
      'Mixing sandbox + prod refs in the same call?',
    );
  }
  return r;
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
    const parentTarget = targetOf(target.storage);
    if (parentTarget.kind === 'prod') {
      const newFbRef = fb.ref(fbRefOf(target), path ?? '');
      return wrapProdRef(target.storage, newFbRef);
    }
    return new SandboxStorageReference(target.storage, joinPaths(target.fullPath, path ?? ''));
  }
  // Storage-rooted overload.
  const t = targetOf(target);
  if (t.kind === 'prod') {
    const fbR = path === undefined ? fb.ref(t.fbStorage) : fb.ref(t.fbStorage, path);
    return wrapProdRef(target, fbR);
  }
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

// ─── Prod impl ─────────────────────────────────────────────────────

/**
 * Wrap a `firebase/storage` ref in our `StorageReference` shape.
 * Tags it in `PROD_FB_REF` so ops can recover the underlying ref.
 * `parent` / `root` recursively wrap to keep the target consistent.
 */
function wrapProdRef(storage: FirebaseStorage, fbR: fb.StorageReference): StorageReference {
  const wrapper: StorageReference = {
    storage,
    get bucket(): string { return fbR.bucket; },
    get fullPath(): string { return fbR.fullPath; },
    get name(): string { return fbR.name; },
    get parent(): StorageReference | null {
      const p = fbR.parent;
      return p ? wrapProdRef(storage, p) : null;
    },
    get root(): StorageReference {
      return wrapProdRef(storage, fbR.root);
    },
    toString(): string { return fbR.toString(); },
  };
  PROD_FB_REF.set(wrapper, fbR);
  return wrapper;
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
