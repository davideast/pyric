import type { ListenerOwner } from '@pyric/ui/listener-owner';
import {
  doc,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type QueryDocumentSnapshot,
  type SnapshotOptions,
  type WithFieldValue,
} from 'firebase/firestore';
import { ServiceError } from '../firebase/types';

export const requireUid = (uid: string | null | undefined): string => {
  if (!uid) throw new ServiceError('unauthenticated', 'Sign in is required');
  return uid;
};

export const mapFirestoreError = (error: unknown): ServiceError => {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  if (code.includes('permission-denied')) return new ServiceError('forbidden', 'The operation is not allowed', error);
  if (code.includes('not-found')) return new ServiceError('not-found', 'The requested record was not found', error);
  if (code.includes('resource-exhausted')) return new ServiceError('quota-exceeded', 'The service quota was exceeded', error);
  if (code.includes('invalid-argument')) return new ServiceError('invalid-input', 'The request is invalid', error);
  return new ServiceError('network', 'The Firebase operation failed', error);
};

export const converter = <T extends DocumentData>() => ({
  toFirestore(value: WithFieldValue<T>): DocumentData {
    return value;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot, options: SnapshotOptions): T {
    return snapshot.data(options) as T;
  },
});

export const typedDoc = <T extends DocumentData>(firestore: Firestore, path: string): DocumentReference<T> =>
  doc(firestore, path).withConverter(converter<T>());

export const clampPageSize = (value: number | undefined, fallback = 50): number =>
  Math.min(Math.max(Math.trunc(value ?? fallback), 1), 100);

/**
 * Who owns a listener: either a region name the caller gives it, or the
 * React component `useListenerOwner` identified. Under the local sandbox the
 * SDK records this as the listener's owner, which is how the runtime chip and
 * Studio group listeners by the UI they feed. The production SDK reads only
 * its own keys from the listen options and ignores the owner.
 *
 * `ListenerOwner` is a type-only import. `@pyric/ui` is a development
 * dependency and none of it reaches the production build.
 */
export type ListenerOptions = { owner?: string | ListenerOwner };

/** The listen options object to hand the SDK, typed as whatever the SDK expects so the extra key passes. */
export function listenOptions<T extends object>(options: ListenerOptions | undefined): T {
  return (options?.owner === undefined ? {} : { owner: options.owner }) as T;
}
