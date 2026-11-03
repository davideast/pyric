'use strict';

/**
 * The functions-callable oracle codebase (`pyric-functions-callable-oracle`).
 * The capture harness deploys this file unchanged, and the local conformance
 * suite serves the same file through pyric, so a row's two sides always ran
 * one source. It is a separate codebase from `pyric-functions-http-oracle`, so
 * that fixture and its unknown-function listing stay frozen.
 *
 * Every callable answers with a report of what the SDK handed it: claim and
 * key names, never token values.
 */
const { randomUUID } = require('node:crypto');
const { HttpsError, onCall } = require('firebase-functions/v2/https');
const functionsV1 = require('firebase-functions/v1');

let runtime = {};
try {
  runtime = require('./runtime.cjs');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

/** Identifies the process that served a call, so a restart is observable. */
const INSTANCE_ID = randomUUID();
const FAILURE_MARKER = 'PYRIC_EXPECTED_ONCALL_FAILURE';

const options = (extra) => ({ region: 'us-central1', ...runtime, ...extra });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}

/** Claim names and the issuer and audience forms of a verified ID token; no token values. */
function authReport(auth) {
  if (auth === undefined) return { present: false };
  if (auth === null) return { present: true, value: null };
  const token = auth.token ?? {};
  return {
    present: true,
    keys: Object.keys(auth).sort(),
    uidMatchesSub: auth.uid === token.sub,
    rawTokenPresent: typeof auth.rawToken === 'string',
    claimNames: Object.keys(token).sort(),
    firebaseClaimNames: token.firebase ? Object.keys(token.firebase).sort() : [],
    signInProvider: token.firebase?.sign_in_provider ?? null,
    iss: token.iss ?? null,
    aud: token.aud ?? null,
  };
}

/** The App Check data the SDK attached; claim names only. */
function appReport(app) {
  if (app === undefined) return { present: false };
  return {
    present: true,
    keys: Object.keys(app).sort(),
    appIdPresent: typeof app.appId === 'string',
    claimNames: app.token ? Object.keys(app.token).sort() : [],
    alreadyConsumed: app.alreadyConsumed ?? null,
  };
}

function report(data, context) {
  return {
    instanceId: INSTANCE_ID,
    dataType: typeOf(data),
    data,
    auth: authReport(context.auth),
    app: appReport(context.app),
    acceptsStreaming: context.acceptsStreaming ?? null,
    rawRequest: context.rawRequest
      ? { method: context.rawRequest.method, headerNames: Object.keys(context.rawRequest.headers).sort() }
      : null,
  };
}

/** Values `encode` meets on the way out; some of them it cannot encode. */
const RETURNS = {
  undefined: () => undefined,
  null: () => null,
  date: () => new Date('2026-01-02T03:04:05.006Z'),
  nan: () => Number.NaN,
  infinity: () => Number.POSITIVE_INFINITY,
  'large-integer': () => 9007199254740993,
  nested: () => ({ list: [1, 'two', true, null], inner: { when: new Date(0) } }),
};

/** Writes one Firestore document through firebase-admin before answering (local replay only). */
async function adminWrite(id) {
  const { getApps, initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const app = getApps()[0] ?? initializeApp();
  await getFirestore(app).doc(`pyric_oracle_callable/${id}`).set({ writtenBy: 'pyricCallableEcho', id });
}

const MODES = {
  echo: (data, context) => report(data, context),
  return: (data) => {
    const value = RETURNS[data.value];
    if (!value) throw new HttpsError('invalid-argument', 'unknown return value', { values: Object.keys(RETURNS) });
    return value();
  },
  throw: (data) => {
    throw new HttpsError(data.code, data.message, data.details);
  },
  'throw-plain': () => {
    throw new Error(FAILURE_MARKER);
  },
  'reject-plain': () => Promise.reject(new Error(FAILURE_MARKER)),
  'throw-string': () => {
    throw FAILURE_MARKER;
  },
  delay: async (data, context) => {
    await sleep(data.ms);
    return report(data, context);
  },
  'admin-write': async (data, context) => {
    await adminWrite(data.id);
    return report(data, context);
  },
};

/** Plain data echoes; `{ mode, ... }` picks a behavior from MODES. */
function dispatch(data, context) {
  const mode = data !== null && typeof data === 'object' && typeof data.mode === 'string' ? data.mode : 'echo';
  const run = MODES[mode];
  if (!run) throw new HttpsError('invalid-argument', 'unknown mode', { modes: Object.keys(MODES) });
  return run(data, context);
}

exports.pyricCallableEcho = onCall(options({}), (request) => dispatch(request.data, request));

exports.pyricCallableEnforced = onCall(options({ enforceAppCheck: true }), (request) => report(request.data, request));

exports.pyricCallableConsume = onCall(
  options({ enforceAppCheck: true, consumeAppCheckToken: true }),
  (request) => report(request.data, request),
);

/**
 * Streams `data.chunks` (default three), pausing `data.pauseMs` before the
 * result so a heartbeat can land, and fails after the first chunk when
 * `data.mode` is `throw`.
 */
exports.pyricCallableStream = onCall(options({ heartbeatSeconds: 1 }), async (request, response) => {
  const data = request.data ?? {};
  const chunks = Array.isArray(data.chunks) ? data.chunks : ['one', 'two', 'three'];
  const sendChunkResults = [];
  for (const [index, chunk] of chunks.entries()) {
    sendChunkResults.push(await response.sendChunk(chunk));
    if (data.mode === 'throw' && index === 0) {
      throw new HttpsError('failed-precondition', 'stream failed after one chunk', { after: 1 });
    }
  }
  if (typeof data.pauseMs === 'number') await sleep(data.pauseMs);
  return { acceptsStreaming: request.acceptsStreaming, sendChunkResults, signalAborted: response.signal.aborted };
});

exports.pyricCallableV1 = functionsV1
  .runWith(runtime.serviceAccount ? { serviceAccount: runtime.serviceAccount } : {})
  .https.onCall((data, context) => dispatch(data, context));
