/**
 * `pyric/firestore` — document writes.
 *
 * `setDoc` / `updateDoc` / `deleteDoc` / `addDoc` and the modular
 * `SetOptions` shape. Operations route through the sandbox's chainable
 * adapter, running any converter on `setDoc` / `addDoc`.
 */
import { runSdkWrite } from '../sandbox/internal/sdk-write-activity.js';
import { beginFirestoreActivity } from './sdk-activity.js';
import type {
  DocumentData,
  SetOptions as ChainSetOptions,
} from 'pyric/sandbox/admin-firestore';
import { parseChainUpdate } from './chain-update.js';
import type { FieldPath } from './field-values.js';
import { requireDocumentData } from './internal/document-data.js';
import { generateAutoId } from './sandbox/auto-id.js';
import type { OfflineMutation } from './sandbox/client-offline-overlay.js';
import {
  assertSupportedWriteData,
  normalizeMergeFields,
  parseUpdateArguments,
  updateFieldsData,
} from './sandbox/update-fields.js';

import {
  targetOf,
  converterOf,
  chainDocFor,
  chainCollFor,
  tagSandboxRef,
} from './state.js';
import { registerDocumentReferenceValue } from './converter-method.js';
import type {
  DocumentReference,
  CollectionReference,
  FirestoreDataConverter,
  PartialWithFieldValue,
  UpdateData,
  WithFieldValue,
} from './types.js';
import { withFirestoreFirebaseError } from './errors.js';
import { clientStateFor } from './client-state.js';
import { markUserWriteValue } from './sandbox/unescaped-map.js';

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
 * When both `merge` and `mergeFields` are supplied on the same options
 * object, `merge: true` takes precedence over `mergeFields`, whereas
 * `{ merge: false, mergeFields }` applies `mergeFields` (matching
 * `firebase/firestore` `parseSetData` order).
 */
export interface SetOptions {
  merge?: boolean;
  mergeFields?: readonly (string | FieldPath)[];
}

function applySetConverter<T>(
  converter: FirestoreDataConverter<T> | null | undefined,
  data: PartialWithFieldValue<T> | WithFieldValue<T>,
  options?: SetOptions,
): unknown {
  if (converter === undefined || converter === null) {
    return data;
  }
  const usesMergeConverter =
    options !== undefined && (Boolean(options.merge) || options.mergeFields !== undefined);
  if (usesMergeConverter) {
    return converter.toFirestore(data, options);
  }
  return converter.toFirestore(data as WithFieldValue<T>);
}

export function setDoc<T = DocumentData>(
  ref: DocumentReference<T>,
  data: WithFieldValue<T>,
): Promise<void>;
export function setDoc<T = DocumentData>(
  ref: DocumentReference<T>,
  data: PartialWithFieldValue<T>,
  options: SetOptions,
): Promise<void>;
export function setDoc<T = DocumentData>(
  ref: DocumentReference<T>,
  data: WithFieldValue<T>,
  options?: SetOptions,
): Promise<void>;
export async function setDoc<T = DocumentData>(
  ref: DocumentReference<T>,
  data: PartialWithFieldValue<T> | WithFieldValue<T>,
  options?: SetOptions,
): Promise<void> {
  const target = targetOf(ref);
  return runSdkWrite(beginFirestoreActivity(target, ref, 'setDoc', 'operation'), async () => {
    const conv = converterOf(ref) as FirestoreDataConverter<T> | null | undefined;
    const rawPayload = applySetConverter(conv, data, options);
    const checkedPayload = requireDocumentData(rawPayload);
    assertSupportedWriteData('setDoc', ref.path, checkedPayload, { allowInt64: target.adminBypass === true });
    const payload = markUserWriteValue(checkedPayload) as DocumentData;
    let mergeFields: string[] | undefined;
    if (options?.mergeFields !== undefined && options.merge !== true) {
      mergeFields = normalizeMergeFields(options.mergeFields);
    }
    const mutation: OfflineMutation = {
      kind: 'set',
      path: ref.path,
      data: payload,
      merge: options?.merge === true,
      mergeFields,
    };
    const client = clientStateFor(target);
    client.syncMissingDatabaseOfflineState(target, ref.path);
    return client.runWrite(
      () => withFirestoreFirebaseError(() =>
        chainDocFor(target, ref).set(payload, options as ChainSetOptions | undefined),
      ),
      ref.path,
      [mutation],
    );
  });
}

/**
 * `updateDoc` does NOT run the converter. Matches `firebase/firestore`'s
 * Web SDK shape — partial updates can target any subset of fields, so
 * a translator built around a full `AppModelType` would be a type-shape
 * mismatch. Use the underlying `DocumentData` view (`withConverter(ref,
 * null)`) for typed-and-untyped mixed access if you need both styles
 * against the same path.
 *
 * Takes the data-object form or the field-and-value form
 * (`updateDoc(ref, field, value, ...moreFieldsAndValues)`), where each
 * field is a dot-separated string or a `FieldPath` whose segments are
 * literal field names.
 */
