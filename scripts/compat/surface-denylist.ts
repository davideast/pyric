/**
 * Surface census deny-list (tier 1 — runtime exports).
 *
 * Every upstream `firebase/*` runtime export the census sees must be either
 * (1) re-exported by the corresponding `pyric/*` mirror, (2) listed HERE with a
 * reason, or (3) reported as an UNMAPPED gap (which fails the gate). This file
 * is the committed "(2)" bucket.
 *
 * ── Two-tier policy ─────────────────────────────────────────────────────────
 *
 * `OUT_OF_SCOPE` and `DEFERRED` are NOT interchangeable, and conflating them
 * is exactly the dishonesty this split exists to prevent. `OUT_OF_SCOPE`
 * holds ONLY the internal `_`-prefixed plumbing symbols firebase/* happens to
 * export — they are not part of the public modular surface pyric mirrors at
 * all, which is a genuine can't-apply reason. Every other denied symbol is
 * intended and buildable; it belongs in `DEFERRED`, which stays IN the
 * `intended` denominator in coverage.ts as an honest gap. Two reasons are
 * explicitly INVALID for treating something as out of scope:
 *
 *   - "needs external infrastructure" (SMTP / SMS / reCAPTCHA / an OAuth
 *     provider). Mocking external infrastructure is pyric's entire product —
 *     see the injected resolver + host UI that already mocks OAuth sign-in
 *     (`packages/pyric/src/auth/sandbox-backend.ts`, the `mockResults` /
 *     `resolver` mechanism). Phone / MFA / reCAPTCHA / email-link can follow
 *     the same pattern, so needing an external service is not a reason to
 *     write the API off.
 *   - "v0 scope" / "not yet" / "deferred" / "not in v0". These are honest
 *     admissions that the work hasn't happened — which makes them GAPS
 *     against `intended`, not exclusions from it. An item pyric fully intends
 *     to build stays in the `intended` denominator so the coverage number
 *     stays honest about what's actually done.
 *
 * `DEFERRED` entries are excluded from `mapped`/`unmapped` (same as
 * `OUT_OF_SCOPE` — the census still needs an explanation for every symbol so
 * the gate doesn't flag them as accidental gaps) but are NOT subtracted from
 * `intended` in coverage.ts. They count as coverage debt.
 *
 * Reasons are grounded, not invented. Where a registry doc already carries a
 * deny-list table (`scripts/compat/registry/{auth,firestore,storage}.ts`, in
 * the "## Deny-list (intentionally NOT shimmed)" markdown blocks) the reason
 * quotes / paraphrases that table.
 *
 * House style: this is pure data. The census matches symbols against these
 * entries with exact string (Set) equality — no regex, no prefix heuristics in
 * the trust path. Internal `_`-prefixed symbols are enumerated explicitly below
 * rather than matched by a `startsWith` rule, so the trust path stays a lookup.
 */

export type CensusSurface = 'app' | 'auth' | 'ai' | 'firestore' | 'database' | 'storage';

/**
 * `out-of-scope`  — genuinely cannot be modeled by the sandbox: internal
 *                    plumbing symbols not part of the public surface.
 *                    Subtracted from `intended`.
 * `deferred`      — intended, buildable, just not built yet. Stays IN the
 *                    `intended` denominator as a gap.
 */
export type DenyTier = 'out-of-scope' | 'deferred';

export interface DenyEntry {
  /** The census surface this upstream export belongs to. */
  surface: CensusSurface;
  /** The exact upstream (`firebase/*`) runtime export name. */
  symbol: string;
  /** Why the mirror intentionally does not export it (yet). Must be honest. */
  reason: string;
  /** Whether this is genuinely un-modelable or merely not-yet-built. */
  tier: DenyTier;
}

/** Expand a shared reason + tier over a list of symbols into individual entries. */
function deny(surface: CensusSurface, tier: DenyTier, reason: string, symbols: string[]): DenyEntry[] {
  return symbols.map((symbol) => ({ surface, symbol, reason, tier }));
}

const INTERNAL = 'Firebase-internal symbol (leading underscore); firebase/* exports it as plumbing, it is not part of the public modular surface pyric mirrors.';

