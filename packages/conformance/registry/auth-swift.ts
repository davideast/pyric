import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const CONFORMANCE_SUITE = 'packages/swift-client/Tests/PyricAuthTests/AuthConformanceTests.swift';
const UNOBSERVED_REASON =
  'Behavior stated from FirebaseAuth Swift specification; test has not passed yet.';

const buildRow = defineRows({
  surface: 'auth-swift',
});

interface SwiftAuthRowSeed {
  ref: number;
  section: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  flipped?: 'unit-backed';
}

function row(seed: SwiftAuthRowSeed): CompatibilityRow {
  const { ref, flipped, evidence, ...rest } = seed;
  const defaultEvidence = flipped
    ? 'FirebaseAuth Swift specification.'
    : 'FirebaseAuth Swift specification; unverified locally.';
  const resolvedEvidence = evidence ?? defaultEvidence;
  const climb = flipped
    ? {
        status: 'conforms' as const,
        automation: 'unit-backed' as const,
        evidence: `${resolvedEvidence} Swift test: \`${CONFORMANCE_SUITE}\` assertion set \`auth-swift#${ref}\`.`,
        conformanceTests: [CONFORMANCE_SUITE],
      }
    : {
        status: 'unverified' as const,
        automation: 'unverified' as const,
        risk: ['unobserved'],
        riskScore: 2,
        riskReasons: [UNOBSERVED_REASON],
        evidence: resolvedEvidence,
      };
  return buildRow({
    ...rest,
    rowRef: String(ref),
    ...climb,
  });
}

