import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const CONFORMANCE_SUITE = 'packages/flutter-client/test/auth/conformance_test.dart';
const UNOBSERVED_REASON =
  'Behavior stated from firebase_auth_platform_interface specification; containerized test has not passed yet.';

const buildRow = defineRows({
  surface: 'auth-flutter',
});

interface FlutterAuthRowSeed {
  ref: number;
  section: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  flipped?: 'unit-backed';
}

function row(seed: FlutterAuthRowSeed): CompatibilityRow {
  const { ref, flipped, evidence, ...rest } = seed;
  const defaultEvidence = flipped
    ? 'firebase_auth_platform_interface specification.'
    : 'firebase_auth_platform_interface specification; unverified locally.';
  const resolvedEvidence = evidence ?? defaultEvidence;
  const climb = flipped
    ? {
        status: 'conforms' as const,
        automation: 'unit-backed' as const,
        evidence: `${resolvedEvidence} Container test: \`${CONFORMANCE_SUITE}\` assertion set \`auth-flutter#${ref}\`.`,
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

export const authFlutterRows: CompatibilityRow[] = [
  // ── 1. FirebaseAuthPlatform: Instance & Lifecycle ─────────────────────────
  row({ ref: 1, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — instance & lifecycle',
    api: 'FirebaseAuthPlatform.instance', behavior: 'Returns the default platform instance registered via PlatformInterface.', featureKeys: ['instance'] }),
  row({ ref: 2, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — instance & lifecycle',
    api: 'FirebaseAuthPlatform.instanceFor(app: app)', behavior: 'Returns a platform instance associated with a specific FirebaseApp.', featureKeys: ['instanceFor'] }),
  row({ ref: 3, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — instance & lifecycle',
    api: 'FirebaseAuthPlatform.delegateFor(app: app)', behavior: 'Creates an isolated platform instance sharing the bridge client for non-default apps.', featureKeys: ['delegateFor'] }),
  row({ ref: 4, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — instance & lifecycle',
    api: 'PyricFirebaseAuthPlatform.registerWith({bridgeClient})', behavior: 'Registers PyricFirebaseAuthPlatform as the active platform interface singleton.', featureKeys: ['registerWith'] }),
  row({ ref: 5, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — instance & lifecycle',
    api: 'FirebaseAuthPlatform.dispose()', behavior: 'Disposes platform resources, canceling bridge subscriptions and closing reactive stream controllers.', featureKeys: ['dispose'] }),

  // ── 2. FirebaseAuthPlatform: User Authentication ──────────────────────────
  row({ ref: 6, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — user authentication',
    api: 'FirebaseAuthPlatform.signInWithEmailAndPassword(email, password)', behavior: 'Authenticates user via bridge auth.signInEmail RPC and updates currentUser.', featureKeys: ['signInWithEmailAndPassword'] }),
  row({ ref: 7, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — user authentication',
    api: 'FirebaseAuthPlatform.createUserWithEmailAndPassword(email, password)', behavior: 'Registers user via bridge auth.createUser RPC and returns UserCredential with isNewUser: true.', featureKeys: ['createUserWithEmailAndPassword'] }),
  row({ ref: 8, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — user authentication',
    api: 'FirebaseAuthPlatform.signInAnonymously()', behavior: 'Creates an anonymous session via bridge auth.signInAnonymously RPC.', featureKeys: ['signInAnonymously'] }),
  row({ ref: 9, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — user authentication',
    api: 'FirebaseAuthPlatform.signOut()', behavior: 'Signs out active session via bridge auth.signOut RPC, clearing currentUser and emitting null on streams.', featureKeys: ['signOut'] }),
  row({ ref: 10, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — user authentication',
    api: 'FirebaseAuthPlatform.currentUser', behavior: 'Accesses cached UserPlatform instance or null when unauthenticated.', featureKeys: ['currentUser'] }),

  // ── 3. FirebaseAuthPlatform: Reactive State Streams ───────────────────────
  row({ ref: 11, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — reactive state streams',
    api: 'FirebaseAuthPlatform.authStateChanges()', behavior: 'Broadcast Stream emitting UserPlatform upon sign-in/sign-out with immediate replay of current state.', featureKeys: ['authStateChanges'] }),
  row({ ref: 12, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — reactive state streams',
    api: 'FirebaseAuthPlatform.idTokenChanges()', behavior: 'Broadcast Stream emitting UserPlatform upon sign-in, sign-out, or token refresh with immediate replay.', featureKeys: ['idTokenChanges'] }),
  row({ ref: 13, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — reactive state streams',
    api: 'FirebaseAuthPlatform.userChanges()', behavior: 'Broadcast Stream emitting UserPlatform upon user profile, claims, or auth transitions.', featureKeys: ['userChanges'] }),
  row({ ref: 14, flipped: 'unit-backed', section: '`FirebaseAuthPlatform` — reactive state streams',
    api: 'FirebaseAuthPlatform.sendAuthChangesEvent(appName, userPlatform)', behavior: 'Dispatches synthetic auth state updates across all stream controllers.', featureKeys: ['sendAuthChangesEvent'] }),

  // ── 4. Multi-Tenancy & AuthLens Integration ──────────────────────────────
  row({ ref: 15, flipped: 'unit-backed', section: 'Multi-tenancy & AuthLens integration',
    api: 'PyricAuthCredentialsProvider.currentAuthLens', behavior: 'Derives active AuthLens (asUser with uid, tenant, and custom claims, or anon).', featureKeys: ['currentAuthLens'] }),
  row({ ref: 16, flipped: 'unit-backed', section: 'Multi-tenancy & AuthLens integration',
    api: 'PyricAuthCredentialsProvider.authLensChanges', behavior: 'Emits distinct AuthLens transitions driving Firestore operation stamping and listener re-subscription.', featureKeys: ['authLensChanges'] }),
  row({ ref: 17, flipped: 'unit-backed', section: 'Multi-tenancy & AuthLens integration',
    api: 'AuthLens.asUser tenant claim isolation', behavior: 'Propagates tenant ID to request.auth.token.firebase.tenant for multi-tenant Security Rules evaluation.', featureKeys: ['tenant'] }),
  row({ ref: 18, flipped: 'unit-backed', section: 'Multi-tenancy & AuthLens integration',
    api: 'AuthLens deep equality semantics', behavior: 'Compares token claims and tenant attributes by deep collection equality to avoid spurious re-subscriptions.', featureKeys: ['AuthLens'] }),
  row({ ref: 19, flipped: 'unit-backed', section: 'Multi-tenancy & AuthLens integration',
    api: 'Firestore snapshot re-subscription supervisor', behavior: 'Automatically re-subscribes active Firestore snapshot listeners under the new AuthLens upon auth transition.', featureKeys: ['snapshots', 'authLens'] }),

  // ── 5. UserPlatform: Identity Properties & Metadata ───────────────────────
  row({ ref: 20, flipped: 'unit-backed', section: '`UserPlatform` — identity properties & metadata',
    api: 'UserPlatform.uid', behavior: 'Returns unique identifier string for the authenticated user.', featureKeys: ['uid'] }),
  row({ ref: 21, flipped: 'unit-backed', section: '`UserPlatform` — identity properties & metadata',
    api: 'UserPlatform.email', behavior: 'Returns primary email address or null for anonymous users.', featureKeys: ['email'] }),
  row({ ref: 22, flipped: 'unit-backed', section: '`UserPlatform` — identity properties & metadata',
    api: 'UserPlatform.displayName', behavior: 'Returns profile display name string or null if unset.', featureKeys: ['displayName'] }),
  row({ ref: 23, flipped: 'unit-backed', section: '`UserPlatform` — identity properties & metadata',
    api: 'UserPlatform.photoURL', behavior: 'Returns profile photo URL string or null if unset.', featureKeys: ['photoURL'] }),
  row({ ref: 24, flipped: 'unit-backed', section: '`UserPlatform` — identity properties & metadata',
    api: 'UserPlatform.phoneNumber', behavior: 'Returns associated phone number or null if unset.', featureKeys: ['phoneNumber'] }),
  row({ ref: 25, flipped: 'unit-backed', section: '`UserPlatform` — identity properties & metadata',
    api: 'UserPlatform.isAnonymous', behavior: 'Reports true if user signed in anonymously, false otherwise.', featureKeys: ['isAnonymous'] }),
  row({ ref: 26, flipped: 'unit-backed', section: '`UserPlatform` — identity properties & metadata',
    api: 'UserPlatform.emailVerified', behavior: 'Indicates whether user email address has been verified.', featureKeys: ['emailVerified'] }),
  row({ ref: 27, flipped: 'unit-backed', section: '`UserPlatform` — identity properties & metadata',
    api: 'UserPlatform.tenantId', behavior: 'Exposes Google Cloud Identity Platform tenant ID associated with user.', featureKeys: ['tenantId'] }),
  row({ ref: 28, flipped: 'unit-backed', section: '`UserPlatform` — identity properties & metadata',
    api: 'UserPlatform.providerData', behavior: 'Provides List<UserInfo> detailing linked authentication providers.', featureKeys: ['providerData'] }),
  row({ ref: 29, flipped: 'unit-backed', section: '`UserPlatform` — identity properties & metadata',
    api: 'UserPlatform.metadata', behavior: 'Provides creationTimestamp and lastSignInTimestamp wrapped in UserMetadata.', featureKeys: ['metadata'] }),

  // ── 6. UserPlatform: Tokens & Security Context ────────────────────────────
  row({ ref: 30, flipped: 'unit-backed', section: '`UserPlatform` — tokens & security context',
    api: 'UserPlatform.getIdToken([forceRefresh])', behavior: 'Retrieves valid JWT ID token string from bridge, forcing refresh when requested.', featureKeys: ['getIdToken'] }),
  row({ ref: 31, flipped: 'unit-backed', section: '`UserPlatform` — tokens & security context',
    api: 'UserPlatform.getIdTokenResult([forceRefresh])', behavior: 'Returns structured IdTokenResult containing decoded claims, expiration, and auth timestamps.', featureKeys: ['getIdTokenResult'] }),
  row({ ref: 32, flipped: 'unit-backed', section: '`UserPlatform` — tokens & security context',
    api: 'UserPlatform.customClaims', behavior: 'Exposes decoded custom claims map attached to user token identity.', featureKeys: ['customClaims'] }),
  row({ ref: 33, flipped: 'unit-backed', section: '`UserPlatform` — tokens & security context',
    api: 'UserPlatform forced token refresh event dispatch', behavior: 'Dispatches auth change events across platform streams when token claims change upon forced refresh.', featureKeys: ['idTokenRefresh'] }),

  // ── 7. UserPlatform: Profile & Account Mutations ──────────────────────────
  row({ ref: 34, flipped: 'unit-backed', section: '`UserPlatform` — profile & account mutations',
    api: 'UserPlatform.updateProfile(profile)', behavior: 'Updates displayName and photoURL via bridge RPC, refreshing cached currentUser and notifying listeners.', featureKeys: ['updateProfile'] }),
  row({ ref: 35, flipped: 'unit-backed', section: '`UserPlatform` — profile & account mutations',
    api: 'UserPlatform.reload()', behavior: 'Fetches latest user profile from bridge and updates active currentUser.', featureKeys: ['reload'] }),
  row({ ref: 36, flipped: 'unit-backed', section: '`UserPlatform` — profile & account mutations',
    api: 'UserPlatform.delete()', behavior: 'Deletes authenticated user account via bridge RPC and clears currentUser.', featureKeys: ['deleteUser'] }),
  row({ ref: 37, section: '`UserPlatform` — profile & account mutations',
    api: 'UserPlatform.updateEmail(newEmail)', behavior: 'Updates user account email address via bridge RPC.', featureKeys: ['updateEmail'] }),
  row({ ref: 38, section: '`UserPlatform` — profile & account mutations',
    api: 'UserPlatform.updatePassword(newPassword)', behavior: 'Updates user account password via bridge RPC.', featureKeys: ['updatePassword'] }),

  // ── 8. UserCredentialPlatform & Supporting Models ─────────────────────────
  row({ ref: 39, flipped: 'unit-backed', section: '`UserCredentialPlatform` & supporting models',
    api: 'UserCredentialPlatform.user', behavior: 'Exposes UserPlatform instance resulting from successful authentication.', featureKeys: ['UserCredential'] }),
  row({ ref: 40, flipped: 'unit-backed', section: '`UserCredentialPlatform` & supporting models',
    api: 'UserCredentialPlatform.additionalUserInfo', behavior: 'Provides AdditionalUserInfo indicating whether authenticated user is a new user.', featureKeys: ['additionalUserInfo'] }),
  row({ ref: 41, flipped: 'unit-backed', section: '`UserCredentialPlatform` & supporting models',
    api: 'InternalUserDetails wire deserializer', behavior: 'Deserializes bridge user wire payload into InternalUserDetails and provider structures.', featureKeys: ['InternalUserDetails'] }),

  // ── 9. Advanced Auth & Platform Extensions ────────────────────────────────
  row({ ref: 42, flipped: 'unit-backed', section: 'Advanced auth & platform extensions',
    api: 'MultiFactorPlatform interface contract', behavior: 'Exposes stub MultiFactorPlatform for enrolled multi-factor inspection.', featureKeys: ['multiFactor'] }),
  row({ ref: 43, section: 'Advanced auth & platform extensions',
    api: 'FirebaseAuthPlatform.setLanguageCode(languageCode)', behavior: 'Configures locale language code for out-of-band auth communications.', featureKeys: ['setLanguageCode'] }),
  row({ ref: 44, section: 'Advanced auth & platform extensions',
    api: 'FirebaseAuthPlatform.useAuthEmulator(host, port)', behavior: 'Directs client auth operations to designated host and port emulator endpoint.', featureKeys: ['useAuthEmulator'] }),
  row({ ref: 45, section: 'Advanced auth & platform extensions',
    api: 'FirebaseAuthPlatform.setPersistence(persistence)', behavior: 'Configures session persistence mode across local storage or in-memory sessions.', featureKeys: ['setPersistence'] }),

  // ── 10. Error Handling & Wire Codecs ──────────────────────────────────────
  row({ ref: 46, flipped: 'unit-backed', section: 'Error handling & wire codecs',
    api: 'FirebaseAuthException translation', behavior: 'Translates bridge RPC errors to typed FirebaseAuthException with normalized error codes.', featureKeys: ['FirebaseAuthException'] }),
  row({ ref: 47, flipped: 'unit-backed', section: 'Error handling & wire codecs',
    api: 'Bridge auth operation codecs', behavior: 'Encodes and decodes auth.* RPC operations and subscription frames across WebSocket bridge.', featureKeys: ['bridgeOps'] }),
  row({ ref: 48, flipped: 'unit-backed', section: 'Error handling & wire codecs',
    api: 'Remote client session isolation', behavior: 'Isolates client auth state and token subscriptions to clientSessionId without mutating browser session.', featureKeys: ['sessionIsolation'] }),
];

const INTRO = `# Flutter Firebase Auth integration compatibility

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — containerized Dart test matches platform interface under replay |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match platform interface but does not |
| — | **Not implemented yet** — explicitly outside the implemented slice |
| ? | **Unverified** — platform interface behavior not yet verified in container |
`;

export const authFlutterRegistry: CompatibilitySurfaceRegistry = {
  surface: 'auth-flutter',
  label: 'Auth · Flutter',
  compatPath: 'packages/conformance/docs/auth-flutter/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    {
      kind: 'table',
      prefix: '## `FirebaseAuthPlatform` — instance & lifecycle\n',
      rows: authFlutterRows.filter((r) => r.section.includes('instance & lifecycle')),
    },
    {
      kind: 'table',
      prefix: '## `FirebaseAuthPlatform` — user authentication\n',
      rows: authFlutterRows.filter((r) => r.section.includes('user authentication')),
    },
    {
      kind: 'table',
      prefix: '## `FirebaseAuthPlatform` — reactive state streams\n',
      rows: authFlutterRows.filter((r) => r.section.includes('reactive state streams')),
    },
    {
      kind: 'table',
      prefix: '## Multi-tenancy & AuthLens integration\n',
      rows: authFlutterRows.filter((r) => r.section.includes('Multi-tenancy')),
    },
    {
      kind: 'table',
      prefix: '## `UserPlatform` — identity properties & metadata\n',
      rows: authFlutterRows.filter((r) => r.section.includes('identity properties & metadata')),
    },
    {
      kind: 'table',
      prefix: '## `UserPlatform` — tokens & security context\n',
      rows: authFlutterRows.filter((r) => r.section.includes('tokens & security context')),
    },
    {
      kind: 'table',
      prefix: '## `UserPlatform` — profile & account mutations\n',
      rows: authFlutterRows.filter((r) => r.section.includes('profile & account mutations')),
    },
    {
      kind: 'table',
      prefix: '## `UserCredentialPlatform` & supporting models\n',
      rows: authFlutterRows.filter((r) => r.section.includes('UserCredentialPlatform')),
    },
    {
      kind: 'table',
      prefix: '## Advanced auth & platform extensions\n',
      rows: authFlutterRows.filter((r) => r.section.includes('Advanced auth')),
    },
    {
      kind: 'table',
      prefix: '## Error handling & wire codecs\n',
      rows: authFlutterRows.filter((r) => r.section.includes('Error handling')),
    },
  ],
};

export default authFlutterRegistry;
