/**
 * Surface census deny-list (tier 1 — runtime exports).
 *
 * Every upstream `firebase/*` runtime export the census sees must be either
 * (1) re-exported by the corresponding `pyric/*` mirror, (2) listed HERE with a
 * reason, or (3) reported as an UNMAPPED gap (which fails the gate). This file
 * is the committed "(2)" bucket.
 *
 * Reasons are grounded, not invented. Where a registry doc already carries a
 * deny-list table (`scripts/compat/registry/{auth,firestore,storage}.ts`, in
 * the "## Deny-list (intentionally NOT shimmed)" markdown blocks) the reason
 * quotes / paraphrases that table. Firebase-internal symbols (the leading-`_`
 * plumbing that `firebase/*` happens to export) are denied as a group with an
 * "internal" reason. Everything without a defensible reason is left UNMAPPED on
 * purpose — the gate is supposed to fail on genuine gaps, not on hand-waving.
 *
 * House style: this is pure data. The census matches symbols against these
 * entries with exact string (Set) equality — no regex, no prefix heuristics in
 * the trust path. Internal `_`-prefixed symbols are enumerated explicitly below
 * rather than matched by a `startsWith` rule, so the trust path stays a lookup.
 */

export type CensusSurface = 'app' | 'auth' | 'firestore' | 'database' | 'storage';

export interface DenyEntry {
  /** The census surface this upstream export belongs to. */
  surface: CensusSurface;
  /** The exact upstream (`firebase/*`) runtime export name. */
  symbol: string;
  /** Why the mirror intentionally does not export it. Must be honest. */
  reason: string;
}

/** Expand a shared reason over a list of symbols into individual entries. */
function deny(surface: CensusSurface, reason: string, symbols: string[]): DenyEntry[] {
  return symbols.map((symbol) => ({ surface, symbol, reason }));
}

const INTERNAL = 'Firebase-internal symbol (leading underscore); firebase/* exports it as plumbing, it is not part of the public modular surface pyric mirrors.';

// ── firebase/app → pyric/app ──────────────────────────────────────────────
// No registry doc backs app (it has no COMPAT matrix). Only the internal
// plumbing is denied here; the public app-management surface pyric does not yet
// mirror (getApp/getApps/deleteApp/registerVersion/…) is left UNMAPPED so the
// gate keeps flagging it.
const appDenials: DenyEntry[] = [
  ...deny('app', INTERNAL, [
    '_DEFAULT_ENTRY_NAME', '_addComponent', '_addOrOverwriteComponent', '_apps',
    '_clearComponents', '_components', '_getProvider', '_isFirebaseApp',
    '_isFirebaseServerApp', '_isFirebaseServerAppSettings', '_registerComponent',
    '_removeServiceInstance', '_serverApps',
  ]),
];

// ── firebase/auth → pyric/auth ────────────────────────────────────────────
// Grounded in the auth registry deny-list table (registry/auth.ts, "## Deny-list
// (intentionally NOT shimmed)").
const authDenials: DenyEntry[] = [
  ...deny('auth', 'Account linking is non-trivial auth state; v0 scope (auth deny-list: linkWith* / unlink).', [
    'linkWithCredential', 'linkWithPopup', 'linkWithRedirect', 'unlink',
  ]),
  ...deny('auth', 'Re-authentication is v0 scope (auth deny-list: reauthenticateWith*).', [
    'reauthenticateWithCredential', 'reauthenticateWithPopup', 'reauthenticateWithRedirect',
  ]),
  ...deny('auth', 'Phone-number auth state is not modeled by the sandbox (auth deny-list: updatePhoneNumber). NOTE: updateEmail / updatePassword are now mirrored — see registry/auth.ts, issue #149.', [
    'updatePhoneNumber',
  ]),
  ...deny('auth', 'Email-link / action-code flows require an SMTP path; deliberately out of scope (auth deny-list).', [
    'verifyBeforeUpdateEmail', 'sendEmailVerification', 'applyActionCode', 'checkActionCode',
    'confirmPasswordReset', 'sendPasswordResetEmail', 'verifyPasswordResetCode',
    'isSignInWithEmailLink', 'sendSignInLinkToEmail', 'signInWithEmailLink',
    'ActionCodeURL', 'ActionCodeOperation', 'parseActionCodeURL',
  ]),
  ...deny('auth', 'MFA / phone / reCAPTCHA family is not modeled by the sandbox (auth deny-list: multiFactor / MFA APIs).', [
    'multiFactor', 'getMultiFactorResolver', 'FactorId',
    'PhoneAuthProvider', 'PhoneAuthCredential', 'PhoneMultiFactorGenerator',
    'TotpMultiFactorGenerator', 'TotpSecret',
    'signInWithPhoneNumber', 'linkWithPhoneNumber', 'reauthenticateWithPhoneNumber',
    'RecaptchaVerifier', 'initializeRecaptchaConfig',
  ]),
  // NOTE: useDeviceLanguage is now mirrored as an accepted no-op — see
  // registry/auth.ts, issue #149. (setLanguageCode is a method on Auth, not
  // a free export, so it is not deny-listed here.)
  ...deny('auth', 'Blocking middleware; the sandbox uses synchronous fan-out and has no equivalent (auth deny-list: beforeAuthStateChanged).', [
    'beforeAuthStateChanged',
  ]),
];