export const authSwiftRows: CompatibilityRow[] = [
  // ── 1. Auth: Instance & Lifecycle ─────────────────────────────────────────
  row({ ref: 1, flipped: 'unit-backed', section: '`Auth` — instance & lifecycle',
    api: 'Auth.auth()', behavior: 'Returns the default Auth instance configured with the default FirebaseApp.', featureKeys: ['auth'] }),
  row({ ref: 2, flipped: 'unit-backed', section: '`Auth` — instance & lifecycle',
    api: 'Auth.auth(app:)', behavior: 'Returns an Auth instance associated with the specified FirebaseApp.', featureKeys: ['authApp'] }),
  row({ ref: 3, flipped: 'unit-backed', section: '`Auth` — instance & lifecycle',
    api: 'Auth.reset()', behavior: 'Resets cached Auth instances across all FirebaseApp instances.', featureKeys: ['reset'] }),
  row({ ref: 4, flipped: 'unit-backed', section: '`Auth` — instance & lifecycle',
    api: 'Auth.app', behavior: 'Returns the FirebaseApp instance associated with this Auth instance.', featureKeys: ['app'] }),
  row({ ref: 5, flipped: 'unit-backed', section: '`Auth` — instance & lifecycle',
    api: 'Auth.useEmulator(withHost:port:)', behavior: 'Configures the Auth client to connect to local Pyric emulator WebSocket endpoint.', featureKeys: ['useEmulator'] }),

  // ── 2. Auth: Authentication Operations ────────────────────────────────────
  row({ ref: 6, flipped: 'unit-backed', section: '`Auth` — authentication operations',
    api: 'Auth.signIn(withEmail:password:)', behavior: 'Authenticates a user with email and password asynchronously, returning AuthDataResult.', featureKeys: ['signInWithEmailAndPassword'] }),
  row({ ref: 7, flipped: 'unit-backed', section: '`Auth` — authentication operations',
    api: 'Auth.signIn(withEmail:password:completion:)', behavior: 'Authenticates a user with email and password using a completion closure.', featureKeys: ['signInWithEmailAndPassword'] }),
  row({ ref: 8, flipped: 'unit-backed', section: '`Auth` — authentication operations',
    api: 'Auth.createUser(withEmail:password:)', behavior: 'Creates a new user account with email and password asynchronously, returning AuthDataResult.', featureKeys: ['createUserWithEmailAndPassword'] }),
  row({ ref: 9, flipped: 'unit-backed', section: '`Auth` — authentication operations',
    api: 'Auth.createUser(withEmail:password:completion:)', behavior: 'Creates a new user account with email and password using a completion closure.', featureKeys: ['createUserWithEmailAndPassword'] }),
  row({ ref: 10, flipped: 'unit-backed', section: '`Auth` — authentication operations',
    api: 'Auth.signInAnonymously()', behavior: 'Signs in as an anonymous user asynchronously, returning AuthDataResult.', featureKeys: ['signInAnonymously'] }),
  row({ ref: 11, flipped: 'unit-backed', section: '`Auth` — authentication operations',
    api: 'Auth.signInAnonymously(completion:)', behavior: 'Signs in as an anonymous user using a completion closure.', featureKeys: ['signInAnonymously'] }),
  row({ ref: 12, flipped: 'unit-backed', section: '`Auth` — authentication operations',
    api: 'Auth.signOut()', behavior: 'Signs out the current user, clears currentUser, and notifies all state listeners.', featureKeys: ['signOut'] }),
  row({ ref: 13, flipped: 'unit-backed', section: '`Auth` — authentication operations',
    api: 'Auth.restoreSession(uid:)', behavior: 'Restores an authenticated session for the given UID via the Pyric bridge.', featureKeys: ['restoreSession'] }),

  // ── 3. Auth: State Listeners & Reactive Streams ───────────────────────────
  row({ ref: 14, flipped: 'unit-backed', section: '`Auth` — state listeners & reactive streams',
    api: 'Auth.currentUser', behavior: 'Returns the currently authenticated User, or nil if no user is signed in.', featureKeys: ['currentUser'] }),
  row({ ref: 15, flipped: 'unit-backed', section: '`Auth` — state listeners & reactive streams',
    api: 'Auth.addStateDidChangeListener(_:)', behavior: 'Attaches an auth state change listener callback that fires immediately and on state transitions.', featureKeys: ['onAuthStateChanged'] }),
  row({ ref: 16, flipped: 'unit-backed', section: '`Auth` — state listeners & reactive streams',
    api: 'Auth.removeStateDidChangeListener(_:)', behavior: 'Detaches an auth state change listener using its registration handle.', featureKeys: ['onAuthStateChanged'] }),
  row({ ref: 17, flipped: 'unit-backed', section: '`Auth` — state listeners & reactive streams',
    api: 'Auth.addIDTokenDidChangeListener(_:)', behavior: 'Attaches an ID token listener callback that fires immediately and on token refreshes or user transitions.', featureKeys: ['onIdTokenChanged'] }),
  row({ ref: 18, flipped: 'unit-backed', section: '`Auth` — state listeners & reactive streams',
    api: 'Auth.removeIDTokenDidChangeListener(_:)', behavior: 'Detaches an ID token change listener using its registration handle.', featureKeys: ['onIdTokenChanged'] }),
  row({ ref: 19, flipped: 'unit-backed', section: '`Auth` — state listeners & reactive streams',
    api: 'Auth.authStateDidChangeStream', behavior: 'Provides an AsyncStream of User? updates emitted on authentication state changes.', featureKeys: ['authStateStream'] }),
  row({ ref: 20, flipped: 'unit-backed', section: '`Auth` — state listeners & reactive streams',
    api: 'Auth.idTokenDidChangeStream', behavior: 'Provides an AsyncStream of User? updates emitted on ID token changes or refreshes.', featureKeys: ['idTokenStream'] }),
  row({ ref: 21, flipped: 'unit-backed', section: '`Auth` — state listeners & reactive streams',
    api: 'Auth.authStateChanges', behavior: 'Exposes an AsyncSequence for modern async/await iteration over auth state transitions.', featureKeys: ['authStateChanges'] }),
  row({ ref: 22, flipped: 'unit-backed', section: '`Auth` — state listeners & reactive streams',
    api: 'Auth.idTokenChanges', behavior: 'Exposes an AsyncSequence for modern async/await iteration over ID token transitions.', featureKeys: ['idTokenChanges'] }),
  row({ ref: 23, flipped: 'unit-backed', section: '`Auth` — state listeners & reactive streams',
    api: 'Auth.authStatePublisher', behavior: 'Exposes a Combine AnyPublisher emitting User? on auth state transitions.', featureKeys: ['authStatePublisher'] }),
  row({ ref: 24, flipped: 'unit-backed', section: '`Auth` — state listeners & reactive streams',
    api: 'Auth.idTokenPublisher', behavior: 'Exposes a Combine AnyPublisher emitting User? on ID token transitions.', featureKeys: ['idTokenPublisher'] }),

  // ── 4. User: Identity Properties ──────────────────────────────────────────
  row({ ref: 25, flipped: 'unit-backed', section: '`User` — identity properties',
    api: 'User.uid', behavior: 'Returns the unique string identifier for the user account.', featureKeys: ['uid'] }),
  row({ ref: 26, flipped: 'unit-backed', section: '`User` — identity properties',
    api: 'User.email', behavior: 'Returns the user\'s primary email address if available.', featureKeys: ['email'] }),
  row({ ref: 27, flipped: 'unit-backed', section: '`User` — identity properties',
    api: 'User.displayName', behavior: 'Returns the user\'s display name if set.', featureKeys: ['displayName'] }),
  row({ ref: 28, flipped: 'unit-backed', section: '`User` — identity properties',
    api: 'User.photoURL', behavior: 'Returns the user\'s profile photo URL if set.', featureKeys: ['photoURL'] }),
  row({ ref: 29, flipped: 'unit-backed', section: '`User` — identity properties',
    api: 'User.phoneNumber', behavior: 'Returns the user\'s phone number if available.', featureKeys: ['phoneNumber'] }),
  row({ ref: 30, flipped: 'unit-backed', section: '`User` — identity properties',
    api: 'User.isAnonymous', behavior: 'Indicates whether the user account is anonymous.', featureKeys: ['isAnonymous'] }),
  row({ ref: 31, flipped: 'unit-backed', section: '`User` — identity properties',
    api: 'User.isEmailVerified', behavior: 'Indicates whether the user\'s primary email address has been verified.', featureKeys: ['isEmailVerified'] }),
  row({ ref: 32, flipped: 'unit-backed', section: '`User` — identity properties',
    api: 'User.providerID', behavior: 'Returns the provider identifier for the user identity.', featureKeys: ['providerId'] }),
  row({ ref: 33, flipped: 'unit-backed', section: '`User` — identity properties',
    api: 'User.providerData', behavior: 'Returns an array of UserInfo objects representing linked authentication providers.', featureKeys: ['providerData'] }),
  row({ ref: 34, flipped: 'unit-backed', section: '`User` — identity properties',
    api: 'User.tenant', behavior: 'Returns the tenant identifier associated with the user in multi-tenant configurations.', featureKeys: ['tenant'] }),
  row({ ref: 35, flipped: 'unit-backed', section: '`User` — identity properties',
    api: 'User.claims', behavior: 'Returns the dictionary of custom and standard claims associated with the user\'s ID token.', featureKeys: ['claims'] }),

  // ── 5. User: Token Retrieval & Mutations ──────────────────────────────────
  row({ ref: 36, flipped: 'unit-backed', section: '`User` — token retrieval & mutations',
    api: 'User.getIDToken(forcingRefresh:)', behavior: 'Retrieves the Firebase Auth ID token string asynchronously, optionally forcing a refresh.', featureKeys: ['getIdToken'] }),
  row({ ref: 37, flipped: 'unit-backed', section: '`User` — token retrieval & mutations',
    api: 'User.getIDToken(forcingRefresh:completion:)', behavior: 'Retrieves the Firebase Auth ID token string using a completion closure.', featureKeys: ['getIdToken'] }),
  row({ ref: 38, flipped: 'unit-backed', section: '`User` — token retrieval & mutations',
    api: 'User.getIDTokenResult(forcingRefresh:)', behavior: 'Retrieves detailed AuthTokenResult with expiration and claims asynchronously.', featureKeys: ['getIdTokenResult'] }),
  row({ ref: 39, flipped: 'unit-backed', section: '`User` — token retrieval & mutations',
    api: 'User.getIDTokenResult(forcingRefresh:completion:)', behavior: 'Retrieves detailed AuthTokenResult using a completion closure.', featureKeys: ['getIdTokenResult'] }),
  row({ ref: 40, flipped: 'unit-backed', section: '`User` — token retrieval & mutations',
    api: 'User.updateProfile(displayName:photoURL:)', behavior: 'Updates the user\'s display name and photo URL asynchronously.', featureKeys: ['updateProfile'] }),
  row({ ref: 41, flipped: 'unit-backed', section: '`User` — token retrieval & mutations',
    api: 'User.reload()', behavior: 'Refreshes user account data and custom claims from the Pyric backend asynchronously.', featureKeys: ['reload'] }),

  // ── 6. Supporting Types & Metadata ────────────────────────────────────────
  row({ ref: 42, flipped: 'unit-backed', section: 'Supporting types & metadata',
    api: 'AuthDataResult.user', behavior: 'Returns the User instance associated with the authentication result.', featureKeys: ['authDataResult'] }),
  row({ ref: 43, flipped: 'unit-backed', section: 'Supporting types & metadata',
    api: 'AuthDataResult.additionalUserInfo', behavior: 'Returns AdditionalUserInfo containing provider ID and isNewUser flag.', featureKeys: ['additionalUserInfo'] }),
  row({ ref: 44, flipped: 'unit-backed', section: 'Supporting types & metadata',
    api: 'AuthTokenResult.token', behavior: 'Returns the JWT token string.', featureKeys: ['authTokenResultToken'] }),
  row({ ref: 45, flipped: 'unit-backed', section: 'Supporting types & metadata',
    api: 'AuthTokenResult.claims', behavior: 'Returns the decoded token claims dictionary.', featureKeys: ['authTokenResultClaims'] }),
  row({ ref: 46, flipped: 'unit-backed', section: 'Supporting types & metadata',
    api: 'AuthTokenResult.expirationTime', behavior: 'Returns the expiration timestamp of the ID token.', featureKeys: ['authTokenResultExpiration'] }),
  row({ ref: 47, flipped: 'unit-backed', section: 'Supporting types & metadata',
    api: 'UserInfoImpl', behavior: 'Conforms to UserInfo protocol representing user attributes from an auth provider.', featureKeys: ['userInfo'] }),

  // ── 7. Multi-Tenancy, Impersonation & Firestore Coupling ──────────────────
  row({ ref: 48, flipped: 'unit-backed', section: 'Multi-tenancy, Impersonation & Firestore Coupling',
    api: 'Auth.switchLens(_:)', behavior: 'Sets or clears an active impersonation AuthLens (.admin, .asUser, .anon).', featureKeys: ['switchLens'] }),
  row({ ref: 49, flipped: 'unit-backed', section: 'Multi-tenancy, Impersonation & Firestore Coupling',
    api: 'Auth.currentAuthLens()', behavior: 'Computes the effective AuthLens based on active impersonation or currentUser state.', featureKeys: ['currentAuthLens'] }),
  row({ ref: 50, flipped: 'unit-backed', section: 'Multi-tenancy, Impersonation & Firestore Coupling',
    api: 'Auth.authLensStream', behavior: 'Emits AuthLens updates whenever user transitions occur or impersonation lens changes.', featureKeys: ['authLensStream'] }),
  row({ ref: 51, flipped: 'unit-backed', section: 'Multi-tenancy, Impersonation & Firestore Coupling',
    api: 'FirebaseAuthBootstrap.initialize()', behavior: 'Registers Auth as the Firestore AuthCredentialProvider factory.', featureKeys: ['authCredentialProvider'] }),
  row({ ref: 52, flipped: 'unit-backed', section: 'Multi-tenancy, Impersonation & Firestore Coupling',
    api: 'SnapshotSubscriptionCoordinator re-subscription', behavior: 'Auth state and token transitions trigger Firestore snapshot listener re-subscription.', featureKeys: ['authFirestoreCoupling'] }),

  // ── 8. Error Handling ─────────────────────────────────────────────────────
  row({ ref: 53, flipped: 'unit-backed', section: 'Error handling',
    api: 'AuthErrorCode', behavior: 'Enumerates standard Firebase Auth error codes (e.g. invalidEmail, wrongPassword, userNotFound).', featureKeys: ['authErrorCode'] }),
  row({ ref: 54, flipped: 'unit-backed', section: 'Error handling',
    api: 'AuthError', behavior: 'Conforms to LocalizedError and maps wire error codes to structured AuthErrorCode.', featureKeys: ['authError'] }),
];

