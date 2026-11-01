import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilityTableBlock } from './types.ts';

/**
 * firebase-admin App Check rows backed by the App Check and AI Logic hunt's
 * production captures (`app-check-admin-options-`, from
 * src/app-check-admin-option-probes.ts). Each row is a `bug`: production's
 * behavior and pyric's differ, and the replay in REPLAY pins both answers
 * under the hunt's finding ID until its fix removes the pin.
 *
 * A non-conforming row's behavior and evidence ship as browser caveats under
 * a byte budget (can-i-use-template.test.ts), so each behavior is one
 * sentence, rows share one evidence string per capture, and the capture keys
 * and messages are in `notes`.
 *
 * These rows are not in `appCheckRows`: their witness is the replay, not the
 * admin oracle suite's one-assertion-set-per-row partition.
 */
const REPLAY = 'packages/pyric-admin/test/app-check/hunt-captures.test.ts';
const CREATE = 'app-check-admin-options-create-token';
const CONSUME = 'app-check-admin-options-same-jti-consume';
const CREATE_EVIDENCE = `\`oracle:${CREATE}\`.`;

export const SEC_ADMIN_OPTIONS = 'firebase-admin `createToken` options, checked against production captures';

const captureRow = defineRows({
  surface: 'app-check-admin',
  defaults: {
    section: SEC_ADMIN_OPTIONS,
    status: 'bug',
    automation: 'oracle-backed',
    conformanceDisposition: 'pending-fix',
    conformanceTests: [REPLAY],
    evidence: CREATE_EVIDENCE,
    oracleObservations: [CREATE],
  },
});

const ERROR_TEXT = {
  risk: ['error-code'],
  riskScore: 2,
  riskReasons: ['asserts production error codes and message text that can drift on re-capture'],
};
const VALUES = (count: number) => ({ risk: ['specific-value'], riskScore: 2, riskReasons: [`asserts ${count} specific value(s)`] });

export const appCheckHuntRows: CompatibilityRow[] = [
  captureRow({
    rowRef: 'create-token-limited-use-jti',
    featureKeys: ['createToken', 'verifyToken'],
    api: 'getAppCheck().createToken(appId, { limitedUse: true, jti }) twice, then verifyToken(token, { consume: true })',
    behavior: 'AC-1: pyric ignores jti, so two same-jti tokens differ and both first consumes say false; production returns one token and the second consume says true.',
    evidence: `\`oracle:${CREATE}\` and \`oracle:${CONSUME}\`.`,
    oracleObservations: [CREATE, CONSUME],
    ...VALUES(3),
    notes: 'Capture keys: `limitedUse.withJti` (`jtiEqualsRequested`), and `sameTokens` and `consume` (first false, second and first again true).',
  }),
  captureRow({
    rowRef: 'create-token-option-type-checks',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken(appId, { jti }) / ({ limitedUse: "yes" }) / ({ limitedUse: true, jti: 5 })',
    behavior: 'AC-1c, AC-1d, AC-1e: production rejects jti without limitedUse, a non-boolean limitedUse and a non-string jti; pyric mints a token.',
    ...ERROR_TEXT,
    notes: 'Capture keys `validation.jtiWithoutLimitedUse`, `validation.limitedUseString`, `validation.jtiNumber`: each rejects with `app-check/invalid-argument` and `` `jti` cannot be specified without setting `limitedUse` to `true`. ``, `` `limitedUse` must be a boolean value. ``, `` `jti` must be a string value. ``.',
  }),
  captureRow({
    rowRef: 'create-token-limited-use-ttl',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken(appId, { limitedUse: true })',
    behavior: 'AC-1f: production limited-use tokens live 300 s; pyric gives them 3600 s.',
    ...VALUES(2),
    notes: 'Capture key `limitedUse`: `ttlMillis` 300000 and `exp - iat` 300, with or without a jti.',
  }),
  captureRow({
    rowRef: 'create-token-options-object',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken(appId, null | "str" | [] | { ttlMillis: null })',
    behavior: 'AC-2: production throws for null, string or array options and a null ttlMillis; pyric mints a token.',
    ...ERROR_TEXT,
    notes: 'Capture keys `validation.optionsNull`, `optionsString`, `optionsArray` (`AppCheckTokenOptions must be a non-null object.`) and `validation.ttlNull` (`ttlMillis must be a duration in milliseconds.`), all `app-check/invalid-argument`.',
  }),
  captureRow({
    rowRef: 'create-token-ttl-type-message',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken(appId, { ttlMillis: NaN | "1800000" })',
    behavior: 'AC-3: for a ttlMillis that is not a number, pyric gives the range message instead of production\'s duration message.',
    ...ERROR_TEXT,
    notes: 'Capture keys `validation.ttlNaN`, `validation.ttlString`: production `ttlMillis must be a duration in milliseconds.`; pyric `... between 30 minutes and 7 days (inclusive).`',
  }),
  captureRow({
    rowRef: 'create-token-sync-throw',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken("") / createToken(appId, { ttlMillis: 1 }) and the other local option checks',
    behavior: 'AC-4: production throws createToken input errors synchronously; pyric returns a rejected promise.',
    ...ERROR_TEXT,
    notes: 'Capture key `validation` (`mode` per case): an empty app id, options that are not an object, and a ttlMillis that is not a number or is out of range throw; the jti and limitedUse checks reject. Pyric already gives production\'s code and message for `ttlMillis: 1` and for an empty app id; only the synchronous throw differs.',
  }),
  captureRow({
    rowRef: 'create-token-fractional-ttl',
    featureKeys: ['createToken'],
    api: 'getAppCheck().createToken(appId, { ttlMillis: 1800999 | 1800000.5 })',
    behavior: 'AC-5: for fractional ttlMillis pyric echoes the value and floors the lifetime; production rounds both.',
    ...VALUES(4),
    notes: 'Capture key `fractionalTtl`: production 1800999 gives ttlMillis 1800999 and `exp - iat` 1801, 1800000.5 gives 1800000 and 1800; pyric gives 1800999 and 1800, 1800000.5 and 1800.',
  }),
  captureRow({
    rowRef: 'verify-token-consume-key-order',
    featureKeys: ['verifyToken'],
    api: 'getAppCheck().verifyToken(token, { consume: true })',
    behavior: 'AC-12: the consume result key order is alreadyConsumed, appId, token in production; pyric puts alreadyConsumed last.',
    evidence: `\`oracle:${CONSUME}\`.`,
    oracleObservations: [CONSUME],
    ...VALUES(1),
    notes: 'Capture key `consume` (`keyOrder`).',
  }),
];

export const appCheckHuntBlock: CompatibilityTableBlock = {
  kind: 'table',
  prefix: `## ${SEC_ADMIN_OPTIONS}\n\nEach row cites a production capture from the App Check and AI Logic hunt. A \`bug\` row states production's behavior and pyric's; its replay holds both answers until the fix lands.\n`,
  rows: appCheckHuntRows,
};
