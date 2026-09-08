/**
 * SharedWorker protocol — Auth wire types, serialized user shapes, and auth
 * subscription message descriptors.
 */

// ─── Serialized auth user (crosses the port) ──────────────────────────────

/**
 * Wire representation of a signed-in `User`. The real `pyric/auth` `User`
 * carries methods (`getIdToken`, `getIdTokenResult`) that don't survive
 * structured clone, so the worker flattens the fields the client mirror
 * needs into a plain object. Token accessors on the client re-RPC to the
 * worker (the worker holds the one real user).
 *
 * `null` means "signed out" — there is no current user.
 */
export interface SerializedUser {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly phoneNumber: string | null;
  readonly isAnonymous: boolean;
  readonly providerId: string | null;
  readonly tenantId?: string | null;
  readonly providerData: ReadonlyArray<{
    readonly displayName: string | null;
    readonly email: string | null;
    readonly phoneNumber: string | null;
    readonly photoURL: string | null;
    readonly providerId: string;
    readonly uid: string;
  }>;
}

/**
 * A provider identity resolved IN-PAGE (by the `ServeAuthHelper`'s
 * popup/redirect picker) and handed to the worker for sign-in. Provider flows
 * (`signInWithPopup`/`signInWithRedirect`) can't cross the worker port — the
 * `AuthFlowResolver` lives in-page — so the page resolves the picked identity
 * and bridges it here; the worker seeds it + `restoreSession`s it (no password
 * — provider users never sign in with one). See `auth.acceptIdentity`.
 */
export interface ResolvedIdentity {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  /**
   * The provider profile photo this identity carries, or `null` when it
   * carries none. Named for the serialized-user convention of this protocol
   * (`photoURL`); the host maps it onto the seed record's `photoUrl` at the
   * `seedUsers` boundary, exactly as `displayName` is mapped there.
   */
  readonly photoURL: string | null;
  readonly customClaims: Record<string, unknown>;
  readonly providerId: string;
}

/** Wire form of a `UserCredential` returned by the sign-in/create ops. */
export interface SerializedUserCredential {
  readonly user: SerializedUser;
  readonly providerId: string | null;
  readonly operationType: 'signIn' | 'reauthenticate' | 'link';
}

/** Wire form of `getIdTokenResult()`. */
export interface SerializedIdTokenResult {
  readonly token: string;
  readonly claims: Record<string, unknown>;
  readonly expirationTime: string;
  readonly issuedAtTime: string;
  readonly authTime: string;
  readonly signInProvider: string | null;
}

/**
 * Flatten a live `pyric/auth` `User` (or `null`) into its wire form.
 * Methods are dropped; only the structured fields cross the port.
 */
export function serializeUser(
  user: {
    uid: string;
    email: string | null;
    emailVerified?: boolean;
    displayName: string | null;
    photoURL?: string | null;
    phoneNumber?: string | null;
    isAnonymous: boolean;
    providerId?: string;
    tenantId?: string | null;
    providerData?: ReadonlyArray<{
      displayName: string | null;
      email: string | null;
      phoneNumber: string | null;
      photoURL: string | null;
      providerId: string;
      uid: string;
    }>;
  } | null,
): SerializedUser | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified ?? false,
    displayName: user.displayName,
    photoURL: user.photoURL ?? null,
    phoneNumber: user.phoneNumber ?? null,
    isAnonymous: user.isAnonymous,
    providerId: user.providerId ?? null,
    tenantId: user.tenantId ?? null,
    providerData: (user.providerData ?? []).map((p) => ({
      displayName: p.displayName,
      email: p.email,
      phoneNumber: p.phoneNumber,
      photoURL: p.photoURL,
      providerId: p.providerId,
      uid: p.uid,
    })),
  };
}

/**
 * Persistence mode for the worker's shared auth session.
 * Mirrors `pyric/auth`'s `Persistence.type`. `'NONE'` (inMemoryPersistence)
 * disables the IndexedDB session record so a full close does NOT keep the
 * user signed in; `'LOCAL'` and `'SESSION'` both persist the session in
 * this single-backend model (see SESSION/LOCAL collapse note in host.ts).
 */
export type AuthPersistenceMode = 'LOCAL' | 'SESSION' | 'NONE';

/**
 * Register an AUTH listener (cross-tab auth — the headline of Phase 2).
 *
 * `target: 'authState'` mirrors `onAuthStateChanged`; `target: 'idToken'`
 * mirrors `onIdTokenChanged`. The worker registers ONE real sandbox auth
 * listener and fans out the new current user to EVERY subscribed port —
 * so a sign-in on any tab updates every tab live. The `snap.value` is a
 * `SerializedUser | null` (signed-out → null).
 */
export interface AuthSubMessage {
  t: 'sub';
  subId: string;
  target: 'authState' | 'idToken';
}

/** Type guard: is this an auth subscription (vs a Firestore / event one)? */
export function isAuthSub(msg: { target: unknown }): msg is AuthSubMessage {
  return msg.target === 'authState' || msg.target === 'idToken';
}
