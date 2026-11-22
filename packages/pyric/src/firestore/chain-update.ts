/**
 * Modular `update` arguments handed to the chainable adapter.
 *
 * The modular surface parses its arguments with the Web SDK's rules, then
 * calls the chain's Admin-shaped `update` in the field-and-value form, so
 * each field path reaches the engine as a segment vector and never passes
 * through a dot-separated string.
 */
import {
  FieldPath as ChainFieldPath,
  type DocumentData,
} from 'pyric/sandbox/admin-firestore';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { isPlainObject } from './plain-object.js';
import { isRegisteredFieldValueSentinel, markUserWriteValue } from './sandbox/unescaped-map.js';
import { parseUpdateArguments, type WriteValidationOptions } from './sandbox/update-fields.js';

export type ChainUpdateArguments = [DocumentData | ChainFieldPath, ...unknown[]];

function assertNoUndefinedInSentinels(methodName: string, documentPath: string, value: unknown): void {
  if (value === undefined) {
    throw new FirebaseError(
      'invalid-argument',
      `Function ${methodName}() called with invalid data. Unsupported field value: undefined (found in document ${documentPath})`,
    );
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoUndefinedInSentinels(methodName, documentPath, entry);
    }
    return;
  }
  if (value !== null && typeof value === 'object' && isRegisteredFieldValueSentinel(value)) {
    const sentinel = value as { values?: unknown };
    if (Array.isArray(sentinel.values)) {
      for (const entry of sentinel.values) {
        assertNoUndefinedInSentinels(methodName, documentPath, entry);
      }
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) {
      assertNoUndefinedInSentinels(methodName, documentPath, entry);
    }
  }
}

/** Parse a modular `update` call after its reference into chain arguments. */
export function parseChainUpdate(
  methodName: string,
  documentPath: string,
  dataOrField: unknown,
  rest: readonly unknown[],
  options?: WriteValidationOptions,
): ChainUpdateArguments {
  const fields = parseUpdateArguments(methodName, documentPath, dataOrField, rest, options);
  // An empty data object still requires the document to exist.
  if (fields.length === 0) return [{}];
  const args: unknown[] = [];
  for (const field of fields) {
    assertNoUndefinedInSentinels(methodName, documentPath, field.value);
    args.push(new ChainFieldPath(...field.path), markUserWriteValue(field.value));
  }
  return args as ChainUpdateArguments;
}
