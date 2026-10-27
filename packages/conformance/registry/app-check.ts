import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry, ConformanceDisposition } from './types.ts';

/**
 * The App Check registry, climbing under Conformance Driven Development
 * (docs/conformance/cdd.md). Two surface planes share it, on the messaging
 * precedent: `app-check` (the web SDK, `pyric/app-check`) and
 * `app-check-admin` (firebase-admin, `pyric-admin/app-check`).
 *
 * Rows come from two inputs. The census (`compat:census`, surface
 * `app-check`) gives the shape universe: the 8 runtime exports of
 * `firebase/app-check` 12.13.0. The 16 `app-check-` captures
 * (packages/conformance/docs/app-check/capture-plan.md) give the behavior
 * facts. A row's behavior states a production fact only where a cited capture
 * vouches for it; anything else is marked upstream-documented in `evidence`
 * and carries an `unobserved` risk.
 *
 * Rows about production AI pass-through (the real `firebase/app-check` on the
 * bridged app so `firebase/ai` sends `X-Firebase-AppCheck`) live in the `ai`
 * registry beside the AI rows, and cite these captures from there.
 *
 * Each row's assertion set is in its plane's red suite (SUITE below). A row
 * flips only when that assertion set passes unweakened.
 */

type Plane = 'app-check' | 'app-check-admin';

export const APP_CHECK_SUITES: Record<Plane, string> = {
  'app-check': 'packages/pyric/test/app-check/oracle-conformance.test.ts',
  'app-check-admin': 'packages/pyric-admin/test/app-check/oracle-conformance.test.ts',
};

const UNOBSERVED_REASON =
  'Behavior stated from upstream documentation and typings only (firebase 12.13.0, firebase-admin 13); no committed capture vouches for it.';
const CITED_NOT_REPLAYED_REASON =
  'Production observed and cited, but not yet replayed against the sandbox; the citation does not lock the claim until the suite replays it.';
const ERROR_TEXT_REASON = 'asserts production error codes and message text that can drift on re-capture';

interface Seed {
  plane: Plane;
  rowRef: string;
  section: string;
  api: string;
  featureKeys: string[];
  behavior: string;
  evidence: string;
  observations?: string[];
  /** Asserts production error codes or message text. */
  errorText?: boolean;
  notes?: string;
  /** Set when the row's assertion set passes: the evidence tier it earned. */
  flipped?: 'oracle-backed' | 'unit-backed';
  /** Set when the sandbox deliberately or knowingly differs (cdd.md Step 6). */
  diverged?: ConformanceDisposition;
  /** Set when the sandbox will never model the behavior. */
  unsupportedReason?: string;
}

const build = defineRows({ surface: 'app-check' });

function riskFor(seed: Seed): Pick<CompatibilityRow, 'risk' | 'riskScore' | 'riskReasons'> {
  const observed = (seed.observations ?? []).length > 0;
  const risk = [observed ? 'cited-not-replayed' : 'unobserved'];
  const riskReasons = [observed ? CITED_NOT_REPLAYED_REASON : UNOBSERVED_REASON];
  if (seed.errorText) {
    risk.push('error-code');
    riskReasons.push(ERROR_TEXT_REASON);
  }
  return { risk, riskScore: observed ? 1 : 2, riskReasons };
}

/** App scenario that drives the web SDK plane through a real dev server and Chromium. */
const SANDBOX_SCENARIO = 'test/apps/sandbox-app-check/scenario.ts';

function witnesses(plane: Plane): string[] {
  return plane === 'app-check' ? [APP_CHECK_SUITES[plane], SANDBOX_SCENARIO] : [APP_CHECK_SUITES[plane]];
}

