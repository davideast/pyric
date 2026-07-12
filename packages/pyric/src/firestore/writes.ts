/**
 * `pyric/firestore` — document writes.
 *
 * `setDoc` / `updateDoc` / `deleteDoc` / `addDoc` and the modular
 * `SetOptions` shape. Sandbox handles route through the chainable adapter
 * (running any converter on `setDoc` / `addDoc`); prod handles forward to
 * `firebase/firestore`.
 */
import * as fb from 'firebase/firestore';
import type {
  DocumentData,
  SetOptions as ChainSetOptions,
} from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  isSandboxKind,
  converterOf,
  chainDocFor,
  chainCollFor,
  tagSandboxRef,
  buildSandboxShell,
  tag,
  asFbDoc,
  asFbColl,
} from './state.js';
import type {
  DocumentReference,
  CollectionReference,
  FirestoreDataConverter,
} from './types.js';

// ─── Writes ───────────────────────────────────────────────────────────

/**
 * Modular Web-SDK-shaped `SetOptions`. Either flag controls how `data`
 * combines with the existing document; passing nothing replaces the
 * existing doc entirely (Firestore default).
 *
 *   - `{ merge: true }` — shallow-merge every top-level field in
 *     `data` into the existing document, preserving fields not in
 *     `data`. Equivalent to `firebase/firestore`'s `setDoc(ref, data,
 *     { merge: true })`.
 *   - `{ mergeFields: [...] }` — project `data` to just the listed
 *     top-level fields, then merge. Other fields in `data` are
 *     ignored; other fields in the existing doc are preserved.
 *
 * `merge` and `mergeFields` are mutually exclusive; passing both is
 * a programming error (`mergeFields` wins on the sandbox path,
 * matching the JS SDK's effective behavior).
 */
export interface SetOptions {
  merge?: boolean;
  mergeFields?: readonly string[];
}

export async function setDoc<T = DocumentData>(
  ref: DocumentReference<T>,
  data: T,
  options?: SetOptions,
): Promise<void> {
  const target = targetOf(ref);
  if (isSandboxKind(target)) {
    const conv = converterOf(ref);
    const payload = conv
      ? (conv as FirestoreDataConverter<T>).toFirestore(data)
      : (data as unknown as DocumentData);
    // Pass `options` through verbatim — `ChainSetOptions` is structurally
    // the same shape as our public `SetOptions` (sandbox layer adds an
    // optional `auth` field we don't expose at the modular layer).
    return chainDocFor(target, ref).set(payload, options as ChainSetOptions | undefined);
  }
  // Prod refs that came through `withConverter` carry their converter
  // on the fb ref itself — `fb.setDoc` invokes `toFirestore` natively.
  if (options === undefined) return fb.setDoc(asFbDoc(ref) as fb.DocumentReference<T>, data);
  return fb.setDoc(asFbDoc(ref) as fb.DocumentReference<T>, data, options as fb.SetOptions);
}

/**
 * `updateDoc` does NOT run the converter. Matches `firebase/firestore`'s
 * Web SDK shape — partial updates can target any subset of fields, so
 * a translator built around a full `AppModelType` would be a type-shape
 * mismatch. Use the underlying `DocumentData` view (`withConverter(ref,
 * null)`) for typed-and-untyped mixed access if you need both styles
 * against the same path.
 */
export async function updateDoc(ref: DocumentReference, data: DocumentData): Promise<void> {
  const target = targetOf(ref);
  if (isSandboxKind(target)) return chainDocFor(target, ref).update(data);
  return fb.updateDoc(asFbDoc(ref), data);
}

export async function deleteDoc(ref: DocumentReference): Promise<void> {
  const target = targetOf(ref);
  if (isSandboxKind(target)) return chainDocFor(target, ref).delete();
  return fb.deleteDoc(asFbDoc(ref));
}

export async function addDoc<T = DocumentData>(
  coll: CollectionReference<T>,
  data: T,
): Promise<DocumentReference<T>> {
  const target = targetOf(coll);
  if (isSandboxKind(target)) {
    const conv = converterOf(coll);
    const payload = conv
      ? (conv as FirestoreDataConverter<T>).toFirestore(data)
      : (data as unknown as DocumentData);
    const ref = await chainCollFor(target, coll).add(payload);
    // The freshly-minted doc has its auto-id path baked in. Record a
    // rebuild closure for sandbox-live so subsequent ops on `ref`
    // re-resolve against the current user (matches the doc()-factory
    // semantics for explicitly-pathed refs).
    const absPath = (ref as unknown as { path: string }).path;
    const tagged = tagSandboxRef(
      ref as object,
      target,
      (fresh) => fresh.doc(absPath) as unknown as object,
    );
    // Propagate the collection's converter onto the freshly-created
    // doc ref so `getDoc(addDocResult)` round-trips through the same
    // typing without an extra `withConverter` call. Matches fb's
    // native behavior.
    if (conv) {
      return buildSandboxShell(
        tagged as { id: string; path: string },
        target,
        conv,
      ) as DocumentReference<T>;
    }
    return tagged as DocumentReference<T>;
  }
  const ref = await fb.addDoc(asFbColl(coll) as fb.CollectionReference<T>, data);
  return tag(ref as object, target) as DocumentReference<T>;
}
