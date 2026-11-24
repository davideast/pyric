/**
 * Admin-SDK `update(...)` argument, precondition, empty-map, sentinel-placement,
 * and duplicate/prefix-conflicting field-path validation (`@google-cloud/firestore`
 * parity across local and remote sandboxes).
 */

import { FieldPath, type OperationOptions } from 'pyric/sandbox/admin-compat';
import { SandboxError } from 'pyric/sandbox';
import { formatCustomObjectErrorMessage } from './admin-error-messages.js';
import {
  compareFieldSegments,
  validatePreconditionObject,
} from './admin-set-and-precondition-validation.js';
import {
  isFieldPathInstance,
  isPlainDocumentObject,
  validateAndNormalizeFirestoreValue,
  validateStringOrFieldPath,
} from './admin-write-validation.js';

const UPDATE_LEADING_ERROR =
  'Update() requires either a single JavaScript object or an alternating list of field/value pairs that can be followed by an optional precondition.';

function isFieldPathPrefix(prefix: readonly string[], candidate: readonly string[]): boolean {
  if (prefix.length > candidate.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== candidate[i]) {
      return false;
    }
  }
  return true;
}

function assertNoConflictingFieldPaths(paths: ReadonlyArray<readonly string[]>): void {
  if (paths.length < 2) {
    return;
  }
  const sorted = [...paths].sort(compareFieldSegments);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev !== undefined && curr !== undefined && isFieldPathPrefix(prev, curr)) {
      throw new SandboxError(
        'invalid-argument',
        `Value for argument "dataOrField" is not a valid update map. Field "${prev.join('.')}" was specified multiple times.`,
      );
    }
  }
}

function requireUpdatePrecondition(
  argLabel: string | number,
  precondition: unknown,
): OperationOptions | undefined {
  if (typeof precondition !== 'object' || precondition === null) {
    throw new SandboxError('invalid-argument', `${UPDATE_LEADING_ERROR} Input is not an object.`);
  }
  try {
    return validatePreconditionObject(argLabel, precondition, true);
  } catch (err) {
    if (err instanceof SandboxError) {
      throw new SandboxError(err.code, `${UPDATE_LEADING_ERROR} ${err.message}`);
    }
    throw err;
  }
}

export function validateAndNormalizeUpdateArgs(
  args: readonly unknown[],
  requireSentinelBrand: boolean,
): unknown[] {
  if (args.length === 0) {
    throw new SandboxError(
      'invalid-argument',
      'Function "DocumentReference.update()" requires at least 1 argument.',
    );
  }

  const dataOrField = args[0];
  const usesVarargs = typeof dataOrField === 'string' || isFieldPathInstance(dataOrField);

  if (usesVarargs) {
    const outArgs: unknown[] = [];
    const seenPaths: Array<readonly string[]> = [];
    let trailingOptions: OperationOptions | undefined;

    for (let i = 0; i < args.length; i += 2) {
      if (i === args.length - 1) {
        trailingOptions = requireUpdatePrecondition(i + 1, args[i]);
        if (i === 0) {
          outArgs.push(args[0]);
        }
      } else {
        const segs = validateStringOrFieldPath(i + 1, args[i]);
        seenPaths.push(segs);
        const normalizedVal = validateAndNormalizeFirestoreValue(args[i + 1], {
          arg: i + 1,
          expectedType: 'Firestore value',
          leadingMessage: UPDATE_LEADING_ERROR,
          segments: segs,
          allowDeletes: 'root',
          allowTransforms: true,
          requireSentinelBrand,
          level: 1,
          pathLength: 1,
          inArray: false,
          directArrayElement: false,
        });
        outArgs.push(new FieldPath(...segs), normalizedVal);
      }
    }

    assertNoConflictingFieldPaths(seenPaths);
    if (trailingOptions !== undefined) {
      outArgs.push(trailingOptions);
    }
    return outArgs;
  }

  if (!isPlainDocumentObject(dataOrField)) {
    throw new SandboxError(
      'invalid-argument',
      formatCustomObjectErrorMessage(
        'dataOrField',
        'Firestore document',
        UPDATE_LEADING_ERROR,
        dataOrField,
        [],
      ),
    );
  }

  const keys = Object.keys(dataOrField);
  if (keys.length === 0) {
    throw new SandboxError(
      'invalid-argument',
      `${UPDATE_LEADING_ERROR} At least one field must be updated.`,
    );
  }

  if (args.length > 2) {
    throw new SandboxError(
      'invalid-argument',
      `${UPDATE_LEADING_ERROR} Function "update()" accepts at most 3 arguments.`,
    );
  }

  const normalizedMap: Record<string, unknown> = {};
  const seenPaths: Array<readonly string[]> = [];
  for (const key of keys) {
    const segs = validateStringOrFieldPath(key, key);
    seenPaths.push(segs);
    Object.defineProperty(normalizedMap, key, {
      value: validateAndNormalizeFirestoreValue(dataOrField[key], {
        arg: 'dataOrField',
        expectedType: 'Firestore value',
        leadingMessage: UPDATE_LEADING_ERROR,
        segments: segs,
        allowDeletes: 'root',
        allowTransforms: true,
        requireSentinelBrand,
        level: 0,
        pathLength: 1,
        inArray: false,
        directArrayElement: false,
      }),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  let extractedOptions: OperationOptions | undefined;
  if (args.length === 2) {
    extractedOptions = requireUpdatePrecondition('preconditionOrValues', args[1]);
  }

  assertNoConflictingFieldPaths(seenPaths);
  if (extractedOptions !== undefined) {
    return [normalizedMap, extractedOptions];
  }
  return [normalizedMap];
}