// ── firebase/app → pyric/app ──────────────────────────────────────────────
// No registry doc backs app (it has no COMPAT matrix). Only the internal
// plumbing is denied here; the public app-management surface pyric does not yet
// mirror (getApp/getApps/deleteApp/registerVersion/…) is left UNMAPPED so the
// gate keeps flagging it.
const appDenials: DenyEntry[] = [
  ...deny('app', 'out-of-scope', INTERNAL, [
    '_DEFAULT_ENTRY_NAME', '_addComponent', '_addOrOverwriteComponent', '_apps',
    '_clearComponents', '_components', '_getProvider', '_isFirebaseApp',
    '_isFirebaseServerApp', '_isFirebaseServerAppSettings', '_registerComponent',
    '_removeServiceInstance', '_serverApps',
  ]),
];

// ── firebase/auth → pyric/auth ────────────────────────────────────────────
// Grounded in the auth registry deny-list table (registry/auth.ts, "## Deny-list
// (intentionally NOT shimmed)").
//
// Policy: essentially ALL of auth's remaining gaps are intended and buildable
// via the resolver/mock pattern already proven for OAuth sign-in. The genuine
// OUT_OF_SCOPE set for auth is therefore EMPTY — every entry below is
// DEFERRED. `updateEmail`, `updatePassword`, `updatePhoneNumber` (partially —
// see note), `deleteUser`, `reload`, `useDeviceLanguage`, and
// `beforeAuthStateChanged` were REMOVED from this file entirely: they are
// implemented, so they no longer belong on a deny-list at all.
const authDenials: DenyEntry[] = [
  ...deny('auth', 'deferred', 'Account linking is non-trivial auth state; deferred, not out of scope — buildable via the same resolver/mock pattern already used for OAuth sign-in (auth deny-list: linkWith* / unlink).', [
    'linkWithCredential', 'linkWithPopup', 'linkWithRedirect', 'unlink',
  ]),
  ...deny('auth', 'deferred', 'Re-authentication is deferred, not out of scope — same credential-check machinery as sign-in, just not wired to a "recent login" gate yet (auth deny-list: reauthenticateWith*).', [
    'reauthenticateWithCredential', 'reauthenticateWithPopup', 'reauthenticateWithRedirect',
  ]),
  ...deny('auth', 'deferred', 'Phone number mutation deferred alongside the rest of the phone-auth family — buildable via a mocked SMS/verification-code resolver, same shape as the OAuth resolver (auth deny-list: updatePhoneNumber).', [
    'updatePhoneNumber',
  ]),
  ...deny('auth', 'deferred', 'Email-link / action-code flows are deferred, not out of scope — an SMTP dependency is not a valid out-of-scope reason (mocking external infrastructure is the product); these can follow the injected-resolver pattern (auth deny-list).', [
    'verifyBeforeUpdateEmail', 'sendEmailVerification', 'applyActionCode', 'checkActionCode',
    'confirmPasswordReset', 'sendPasswordResetEmail', 'verifyPasswordResetCode',
    'isSignInWithEmailLink', 'sendSignInLinkToEmail', 'signInWithEmailLink',
    'ActionCodeURL', 'ActionCodeOperation', 'parseActionCodeURL',
  ]),
  ...deny('auth', 'deferred', 'MFA / phone / reCAPTCHA family is deferred, not out of scope — reCAPTCHA/SMS are external infra pyric can mock (same resolver pattern as OAuth), and TOTP is pure algorithm work (auth deny-list: multiFactor / MFA APIs).', [
    'multiFactor', 'getMultiFactorResolver', 'FactorId',
    'PhoneAuthProvider', 'PhoneAuthCredential', 'PhoneMultiFactorGenerator',
    'TotpMultiFactorGenerator', 'TotpSecret',
    'signInWithPhoneNumber', 'linkWithPhoneNumber', 'reauthenticateWithPhoneNumber',
    'RecaptchaVerifier', 'initializeRecaptchaConfig',
  ]),
  // useDeviceLanguage, deleteUser, reload, and beforeAuthStateChanged are now
  // mirrored (see registry/auth.ts) and are intentionally NOT deny-listed.
];

