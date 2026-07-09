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
  ...deny('auth', 'Mutates auth state in ways the sandbox does not model (auth deny-list: updateEmail / updatePassword).', [
    'updateEmail', 'updatePassword', 'updatePhoneNumber',
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
  ...deny('auth', 'i18n surface; not in v0 (auth deny-list: useDeviceLanguage / setLanguageCode).', [
    'useDeviceLanguage',
  ]),
  ...deny('auth', 'Blocking middleware; the sandbox uses synchronous fan-out and has no equivalent (auth deny-list: beforeAuthStateChanged).', [
    'beforeAuthStateChanged',
  ]),
  ...deny('auth', 'Account-lifecycle the sandbox does not model — documented per AUTH-GAP (auth deny-list: User.delete() / User.reload()).', [
    'deleteUser', 'reload',
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
  ...deny('firestore', 'Persistence / cache story is owned by pyric/sandbox (IndexedDB + memory backends); the modular SDK cache + index-config APIs would conflict (firestore deny-list).', [
    'enableIndexedDbPersistence', 'enableMultiTabIndexedDbPersistence', 'clearIndexedDbPersistence',
    'persistentLocalCache', 'persistentMultipleTabManager', 'persistentSingleTabManager',
    'memoryLocalCache', 'memoryEagerGarbageCollector', 'memoryLruGarbageCollector',
    'CACHE_SIZE_UNLIMITED',
    'PersistentCacheIndexManager', 'getPersistentCacheIndexManager',
    'deleteAllPersistentCacheIndexes', 'enablePersistentCacheIndexAutoCreation',
    'disablePersistentCacheIndexAutoCreation', 'setIndexConfiguration',
  ]),
  ...deny('firestore', 'No network in the sandbox; semantically vacuous (firestore deny-list: waitForPendingWrites / disableNetwork / enableNetwork).', [
    'waitForPendingWrites', 'disableNetwork', 'enableNetwork',
  ]),
  ...deny('firestore', 'Handled by Sandbox.dispose() at the host level (firestore deny-list: terminate).', [
    'terminate',
  ]),
  ...deny('firestore', 'Bundle-loading depends on server-side packaging not modeled in the sandbox (firestore deny-list: loadBundle / namedQuery).', [
    'loadBundle', 'namedQuery', 'LoadBundleTask',
  ]),
  ...deny('firestore', 'SSR snapshot serialization surface (React hydration: snapshot.toJSON on the server, revive and resume on the client; firebase blog 2026-06). Deferred pending demand, tracked as a known gap - NOT plumbing. Tier-2 census must also cover the paired instance methods (QuerySnapshot.toJSON) that runtime export diffing cannot see.', [
    'documentSnapshotFromJSON', 'querySnapshotFromJSON', 'onSnapshotResume',
  ]),
  ...deny('app', 'SSR app construct (initializeServerApp): upstream answer to running client-shaped code in a server context. Deferred; convergent with the pyric ambient-init/register architecture and worth reading as design input when mirrored.', [
    'initializeServerApp',
  ]),
  ...deny('firestore', 'No cache/server split in the sandbox (firestore deny-list: getDoc*FromCache / getDoc*FromServer).', [
    'getDocFromCache', 'getDocFromServer', 'getDocsFromCache', 'getDocsFromServer',
  ]),
  ...deny('firestore', 'Cross-listener sync semantics not modeled (firestore deny-list: onSnapshotsInSync).', [
    'onSnapshotsInSync',
  ]),
  ...deny('firestore', 'Sandbox uses host-level logging, not the modular SDK logger (firestore deny-list: setLogLevel).', [
    'setLogLevel',
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
  ...deny('database', 'Connection / transport / logging management has no meaning for the in-memory sandbox (no live socket).', [
    'goOffline', 'goOnline', 'forceLongPolling', 'forceWebSockets', 'enableLogging',
  ]),
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