export function updateDoc(ref: DocumentReference<unknown>, data: UpdateData<DocumentData>): Promise<void>;
export function updateDoc(
  ref: DocumentReference<unknown>,
  field: string | FieldPath,
  value: unknown,
  ...moreFieldsAndValues: unknown[]
): Promise<void>;
export function updateDoc(
  ref: DocumentReference<unknown>,
  dataOrField: UpdateData<DocumentData> | string | FieldPath,
  ...valueAndMoreFieldsAndValues: unknown[]
): Promise<void> {
  const target = targetOf(ref);
  const validation = { allowInt64: target.adminBypass === true };
  const parsedFields = parseUpdateArguments('updateDoc', ref.path, dataOrField, valueAndMoreFieldsAndValues, validation);
  const args = parseChainUpdate('updateDoc', ref.path, dataOrField, valueAndMoreFieldsAndValues, validation);
  const offlineData = updateFieldsData(
    parsedFields.map((field) => ({ path: field.path, value: markUserWriteValue(field.value) })),
  );
  return runSdkWrite(beginFirestoreActivity(target, ref, 'updateDoc', 'operation'), async () => {
    const client = clientStateFor(target);
    client.syncMissingDatabaseOfflineState(target, ref.path);
    return client.runWrite(
      () => withFirestoreFirebaseError(() => chainDocFor(target, ref).update(...args)),
      ref.path,
      [{ kind: 'update', path: ref.path, data: offlineData }],
    );
  });
}

export async function deleteDoc(ref: DocumentReference): Promise<void> {
  const target = targetOf(ref);
  return runSdkWrite(beginFirestoreActivity(target, ref, 'deleteDoc', 'operation'), async () => {
    const client = clientStateFor(target);
    client.syncMissingDatabaseOfflineState(target, ref.path);
    return client.runWrite(
      () => withFirestoreFirebaseError(() => chainDocFor(target, ref).delete()),
      ref.path,
      [{ kind: 'delete', path: ref.path }],
    );
  });
}

export async function addDoc<T = DocumentData>(
  coll: CollectionReference<T>,
  data: WithFieldValue<T>,
): Promise<DocumentReference<T>> {
  const target = targetOf(coll);
  return runSdkWrite(beginFirestoreActivity(target, coll, 'addDoc', 'operation'), async () => {
    const conv = converterOf(coll);
    let rawPayload: unknown = data;
    if (conv !== undefined && conv !== null) {
      rawPayload = (conv as FirestoreDataConverter<T>).toFirestore(data);
    }
    const checkedPayload = requireDocumentData(rawPayload);
    assertSupportedWriteData('addDoc', coll.path, checkedPayload, { allowInt64: target.adminBypass === true });
    const payload = markUserWriteValue(checkedPayload) as DocumentData;
    const clientState = clientStateFor(target);
    clientState.syncMissingDatabaseOfflineState(target, coll.path);
    let ref: { id: string; path: string };
    if (!clientState.isNetworkEnabled()) {
      const mintedId = generateAutoId();
      const mintedPath = `${coll.path}/${mintedId}`;
      ref = await clientState.runWrite(
        async () => {
          await withFirestoreFirebaseError(() => chainCollFor(target, coll).doc(mintedId).create(payload));
          return { id: mintedId, path: mintedPath };
        },
        mintedPath,
        [{ kind: 'set', path: mintedPath, data: payload }],
      );
    } else {
      const created = await clientState.runWrite(async () => {
        const docRef = await withFirestoreFirebaseError(() => chainCollFor(target, coll).add(payload));
        clientState.cachePath(docRef.path);
        return docRef;
      });
      ref = created as unknown as { id: string; path: string };
    }
    const createdRef = ref as unknown as { id: string; path: string };
    const absPath = createdRef.path;
    const tagged = tagSandboxRef(
      createdRef,
      target,
      (fresh) => fresh.doc(absPath) as unknown as { id: string; path: string },
    );
    const resolvedConverter = conv ?? null;
    return registerDocumentReferenceValue<T>(tagged, absPath, target, resolvedConverter);
  });
}

import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import type { Firestore } from './types.js';

export function ensureFirestoreConfigured(db: Firestore): object {
  const target = targetOf(db);
  const clientState = clientStateFor(target);
  clientState.markStarted();
  return clientState;
}

export function executeWrite(
  db: Firestore,
  mutations: readonly unknown[],
): Promise<void> {
  const target = targetOf(db);
  const clientState = clientStateFor(target);
  clientState.markStarted();
  if (!Array.isArray(mutations)) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected second argument to executeWrite() to be an array of mutations.',
    );
  }
  if (mutations.length === 0) {
    return clientState.runWrite(async () => undefined);
  }
  return Promise.reject(
    new FirebaseError(
      'invalid-argument',
      'Unsupported internal mutation entry passed to executeWrite().',
    ),
  );
}