// ── firebase/ai → pyric/ai ────────────────────────────────────────────────
// Grounded in the surface inventory's draft denylist table
// (docs/conformance/ai/surface-inventory.md, "## Draft denylist"): the 17
// denied runtime value exports of the installed @firebase/ai@2.12.0, in four
// groups (Imagen, Live API, server-side templates, hybrid/on-device).
const aiDenials: DenyEntry[] = [
  ...deny('ai', 'Imagen is deprecated upstream; all Imagen models shut down as early as June 2026 (upstream 2.11.0 deprecation).', [
    'getImagenModel', 'ImagenModel', 'ImagenImageFormat', 'ImagenAspectRatio',
    'ImagenPersonFilterLevel', 'ImagenSafetyFilterLevel',
  ]),
  ...deny('ai', 'Imagen (deprecated, June 2026 shutdown) plus server-side templates (public preview, server-stored templates the sandbox does not host).', [
    'getTemplateImagenModel', 'TemplateImagenModel',
  ]),
  ...deny('ai', 'Live API is a separate bidirectional websocket protocol in public preview; not part of the mirrored REST plane.', [
    'getLiveGenerativeModel', 'LiveGenerativeModel', 'LiveSession', 'LiveResponseType',
  ]),
  ...deny('ai', 'Live API browser audio helper (microphone, autoplay policies); websocket protocol in public preview.', [
    'startAudioConversation',
  ]),
  ...deny('ai', 'Server-side templates are public preview and depend on server-stored templates the sandbox does not host.', [
    'getTemplateGenerativeModel', 'TemplateGenerativeModel',
  ]),
  ...deny('ai', 'Hybrid/on-device inference depends on Chrome window.LanguageModel; browser-only, not mirrorable server-side.', [
    'InferenceMode',
  ]),
  ...deny('ai', 'Hybrid/on-device inference marker; set client-side by the SDK, never on the wire (ticket #93); meaningless without the denied hybrid mode.', [
    'InferenceSource',
  ]),
];

// ── firebase/firestore → pyric/firestore ──────────────────────────────────
// Grounded in the firestore registry deny-list table (registry/firestore.ts,
// "## Deny-list (intentionally NOT shimmed)").
const firestoreDenials: DenyEntry[] = [
  ...deny('firestore', 'out-of-scope', INTERNAL, [
    '_AutoId', '_ByteString', '_DatabaseId', '_DocumentKey', '_EmptyAppCheckTokenProvider',
    '_EmptyAuthCredentialsProvider', '_FieldPath', '_TestingHooks', '_cast', '_debugAssert',
    '_internalAggregationQueryToProtoRunAggregationQueryRequest',
    '_internalQueryToProtoQueryTarget', '_isBase64Available', '_logWarn',
    '_validateIsNotUsedTogether',
  ]),
  // `terminate` is now mirrored by the honest no-op export batch — see
  // registry/firestore.ts. It is intentionally NOT deny-listed here.
  ...deny('firestore', 'deferred', 'Index-tuning / GC-policy admin surface has no real knob to turn in an in-memory sandbox today, but the sibling cache-factory tokens (persistentLocalCache/memoryLocalCache/tab-managers/GC-collectors) were already mirrored as honest inert tokens under the same rationale — buildable the same way, not genuinely out of scope (firestore deny-list: index-tuning APIs).', [
    'CACHE_SIZE_UNLIMITED',
    'PersistentCacheIndexManager', 'getPersistentCacheIndexManager',
    'deleteAllPersistentCacheIndexes', 'enablePersistentCacheIndexAutoCreation',
    'disablePersistentCacheIndexAutoCreation', 'setIndexConfiguration',
  ]),
  ...deny('firestore', 'deferred', 'Bundle-loading depends on server-side packaging (protobuf bundle format) not modeled in the sandbox yet — a data/parsing problem, not external infrastructure, so it is buildable rather than genuinely un-modelable (firestore deny-list: loadBundle / namedQuery).', [
    'loadBundle', 'namedQuery', 'LoadBundleTask',
  ]),
];

