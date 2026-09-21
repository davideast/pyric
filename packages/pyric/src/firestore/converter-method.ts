/**
 * `pyric/firestore` — the `withConverter` instance method for collection and
 * query values.
 *
 * Document references get theirs from `registerDocumentValue` in `refs.ts`,
 * which builds a fresh shell per view. Collections and queries are the
 * chainable sandbox value itself (or a converter shell over one), so the
 * method is attached to every value `collection` / `collectionGroup` /
 * `query` hands back, and to each shell those produce.
 *
 * Package-internal: not re-exported by the barrel, so it stays off the
 * published `pyric/firestore` surface.
 */
import {
  targetOf,
  underlyingOf,
  buildSandboxShell,
} from './state.js';
import { copyQueryValueRegistration } from './sandbox/query-value-registry.js';
import type { DocumentData, FirestoreDataConverter } from './types.js';

/**
 * A fresh typed view over a collection or query. `null` strips the converter
 * and hands back the underlying untyped value, which already carries the
 * method. Documents are not routed here — `withConverter` in `refs.ts` keeps
 * its own document branch.
 */
export function convertedView(
  source: object,
  converter: FirestoreDataConverter<unknown, DocumentData> | null,
): object {
  const underlying = underlyingOf(source);
  const removesConverter = converter === null;
  if (removesConverter) return underlying;
  const target = targetOf(source);
  const shell = buildSandboxShell(underlying as { id?: string; path?: string }, target, converter);
  copyQueryValueRegistration(underlying, shell);
  return attachConverterMethod(shell);
}

/** Attach Firebase's `withConverter` method to a collection or query value. */
export function attachConverterMethod<V extends object>(value: V): V {
  function convert<A, D extends DocumentData = DocumentData>(converter: FirestoreDataConverter<A, D>): V;
  function convert(converter: null): V;
  function convert(converter: FirestoreDataConverter<unknown, DocumentData> | null): object {
    return convertedView(value, converter);
  }
  return Object.assign(value, { withConverter: convert });
}
