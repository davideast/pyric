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

function tierFor(seed: Seed): Partial<CompatibilityRow> {
  const suite = APP_CHECK_SUITES[seed.plane];
  if (seed.unsupportedReason) {
    return { status: 'unsupported', automation: 'unsupported', exceptionReason: seed.unsupportedReason, risk: ['unsupported'], riskScore: 0, riskReasons: [seed.unsupportedReason] };
  }
  if (seed.diverged) {
    return { status: 'diverged-documented', automation: 'oracle-backed', conformanceDisposition: seed.diverged, conformanceTests: [suite] };
  }
  if (seed.flipped === 'oracle-backed') {
    return { status: 'conforms', automation: 'oracle-backed', conformanceTests: [suite], risk: [], riskScore: 0, riskReasons: [] };
  }
  if (seed.flipped === 'unit-backed') {
    return { status: 'conforms', automation: 'unit-backed', conformanceTests: [suite], ...riskFor(seed) };
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
    section: SEC_INIT,
    api: 'new ReCaptchaV3Provider(siteKey); new ReCaptchaEnterpriseProvider(siteKey); new CustomProvider({ getToken })',
    featureKeys: ['ReCaptchaV3Provider', 'ReCaptchaEnterpriseProvider', 'CustomProvider'],
    behavior: 'The three attestation providers construct and are accepted by `initializeAppCheck`. With a debug token in effect, the SDK never calls the provider (a `CustomProvider` whose `getToken` would reject is called zero times).',
    evidence: 'Construction is upstream-documented (firebase 12.13.0 typings). The provider-not-called fact: capture `app-check-client-debug-get-token` (`customProviderCalls`).',
    observations: ['app-check-client-debug-get-token'],
  }),
];

// Section: tokens -------------------------------------------------------------

const SEC_TOKENS = 'Tokens: `getToken`, `getLimitedUseToken`';
const tokenRows: CompatibilityRow[] = [
  row({
    plane: 'app-check',
    rowRef: 'get-token-before-initialize',
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
    section: SEC_TOKENS,
    api: 'getToken(appCheck, forceRefresh?): Promise<AppCheckTokenResult>',
    featureKeys: ['getToken', 'AppCheckTokenResult'],
    behavior: 'Resolves `{ token }` where `token` is a three-segment JWT: header `alg` RS256, `typ` JWT, with a `kid`; claims `aud`, `exp`, `iat`, `iss`, `jti`, `provider`, `sub`; `iss` is `https://firebaseappcheck.googleapis.com/<projectNumber>`, `aud` is `[projects/<projectNumber>, projects/<projectId>]`, `sub` is the app id, and `exp - iat` is 3600 seconds.',
    evidence: 'capture `app-check-client-debug-get-token` (`first`, `forced`).',
    observations: ['app-check-client-debug-get-token'],
  }),
  row({
    plane: 'app-check',
    rowRef: 'get-token-caching',
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
    section: SEC_TOKENS,
    api: 'getLimitedUseToken(appCheck): Promise<AppCheckTokenResult>',
    featureKeys: ['getLimitedUseToken'],
    behavior: 'Resolves `{ token }` with the same JWT shape as `getToken`, a different token on every call, never the cached token, and leaves the cached `getToken` token unchanged.',
    evidence: 'capture `app-check-client-limited-use-token`.',
    observations: ['app-check-client-limited-use-token'],
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
    notes: 'The sandbox has no attestation authority that can refuse; a sandbox knob that simulates refusal is a candidate, not a commitment.',
  }),
];

// Section: listeners and refresh ---------------------------------------------

const SEC_LISTEN = 'Listeners and refresh: `onTokenChanged`, `setTokenAutoRefreshEnabled`';
const listenRows: CompatibilityRow[] = [
  row({
    plane: 'app-check',
    rowRef: 'on-token-changed-existing-token',
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
    section: SEC_LISTEN,
    api: 'onTokenChanged(appCheck, listener | observer)',
    featureKeys: ['onTokenChanged'],
    behavior: 'In debug mode, listeners and observers registered before the first `getToken` are never called, not by the first token, a forced refresh, or limited-use tokens. Upstream documents that listeners are called whenever the token changes; that path (an attestation provider, not a debug token) is not captured.',
    evidence: 'capture `app-check-client-on-token-changed` (every `listenerCalls*` and `observerCallsTotal` count). The attested-provider behavior is upstream-documented only.',
    observations: ['app-check-client-on-token-changed'],
  }),
  row({
    plane: 'app-check',
    rowRef: 'set-auto-refresh',
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
    notes: 'The sandbox mints tokens in process and serves no App Check REST endpoint; a candidate for unsupported.',
  }),
];

// Section: firebase-admin -------------------------------------------------------

const SEC_ADMIN = 'firebase-admin `getAppCheck()`';
const adminRows: CompatibilityRow[] = [
  row({
    plane: 'app-check-admin',
    rowRef: 'create-token-shape',
    section: SEC_ADMIN,
    api: 'getAppCheck().createToken(appId)',
    featureKeys: ['createToken'],
    behavior: 'Resolves `{ token, ttlMillis: 3600000 }`; the token has the web SDK token shape (RS256 JWT with `kid`, claims `aud`, `exp`, `iat`, `iss`, `jti`, `provider`, `sub`, `exp - iat` 3600).',
    evidence: 'capture `app-check-admin-create-token-shape`.',
    observations: ['app-check-admin-create-token-shape'],
  }),
  row({
    plane: 'app-check-admin',
    rowRef: 'create-token-ttl',
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
    section: SEC_ADMIN,
    api: 'getAppCheck().createToken(unknownAppId)',
    featureKeys: ['createToken'],
    behavior: 'An app id the project does not own rejects with `app-check/unknown-error` and the message `App not registered: <appId>.`',
    evidence: 'capture `app-check-admin-create-token-unknown-app`.',
    observations: ['app-check-admin-create-token-unknown-app'],
    errorText: true,
  }),
  row({
    plane: 'app-check-admin',
    rowRef: 'verify-token',
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
    rowRef: 'verify-token-consume',
    section: SEC_ADMIN,
    api: 'getAppCheck().verifyToken(token, { consume: true })',
    featureKeys: ['verifyToken'],
    behavior: 'The first consume resolves with `alreadyConsumed: false`, a second consume with `alreadyConsumed: true`, and a plain verify afterwards has no `alreadyConsumed` key.',
    evidence: 'capture `app-check-admin-verify-consume`.',
    observations: ['app-check-admin-verify-consume'],
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
