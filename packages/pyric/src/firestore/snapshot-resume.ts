/**
 * `pyric/firestore` -- SSR snapshot listener resumption (`onSnapshotResume`)
 * and initial `fromCache: true` delivery wrapping matching `firebase/firestore@12.19.0`.
 */
import type { DocumentData } from 'pyric/sandbox/admin-firestore';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { loadBundle, namedQuery } from './bundles.js';
import { clientStateFor } from './client-state.js';
import { listenAs, type SnapshotListenOptions, type SnapshotObserver } from './listeners.js';
import { doc } from './refs.js';
import type { SerializedSnapshotEnvelope } from './sandbox/ssr-bundle-encoder.js';
import { createSnapshotMetadata } from './snapshot-metadata.js';
import { targetOf } from './state.js';
import {
  Firestore,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore as FirestoreHandle,
  type FirestoreDataConverter,
  type FirestoreError,
  type QuerySnapshot,
  type Unsubscribe,
} from './types.js';

export function validateResumeSnapshotEnvelope(snapshotJson: unknown): SerializedSnapshotEnvelope {
  if (snapshotJson === null || typeof snapshotJson !== 'object') {
    throw new TypeError("Cannot use 'in' operator to search for 'bundle' in snapshotJson");
  }
  const rec = snapshotJson as Record<string, unknown>;
  const requiredKeys = ['bundle', 'bundleName', 'bundleSource'] as const;
  for (const key of requiredKeys) {
    if (!(key in rec)) {
      throw new FirebaseError('invalid-argument', `snapshotJson missing required field: ${key}`);
    }
    const value = rec[key];
    if (typeof value !== 'string') {
      throw new FirebaseError('invalid-argument', `snapshotJson field '${key}' must be a string.`);
    }
    if (value.length === 0) {
      throw new FirebaseError('invalid-argument', `snapshotJson field '${key}' cannot be an empty string.`);
    }
  }
  const source = rec.bundleSource as string;
  if (source !== 'DocumentSnapshot' && source !== 'QuerySnapshot') {
    throw new FirebaseError('invalid-argument', `unsupported bundle source: ${source}`);
  }
  let typeTag: SerializedSnapshotEnvelope['type'] = 'firestore/querySnapshot/1.0';
  if (source === 'DocumentSnapshot') {
    typeTag = 'firestore/documentSnapshot/1.0';
  }
  return {
    type: typeTag,
    bundle: rec.bundle as string,
    bundleName: rec.bundleName as string,
    bundleSource: source,
  };
}

function isPartialObserverArg(val: unknown): val is SnapshotObserver<unknown> {
  if (val === null || typeof val !== 'object') return false;
  const r = val as Record<string, unknown>;
  return typeof r.next === 'function' || typeof r.error === 'function' || typeof r.complete === 'function';
}

function parseResumeArguments(args: readonly unknown[]): {
  readonly wrapped: unknown[];
  readonly onError?: (err: unknown) => void;
  readonly converter?: FirestoreDataConverter<unknown, DocumentData>;
} {
  let curArg = 0;
  let options: SnapshotListenOptions | undefined;
  if (args[curArg] !== null && typeof args[curArg] === 'object' && !isPartialObserverArg(args[curArg])) {
    options = args[curArg] as SnapshotListenOptions;
    curArg += 1;
  }
  let rawObserver: SnapshotObserver<unknown>;
  if (args[curArg] !== null && typeof args[curArg] === 'object' && isPartialObserverArg(args[curArg])) {
    const userObs = args[curArg] as SnapshotObserver<unknown>;
    curArg += 1;
    let nextFn: ((snap: unknown) => void) | undefined;
    if (typeof userObs.next === 'function') nextFn = userObs.next.bind(userObs);
    let errorFn: ((err: unknown) => void) | undefined;
    if (typeof userObs.error === 'function') errorFn = userObs.error.bind(userObs);
    let completeFn: (() => void) | undefined;
    if (typeof userObs.complete === 'function') completeFn = userObs.complete.bind(userObs);
    rawObserver = { next: nextFn, error: errorFn, complete: completeFn };
  } else {
    const nextCandidate = args[curArg];
    curArg += 1;
    const errorCandidate = args[curArg];
    curArg += 1;
    const completeCandidate = args[curArg];
    curArg += 1;
    let nextFn: ((snap: unknown) => void) | undefined;
    if (typeof nextCandidate === 'function') nextFn = nextCandidate as (snap: unknown) => void;
    let errorFn: ((err: unknown) => void) | undefined;
    if (typeof errorCandidate === 'function') errorFn = errorCandidate as (err: unknown) => void;
    let completeFn: (() => void) | undefined;
    if (typeof completeCandidate === 'function') completeFn = completeCandidate as () => void;
    rawObserver = { next: nextFn, error: errorFn, complete: completeFn };
  }
  const converterCandidate = args[curArg];
  let converter: FirestoreDataConverter<unknown, DocumentData> | undefined;
  if (converterCandidate !== null && typeof converterCandidate === 'object') {
    converter = converterCandidate as FirestoreDataConverter<unknown, DocumentData>;
  }
  let firstDelivery = true;
  const stampInitial = <S>(snap: S): S => {
    if (firstDelivery && snap !== null && typeof snap === 'object') {
      firstDelivery = false;
      const hasPending = Boolean((snap as { metadata?: { hasPendingWrites?: unknown } }).metadata?.hasPendingWrites);
      Object.defineProperty(snap, 'metadata', {
        value: createSnapshotMetadata(true, hasPending),
        configurable: true,
      });
    }
    return snap;
  };
  let wrappedNext: ((snap: unknown) => void) | undefined;
  if (rawObserver.next !== undefined) {
    const innerNext = rawObserver.next;
    wrappedNext = (snap: unknown) => {
      innerNext(stampInitial(snap));
    };
  }
  const wrappedObserver: SnapshotObserver<unknown> = {
    next: wrappedNext,
    error: rawObserver.error,
    complete: rawObserver.complete,
  };
  let wrapped: unknown[] = [wrappedObserver];
  if (options !== undefined) {
    wrapped = [options, wrappedObserver];
  }
  return { wrapped, onError: rawObserver.error, converter };
}

