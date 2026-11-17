/**
 * Shared WeakMap handle registry for `pyric-admin/firestore` wrapper proxies.
 */

import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import type { AdminServiceLifecycle } from '../app/lifecycle.js';

export const adminToUnderlying = new WeakMap<object, object>();
export const adminToRootDb = new WeakMap<object, SandboxFirestore>();
export const adminToLifecycle = new WeakMap<object, AdminServiceLifecycle>();
export const wrappedDbCache = new WeakMap<SandboxFirestore, SandboxFirestore>();
export const adminDocumentRefBrand = new WeakSet<object>();
export const adminQueryBrand = new WeakSet<object>();

export function lifecycleOf(target: object): AdminServiceLifecycle | undefined {
  return adminToLifecycle.get(target);
}

export function assertRootActive(rootDb: SandboxFirestore): void {
  lifecycleOf(rootDb)?.assertActive();
}

export function runAsyncWithLifecycle<R>(
  rootDb: SandboxFirestore,
  fn: () => Promise<R>,
): Promise<R> {
  try {
    assertRootActive(rootDb);
  } catch (err) {
    return Promise.reject(err);
  }
  return fn();
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
