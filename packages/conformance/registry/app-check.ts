import { defineRows } from './define-rows.ts';
import { appCheckHuntBlock } from './app-check-hunt-captures.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry, ConformanceDisposition } from './types.ts';

/**
 * The App Check registry, climbing under Conformance Driven Development
 * (docs/conformance/cdd.md). Two surface planes share it, on the messaging
 * precedent: `app-check` (the web SDK, `pyric/app-check`) and
 * `app-check-admin` (firebase-admin, `pyric-admin/app-check`).
 *
 * Rows come from two inputs. The census (`compat:census`, surface
 * `app-check`) gives the shape universe: the 8 runtime exports of
 * `firebase/app-check` 12.13.0. The 18 `app-check-` captures
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
    rowRef: 'initialize-twice-unset-auto-refresh',
    flipped: 'oracle-backed',
    section: SEC_INIT,
    api: 'initializeAppCheck(app, options) called twice',
    featureKeys: ['initializeAppCheck'],
    behavior: 'An omitted `isTokenAutoRefreshEnabled` is not equal to `false`: a first call that omits it followed by one that passes `false`, or the reverse, throws `appCheck/already-initialized`, and two calls that both omit it return the same instance.',
    evidence: 'capture `app-check-client-initialize-twice-unset-auto-refresh` (`unsetThenFalse`, `falseThenUnset`, `unsetThenUnset`). Upstream `initializeAppCheck` in `@firebase/app-check` 0.11.3 compares `initialOptions.isTokenAutoRefreshEnabled === options.isTokenAutoRefreshEnabled`.',
    observations: ['app-check-client-initialize-twice-unset-auto-refresh'],
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
    rowRef: 'custom-provider-without-debug-token',
    section: SEC_INIT,
    api: 'getToken(appCheck), getLimitedUseToken(appCheck) with a CustomProvider and no debug token',
    featureKeys: ['CustomProvider', 'getToken', 'getLimitedUseToken'],
    behavior: 'With `FIREBASE_APPCHECK_DEBUG_TOKEN` neither `true` nor a string, the SDK calls the `CustomProvider` and returns its token as given, caching it until its `expireTimeMillis`. When the provider rejects, `getToken` and `getLimitedUseToken` reject with its error, an `onTokenChanged` error handler receives it. AI Logic then depends on the handle: by default it gets the placeholder token and refuses the request with a 403, and with `useLimitedUseAppCheckTokens: true` no request is sent and the call rejects with `AIError` code `error`, message `Error fetching from <url>: <provider message>`.',
    evidence: 'Upstream source only, `@firebase/app-check` 0.11.3 `dist/esm/index.esm.js`: `initializeDebugMode` (lines 638 to 657), `getToken$2` (the provider path from line 783, `makeDummyTokenResult` on error), `getLimitedUseToken$1` (lines 847 to 861, no placeholder), `CustomProvider.getToken` (lines 1374 to 1388), and the public `getToken` rethrowing `result.error`; `@firebase/ai` 2.12.0 `dist/esm/index.esm.js` `getHeaders` (line 1619) awaited inside `makeRequest`\'s `try`, whose `catch` wraps the rejection (line 1717). A real-SDK Node run in the ai-app-check hunt (GATE-1) saw the provider called and its token, or the placeholder, sent to AI Logic. No committed capture.',
    notes: 'The sandbox cannot verify a token Google signed, so AI Logic\'s gate in the sandbox admits only a sandbox-signed token (one `pyric-admin` `createToken` or the sandbox mints). Upstream reads the debug global at the first `initializeAppCheck` in the page; the sandbox reads it at each one. The sandbox has no token refresher: with `isTokenAutoRefreshEnabled: true`, upstream `initializeAppCheck` adds an internal token listener that calls the provider at once, refreshes at the token\'s issue time plus half its TTL plus 5 minutes (no later than 5 minutes before expiry), and retries a failure with backoff from 30 seconds to 16 minutes (lines 909 to 975 and 1516 to 1520). The sandbox calls the provider only when a token is requested.',
  }),
  row({
    plane: 'app-check',
    rowRef: 'recaptcha-providers-construct',
    section: SEC_INIT,
    api: 'new ReCaptchaV3Provider(siteKey); new ReCaptchaEnterpriseProvider(siteKey)',
    featureKeys: ['ReCaptchaV3Provider', 'ReCaptchaEnterpriseProvider'],
    behavior: 'Both reCAPTCHA providers construct from a site key and are accepted by `initializeAppCheck` in a realm with a `document`, such as a page.',
    evidence: 'Upstream-documented only (firebase 12.13.0 typings and the App Check web guide). The oracle web app has no reCAPTCHA registration, so no capture exists; the sandbox never loads reCAPTCHA.',
  }),
  row({
    plane: 'app-check',
    rowRef: 'recaptcha-providers-without-document',
    section: SEC_INIT,
    api: 'initializeAppCheck(app, { provider: new ReCaptchaV3Provider(siteKey) }) with no `document`, and the same for ReCaptchaEnterpriseProvider',
    featureKeys: ['initializeAppCheck', 'ReCaptchaV3Provider', 'ReCaptchaEnterpriseProvider'],
    behavior: 'Where there is no `document`, such as a Node process or a server-rendered module, `initializeAppCheck` with either reCAPTCHA provider throws `ReferenceError: document is not defined` synchronously, with or without `FIREBASE_APPCHECK_DEBUG_TOKEN`. App Check is already set up for the app when it throws: a second call with the same options returns the handle, and one with other options throws `appCheck/already-initialized`.',
    evidence: 'Upstream source, `@firebase/app-check` 0.11.3 `dist/esm/index.esm.js`: `initializeAppCheck` creates the instance (line 1511) before `_activate` marks the app activated and calls `provider.initialize` last (line 1559); `ReCaptchaV3Provider.initialize` (line 1270) and `ReCaptchaEnterpriseProvider.initialize` (line 1347) call `initializeV3` and `initializeEnterprise`, whose `makeDiv` reads `document` (line 1133). A real-SDK run in plain Node 24 (firebase 12.13.0, offline) saw each provider throw the ReferenceError, debug token or not, then return the instance for the same options and throw `appCheck/already-initialized` for another site key. The package has no Node build. No committed capture. Integration: `test/apps/sandbox-app-check` (a registered Node process and a Vite server-rendered module).',
    errorText: true,
    notes: 'After the throw, upstream `getToken` with no debug token never settles in Node, since it waits for a reCAPTCHA widget that never loads; the sandbox mints a token there, as it does for a page.',
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
    rowRef: 'get-token-concurrent',
    flipped: 'oracle-backed',
    section: SEC_TOKENS,
    api: 'getToken(appCheck, forceRefresh?) called concurrently',
    featureKeys: ['getToken'],
    behavior: 'Production, debug mode: concurrent `getToken` calls share one in-flight exchange, `forceRefresh` calls included: two calls started together with no cached token resolve to one token, and two forced calls started together resolve to one new token. Listener calls are row `app-check#on-token-changed-refresh`.',
    evidence: 'capture `app-check-client-get-token-concurrent` (`concurrentFirstShareOneToken`, `concurrentForcedShareOneToken`, `forcedDiffersFromFirst`). Upstream `getToken` in `@firebase/app-check` 0.11.3 starts an exchange only `if (!state.exchangeTokenPromise)`.',
    observations: ['app-check-client-get-token-concurrent'],
    notes: 'In debug mode the capture also records 0 listener calls after each pair, the debug-mode early return that row `app-check#on-token-changed-refresh` documents as a by-design divergence. The sandbox notifies listeners once per shared exchange, which a unit case in the suite pins.',
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
    api: 'getAppCheck().verifyToken(token, options) with bad input, on another project, or with a foreign issuer, algorithm, subject, key, nbf, or exp',
    featureKeys: ['verifyToken'],
    behavior: 'Options that are not a non-null object throw `app-check/invalid-argument` with `VerifyAppCheckTokenOptions must be a non-null object.`, and a token that is not a string throws `App check token must be a non-null string.`; both throw synchronously. Then, with no project id configured, `app-check/invalid-credential`. A token with a character outside base64url in any segment fails with the decoding message. Before the signature, the token content is checked in this order: a header `alg` other than RS256 rejects with `The provided App Check token has incorrect algorithm. Expected "RS256" but got "<alg>".`; an `aud` without `projects/<projectId>` of the verifying app rejects with `app-check/invalid-argument` and `The provided App Check token has incorrect "aud" (audience) claim. Expected "projects/<projectId>" but got "<aud>". Make sure the App Check token comes from the same Firebase project as the service account used to authenticate this SDK.`; an `iss` not starting with `https://firebaseappcheck.googleapis.com/` rejects with `The provided App Check token has incorrect "iss" (issuer) claim.`; a `sub` that is not a string rejects with `The provided App Check token has no "sub" (subject) claim.`, and an empty one with `The provided App Check token has an empty string "sub" (subject) claim.` Then a token with no `kid` is checked against every key. A `kid` that names a key other than the sandbox\'s marks a token from Firebase: in sandbox AI mode it rejects with Pyric\'s message (row `verify-token-firebase-token`), and in production AI mode it goes to firebase-admin (row `verify-token-firebase-token-production-ai-mode`). After the signature, a non-numeric or future `nbf` and a non-numeric `exp` reject as an invalid signature; an absent `nbf` or `exp` does not apply.',
    evidence: 'Upstream-documented only: firebase-admin 13.10.0 `lib/app-check/token-verifier.js` (`verifyToken`, `verifyContent`, `ensureProjectId`, `mapJwtErrorToAppCheckError`), `lib/utils/jwt.js` (`getKeyCallback`, `PublicKeySignatureVerifier.verify`), jws 4 `verify-stream.js` (`JWS_REGEX`), and jsonwebtoken 9 `verify.js` (`nbf`, `exp`). No capture; verification runs locally in the Admin SDK, so a capture would need no production change.',
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
  row({
    plane: 'app-check-admin',
    rowRef: 'verify-token-firebase-token',
    diverged: 'by-design',
    section: SEC_ADMIN,
    api: 'getAppCheck().verifyToken(firebaseToken) in sandbox AI mode',
    featureKeys: ['verifyToken'],
    behavior: 'Production verifies the App Check tokens Firebase issues. Sandbox: in sandbox AI mode, or in a process not started with `@pyric/cli/register` in production AI mode, a token whose `kid` names a key other than the sandbox\'s rejects with `app-check/invalid-argument` and Pyric\'s message, which says the token was not minted by the Pyric sandbox and to start the server in production AI mode (`PYRIC_AI_MODE=production`). The project check comes first, as in production.',
    evidence: 'capture `app-check-admin-verify-token` (production verifies a token from its debug exchange); the sandbox side is pinned in the admin suite.',
    observations: ['app-check-admin-verify-token'],
    errorText: true,
    notes: 'Divergence, by design: the sandbox holds no Firebase keys and, in sandbox AI mode, never loads firebase-admin or reaches Google. The page gets such a token only in production AI mode. The code stays `invalid-argument`, so a server that branches on it still answers 401. The Vite SSR plane maps `firebase-admin/*` to this mirror without the register, so it keeps this message in production AI mode too.',
  }),
  row({
    plane: 'app-check-admin',
    rowRef: 'verify-token-firebase-token-production-ai-mode',
    section: SEC_ADMIN,
    api: 'getAppCheck().verifyToken(firebaseToken) under @pyric/cli/register in production AI mode',
    featureKeys: ['verifyToken'],
    behavior: 'A token whose `kid` names a key other than the sandbox\'s goes to firebase-admin\'s own `verifyToken`, for an app scoped to the project the mirror resolves. It resolves with production\'s `{ appId, token }` shape, the decoded token carrying `app_id`, and firebase-admin\'s errors (signature, audience, issuer, expiry) pass through with their codes and messages. Sandbox tokens, tokens with no `kid`, and malformed tokens keep the sandbox path.',
    evidence: 'capture `app-check-admin-verify-token` for the result shape; the verification itself is firebase-admin 13.10.0 `lib/app-check/token-verifier.js`, run unchanged.',
    observations: ['app-check-admin-verify-token'],
    notes: 'Unverified until the audit gate accepts its evidence: the assertion set runs in the climb lane, packages/pyric-admin/test/app-check/firebase-token.test.ts pins the hand-off on every run, and test/apps/ai-production-app-check/scenario.ts runs the real firebase-admin under `node --import @pyric/cli/register` against a stand-in for Firebase\'s public keys. The verifier\'s firebase-admin app holds no credentials: the only request it makes is the unauthenticated `GET https://firebaseappcheck.googleapis.com/v1/jwks`, cached for six hours. firebase-admin must be installed beside the server; without it the first such token rejects with `app-check/invalid-argument` and a message naming `npm install firebase-admin`. Not covered: a token Firebase itself issued, which would take a production capture through the bridge.',
  }),
  row({
    plane: 'app-check-admin',
    rowRef: 'verify-token-firebase-token-consume',
    diverged: 'by-design',
    section: SEC_ADMIN,
    api: 'getAppCheck().verifyToken(firebaseToken, { consume: true }) in production AI mode',
    featureKeys: ['verifyToken'],
    behavior: 'Production records consumption on Firebase\'s servers, once per project: the first consume resolves with `alreadyConsumed: false` and a second with `alreadyConsumed: true`. Sandbox: firebase-admin verifies the token without `consume`, and the mirror records it in the process, in the set it keeps for sandbox tokens, with the same `false` then `true` results.',
    evidence: 'capture `app-check-admin-verify-consume`; the sandbox side is pinned in the admin suite and the production AI mode app scenario.',
    observations: ['app-check-admin-verify-consume'],
    notes: 'Divergence, by design: production\'s consume is an authorized call that needs a credential with App Check permissions, and Pyric holds none. Forwarding it would write to production from a development loop. The record is lost on restart and each process keeps its own, as for sandbox tokens (#1297).',
  }),
  row({
    plane: 'app-check-admin',
    rowRef: 'project-from-cert',
    section: SEC_ADMIN,
    api: 'initializeApp({ credential: cert(serviceAccount) }), then getAppCheck().createToken and verifyToken',
    featureKeys: ['createToken', 'verifyToken'],
    behavior: 'An app initialized with only a cert credential finds its project in the service account\'s `project_id` (or `projectId`), so `createToken` mints a token whose `aud` names `projects/<project_id>` and `verifyToken` accepts it. The `projectId` app option wins over the credential, and the credential wins over `GOOGLE_CLOUD_PROJECT` and `GCLOUD_PROJECT`. The project id is not copied into `app.options`.',
    evidence: 'Upstream-documented only: firebase-admin 13.6.0 `lib/utils/index.js` (`getExplicitProjectId`) and `lib/app/credential-internal.js` (`ServiceAccount`, `copyAttr`). No capture; the project is resolved locally in the Admin SDK.',
    notes: 'Unverified until a capture vouches for it: the project is resolved locally in firebase-admin, but a capture needs a real service account, so the assertion set runs in the climb lane and packages/pyric-admin/test/app-check/project-id.test.ts pins the sandbox side on every run. Not claimed: production\'s `cert()` throws on a service account without a private key or client email, or on a file it cannot parse. Pyric\'s `cert()` is inert by design, keeps only the project id, and never throws, so apps run without a key on disk; a credential without a project id falls through to the environment.',
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
    appCheckHuntBlock,
  ],
};
