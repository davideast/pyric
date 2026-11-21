/**
 * Public core TypeScript declarations for `pyric/auth`, mirroring
 * `@firebase/auth` (`1.13.6`) and `@firebase/util` (`1.15.3`) exactly.
 */
import type { FirebaseError } from '../sandbox/internal/firebase-error.js';
import type { AuthErrorMap } from './config-tokens.js';
import type { Persistence } from './types.js';

/** Callback invoked when an observer stream completes (`@firebase/util`). */
export type CompleteFn = () => void;

/** Callback invoked when an observer stream errors (`@firebase/util`). */
export type ErrorFn = (error: Error) => void;

/** Callback invoked for each value emitted to an observer (`@firebase/util`). */
export type NextFn<T> = (value: T) => void;

interface Observer<T> {
  next: NextFn<T>;
  error: ErrorFn;
  complete: CompleteFn;
}

/**
 * Event callback or observer object accepted by `onAuthStateChanged` and
 * `onIdTokenChanged` (`@firebase/auth`).
 */
export type NextOrObserver<T> = NextFn<T | null> | Observer<T | null>;

/** Interface for an `Auth` error (`@firebase/auth`). */
export interface AuthError extends FirebaseError {
  readonly customData: {
    readonly appName: string;
    readonly email?: string;
    readonly phoneNumber?: string;
    readonly tenantId?: string;
  };
}

/** Interface representing an `Auth` instance's settings (`@firebase/auth`). */
export interface AuthSettings {
  appVerificationDisabledForTesting: boolean;
}

/** Interface representing the `Auth` config (`@firebase/auth`). */
export interface Config {
  apiKey: string;
  apiHost: string;
  apiScheme: string;
  tokenApiHost: string;
  sdkClientVersion: string;
  authDomain?: string;
}

/** Map of OAuth custom parameters (`@firebase/auth`). */
export type CustomParameters = Record<string, string>;

/**
 * Resolver for DOM-specific operations such as `signInWithPopup` and
 * `signInWithRedirect` (`@firebase/auth`).
 */
export interface PopupRedirectResolver {}

/** Dependencies accepted by `initializeAuth` (`@firebase/auth`). */
export interface Dependencies {
  persistence?: Persistence | Persistence[];
  popupRedirectResolver?: PopupRedirectResolver;
  errorMap?: AuthErrorMap;
}

/** Configuration of Firebase Authentication Emulator (`@firebase/auth`). */
export interface EmulatorConfig {
  readonly protocol: string;
  readonly host: string;
  readonly port: number | null;
  readonly options: {
    readonly disableWarnings: boolean;
  };
}

/** Options for initializing an `OAuthCredential` (`@firebase/auth`). */
export interface OAuthCredentialOptions {
  idToken?: string;
  accessToken?: string;
  rawNonce?: string;
}

/** Interface representing a parsed ID token (`@firebase/auth`). */
export interface ParsedToken {
  exp?: string;
  sub?: string;
  auth_time?: string;
  iat?: string;
  firebase?: {
    sign_in_provider?: string;
    sign_in_second_factor?: string;
    identities?: Record<string, string>;
  };
  [key: string]: unknown;
}

/** Interface for a supplied React Native `AsyncStorage` (`@firebase/auth`). */
export interface ReactNativeAsyncStorage {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
}

/** Interface representing a user's creation and sign-in metadata (`@firebase/auth`). */
export interface UserMetadata {
  readonly creationTime?: string;
  readonly lastSignInTime?: string;
}

/** User profile map carried on `AdditionalUserInfo` (`@firebase/auth`). */
export type UserProfile = Record<string, unknown>;