export const authSwiftRegistry: CompatibilitySurfaceRegistry = {
  surface: 'auth-swift',
  label: 'FirebaseAuth Swift',
  compatPath: 'packages/conformance/docs/auth-swift/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: '# FirebaseAuth Swift Conformance\n\nCompatibility reference for Pyric\'s pure-Swift client conforming to `FirebaseAuth` via the Pyric WebSocket bridge.' },
    {
      kind: 'table',
      prefix: '## `Auth` — instance & lifecycle\n',
      rows: authSwiftRows.filter((r) => r.section === '`Auth` — instance & lifecycle'),
    },
    {
      kind: 'table',
      prefix: '## `Auth` — authentication operations\n',
      rows: authSwiftRows.filter((r) => r.section === '`Auth` — authentication operations'),
    },
    {
      kind: 'table',
      prefix: '## `Auth` — state listeners & reactive streams\n',
      rows: authSwiftRows.filter((r) => r.section === '`Auth` — state listeners & reactive streams'),
    },
    {
      kind: 'table',
      prefix: '## `User` — identity properties\n',
      rows: authSwiftRows.filter((r) => r.section === '`User` — identity properties'),
    },
    {
      kind: 'table',
      prefix: '## `User` — token retrieval & mutations\n',
      rows: authSwiftRows.filter((r) => r.section === '`User` — token retrieval & mutations'),
    },
    {
      kind: 'table',
      prefix: '## Supporting types & metadata\n',
      rows: authSwiftRows.filter((r) => r.section === 'Supporting types & metadata'),
    },
    {
      kind: 'table',
      prefix: '## Multi-tenancy, Impersonation & Firestore Coupling\n',
      rows: authSwiftRows.filter((r) => r.section === 'Multi-tenancy, Impersonation & Firestore Coupling'),
    },
    {
      kind: 'table',
      prefix: '## Error handling\n',
      rows: authSwiftRows.filter((r) => r.section === 'Error handling'),
    },
  ],
};

export default authSwiftRegistry;
