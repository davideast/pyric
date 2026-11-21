/**
 * Admin-SDK `set()` options (`merge`, `mergeFields`) and write `Precondition`
 * validation (`@google-cloud/firestore` parity across local and remote sandboxes).
 */

import {
  FieldPath,
  Timestamp as CompatTimestamp,
  type AuthContext,
  type DocumentData,
  type OperationOptions,
  type SetOptions,
} from 'pyric/sandbox/admin-compat';
import { SandboxError } from 'pyric/sandbox';
import {
  isObjectRecord,
  isPlainDocumentObject,
  validateAndNormalizeDocumentData,
  validateStringOrFieldPath,
} from './admin-write-validation.js';

export function compareFieldSegments(left: readonly string[], right: readonly string[]): number {
  const minLen = Math.min(left.length, right.length);
  for (let i = 0; i < minLen; i += 1) {
    const a = left[i] ?? '';
    const b = right[i] ?? '';
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
  }
  return left.length - right.length;
}

function deduplicateSortedPaths(
  paths: ReadonlyArray<readonly string[]>,
): Array<readonly string[]> {
  const sorted = [...paths].sort(compareFieldSegments);
  const unique: Array<readonly string[]> = [];
  for (const segs of sorted) {
    const prev = unique[unique.length - 1];
    if (prev === undefined || compareFieldSegments(prev, segs) !== 0) {
      unique.push(segs);
    }
  }
  return unique;
}

function verifyMaskPathsPresentInData(
  data: Record<string, unknown>,
  sortedUniquePaths: ReadonlyArray<readonly string[]>,
): void {
  const remaining = new Set<number>(sortedUniquePaths.map((_, idx) => idx));

  function findExactMaskIndex(candidate: readonly string[]): number {
    for (let i = 0; i < sortedUniquePaths.length; i += 1) {
      const target = sortedUniquePaths[i];
      if (target !== undefined && compareFieldSegments(target, candidate) === 0) {
        return i;
      }
    }
    return -1;
  }

  function walkObject(current: Record<string, unknown>, prefix: readonly string[]): void {
    for (const key of Object.keys(current)) {
      const childPath = [...prefix, key];
      const matchedIdx = findExactMaskIndex(childPath);
      if (matchedIdx !== -1) {
        remaining.delete(matchedIdx);
      } else {
        const childVal = current[key];
        if (isPlainDocumentObject(childVal)) {
          walkObject(childVal, childPath);
        }
      }
    }
  }

  walkObject(data, []);

  for (let i = 0; i < sortedUniquePaths.length; i += 1) {
    if (remaining.has(i)) {
      const missingSegs = sortedUniquePaths[i] ?? [];
      const formatted = new FieldPath(...missingSegs).toString();
      throw new SandboxError('invalid-argument', `Input data is missing for field "${formatted}".`);
    }
  }
}

function copyOptionalAuth(source: Record<string, unknown>, target: SetOptions): void {
  if ('auth' in source) {
    target.auth = source.auth as AuthContext;
  }
}

export function validateAndNormalizeSetCall(
  data: unknown,
  rawOptions: unknown,
  coerceFalsyOptions: boolean,
  requireSentinelBrand: boolean,
): { data: DocumentData; options: SetOptions | undefined } {
  let effectiveOptions = rawOptions;
  if (coerceFalsyOptions && !rawOptions) {
    effectiveOptions = undefined;
  }

  if (effectiveOptions === undefined) {
    return {
      data: validateAndNormalizeDocumentData('data', data, 'none', requireSentinelBrand),
      options: undefined,
    };
  }

  if (!isObjectRecord(effectiveOptions)) {
    throw new SandboxError(
      'invalid-argument',
      'Value for argument "options" is not a valid set() options argument. Input is not an object.',
    );
  }

  const hasMergeKey = 'merge' in effectiveOptions;
  const hasMergeFieldsKey = 'mergeFields' in effectiveOptions;
  if (hasMergeKey && hasMergeFieldsKey) {
    throw new SandboxError(
      'invalid-argument',
      'Value for argument "options" is not a valid set() options argument. You cannot specify both "merge" and "mergeFields".',
    );
  }

  let sortedUniqueMask: Array<readonly string[]> | undefined;
  if (hasMergeFieldsKey) {
    const rawMask = effectiveOptions.mergeFields;
    const rawLength = (rawMask as { length: number }).length;
    for (let i = 0; i < rawLength; i += 1) {
      validateStringOrFieldPath(i, (rawMask as Record<number, unknown>)[i]);
    }
    const maskInputs: Array<readonly string[]> = [];
    for (const item of rawMask as Iterable<unknown>) {
      maskInputs.push(validateStringOrFieldPath('mergeFields', item));
    }
    sortedUniqueMask = deduplicateSortedPaths(maskInputs);
  }

  const mergeLeaves = hasMergeKey && Boolean(effectiveOptions.merge);
  let allowDeletes: 'none' | 'all' = 'none';
  if (mergeLeaves || hasMergeFieldsKey) {
    allowDeletes = 'all';
  }
  const normalizedData = validateAndNormalizeDocumentData(
    'data',
    data,
    allowDeletes,
    requireSentinelBrand,
  );

  if (sortedUniqueMask !== undefined) {
    verifyMaskPathsPresentInData(normalizedData, sortedUniqueMask);
    const outOptions: SetOptions = {
      mergeFields: sortedUniqueMask.map((segs) => new FieldPath(...segs)),
    };
    copyOptionalAuth(effectiveOptions, outOptions);
    return { data: normalizedData, options: outOptions };
  }

  if (hasMergeKey) {
    const outOptions: SetOptions = { merge: mergeLeaves };
    copyOptionalAuth(effectiveOptions, outOptions);
    return { data: normalizedData, options: outOptions };
  }

  const outOptions: SetOptions = {};
  copyOptionalAuth(effectiveOptions, outOptions);
  return { data: normalizedData, options: outOptions };
}

export function validatePreconditionObject(
  argName: string,
  precondition: unknown,
  forbidExistsFalse = false,
): OperationOptions | undefined {
  if (precondition === undefined) {
    return undefined;
  }
  if (typeof precondition !== 'object' || precondition === null) {
    throw new SandboxError('invalid-argument', 'Input is not an object.');
  }
  const record = precondition as Record<string, unknown>;
  const existsVal = record.exists;
  const lastUpdateVal = record.lastUpdateTime;
  if (existsVal !== undefined) {
    if (typeof existsVal !== 'boolean') {
      throw new SandboxError(
        'invalid-argument',
        `Value for argument "${argName}" is not a valid precondition. "exists" is not a boolean.`,
      );
    }
    if (forbidExistsFalse && existsVal === false) {
      throw new SandboxError(
        'invalid-argument',
        `Value for argument "${argName}" is not a valid precondition. "exists" is not allowed to have the value false (allowed values: true)`,
      );
    }
  }
  if (lastUpdateVal !== undefined && !(lastUpdateVal instanceof CompatTimestamp)) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "${argName}" is not a valid precondition. "lastUpdateTime" is not a Firestore Timestamp.`,
    );
  }
  if (existsVal !== undefined && lastUpdateVal !== undefined) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "${argName}" is not a valid precondition. Input specifies more than one precondition.`,
    );
  }
  if ('auth' in record) {
    return { auth: record.auth as AuthContext };
  }
  return undefined;
}