function tierFor(seed: Seed): Partial<CompatibilityRow> {
  const suite = witnesses(seed.plane);
  if (seed.unsupportedReason) {
    return { status: 'unsupported', automation: 'unsupported', exceptionReason: seed.unsupportedReason, risk: ['unsupported'], riskScore: 0, riskReasons: [seed.unsupportedReason] };
  }
  if (seed.diverged) {
    return { status: 'diverged-documented', automation: 'oracle-backed', conformanceDisposition: seed.diverged, conformanceTests: suite };
  }
  if (seed.flipped === 'oracle-backed') {
    return { status: 'conforms', automation: 'oracle-backed', conformanceTests: suite, risk: [], riskScore: 0, riskReasons: [] };
  }
  if (seed.flipped === 'unit-backed') {
    return { status: 'conforms', automation: 'unit-backed', conformanceTests: suite, ...riskFor(seed) };
  }
  return { status: 'unverified', automation: 'unverified', ...riskFor(seed) };
}

function row(seed: Seed): CompatibilityRow {
  const { plane, observations = [], errorText: _errorText, flipped: _flipped, diverged: _diverged, unsupportedReason: _unsupported, ...rest } = seed;
  return build({ ...rest, surface: plane, oracleObservations: observations, ...riskFor(seed), ...tierFor(seed) });
}

// Section: initialization ----------------------------------------------------

const SEC_INIT = '`initializeAppCheck(app, options)` and providers';
const initRows: CompatibilityRow[] = [
  row({
    plane: 'app-check',
    rowRef: 'initialize-returns-handle',
    flipped: 'oracle-backed',
    section: SEC_INIT,
    api: 'initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled }): AppCheck',
    featureKeys: ['initializeAppCheck', 'AppCheck'],
    behavior: 'Returns an `AppCheck` handle whose `app` is the app it was initialized on.',
    evidence: 'capture `app-check-client-initialize-twice` (`instanceKeySet` includes `app`).',
    observations: ['app-check-client-initialize-twice'],
  }),
  row({
    plane: 'app-check',
    rowRef: 'initialize-twice-same-options',
    flipped: 'oracle-backed',
    section: SEC_INIT,
    api: 'initializeAppCheck(app, options) called twice',
    featureKeys: ['initializeAppCheck'],
    behavior: 'A second call with the same options returns the same instance without throwing, including when the provider is a new `CustomProvider` instance built from the same factory.',
    evidence: 'capture `app-check-client-initialize-twice` (`sameOptions`, `sameOptionsNewProviderInstance`).',
    observations: ['app-check-client-initialize-twice'],
  }),
  row({
    plane: 'app-check',
    rowRef: 'initialize-twice-different-options',
    flipped: 'oracle-backed',
    section: SEC_INIT,
    api: 'initializeAppCheck(app, options) called twice',
    featureKeys: ['initializeAppCheck'],
    behavior: 'A second call with a different `isTokenAutoRefreshEnabled` throws a `FirebaseError` with code `appCheck/already-initialized`, `customData.appName` set to the app name, and the message that names `initializeAppCheck()` and the app.',
    evidence: 'capture `app-check-client-initialize-twice` (`differentAutoRefresh`).',
    observations: ['app-check-client-initialize-twice'],
    errorText: true,
  }),
  row({
    plane: 'app-check',
    rowRef: 'providers-construct',
    flipped: 'oracle-backed',
    section: SEC_INIT,
    api: 'new CustomProvider({ getToken })',
    featureKeys: ['CustomProvider'],
    behavior: 'A `CustomProvider` constructs and is accepted by `initializeAppCheck`. With a debug token in effect, the SDK never calls it (a provider whose `getToken` would reject is called zero times).',
    evidence: 'capture `app-check-client-debug-get-token` (`customProviderCalls`; the capture initialized App Check with a `CustomProvider`).',
    observations: ['app-check-client-debug-get-token'],
  }),
  row({
    plane: 'app-check',
    rowRef: 'recaptcha-providers-construct',
    section: SEC_INIT,
    api: 'new ReCaptchaV3Provider(siteKey); new ReCaptchaEnterpriseProvider(siteKey)',
    featureKeys: ['ReCaptchaV3Provider', 'ReCaptchaEnterpriseProvider'],
    behavior: 'Both reCAPTCHA providers construct from a site key and are accepted by `initializeAppCheck`.',
    evidence: 'Upstream-documented only (firebase 12.13.0 typings and the App Check web guide). The oracle web app has no reCAPTCHA registration, so no capture exists; the sandbox never loads reCAPTCHA.',
  }),
];