export function wrapInitialCachedSnapshotArgs(args: readonly unknown[]): {
  wrapped: unknown[];
  onError?: (err: unknown) => void;
} {
  const parsed = parseResumeArguments(args);
  return { wrapped: [...parsed.wrapped], onError: parsed.onError };
}

export function onSnapshotResume<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  db: FirestoreHandle,
  snapshotJson: object,
  onNext: (snapshot: QuerySnapshot<AppModelType> | DocumentSnapshot<AppModelType>) => void,
  onError?: (error: FirestoreError) => void,
  onCompletion?: () => void,
  converter?: FirestoreDataConverter<AppModelType, DbModelType>,
): Unsubscribe;
export function onSnapshotResume<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  db: FirestoreHandle,
  snapshotJson: object,
  options: SnapshotListenOptions,
  onNext: (snapshot: QuerySnapshot<AppModelType> | DocumentSnapshot<AppModelType>) => void,
  onError?: (error: FirestoreError) => void,
  onCompletion?: () => void,
  converter?: FirestoreDataConverter<AppModelType, DbModelType>,
): Unsubscribe;
export function onSnapshotResume<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  db: FirestoreHandle,
  snapshotJson: object,
  observer: SnapshotObserver<any>,
  converter?: FirestoreDataConverter<AppModelType, DbModelType>,
): Unsubscribe;
export function onSnapshotResume<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  db: FirestoreHandle,
  snapshotJson: object,
  options: SnapshotListenOptions,
  observer: SnapshotObserver<any>,
  converter?: FirestoreDataConverter<AppModelType, DbModelType>,
): Unsubscribe;
export function onSnapshotResume(db: FirestoreHandle, snapshotJson: object, ...args: unknown[]): Unsubscribe {
  if (!(db instanceof Firestore)) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected first argument to onSnapshotResume() to be a Firestore instance.',
    );
  }
  const target = targetOf(db);
  clientStateFor(target).markStarted();
  const env = validateResumeSnapshotEnvelope(snapshotJson);
  const { wrapped, onError, converter } = parseResumeArguments(args);
  let cancelled = false;
  let innerUnsub: Unsubscribe | undefined;
  void (async () => {
    try {
      await loadBundle(db, env.bundle);
      if (cancelled) return;
      if (env.bundleSource === 'DocumentSnapshot') {
        let docRef: DocumentReference<unknown> = doc(db, env.bundleName);
        if (converter !== undefined) {
          docRef = docRef.withConverter(converter);
        }
        innerUnsub = (listenAs as (...a: unknown[]) => Unsubscribe)('onSnapshotResume', docRef, ...wrapped);
        return;
      }
      const hydratedQuery = await namedQuery(db, env.bundleName);
      if (cancelled) return;
      if (hydratedQuery === null) {
        throw new FirebaseError('invalid-argument', `Named query '${env.bundleName}' not found in snapshot bundle.`);
      }
      // Matches @firebase/firestore@4.17.2 onSnapshotQuerySnapshotBundle, which invokes
      // hydratedQuery.withConverter(converter) without reassigning the query reference.
      if (converter !== undefined) {
        hydratedQuery.withConverter(converter);
      }
      innerUnsub = (listenAs as (...a: unknown[]) => Unsubscribe)('onSnapshotResume', hydratedQuery, ...wrapped);
    } catch (err) {
      if (!cancelled && onError !== undefined) onError(err);
    }
  })();
  return () => {
    if (cancelled) return;
    cancelled = true;
    innerUnsub?.();
  };
}
