/**
 * Structural deep equality and `isEqual` helpers for Admin `DocumentReference`,
 * `CollectionReference`, `Query`, `DocumentSnapshot`, and `QuerySnapshot`.
 */

import { Timestamp as CompatTimestamp } from 'pyric/sandbox/admin-compat';
import {
  adminCollectionRefBrand,
  adminDocSnapshotBrand,
  adminDocumentRefBrand,
  adminQueryBrand,
  adminToRootDb,
  isPlainMap,
} from './admin-handle-registry.js';
import { adminHandleConverter } from './admin-converter-and-discovery.js';
import { isAdminGeoPoint } from './admin-geopoint.js';
import { adminQueryMetadata } from './admin-query-validation.js';
import { isAdminVectorValue } from './admin-vector-and-errors.js';

function adminValuesDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right;
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (left instanceof CompatTimestamp && right instanceof CompatTimestamp) {
    return left.isEqual(right);
  }
  if (isAdminGeoPoint(left) && isAdminGeoPoint(right)) {
    return left.isEqual(right);
  }
  if (isAdminVectorValue(left) && isAdminVectorValue(right)) {
    return left.isEqual(right);
  }
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) {
    return left.equals(right);
  }
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.byteLength !== right.byteLength) return false;
    for (let i = 0; i < left.byteLength; i += 1) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }
  if (adminDocumentRefBrand.has(left) && adminDocumentRefBrand.has(right)) {
    return isAdminDocRefEqual(left, right);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (!adminValuesDeepEqual(left[i], right[i])) return false;
    }
    return true;
  }
  if (isPlainMap(left) && isPlainMap(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    for (let i = 0; i < leftKeys.length; i += 1) {
      const k = leftKeys[i] as string;
      if (k !== rightKeys[i]) return false;
      if (!adminValuesDeepEqual(left[k], right[k])) return false;
    }
    return true;
  }
  return false;
}

export function isAdminDocRefEqual(self: object, other: unknown): boolean {
  if (self === other) return true;
  if (typeof other !== 'object' || other === null || !adminDocumentRefBrand.has(other)) {
    return false;
  }
  return (
    adminToRootDb.get(self) === adminToRootDb.get(other) &&
    adminHandleConverter.get(self) === adminHandleConverter.get(other) &&
    (self as { path?: unknown }).path === (other as { path?: unknown }).path
  );
}

export function isAdminCollectionRefEqual(self: object, other: unknown): boolean {
  if (self === other) return true;
  if (typeof other !== 'object' || other === null || !adminCollectionRefBrand.has(other)) {
    return false;
  }
  return (
    adminToRootDb.get(self) === adminToRootDb.get(other) &&
    adminHandleConverter.get(self) === adminHandleConverter.get(other) &&
    (self as { path?: unknown }).path === (other as { path?: unknown }).path
  );
}

export function isAdminQueryEqual(self: object, other: unknown): boolean {
  if (self === other) return true;
  if (typeof other !== 'object' || other === null || !adminQueryBrand.has(other)) {
    return false;
  }
  const selfMeta = adminQueryMetadata.get(self);
  const otherMeta = adminQueryMetadata.get(other);
  if (selfMeta === undefined || otherMeta === undefined) return false;
  return (
    adminToRootDb.get(self) === adminToRootDb.get(other) &&
    adminHandleConverter.get(self) === adminHandleConverter.get(other) &&
    JSON.stringify(selfMeta.signature) === JSON.stringify(otherMeta.signature) &&
    selfMeta.pendingLimitType === otherMeta.pendingLimitType &&
    selfMeta.limitCount === otherMeta.limitCount &&
    selfMeta.offsetCount === otherMeta.offsetCount &&
    JSON.stringify(selfMeta.selectedFields ?? null) ===
      JSON.stringify(otherMeta.selectedFields ?? null) &&
    (selfMeta.startSignature ?? '') === (otherMeta.startSignature ?? '') &&
    (selfMeta.endSignature ?? '') === (otherMeta.endSignature ?? '')
  );
}

export function isAdminDocSnapshotEqual(
  self: object,
  selfPath: string,
  selfExists: boolean,
  selfRawData: unknown,
  other: unknown,
): boolean {
  if (self === other) return true;
  if (typeof other !== 'object' || other === null || !adminDocSnapshotBrand.has(other)) {
    return false;
  }
  const otherSnap = other as {
    ref?: { path?: string };
    exists?: boolean;
    data?: () => unknown;
  };
  if (adminToRootDb.get(self) !== adminToRootDb.get(other)) return false;
  if (otherSnap.ref?.path !== selfPath) return false;
  if (Boolean(otherSnap.exists) !== selfExists) return false;
  if (!selfExists) return true;
  let otherData: unknown;
  if (typeof otherSnap.data === 'function') {
    otherData = otherSnap.data();
  }
  return adminValuesDeepEqual(selfRawData, otherData);
}