// ── firebase/firestore → pyric/firestore ──────────────────────────────────
// Grounded in the firestore registry deny-list table (registry/firestore.ts,
// "## Deny-list (intentionally NOT shimmed)").
const firestoreDenials: DenyEntry[] = [
  ...deny('firestore', INTERNAL, [
    '_AutoId', '_ByteString', '_DatabaseId', '_DocumentKey', '_EmptyAppCheckTokenProvider',
    '_EmptyAuthCredentialsProvider', '_FieldPath', '_TestingHooks', '_cast', '_debugAssert',
    '_internalAggregationQueryToProtoRunAggregationQueryRequest',
    '_internalQueryToProtoQueryTarget', '_isBase64Available', '_logWarn',
    '_validateIsNotUsedTogether',
  ]),
  ...deny('firestore', 'Index-tuning / GC-policy admin surface the sandbox has no equivalent knob for; distinct from the tier-1 cache-factory tokens (persistentLocalCache/memoryLocalCache/tab-managers/GC-collectors), which are now mirrored as honest inert tokens (see registry/firestore.ts, issue #144 tier-1 pass).', [
    'CACHE_SIZE_UNLIMITED',
    'PersistentCacheIndexManager', 'getPersistentCacheIndexManager',
    'deleteAllPersistentCacheIndexes', 'enablePersistentCacheIndexAutoCreation',
    'disablePersistentCacheIndexAutoCreation', 'setIndexConfiguration',
  ]),
  ...deny('firestore', 'Handled by Sandbox.dispose() at the host level (firestore deny-list: terminate).', [
    'terminate',
  ]),
  ...deny('firestore', 'Bundle-loading depends on server-side packaging not modeled in the sandbox (firestore deny-list: loadBundle / namedQuery).', [
    'loadBundle', 'namedQuery', 'LoadBundleTask',
  ]),
];

// ── firebase/database → pyric/database(/modular) ──────────────────────────
// The rtdb registry has no dedicated deny-list table; these reasons follow from
// the in-memory sandbox model documented throughout registry/rtdb.ts (there is
// no live socket, and the legacy priority system is out of scope).
const databaseDenials: DenyEntry[] = [
  ...deny('database', INTERNAL, [
    '_QueryImpl', '_QueryParams', '_ReferenceImpl', '_TEST_ACCESS_forceRestClient',
    '_TEST_ACCESS_hijackHash', '_initStandalone', '_repoManagerDatabaseFromApp',
    '_setSDKVersion', '_validatePathString', '_validateWritablePath',
  ]),
  // NOTE: goOffline / goOnline / forceLongPolling / forceWebSockets /
  // enableLogging / refFromURL are now mirrored as honest no-ops / a real
  // alias — see registry/rtdb.ts, issue #149.
  ...deny('database', 'onDisconnect requires a live connection lifecycle the in-memory sandbox has no equivalent for.', [
    'onDisconnect', 'OnDisconnect',
  ]),
  ...deny('database', 'Legacy priority ordering system; out of scope (sandbox exposes orderByChild/Key/Value only).', [
    'setPriority', 'setWithPriority', 'orderByPriority',
  ]),
];

// ── firebase/storage → pyric/storage ──────────────────────────────────────
// Grounded in the storage registry deny-list table (registry/storage.ts,
// "## Deny-list (intentionally NOT shimmed)").
const storageDenials: DenyEntry[] = [
  ...deny('storage', INTERNAL, [
    '_FbsBlob', '_Location', '_TaskEvent', '_TaskState', '_UploadTask',
    '_dataFromString', '_getChild', '_invalidArgument', '_invalidRootOperation',
  ]),
  ...deny('storage', 'Out of scope — no browser-renderable URL in the IDB sandbox (storage deny-list: getDownloadURL).', [
    'getDownloadURL',
  ]),
  ...deny('storage', 'Out of scope — the UploadTask + observer surface is unmodeled; v1 driver is one-shot uploadBytes (storage deny-list: uploadBytesResumable).', [
    'uploadBytesResumable',
  ]),
  ...deny('storage', 'Node-stream variant not modeled in the browser-shaped v1 scope (storage deny-list: getStream).', [
    'getStream',
  ]),
  ...deny('storage', 'Paginated listing deferred — listAll covers the v1 scope; pagination needs a stable pageToken shape (storage deny-list: list).', [
    'list',
  ]),
  ...deny('storage', 'Sandbox replaces the emulator; emulator parity is out of scope (storage deny-list: connectStorageEmulator).', [
    'connectStorageEmulator',
  ]),
];

export const surfaceDenylist: DenyEntry[] = [
  ...appDenials,
  ...authDenials,
  ...firestoreDenials,
  ...databaseDenials,
  ...storageDenials,
];

/** Denied symbol names for one surface, as a Set for exact-match lookups. */
export function denylistFor(surface: CensusSurface): Map<string, string> {
  return new Map(surfaceDenylist.filter((e) => e.surface === surface).map((e) => [e.symbol, e.reason]));
}
