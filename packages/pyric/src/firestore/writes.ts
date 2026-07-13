/**
 * `pyric/firestore` — document writes.
 *
 * `setDoc` / `updateDoc` / `deleteDoc` / `addDoc` and the modular
 * `SetOptions` shape. Operations route through the sandbox's chainable
 * adapter, running any converter on `setDoc` / `addDoc`.
 */
import type {
  DocumentData,
  SetOptions as ChainSetOptions,
} from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  converterOf,
  chainDocFor,
  chainCollFor,
  tagSandboxRef,
  buildSandboxShell,
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
  const conv = converterOf(ref);
  const payload = conv
    ? (conv as FirestoreDataConverter<T>).toFirestore(data)
    : (data as unknown as DocumentData);
  return chainDocFor(target, ref).set(payload, options as ChainSetOptions | undefined);
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
  return chainDocFor(target, ref).update(data);
}

export async function deleteDoc(ref: DocumentReference): Promise<void> {
  const target = targetOf(ref);
  return chainDocFor(target, ref).delete();
}

export async function addDoc<T = DocumentData>(
  coll: CollectionReference<T>,
  data: T,
): Promise<DocumentReference<T>> {
  const target = targetOf(coll);
  const conv = converterOf(coll);
  const payload = conv
    ? (conv as FirestoreDataConverter<T>).toFirestore(data)
    : (data as unknown as DocumentData);
  const ref = await chainCollFor(target, coll).add(payload);
  const absPath = (ref as unknown as { path: string }).path;
  const tagged = tagSandboxRef(
    ref as object,
    target,
    (fresh) => fresh.doc(absPath) as unknown as object,
  );
  if (conv) {
    return buildSandboxShell(
      tagged as { id: string; path: string },
      target,
      conv,
    ) as DocumentReference<T>;
  }
  return tagged as DocumentReference<T>;
}