// Section: tokens -------------------------------------------------------------

const SEC_TOKENS = 'Tokens: `getToken`, `getLimitedUseToken`';
const tokenRows: CompatibilityRow[] = [
  row({
    plane: 'app-check',
    rowRef: 'get-token-before-initialize',
    flipped: 'oracle-backed',
    section: SEC_TOKENS,
    api: 'getToken(appCheck) on an app without initializeAppCheck',
    featureKeys: ['getToken'],
    behavior: 'Rejects with a `FirebaseError` with code `appCheck/use-before-activation`, `customData.appName`, and the message telling the caller to call `initializeAppCheck()` first.',
    evidence: 'capture `app-check-client-get-token-before-initialize` (`publicGetTokenWithUninitializedApp`).',
    observations: ['app-check-client-get-token-before-initialize'],
    errorText: true,
  }),
  row({
    plane: 'app-check',
    rowRef: 'get-token-shape',
    flipped: 'oracle-backed',
    section: SEC_TOKENS,
    api: 'getToken(appCheck, forceRefresh?): Promise<AppCheckTokenResult>',
    featureKeys: ['getToken', 'AppCheckTokenResult'],
    behavior: 'Resolves `{ token }` where `token` is a three-segment JWT: header `alg` RS256, `typ` JWT, with a `kid`; claims `aud`, `exp`, `iat`, `iss`, `jti`, `provider`, `sub`; `iss` is `https://firebaseappcheck.googleapis.com/<projectNumber>`, `aud` is `[projects/<projectNumber>, projects/<projectId>]`, `sub` is the app id, and `exp - iat` is 3600 seconds.',
    evidence: 'capture `app-check-client-debug-get-token` (`first`, `forced`).',
    observations: ['app-check-client-debug-get-token'],
    notes: 'Not claimed: token length. Production tokens were 932 to 933 characters; sandbox tokens are about 780, because the sandbox `kid`, `jti`, and `provider` values are shorter. The suite compares every other field of the shape and drops `length` explicitly.',
  }),
  row({
    plane: 'app-check',
    rowRef: 'get-token-caching',
    flipped: 'oracle-backed',
    section: SEC_TOKENS,
    api: 'getToken(appCheck, forceRefresh?)',
    featureKeys: ['getToken'],
    behavior: 'A second `getToken` returns the cached token; `getToken(appCheck, true)` returns a different, newly minted token.',
    evidence: 'capture `app-check-client-debug-get-token` (`secondEqualsFirst`, `forceRefreshDiffersFromFirst`).',
    observations: ['app-check-client-debug-get-token'],
  }),
  row({
    plane: 'app-check',
    rowRef: 'limited-use-token',
    flipped: 'oracle-backed',
    section: SEC_TOKENS,
    api: 'getLimitedUseToken(appCheck): Promise<AppCheckTokenResult>',
    featureKeys: ['getLimitedUseToken'],
    behavior: 'Resolves `{ token }` with the same JWT shape as `getToken`, a different token on every call, never the cached token, and leaves the cached `getToken` token unchanged.',
    evidence: 'capture `app-check-client-limited-use-token`.',
    observations: ['app-check-client-limited-use-token'],
    notes: 'Not claimed: token length. Production tokens were 932 to 933 characters; sandbox tokens are about 780, because the sandbox `kid`, `jti`, and `provider` values are shorter. The suite compares every other field of the shape and drops `length` explicitly.',
  }),
  row({
    plane: 'app-check',
    rowRef: 'attestation-failure',
    section: SEC_TOKENS,
    api: 'getToken / getLimitedUseToken when attestation fails',
    featureKeys: ['getToken', 'getLimitedUseToken'],
    behavior: 'When the exchange is refused (an unregistered debug token), both reject with a `FirebaseError` with code `appCheck/fetch-status-error` and `customData.httpStatus` 403.',
    evidence: 'capture `app-check-client-invalid-debug-token` (`getToken`, `getLimitedUseToken`).',
    observations: ['app-check-client-invalid-debug-token'],
    errorText: true,
    unsupportedReason: 'The sandbox has no attestation authority that can refuse a token, so every request succeeds; a knob that simulates refusal is a candidate, not a commitment. Production pass-through runs the real SDK and inherits this behavior.',
  }),
];

