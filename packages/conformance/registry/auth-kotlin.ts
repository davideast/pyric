import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const CONFORMANCE_SUITE = 'packages/kt-client/src/test/kotlin/dev/pyric/auth/ConformanceTest.kt';
const UNOBSERVED_REASON =
  'Behavior stated from com.google.firebase.auth specification; unit test has not passed yet.';

const buildRow = defineRows({
  surface: 'auth-kotlin',
});

interface KotlinAuthRowSeed {
  ref: number;
  section: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  flipped?: 'unit-backed';
}

function row(seed: KotlinAuthRowSeed): CompatibilityRow {
  const { ref, flipped, evidence, ...rest } = seed;
  const defaultEvidence = flipped
    ? 'com.google.firebase.auth specification.'
    : 'com.google.firebase.auth specification; unverified locally.';
  const resolvedEvidence = evidence ?? defaultEvidence;
  const climb = flipped
    ? {
        status: 'conforms' as const,
        automation: 'unit-backed' as const,
        evidence: `${resolvedEvidence} Test: \`${CONFORMANCE_SUITE}\` assertion set \`auth-kotlin#${ref}\`.`,
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

export const authKotlinRows: CompatibilityRow[] = [
  // ── 1. FirebaseAuth: Instance & Lifecycle ─────────────────────────────
  row({ ref: 1, section: '`FirebaseAuth` — instance & lifecycle',
    api: 'FirebaseAuth.getInstance() / Firebase.auth', behavior: 'Returns the default FirebaseAuth instance for the default FirebaseApp.', featureKeys: ['getInstance'], flipped: 'unit-backed' }),
  row({ ref: 2, section: '`FirebaseAuth` — instance & lifecycle',
    api: 'FirebaseAuth.getInstance(app) / Firebase.auth(app)', behavior: 'Provides isolated FirebaseAuth instances distinguished by FirebaseApp.', featureKeys: ['getInstance'], flipped: 'unit-backed' }),
  row({ ref: 3, section: '`FirebaseAuth` — instance & lifecycle',
    api: 'FirebaseAuth.app', behavior: 'Returns the FirebaseApp instance associated with this FirebaseAuth instance.', featureKeys: ['app'], flipped: 'unit-backed' }),
  row({ ref: 4, section: '`FirebaseAuth` — instance & lifecycle',
    api: 'FirebaseAuth.tenantId', behavior: 'Configures and retrieves the tenant ID, updating the active AuthLens to include tenant scope.', featureKeys: ['tenantId'], flipped: 'unit-backed' }),
  row({ ref: 5, section: '`FirebaseAuth` — instance & lifecycle',
    api: 'FirebaseAuth.clearInstancesForTest()', behavior: 'Clears cached FirebaseAuth instances to isolate test runs.', featureKeys: ['clearInstancesForTest'], flipped: 'unit-backed' }),

  // ── 2. FirebaseAuth: Authentication Operations ─────────────────────────
  row({ ref: 6, section: '`FirebaseAuth` — authentication operations',
    api: 'FirebaseAuth.signInWithEmailAndPassword(email, password)', behavior: 'Authenticates a user with email and password via bridge auth.signInEmail, updating currentUser and AuthLens.', featureKeys: ['signInWithEmailAndPassword'], flipped: 'unit-backed' }),
  row({ ref: 7, section: '`FirebaseAuth` — authentication operations',
    api: 'FirebaseAuth.createUserWithEmailAndPassword(email, password)', behavior: 'Creates a new user account with email and password via bridge auth.createUser, updating currentUser and AuthLens.', featureKeys: ['createUserWithEmailAndPassword'], flipped: 'unit-backed' }),
  row({ ref: 8, section: '`FirebaseAuth` — authentication operations',
    api: 'FirebaseAuth.signInAnonymously()', behavior: 'Authenticates an anonymous user via bridge auth.signInAnonymously, establishing an anonymous FirebaseUser session.', featureKeys: ['signInAnonymously'], flipped: 'unit-backed' }),
  row({ ref: 9, section: '`FirebaseAuth` — authentication operations',
    api: 'FirebaseAuth.signOut()', behavior: 'Signs out the current user via bridge auth.signOut, clearing currentUser and resetting AuthLens to Anon.', featureKeys: ['signOut'], flipped: 'unit-backed' }),
  row({ ref: 10, section: '`FirebaseAuth` — authentication operations',
    api: 'FirebaseAuth.currentUser', behavior: 'Returns the currently signed-in FirebaseUser, or null if unauthenticated.', featureKeys: ['currentUser'], flipped: 'unit-backed' }),

  // ── 3. FirebaseAuth: State Observers & Modern Flows ────────────────────
  row({ ref: 11, section: '`FirebaseAuth` — state observers & modern flows',
    api: 'FirebaseAuth.authStateFlow()', behavior: 'Exposes a Coroutine StateFlow emitting the active FirebaseUser on sign-in, sign-out, or user change.', featureKeys: ['authStateFlow'], flipped: 'unit-backed' }),
  row({ ref: 12, section: '`FirebaseAuth` — state observers & modern flows',
    api: 'FirebaseAuth.idTokenFlow()', behavior: 'Exposes a Coroutine Flow emitting the active FirebaseUser on token refresh, user change, or claims update.', featureKeys: ['idTokenFlow'], flipped: 'unit-backed' }),
  row({ ref: 13, section: '`FirebaseAuth` — state observers & modern flows',
    api: 'FirebaseAuth.addAuthStateListener(listener)', behavior: 'Registers an AuthStateListener invoked immediately on registration and whenever authentication state changes.', featureKeys: ['addAuthStateListener', 'removeAuthStateListener'], flipped: 'unit-backed' }),
  row({ ref: 14, section: '`FirebaseAuth` — state observers & modern flows',
    api: 'FirebaseAuth.addIdTokenListener(listener)', behavior: 'Registers an IdTokenListener invoked immediately on registration and whenever token or claims change.', featureKeys: ['addIdTokenListener', 'removeIdTokenListener'], flipped: 'unit-backed' }),

  // ── 4. FirebaseUser: User Identity & Properties ────────────────────────
  row({ ref: 15, section: '`FirebaseUser` — user identity & properties',
    api: 'FirebaseUser.uid', behavior: 'Returns the non-null string uniquely identifying the user across providers.', featureKeys: ['uid'], flipped: 'unit-backed' }),
  row({ ref: 16, section: '`FirebaseUser` — user identity & properties',
    api: 'FirebaseUser.email', behavior: 'Returns the primary email address for the user, or null for anonymous users.', featureKeys: ['email'], flipped: 'unit-backed' }),
  row({ ref: 17, section: '`FirebaseUser` — user identity & properties',
    api: 'FirebaseUser.displayName', behavior: 'Returns the display name associated with the user profile, or null if unset.', featureKeys: ['displayName'], flipped: 'unit-backed' }),
  row({ ref: 18, section: '`FirebaseUser` — user identity & properties',
    api: 'FirebaseUser.photoUrl', behavior: 'Returns the profile photo URI or null if unset.', featureKeys: ['photoUrl'], flipped: 'unit-backed' }),
  row({ ref: 19, section: '`FirebaseUser` — user identity & properties',
    api: 'FirebaseUser.phoneNumber', behavior: 'Returns the phone number string associated with the user profile, or null if unset.', featureKeys: ['phoneNumber'], flipped: 'unit-backed' }),
  row({ ref: 20, section: '`FirebaseUser` — user identity & properties',
    api: 'FirebaseUser.isAnonymous', behavior: 'Returns true if the user account is authenticated anonymously, false otherwise.', featureKeys: ['isAnonymous'], flipped: 'unit-backed' }),
  row({ ref: 21, section: '`FirebaseUser` — user identity & properties',
    api: 'FirebaseUser.isEmailVerified', behavior: 'Returns true if the user email has been verified, false otherwise.', featureKeys: ['isEmailVerified'], flipped: 'unit-backed' }),
  row({ ref: 22, section: '`FirebaseUser` — user identity & properties',
    api: 'FirebaseUser.providerId', behavior: 'Returns the primary provider identifier ("firebase").', featureKeys: ['providerId'], flipped: 'unit-backed' }),
  row({ ref: 23, section: '`FirebaseUser` — user identity & properties',
    api: 'FirebaseUser.providerData', behavior: 'Returns a list of UserInfo instances corresponding to linked provider accounts.', featureKeys: ['providerData'], flipped: 'unit-backed' }),
  row({ ref: 24, section: '`FirebaseUser` — user identity & properties',
    api: 'FirebaseUser.customClaims', behavior: 'Returns a map of custom claims associated with the user and carried into AuthLens.', featureKeys: ['customClaims'], flipped: 'unit-backed' }),

  // ── 5. FirebaseUser: Token & Profile Operations ────────────────────────
  row({ ref: 25, section: '`FirebaseUser` — token & profile operations',
    api: 'FirebaseUser.getIdToken(forceRefresh)', behavior: 'Retrieves the JWT ID token string, forcing refresh via bridge auth.getIdTokenResult when forceRefresh is true.', featureKeys: ['getIdToken'], flipped: 'unit-backed' }),
  row({ ref: 26, section: '`FirebaseUser` — token & profile operations',
    api: 'FirebaseUser.getIdTokenResult(forceRefresh)', behavior: 'Retrieves GetTokenResult with parsed JWT token string, claims map, expiration, and provider info.', featureKeys: ['getIdTokenResult'], flipped: 'unit-backed' }),
  row({ ref: 27, section: '`FirebaseUser` — token & profile operations',
    api: 'FirebaseUser.updateProfile(request)', behavior: 'Mutates user display name and photo URI via bridge auth.updateProfile, updating local user state.', featureKeys: ['updateProfile'], flipped: 'unit-backed' }),
  row({ ref: 28, section: '`FirebaseUser` — token & profile operations',
    api: 'FirebaseUser.reload()', behavior: 'Reloads user profile and custom claims from bridge auth.getCurrentUser and auth.getIdTokenResult.', featureKeys: ['reload'], flipped: 'unit-backed' }),

  // ── 6. UserProfileChangeRequest: Profile Mutation Builder ──────────────
  row({ ref: 29, section: '`UserProfileChangeRequest` — profile mutation builder',
    api: 'UserProfileChangeRequest.Builder', behavior: 'Builds immutable UserProfileChangeRequest configuring displayName and photoUri.', featureKeys: ['userProfileChangeRequest'], flipped: 'unit-backed' }),

  // ── 7. Data Models & Exception Handling ────────────────────────────────
  row({ ref: 30, section: 'Data models & exception handling',
    api: 'AuthResult / AdditionalUserInfo', behavior: 'AuthResult packages authenticated FirebaseUser and AdditionalUserInfo (providerId, isNewUser).', featureKeys: ['authResult', 'additionalUserInfo'], flipped: 'unit-backed' }),
  row({ ref: 31, section: 'Data models & exception handling',
    api: 'GetTokenResult', behavior: 'Encapsulates token string, custom claims, expirationTimestamp, authTimestamp, and issuedAtTimestamp.', featureKeys: ['getTokenResult'], flipped: 'unit-backed' }),
  row({ ref: 32, section: 'Data models & exception handling',
    api: 'FirebaseAuthException', behavior: 'Translates bridge auth error codes into standard Firebase error codes (e.g. ERROR_WRONG_PASSWORD, ERROR_USER_NOT_FOUND).', featureKeys: ['firebaseAuthException'], flipped: 'unit-backed' }),

  // ── 8. CredentialsProvider & Firestore Auth Coupling ───────────────────
  row({ ref: 33, section: '`CredentialsProvider` & Firestore Auth Coupling',
    api: 'CredentialsProvider.getEffectiveLens()', behavior: 'Provides AuthLens.Anon when signed out, and AuthLens.AsUser with uid, claims, and tenant when signed in.', featureKeys: ['credentialsProvider', 'getEffectiveLens'], flipped: 'unit-backed' }),
  row({ ref: 34, section: '`CredentialsProvider` & Firestore Auth Coupling',
    api: 'CredentialsProvider.authLensFlow', behavior: 'Emits updated AuthLens on authentication state transitions (sign-in, sign-out, token refresh, tenant change).', featureKeys: ['authLensFlow'], flipped: 'unit-backed' }),
  row({ ref: 35, section: '`CredentialsProvider` & Firestore Auth Coupling',
    api: 'FirebaseFirestore actAs stamping', behavior: 'FirebaseFirestore automatically stamps the CredentialsProvider effective AuthLens on all document operations and queries.', featureKeys: ['actAs', 'firestore'], flipped: 'unit-backed' }),
  row({ ref: 36, section: '`CredentialsProvider` & Firestore Auth Coupling',
    api: 'FirebaseFirestore snapshot re-subscription', behavior: 'Active Firestore snapshots() flows automatically re-subscribe when CredentialsProvider emits a new AuthLens.', featureKeys: ['snapshots', 're-subscribe'], flipped: 'unit-backed' }),
];

const INTRO = `# Auth · Kotlin Conformance

Compatibility reference for Pyric's pure-Kotlin client conforming to \`com.google.firebase.auth\` (Firebase Android SDK) via the Pyric WebSocket bridge.

All rows are backed by the containerized and local test suite (\`${CONFORMANCE_SUITE}\`) executed via the automated CDD climb lane (\`scripts/run-kotlin-auth-conformance.sh\`).
`;

export const authKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'auth-kotlin',
  label: 'Auth · Kotlin',
  compatPath: 'packages/conformance/docs/auth-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    {
      kind: 'table',
      prefix: '## `FirebaseAuth` — instance & lifecycle\n',
      rows: authKotlinRows.filter((r) => r.section === '`FirebaseAuth` — instance & lifecycle'),
    },
    {
      kind: 'table',
      prefix: '## `FirebaseAuth` — authentication operations\n',
      rows: authKotlinRows.filter((r) => r.section === '`FirebaseAuth` — authentication operations'),
    },
    {
      kind: 'table',
      prefix: '## `FirebaseAuth` — state observers & modern flows\n',
      rows: authKotlinRows.filter((r) => r.section === '`FirebaseAuth` — state observers & modern flows'),
    },
    {
      kind: 'table',
      prefix: '## `FirebaseUser` — user identity & properties\n',
      rows: authKotlinRows.filter((r) => r.section === '`FirebaseUser` — user identity & properties'),
    },
    {
      kind: 'table',
      prefix: '## `FirebaseUser` — token & profile operations\n',
      rows: authKotlinRows.filter((r) => r.section === '`FirebaseUser` — token & profile operations'),
    },
    {
      kind: 'table',
      prefix: '## `UserProfileChangeRequest` — profile mutation builder\n',
      rows: authKotlinRows.filter((r) => r.section === '`UserProfileChangeRequest` — profile mutation builder'),
    },
    {
      kind: 'table',
      prefix: '## Data models & exception handling\n',
      rows: authKotlinRows.filter((r) => r.section === 'Data models & exception handling'),
    },
    {
      kind: 'table',
      prefix: '## `CredentialsProvider` & Firestore Auth Coupling\n',
      rows: authKotlinRows.filter((r) => r.section === '`CredentialsProvider` & Firestore Auth Coupling'),
    },
  ],
};

export default authKotlinRegistry;
