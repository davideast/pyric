import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilityTableBlock } from './types.ts';

/**
 * firebase-admin App Check rows backed by the App Check and AI Logic hunt's
 * production captures (`app-check-admin-options-`, from
 * src/app-check-admin-option-probes.ts) and replayed against `pyric-admin` in
 * `packages/pyric-admin/test/app-check/hunt-captures.test.ts`.
 *
 * These rows are kept in their own table block so their witness is the shared
 * hunt-capture replay rather than `oracle-conformance.test.ts`'s one-assertion-
 * set-per-row partition over `appCheckRows`.
 */
const REPLAY = 'packages/pyric-admin/test/app-check/hunt-captures.test.ts';
const CREATE = 'app-check-admin-options-create-token';
const CONSUME = 'app-check-admin-options-same-jti-consume';
const CREATE_EVIDENCE = `\`oracle:${CREATE}\` + replay: \`${REPLAY}\`.`;

const SEC_ADMIN_OPTIONS = 'firebase-admin `createToken` options, checked against production captures';

const captureRow = defineRows({
  surface: 'app-check-admin',
  defaults: {
    section: SEC_ADMIN_OPTIONS,
    status: 'conforms',
    automation: 'oracle-backed',
    conformanceTests: [REPLAY],
    evidence: CREATE_EVIDENCE,
    oracleObservations: [CREATE],
  },
});

const appCheckHuntRows: CompatibilityRow[] = [
  captureRow({
    rowRef: 'create-token-limited-use-jti',
    featureKeys: ['createToken', 'verifyToken'],
    api: 'getAppCheck().createToken(appId, { limitedUse: true, jti }) twice, then verifyToken(token, { consume: true })',
    behavior: 'When `limitedUse` is `true` and `jti` is provided, the minted token carries the requested `jti` claim and a second `verifyToken(token, { consume: true })` of that same `jti` resolves `alreadyConsumed: true`.',
    evidence: `\`oracle:${CREATE}\` and \`oracle:${CONSUME}\` + replay: \`${REPLAY}\`.`,
    oracleObservations: [CREATE, CONSUME],
    notes: 'Capture keys: `limitedUse.withJti` (`jtiEqualsRequested`), and `consume` (`first` false, `secondSameJti` and `firstAgain` true). `sameTokens` varies across captures, so it is not pinned.',
  }),
  captureRow({
    rowRef: 'create-token-option-type-checks',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken(appId, { jti }) / ({ limitedUse: "yes" }) / ({ limitedUse: true, jti: 5 })',
    behavior: 'Rejects asynchronously with `app-check/invalid-argument` when `jti` is set without `limitedUse: true`, when `limitedUse` is not a boolean, or when `jti` is not a string.',
    notes: 'Capture keys `validation.jtiWithoutLimitedUse`, `validation.limitedUseString`, `validation.jtiNumber`: each rejects with `app-check/invalid-argument` and `` `jti` cannot be specified without setting `limitedUse` to `true`. ``, `` `limitedUse` must be a boolean value. ``, `` `jti` must be a string value. ``.',
  }),
  captureRow({
    rowRef: 'create-token-limited-use-ttl',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken(appId, { limitedUse: true })',
    behavior: 'When `limitedUse` is `true` and `ttlMillis` is omitted, `createToken` resolves `ttlMillis: 300000` with JWT lifetime `exp - iat` equal to `300` seconds.',
    notes: 'Capture key `limitedUse`: `ttlMillis` 300000 and `exp - iat` 300, with or without a `jti`.',
  }),
  captureRow({
    rowRef: 'create-token-options-object',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken(appId, null | "str" | [] | { ttlMillis: null })',
    behavior: 'Throws synchronously with `app-check/invalid-argument` when `options` is `null`, a primitive, or an array, or when `options.ttlMillis` is `null`.',
    notes: 'Capture keys `validation.optionsNull`, `optionsString`, `optionsArray` (`AppCheckTokenOptions must be a non-null object.`) and `validation.ttlNull` (`ttlMillis must be a duration in milliseconds.`), all `app-check/invalid-argument`.',
  }),
  captureRow({
    rowRef: 'create-token-ttl-type-message',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken(appId, { ttlMillis: NaN | "1800000" })',
    behavior: 'Throws synchronously with `app-check/invalid-argument` and message `ttlMillis must be a duration in milliseconds.` when `ttlMillis` is `NaN` or not a number.',
    notes: 'Capture keys `validation.ttlNaN`, `validation.ttlString`.',
  }),
  captureRow({
    rowRef: 'create-token-sync-throw',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken("") / createToken(appId, { ttlMillis: 1 }) and the other local option checks',
    behavior: 'Throws synchronously on an empty `appId`, non-object `options`, and non-number or out-of-range `ttlMillis`, while rejecting asynchronously on `limitedUse` and `jti` checks.',
    notes: 'Capture key `validation` (`mode` per case: `sync-throw` vs `rejected`).',
  }),
  captureRow({
    rowRef: 'create-token-fractional-ttl',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken(appId, { ttlMillis: 1800999 | 1800000.5 })',
    behavior: 'Rounds fractional `ttlMillis / 1000` for the JWT `exp - iat` claim and floors `ttlMillis` in the resolved `AppCheckToken` object.',
    notes: 'Capture key `fractionalTtl`: `1800999` gives `ttlMillis: 1800999` and `exp - iat: 1801`; `1800000.5` gives `ttlMillis: 1800000` and `exp - iat: 1800`.',
  }),
  captureRow({
    rowRef: 'verify-token-consume-key-order',
    featureKeys: ['verifyToken'],
    api: 'getAppCheck().verifyToken(token, { consume: true })',
    behavior: 'Resolves an object whose own property order is `alreadyConsumed`, `appId`, `token`.',
    evidence: `\`oracle:${CONSUME}\` + replay: \`${REPLAY}\`.`,
    oracleObservations: [CONSUME],
    notes: 'Capture key `consume` (`keyOrder`).',
  }),
];

export const appCheckHuntBlock: CompatibilityTableBlock = {
  kind: 'table',
  prefix: `## ${SEC_ADMIN_OPTIONS}\n\nEach row cites a production capture from \`app-check-admin-options\` and is replayed against \`pyric-admin/app-check\` in \`hunt-captures.test.ts\`.\n`,
  rows: appCheckHuntRows,
};