// Section: listeners and refresh ---------------------------------------------

const SEC_LISTEN = 'Listeners and refresh: `onTokenChanged`, `setTokenAutoRefreshEnabled`';
const listenRows: CompatibilityRow[] = [
  row({
    plane: 'app-check',
    rowRef: 'on-token-changed-existing-token',
    flipped: 'oracle-backed',
    section: SEC_LISTEN,
    api: 'onTokenChanged(appCheck, listener | observer): Unsubscribe',
    featureKeys: ['onTokenChanged'],
    behavior: 'Returns an unsubscribe function. A listener registered after a token exists is not called synchronously; it is called once, asynchronously, with the current cached token.',
    evidence: 'capture `app-check-client-on-token-changed` (`unsubscribeType`, `lateListenerCallsSynchronous`, `lateListenerCallsWithin500ms`, `lateListenerTokenSequence`).',
    observations: ['app-check-client-on-token-changed'],
  }),
  row({
    plane: 'app-check',
    rowRef: 'on-token-changed-refresh',
    diverged: 'by-design',
    section: SEC_LISTEN,
    api: 'onTokenChanged(appCheck, listener | observer)',
    featureKeys: ['onTokenChanged'],
    behavior: 'Production, debug mode: listeners and observers registered before the first `getToken` are never called, not by the first token, a forced refresh, or limited-use tokens. Sandbox: they are called once each time the cached token changes (the first token and every forced refresh), never for limited-use tokens, and not after unsubscribing, which is the upstream-documented behavior for an attestation provider.',
    evidence: 'capture `app-check-client-on-token-changed` (every `listenerCalls*` count is 0). The sandbox side and the attested-provider behavior are pinned in the suite; the attested-provider path is upstream-documented, not captured.',
    observations: ['app-check-client-on-token-changed'],
    notes: 'Divergence, by design: the sandbox has no attestation provider to stand in for, so it follows the documented provider path apps depend on rather than the debug-mode early return.',
  }),
  row({
    plane: 'app-check',
    rowRef: 'set-auto-refresh',
    flipped: 'oracle-backed',
    section: SEC_LISTEN,
    api: 'setTokenAutoRefreshEnabled(appCheck, isEnabled): void',
    featureKeys: ['setTokenAutoRefreshEnabled'],
    behavior: 'Returns `undefined` and does not throw for either value; `getToken` still returns the cached token afterwards. Background refresh timing is not captured.',
    evidence: 'capture `app-check-client-auto-refresh-toggle`.',
    observations: ['app-check-client-auto-refresh-toggle'],
  }),
];

// Section: wire ----------------------------------------------------------------

const SEC_WIRE = 'Token exchange on the wire';
const wireRows: CompatibilityRow[] = [
  row({
    plane: 'app-check',
    rowRef: 'exchange-debug-token-wire',
    section: SEC_WIRE,
    api: 'POST projects/{projectId}/apps/{appId}:exchangeDebugToken?key=',
    featureKeys: ['getToken'],
    behavior: 'A registered debug token exchanges for `{ token, ttl: "3600s" }`; an unregistered one fails 403 `PERMISSION_DENIED` with message `App attestation failed.`',
    evidence: 'capture `app-check-exchange-debug-token-wire`.',
    observations: ['app-check-exchange-debug-token-wire'],
    errorText: true,
    unsupportedReason: 'The sandbox mints tokens in process and serves no App Check REST endpoint; no app calls the exchange directly.',
  }),
];

