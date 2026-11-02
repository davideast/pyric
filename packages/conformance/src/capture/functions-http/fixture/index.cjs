'use strict';

/**
 * The functions-http oracle codebase. The capture harness deploys this file
 * unchanged, and the local conformance suite serves the same file through
 * pyric, so a row's two sides always ran one source.
 */
const { randomUUID } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const functionsV1 = require('firebase-functions/v1');

let runtime = {};
try {
  runtime = require('./runtime.cjs');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

/** Identifies the process that served a request, so a restart is observable. */
const INSTANCE_ID = randomUUID();
const FAILURE_MARKER = 'PYRIC_EXPECTED_ONREQUEST_FAILURE';
const UNCAUGHT_MARKER = 'PYRIC_EXPECTED_ONREQUEST_UNCAUGHT';

/** Request headers whose values the report keeps; every other header reports only its name. */
const REPORTED_HEADER_VALUE = /^(x-pyric-|content-type$|accept$|origin$|cookie$|access-control-request-|x-forwarded-host$|x-original-url$)/;

const options = (extra) => ({ region: 'us-central1', ...runtime, ...extra });

function encodeBody(body) {
  if (Buffer.isBuffer(body)) return { bodyType: 'buffer', body: body.toString('base64') };
  if (body === undefined) return { bodyType: 'undefined', body: null };
  if (body === null) return { bodyType: 'null', body: null };
  return { bodyType: typeof body, body };
}

function requestReport(req) {
  const headerNames = Object.keys(req.headers).sort();
  const headerValues = {};
  for (const name of headerNames) {
    if (REPORTED_HEADER_VALUE.test(name)) headerValues[name] = req.headers[name];
  }
  return {
    instanceId: INSTANCE_ID,
    method: req.method,
    url: req.url,
    path: req.path,
    originalUrl: req.originalUrl,
    baseUrl: req.baseUrl,
    query: req.query,
    headerNames,
    headerValues,
    ...encodeBody(req.body),
    rawBody: Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('base64') : null,
  };
}

/** Writes one Firestore document through firebase-admin before answering (local replay only). */
async function adminWrite(id) {
  const { getApps, initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const app = getApps()[0] ?? initializeApp();
  await getFirestore(app).doc(`pyric_oracle_http/${id}`).set({ writtenBy: 'pyricHttpEcho', id });
}

async function echo(req, res) {
  if (typeof req.query.adminWrite === 'string') await adminWrite(req.query.adminWrite);
  res.json(requestReport(req));
}

exports.pyricHttpEcho = onRequest(options({}), echo);

exports.pyricHttpRegional = onRequest(options({ region: 'us-east1' }), echo);

exports.pyricHttpPrivate = onRequest(options({ invoker: 'private' }), echo);

exports.pyricHttpCorsTrue = onRequest(options({ cors: true }), echo);

exports.pyricHttpCorsList = onRequest(options({ cors: ['https://allowed.example'] }), echo);

exports.pyricHttpCorsRegex = onRequest(options({ cors: /^https:\/\/allowed\.example$/ }), echo);

exports.pyricHttpV1 = functionsV1
  .runWith(runtime.serviceAccount ? { serviceAccount: runtime.serviceAccount } : {})
  .https.onRequest(echo);

const RESPONSE_SHAPES = {
  json(res) {
    res.status(201).set('x-pyric-custom', 'yes').json({ ok: true, shape: 'json' });
  },
  redirect(res) {
    res.redirect('/elsewhere?from=redirect');
  },
  status(res) {
    res.status(418).send('teapot');
  },
  empty(res) {
    res.status(204).end();
  },
  cookies(res) {
    res.cookie('pyric_a', '1');
    res.append('Set-Cookie', 'pyric_b=2; Path=/');
    res.send('cookies');
  },
  stream(res) {
    res.status(200).set('content-type', 'text/plain');
    res.write('chunk-1\n');
    setTimeout(() => {
      res.write('chunk-2\n');
      res.end('chunk-3\n');
    }, 250);
  },
};

exports.pyricHttpResponses = onRequest(options({}), (req, res) => {
  const shape = RESPONSE_SHAPES[req.query.shape];
  if (!shape) {
    res.status(400).json({ error: 'unknown shape', shapes: Object.keys(RESPONSE_SHAPES) });
    return;
  }
  shape(res);
});

exports.pyricHttpThrow = onRequest(options({}), (req) => {
  if (req.query.mode === 'reject') return Promise.reject(new Error(FAILURE_MARKER));
  throw new Error(FAILURE_MARKER);
});

exports.pyricHttpThrowAfterHeaders = onRequest(options({}), (req, res) => {
  res.status(200).set('content-type', 'text/plain');
  res.write('partial');
  if (req.query.mode === 'reject') return Promise.reject(new Error(FAILURE_MARKER));
  throw new Error(FAILURE_MARKER);
});

/** Never answers, so the platform's request timeout decides the response. */
exports.pyricHttpTimeout = onRequest(options({ timeoutSeconds: 5 }), () => new Promise(() => {}));

/**
 * One instance at most, so `whoami` after an uncaught throw tells whether the
 * process that threw is still the one serving.
 */
exports.pyricHttpUncaught = onRequest(options({ maxInstances: 1 }), (req, res) => {
  const throwSoon = () => setTimeout(() => {
    throw new Error(UNCAUGHT_MARKER);
  }, 10);
  if (req.query.mode === 'after-response') {
    res.json({ instanceId: INSTANCE_ID });
    throwSoon();
    return;
  }
  if (req.query.mode === 'before-response') {
    throwSoon();
    return;
  }
  res.json({ instanceId: INSTANCE_ID });
});
