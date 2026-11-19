/**
 * Shared WeakMap handle registry for `pyric-admin/firestore` wrapper proxies.
 */

import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';

export const adminToUnderlying = new WeakMap<object, object>();
export const adminToRootDb = new WeakMap<object, SandboxFirestore>();
export const appBackedFirestoreRoots = new WeakSet<object>();
export const wrappedDbCache = new WeakMap<SandboxFirestore, SandboxFirestore>();
export const adminDocumentRefBrand = new WeakSet<object>();
export const adminQueryBrand = new WeakSet<object>();
export const adminDocSnapshotBrand = new WeakSet<object>();

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