// Section: firebase-admin -------------------------------------------------------

const SEC_ADMIN = 'firebase-admin `getAppCheck()`';
const adminRows: CompatibilityRow[] = [
  row({
    plane: 'app-check-admin',
    rowRef: 'create-token-shape',
    flipped: 'oracle-backed',
    section: SEC_ADMIN,
    api: 'getAppCheck().createToken(appId)',
    featureKeys: ['createToken'],
    behavior: 'Resolves `{ token, ttlMillis: 3600000 }`; the token has the web SDK token shape (RS256 JWT with `kid`, claims `aud`, `exp`, `iat`, `iss`, `jti`, `provider`, `sub`, `exp - iat` 3600).',
    evidence: 'capture `app-check-admin-create-token-shape`.',
    observations: ['app-check-admin-create-token-shape'],
    notes: 'Not claimed: token length. Production tokens were 932 to 933 characters; sandbox tokens are about 780, because the sandbox `kid`, `jti`, and `provider` values are shorter. The suite compares every other field of the shape and drops `length` explicitly.',
  }),
  row({
    plane: 'app-check-admin',
    rowRef: 'create-token-ttl',
    flipped: 'oracle-backed',
    section: SEC_ADMIN,
    api: 'getAppCheck().createToken(appId, { ttlMillis })',
    featureKeys: ['createToken'],
    behavior: '`ttlMillis` of 30 minutes is honored in the result and in `exp - iat`; 29 minutes and 7 days plus one second reject with `app-check/invalid-argument` and the message that names the 30 minute to 7 day range.',
    evidence: 'capture `app-check-admin-create-token-custom-ttl`.',
    observations: ['app-check-admin-create-token-custom-ttl'],
    errorText: true,
  }),
  row({
    plane: 'app-check-admin',
    rowRef: 'create-token-unknown-app',
    diverged: 'by-design',
    section: SEC_ADMIN,
    api: 'getAppCheck().createToken(unknownAppId)',
    featureKeys: ['createToken'],
    behavior: 'Production: an app id the project does not own rejects with `app-check/unknown-error` and the message `App not registered: <appId>.` Sandbox: it has no list of the project\'s registered apps, so it mints a token for any non-empty app id; an empty app id rejects with `app-check/invalid-argument`.',
    evidence: 'capture `app-check-admin-create-token-unknown-app`; the sandbox side is pinned in the admin suite.',
    observations: ['app-check-admin-create-token-unknown-app'],
    errorText: true,
    notes: 'Divergence, by design: the sandbox does not model Firebase app registrations. A project config that lists app ids would let it refuse unknown ones.',
  }),
  row({
    plane: 'app-check-admin',
    rowRef: 'verify-token',
    flipped: 'oracle-backed',
    section: SEC_ADMIN,
    api: 'getAppCheck().verifyToken(token)',
    featureKeys: ['verifyToken'],
    behavior: 'Resolves `{ appId, token }` for an Admin-minted token and for a token from the web debug exchange; the decoded token carries `app_id`, `aud`, `exp`, `iat`, `iss`, `jti`, `provider`, `sub`, and no `alreadyConsumed` key is present.',
    evidence: 'capture `app-check-admin-verify-token`.',
    observations: ['app-check-admin-verify-token'],
  }),
  row({
    plane: 'app-check-admin',
    rowRef: 'verify-token-rejections',
    flipped: 'oracle-backed',
    section: SEC_ADMIN,
    api: 'getAppCheck().verifyToken(badToken)',
    featureKeys: ['verifyToken'],
    behavior: 'A token with an altered signature rejects with `app-check/invalid-argument` and `The provided App Check token has invalid signature.`; a non-JWT string and the empty string reject with `app-check/invalid-argument` and the decoding message.',
    evidence: 'capture `app-check-admin-verify-tampered`.',
    observations: ['app-check-admin-verify-tampered'],
    errorText: true,
  }),
  row({
    plane: 'app-check-admin',
    rowRef: 'verify-token-content-checks',
    section: SEC_ADMIN,
    api: 'getAppCheck().verifyToken(token) on another project, or with a foreign issuer, algorithm, subject, key, or expiry',
    featureKeys: ['verifyToken'],
    behavior: 'A token that is not a string rejects with `app-check/invalid-argument` and `App check token must be a non-null string.` Before the signature, the token content is checked in this order: a header `alg` other than RS256 rejects with `The provided App Check token has incorrect algorithm. Expected "RS256" but got "<alg>".`; an `aud` without `projects/<projectId>` of the verifying app rejects with `app-check/invalid-argument` and `The provided App Check token has incorrect "aud" (audience) claim. Expected "projects/<projectId>" but got "<aud>". Make sure the App Check token comes from the same Firebase project as the service account used to authenticate this SDK.`; an `iss` not starting with `https://firebaseappcheck.googleapis.com/` rejects with `The provided App Check token has incorrect "iss" (issuer) claim.`; a `sub` that is not a string rejects with `The provided App Check token has no "sub" (subject) claim.`, and an empty one with `The provided App Check token has an empty string "sub" (subject) claim.`; with no project id configured, `app-check/invalid-credential`. Then a `kid` that names no known key rejects with the `"kid" claim which does not correspond to a known public key` message, and a token with no `kid` is checked against every key. After the signature, a non-numeric `exp` rejects as an invalid signature, and an absent `exp` never expires.',
    evidence: 'Upstream-documented only: firebase-admin 13.10.0 `lib/app-check/token-verifier.js` (`verifyToken`, `verifyContent`, `ensureProjectId`, `mapJwtErrorToAppCheckError`), `lib/utils/jwt.js` (`getKeyCallback`, `PublicKeySignatureVerifier.verify`), and jsonwebtoken 9 `verify.js` (`exp`). No capture; verification runs locally in the Admin SDK, so a capture would need no production change.',
    errorText: true,
  }),
  row({
    plane: 'app-check-admin',
    rowRef: 'verify-token-consume',
    flipped: 'oracle-backed',
    section: SEC_ADMIN,
    api: 'getAppCheck().verifyToken(token, { consume: true })',
    featureKeys: ['verifyToken'],
    behavior: 'The first consume resolves with `alreadyConsumed: false`, a second consume with `alreadyConsumed: true`, and a plain verify afterwards has no `alreadyConsumed` key.',
    evidence: 'capture `app-check-admin-verify-consume`.',
    observations: ['app-check-admin-verify-consume'],
    notes: 'Covered: consumes through one sandbox handle in one process, including the require and import copies of `pyric-admin/app-check` (the consumed set sits behind `Symbol.for`). Not covered: production consumes once per project, server side, while the sandbox keeps the consumed set in process memory, so it is lost on restart and each process on one dev server keeps its own (#1297).',
  }),
];

export const appCheckRows: CompatibilityRow[] = [...initRows, ...tokenRows, ...listenRows, ...wireRows, ...adminRows];

export const appCheckRegistry: CompatibilitySurfaceRegistry = {
  surface: 'app-check',
  label: 'App Check',
  compatPath: 'packages/pyric/docs/app-check/COMPAT.md',
  blocks: [
    {
      kind: 'markdown',
      markdown:
        '# App Check compatibility\n\nApp Check is climbing under Conformance Driven Development. A row below is a target with a derived assertion set, not a guarantee, until its status says otherwise. Production AI pass-through rows live in the AI Logic compatibility page.\n',
    },
    { kind: 'table', prefix: `## ${SEC_INIT}\n`, rows: initRows },
    { kind: 'table', prefix: `## ${SEC_TOKENS}\n`, rows: tokenRows },
    { kind: 'table', prefix: `## ${SEC_LISTEN}\n`, rows: listenRows },
    { kind: 'table', prefix: `## ${SEC_WIRE}\n`, rows: wireRows },
    { kind: 'table', prefix: `## ${SEC_ADMIN}\n`, rows: adminRows },
  ],
};
