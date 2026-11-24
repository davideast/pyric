/**
 * Shared WeakMap handle registry for `pyric-admin/firestore` wrapper proxies.
 */

import type { Sandbox } from 'pyric/sandbox';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';

export const adminToUnderlying = new WeakMap<object, object>();
export const adminToRootDb = new WeakMap<object, SandboxFirestore>();
export const adminRawDbSandbox = new WeakMap<object, Sandbox>();
export const adminRawDbBypassDb = new WeakMap<SandboxFirestore, SandboxFirestore>();
export const adminRawDbProjectId = new WeakMap<object, string>();
export const adminRawDbDatabaseId = new WeakMap<object, string>();
export const adminRootDbProjectId = new WeakMap<object, string>();
export const adminRootDbDatabaseId = new WeakMap<object, string>();
export const appBackedFirestoreRoots = new WeakSet<object>();
export const wrappedDbCache = new WeakMap<SandboxFirestore, SandboxFirestore>();
export const adminDocumentRefBrand = new WeakSet<object>();
export const adminCollectionRefBrand = new WeakSet<object>();
export const adminQueryBrand = new WeakSet<object>();
export const adminDocSnapshotBrand = new WeakSet<object>();

export const DEFAULT_ADMIN_DATABASE_ID = '(default)';
const DEFAULT_ADMIN_PROJECT_ID = 'pyric-sandbox';

export function getAdminHandleDatabaseId(handle: object): string {
  const fromRoot = adminRootDbDatabaseId.get(handle);
  if (fromRoot !== undefined && fromRoot.length > 0) {
    return fromRoot;
  }
  const fromRaw = adminRawDbDatabaseId.get(handle);
  if (fromRaw !== undefined && fromRaw.length > 0) {
    return fromRaw;
  }
  const ownerRoot = adminToRootDb.get(handle);
  if (ownerRoot !== undefined && ownerRoot !== handle) {
    return getAdminHandleDatabaseId(ownerRoot);
  }
  return DEFAULT_ADMIN_DATABASE_ID;
}

export function getAdminHandleProjectId(handle: object): string {
  const fromRoot = adminRootDbProjectId.get(handle);
  if (fromRoot !== undefined && fromRoot.length > 0) {
    return fromRoot;
  }
  const fromRaw = adminRawDbProjectId.get(handle);
  if (fromRaw !== undefined && fromRaw.length > 0) {
    return fromRaw;
  }
  const ownerRoot = adminToRootDb.get(handle);
  if (ownerRoot !== undefined && ownerRoot !== handle) {
    return getAdminHandleProjectId(ownerRoot);
  }
  return DEFAULT_ADMIN_PROJECT_ID;
}

export function isAppBackedRoot(target: object): boolean {
  return appBackedFirestoreRoots.has(target);
}

export function unwrapAdminObject<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const raw = adminToUnderlying.get(value);
    if (raw !== undefined) return raw as T;
  }
  return value;
}

export function isPlainMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
