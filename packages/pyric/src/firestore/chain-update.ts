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
import { parseUpdateArguments } from './sandbox/update-fields.js';

export type ChainUpdateArguments = [DocumentData | ChainFieldPath, ...unknown[]];

/** Parse a modular `update` call after its reference into chain arguments. */
export function parseChainUpdate(
  methodName: string,
  documentPath: string,
  dataOrField: unknown,
  rest: readonly unknown[],
): ChainUpdateArguments {
  const fields = parseUpdateArguments(methodName, documentPath, dataOrField, rest);
  // An empty data object still requires the document to exist.
  if (fields.length === 0) return [{}];
  const args: unknown[] = [];
  for (const field of fields) args.push(new ChainFieldPath(...field.path), field.value);
  return args as ChainUpdateArguments;
}
