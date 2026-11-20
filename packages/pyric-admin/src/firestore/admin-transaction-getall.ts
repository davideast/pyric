/**
 * Argument validation and `ReadOptions.fieldMask` snapshot projection for
 * `Transaction.getAll(...documentRefsOrReadOptions)`.
 */

import {
  registeredAdminReferencePath,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type SnapshotFieldPath,
} from 'pyric/sandbox/admin-compat';
import { SandboxError } from 'pyric/sandbox';
import {
  adminDocSnapshotBrand,
  adminDocumentRefBrand,
  isPlainMap,
} from './admin-handle-registry.js';
import {
  assertAdminDocumentReference,
  isPlainDocumentObject,
  validateStringOrFieldPath,
} from './admin-write-validation.js';

function isAdminDocRef(value: unknown): value is DocumentReference {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return adminDocumentRefBrand.has(value) || registeredAdminReferencePath(value) !== undefined;
}

export function parseTransactionGetAllArgs(args: readonly unknown[]): {
  readonly refs: readonly DocumentReference[];
  readonly fieldMask: ReadonlyArray<readonly string[]> | undefined;
} {
  if (args.length === 0) {
    throw new SandboxError(
      'invalid-argument',
      'Function "Transaction.getAll()" requires at least 1 argument.',
    );
  }
  let refArgs = args;
  let fieldMask: Array<readonly string[]> | undefined;
  const lastArg = args[args.length - 1];
  if (args.length >= 2 && isPlainDocumentObject(lastArg) && !isAdminDocRef(lastArg)) {
    refArgs = args.slice(0, -1);
    if ('fieldMask' in lastArg && lastArg.fieldMask !== undefined) {
      if (!Array.isArray(lastArg.fieldMask)) {
        throw new SandboxError(
          'invalid-argument',
          'Value for argument "readOptions.fieldMask" is not an array.',
        );
      }
      fieldMask = lastArg.fieldMask.map((entry, idx) => validateStringOrFieldPath(idx, entry));
    }
  }
  const refs: DocumentReference[] = [];
  for (const candidate of refArgs) {
    assertAdminDocumentReference('documentRefsOrReadOptions', candidate);
    refs.push(candidate as DocumentReference);
  }
  return { refs, fieldMask };
}

function readNestedSegments(source: Record<string, unknown>, segments: readonly string[]): unknown {
  let cursor: unknown = source;
  for (const seg of segments) {
    if (!isPlainMap(cursor) || !Object.hasOwn(cursor, seg)) {
      return undefined;
    }
    cursor = cursor[seg];
  }
  return cursor;
}

function writeNestedSegments(
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i] ?? '';
    if (!isPlainMap(cursor[seg])) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (leaf !== undefined) {
    cursor[leaf] = value;
  }
}

export function projectDocSnapshotFields(
  snap: DocumentSnapshot,
  fieldMask: ReadonlyArray<readonly string[]>,
): DocumentSnapshot {
  if (!snap.exists) {
    return snap;
  }
  const buildProjectedData = (): DocumentData | undefined => {
    const full = snap.data();
    if (full === undefined) {
      return undefined;
    }
    const projected: Record<string, unknown> = {};
    for (const segs of fieldMask) {
      const val = readNestedSegments(full, segs);
      if (val !== undefined) {
        writeNestedSegments(projected, segs, val);
      }
    }
    return projected;
  };
  const proxy = new Proxy(snap, {
    get(t, prop) {
      if (prop === 'data') {
        return buildProjectedData;
      }
      if (prop === 'get') {
        return (fieldPath: SnapshotFieldPath) => {
          const projected = buildProjectedData();
          if (projected === undefined) {
            return undefined;
          }
          const segs = validateStringOrFieldPath('fieldPath', fieldPath);
          if (segs.length === 1) {
            return projected[segs[0] ?? ''];
          }
          return readNestedSegments(projected, segs);
        };
      }
      const value = Reflect.get(t, prop, t);
      if (typeof value === 'function') {
        return value.bind(t);
      }
      return value;
    },
  });
  adminDocSnapshotBrand.add(proxy);
  return proxy;
}
