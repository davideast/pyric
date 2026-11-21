/**
 * Public TypeScript contracts for `pyric/storage` mirroring `@firebase/storage`
 * and `@firebase/util`.
 */
import type { StorageError } from './errors.js';
import type { FullMetadata } from './metadata.js';
import type { StorageReference } from './reference.js';

type FirebaseSignInProvider =
  | 'custom'
  | 'email'
  | 'password'
  | 'phone'
  | 'anonymous'
  | 'google.com'
  | 'facebook.com'
  | 'github.com'
  | 'twitter.com'
  | 'microsoft.com'
  | 'apple.com';

interface FirebaseIdToken {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  user_id: string;
  auth_time: number;
  provider_id?: 'anonymous';
  email?: string;
  email_verified?: boolean;
  phone_number?: string;
  name?: string;
  picture?: string;
  firebase: {
    sign_in_provider: FirebaseSignInProvider;
    identities?: {
      [provider in FirebaseSignInProvider]?: string[];
    };
  };
  [claim: string]: unknown;
  uid?: never;
}

/**
 * Mock Auth token claims accepted by `connectStorageEmulator`, mirroring
 * `@firebase/util`'s `EmulatorMockTokenOptions`.
 */
export type EmulatorMockTokenOptions = (
  | { user_id: string }
  | { sub: string }
) &
  Partial<FirebaseIdToken>;

/**
 * Options accepted by paginated `list()`, mirroring `firebase/storage`'s
 * `ListOptions`.
 */
export interface ListOptions {
  maxResults?: number | null;
  pageToken?: string | null;
}

/**
 * Stream observer for resumable Storage tasks, mirroring `firebase/storage`'s
 * `StorageObserver<T>`.
 */
export interface StorageObserver<T> {
  next?: ((value: T) => void) | null;
  error?: (error: StorageError) => void | null;
  complete?: (() => void) | null;
}

export type TaskEvent = 'state_changed';
export type TaskState = 'running' | 'paused' | 'success' | 'canceled' | 'error';

export interface UploadTaskSnapshot {
  readonly bytesTransferred: number;
  readonly totalBytes: number;
  readonly state: TaskState;
  readonly metadata: FullMetadata;
  readonly ref: StorageReference;
  readonly task: UploadTask;
}

export interface UploadTask extends Promise<UploadTaskSnapshot> {
  readonly snapshot: UploadTaskSnapshot;
  cancel(): boolean;
  pause(): boolean;
  resume(): boolean;
  on(
    event: TaskEvent | string,
    nextOrObserver?:
      | null
      | ((snapshot: UploadTaskSnapshot) => unknown)
      | StorageObserver<UploadTaskSnapshot>
      | {
          next?: ((snapshot: UploadTaskSnapshot) => unknown) | null;
          error?: ((error: Error | StorageError) => unknown) | null;
          complete?: (() => unknown) | null;
        },
    error?:
      | null
      | ((error: StorageError) => unknown)
      | ((error: Error | StorageError) => unknown),
    complete?: null | (() => unknown),
  ): () => void;
}