// ── firebase/database → pyric/database(/modular) ──────────────────────────
// The rtdb registry has no dedicated deny-list table; these reasons follow from
// the in-memory sandbox model documented throughout registry/rtdb.ts.
const databaseDenials: DenyEntry[] = [
  ...deny('database', 'out-of-scope', INTERNAL, [
    '_QueryImpl', '_QueryParams', '_ReferenceImpl', '_TEST_ACCESS_forceRestClient',
    '_TEST_ACCESS_hijackHash', '_initStandalone', '_repoManagerDatabaseFromApp',
    '_setSDKVersion', '_validatePathString', '_validateWritablePath',
  ]),
  // goOffline / goOnline / forceLongPolling / forceWebSockets / enableLogging /
  // refFromURL are now mirrored (honest no-ops or a real alias) and are not
  // deny-listed here.
  ...deny('database', 'deferred', 'onDisconnect requires a live connection lifecycle the in-memory sandbox has no equivalent for today — buildable as an honest no-op / inert token the same way the connection-management APIs were, not genuinely un-modelable (database deny-list: onDisconnect).', [
    'onDisconnect', 'OnDisconnect',
  ]),
  ...deny('database', 'deferred', 'Legacy priority ordering system, deprecated by Firebase itself; the sandbox exposes orderByChild/Key/Value only today. Priority ordering is data-modelable (it is just a sort key), so this is a scoping decision that can be revisited, not a hard sandbox limitation (database deny-list: setPriority / setWithPriority / orderByPriority).', [
    'setPriority', 'setWithPriority', 'orderByPriority',
  ]),
];

// ── firebase/storage → pyric/storage ──────────────────────────────────────
// Grounded in the storage registry deny-list table (registry/storage.ts,
// "## Deny-list (intentionally NOT shimmed)").
const storageDenials: DenyEntry[] = [
  ...deny('storage', 'out-of-scope', INTERNAL, [
    '_FbsBlob', '_Location', '_TaskEvent', '_TaskState', '_UploadTask',
    '_dataFromString', '_getChild', '_invalidArgument', '_invalidRootOperation',
  ]),
  // `connectStorageEmulator` is now mirrored — see registry/storage.ts. It is
  // intentionally NOT deny-listed here.
  ...deny('storage', 'deferred', 'No browser-renderable URL exists yet in the IDB sandbox, but a local blob URL (IDB blob + createObjectURL) looks buildable rather than genuinely un-modelable (storage deny-list: getDownloadURL).', [
    'getDownloadURL',
  ]),
  ...deny('storage', 'deferred', 'The UploadTask + observer surface is deferred — v1 shipped the one-shot uploadBytes driver first; the resumable/observable variant is unbuilt, not unbuildable (storage deny-list: uploadBytesResumable).', [
    'uploadBytesResumable',
  ]),
  ...deny('storage', 'deferred', 'Node-stream variant deferred — not part of the browser-shaped v1 scope yet, not genuinely un-modelable (storage deny-list: getStream).', [
    'getStream',
  ]),
  ...deny('storage', 'deferred', 'Paginated listing deferred — listAll covers the v1 scope; pagination needs a stable pageToken shape, which is unbuilt design work, not a sandbox limitation (storage deny-list: list).', [
    'list',
  ]),
];

export const surfaceDenylist: DenyEntry[] = [
  ...appDenials,
  ...authDenials,
  ...aiDenials,
  ...firestoreDenials,
  ...databaseDenials,
  ...storageDenials,
];

/** Denied symbol names for one surface, as a Set for exact-match lookups. Includes both tiers — every denied symbol still needs an explanation so the census gate doesn't flag it as an accidental gap. */
export function denylistFor(surface: CensusSurface): Map<string, string> {
  return new Map(surfaceDenylist.filter((e) => e.surface === surface).map((e) => [e.symbol, e.reason]));
}

/** Tier lookup for one surface, keyed by symbol — lets coverage.ts subtract only genuinely out-of-scope symbols from `intended`. */
export function denyTierFor(surface: CensusSurface): Map<string, DenyTier> {
  return new Map(surfaceDenylist.filter((e) => e.surface === surface).map((e) => [e.symbol, e.tier]));
}
