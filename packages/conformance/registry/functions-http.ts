/**
 * Functions HTTP `onRequest`: every row born `unverified` under CDD
 * (`docs/conformance/cdd.md`). The row universe and its evidence plan are
 * `packages/conformance/docs/functions-http/plan.md`.
 *
 * Each row names its evidence kind:
 * - `observed`: needs a production observation from the `functions-http` rig.
 * - `upstream`: stated from firebase-functions 7.2.5 / firebase-tools 15.23.0 source.
 * - `pyric`: pyric-owned behavior with no production counterpart.
 */
import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

type EvidenceKind = 'observed' | 'upstream' | 'pyric';

/** Set only when the row's assertion set passes unweakened. */
type Flip =
  | { status: 'conforms'; tests: string[] }
  | { status: 'unsupported'; reason: string; tests: string[] };

interface RowSeed {
  ref: number;
  api: string;
  behavior: string;
  evidence: string;
  kind: EvidenceKind;
  observations?: string[];
  flip?: Flip;
}

const SUITE = 'packages/cli/test/functions-http/oracle-conformance.test.ts';
const VITE_PLANE = 'packages/cli/test/functions-http/vite-plane.test.ts';

const RISK_BY_KIND: Record<EvidenceKind, { risk: string; riskScore: number; reason: string }> = {
  observed: {
    risk: 'unobserved',
    riskScore: 2,
    reason: 'Production behavior is not captured yet; the functions-http rig owns the observation.',
  },
  upstream: {
    risk: 'unobserved',
    riskScore: 1,
    reason: 'Behavior stated from the firebase-functions 7.2.5 and firebase-tools 15.23.0 source; no production capture backs it.',
  },
  pyric: {
    risk: 'pyric-owned',
    riskScore: 1,
    reason: 'Pyric-owned development behavior with no production counterpart; a unit or integration assertion backs it at flip.',
  },
};

const CITED_NOT_REPLAYED_REASON =
  'Production observed and cited, but pyric does not serve onRequest functions yet.';

const buildRow = defineRows({
  surface: 'functions-http',
  defaults: { section: '`firebase-functions/v2/https.onRequest`', featureKeys: ['onRequest'] },
});

function flipped(seed: RowSeed, flip: Flip): CompatibilityRow {
  const { ref, kind: _kind, observations = [], flip: _flip, ...rest } = seed;
  const evidence = `${seed.evidence} Local assertion: \`${SUITE}\` assertion set \`functions-http#${ref}\`.`;
  const shared = { ...rest, evidence, rowRef: String(ref), oracleObservations: observations, conformanceTests: flip.tests };
  if (flip.status === 'unsupported') {
    return buildRow({ ...shared, status: 'unsupported', automation: 'unsupported', exceptionReason: flip.reason });
  }
  return buildRow({ ...shared, status: 'conforms', automation: 'unit-backed' });
}

function row(seed: RowSeed): CompatibilityRow {
  if (seed.flip) return flipped(seed, seed.flip);
  const { ref, kind, observations = [], ...rest } = seed;
  const observed = observations.length > 0;
  const risk = RISK_BY_KIND[kind];
  return buildRow({
    ...rest,
    rowRef: String(ref),
    oracleObservations: observations,
    status: 'unverified',
    automation: 'unverified',
    risk: [observed ? 'cited-not-replayed' : risk.risk],
    riskScore: observed ? 1 : risk.riskScore,
    riskReasons: [observed ? CITED_NOT_REPLAYED_REASON : risk.reason],
  });
}

export const functionsHttpRows: CompatibilityRow[] = [
  row({
    ref: 1,
    kind: 'pyric',
    api: 'onRequest(handler) / onRequest(options, handler)',
    behavior:
      'A discovered v2 onRequest export is served at /{projectId}/{region}/{name} on the sandbox server and the Vite dev server; the region comes from the options, then setGlobalOptions, then us-central1.',
    evidence:
      'upstream: the emulator routes /{projectId}/:region/:trigger_name (firebase-tools `lib/emulator/functionsEmulator.js:151-153`) and the SDK sets `__endpoint.httpsTrigger` and `region` (`lib/v2/providers/https.js:44-108`). Region resolution: `packages/cli/test/functions-http/discovery.test.ts`; the Vite plane: `packages/cli/test/functions-http/vite-plane.test.ts`.',
    flip: {
      status: 'conforms',
      tests: [SUITE, 'packages/cli/test/functions-http/discovery.test.ts', 'packages/cli/test/functions-http/routes.test.ts', VITE_PLANE],
    },
  }),
  row({
    ref: 2,
    kind: 'observed',
    api: 'functions.https.onRequest(handler) (v1)',
    behavior:
      'v1 functions.https.onRequest and functions.region(r).https.onRequest exports are served the same way as v2, with us-central1 when no region is set.',
    evidence:
      'upstream: v1 sets the same `httpsTrigger` with `platform: "gcfv1"` (`lib/v1/providers/https.js:33-50`). Production behavior needs `functions-http-onrequest-v1`.',
  }),
  row({
    ref: 3,
    kind: 'observed',
    api: 'req.method, req.query, req.headers',
    behavior:
      'The request method, the parsed query (repeated and bracketed keys), and the request headers reach the handler; the names of the headers production adds or strips match.',
    evidence: 'Production behavior needs `functions-http-onrequest-basic-get`.',
  }),
  row({
    ref: 4,
    kind: 'observed',
    api: 'req.path, req.url, req.originalUrl, req.baseUrl',
    behavior:
      'The handler sees the path after the function name, with / for the function root, as production shows it on cloudfunctions.net and on the run.app URL.',
    evidence:
      'upstream: the emulator strips the /{project}/{region}/{name} prefix (`functionsEmulator.js:1264`). Production behavior needs `functions-http-onrequest-subpath`.',
  }),
  row({
    ref: 5,
    kind: 'observed',
    api: 'req.body, req.rawBody',
    behavior: 'A JSON body is parsed to req.body, and req.rawBody holds the exact request bytes.',
    evidence:
      'upstream: functions-framework-nodejs parses json and saves rawBody; the emulator matches the parser order (`functionsEmulatorRuntime.js:543-561`). Production behavior needs `functions-http-onrequest-body-parsing`.',
  }),
  row({
    ref: 6,
    kind: 'observed',
    api: 'req.body, req.rawBody',
    behavior:
      'text, urlencoded (extended), octet-stream, an unknown content type, no content type, and an empty body map to req.body and req.rawBody as production maps them.',
    evidence: 'Production behavior needs `functions-http-onrequest-body-parsing`.',
  }),
  row({
    ref: 7,
    kind: 'observed',
    api: 'onRequest body parsing',
    behavior:
      'A JSON body that does not parse is refused before the handler runs, with the status, content type, and body production answers.',
    evidence: 'Production behavior needs `functions-http-onrequest-malformed-json`.',
  }),
  row({
    ref: 8,
    kind: 'observed',
    api: 'res.status, res.set, res.json, res.redirect, res.cookie, res.write',
    behavior:
      'Status codes, headers, JSON bodies, redirects, cookies, empty responses, and streamed res.write chunks arrive unchanged, with no x-powered-by header.',
    evidence:
      'upstream: functions-framework-nodejs disables `x-powered-by`. Production behavior needs `functions-http-onrequest-response-shapes`.',
  }),
  row({
    ref: 9,
    kind: 'observed',
    api: 'onRequest handler failure',
    behavior: 'A handler that throws, or returns a rejected promise, before responding answers 500 Internal Server Error.',
    evidence:
      'upstream: `withErrorHandler` logs "Unhandled error" and answers 500 when headers are unsent (`lib/common/providers/https.js:563-574`). Production behavior needs `functions-http-onrequest-handler-failure`.',
  }),
  row({
    ref: 10,
    kind: 'observed',
    api: 'onRequest handler failure',
    behavior:
      'A handler that throws after sending headers and part of the body ends the response; the client receives what production shows.',
    evidence: 'Production behavior needs `functions-http-onrequest-headers-sent-failure`.',
  }),
  row({
    ref: 11,
    kind: 'observed',
    api: 'onRequest({ timeoutSeconds }, handler)',
    behavior:
      'A handler that never responds is cut at timeoutSeconds (60 when unset) with the status production answers.',
    evidence:
      'upstream: the emulator defaults timeoutSeconds to 60 (`functionsEmulatorShared.js:97`) and destroys the socket on expiry (`functionsRuntimeWorker.js:115-141`), which production need not match. Production behavior needs `functions-http-onrequest-no-response-timeout`.',
  }),
  row({
    ref: 12,
    kind: 'observed',
    api: 'onRequest handler failure',
    behavior:
      'An exception thrown asynchronously outside the handler (a timer callback) has the production outcome for the request; RTDB triggers served by the same pyric child keep running.',
    evidence:
      'Owner decision: the shared pyric child catches the exception rather than restarting, because RTDB triggers run in it. Production behavior needs `functions-http-onrequest-uncaught-async`.',
  }),
  row({
    ref: 13,
    kind: 'observed',
    api: 'onRequest({ cors }, handler)',
    behavior:
      'With cors unset, responses carry no CORS headers and an OPTIONS request reaches the handler, unlike the Functions emulator, which enables CORS for every onRequest function.',
    evidence:
      'upstream: the emulator forces `enableCors: true` unless `cors: false` (`functionsEmulator.js:990-993`, `https.js:55-57`). Production behavior needs `functions-http-onrequest-cors-unset`.',
  }),
  row({
    ref: 14,
    kind: 'observed',
    api: 'onRequest({ cors }, handler)',
    behavior:
      'cors: true, a string list, and a RegExp answer preflights in the SDK middleware and reflect an allowed origin or omit the header for a denied one.',
    evidence:
      'upstream: the SDK wraps the handler in the `cors` package with `origin` from the option (`https.js:53-71`). Production behavior needs `functions-http-onrequest-cors-configured`.',
  }),
  row({
    ref: 15,
    kind: 'observed',
    api: "onRequest({ invoker: 'private' }, handler)",
    behavior:
      "Production refuses an unauthenticated call to an invoker: 'private' function with 403. Pyric serves it, warns once per function, and records the difference as a by-design divergence.",
    evidence:
      'upstream: the emulator never enforces `invoker` (no reference in `lib/emulator`). Owner decision: serve and warn. Production behavior needs `functions-http-onrequest-invoker-private`.',
  }),
  row({
    ref: 16,
    kind: 'observed',
    api: 'onRequest routing',
    behavior: 'A request for a function name the project does not define answers with the production 404 shape.',
    evidence:
      'upstream: the emulator answers `404 Function X does not exist, valid functions are: ...` (`functionsEmulator.js:1233-1247`). Production behavior needs `functions-http-onrequest-not-found`.',
  }),
  row({
    ref: 17,
    kind: 'observed',
    api: 'firebase.json hosting.rewrites[].function',
    behavior:
      'A hosting rewrite to a function routes the full original path and query, honors { functionId, region } (us-central1 by default), and forwards only the __session cookie.',
    evidence:
      'upstream: firebase-tools appends the original req.url and forwards only `__session` plus X-Forwarded-Host and X-Original-Url (`lib/hosting/functionsProxy.js:20-31`, `lib/hosting/proxy.js:29-50`). Production behavior needs `functions-http-hosting-rewrite`.',
  }),
  row({
    ref: 18,
    kind: 'pyric',
    api: 'firebase-admin inside onRequest',
    behavior:
      'A firebase-admin write the handler awaits is visible to a client of the same sandbox before the HTTP response arrives.',
    evidence:
      'The child runs with PYRIC_SANDBOX=remote:<serveUrl> and pre-initializes the ambient firebase-admin app; a bare initializeApp() returns it (`pyric-admin/src/app/index.ts:131-139`). Both planes: the suite and `packages/cli/test/functions-http/vite-plane.test.ts` read the document from the peer sandbox as soon as the response arrives.',
    flip: { status: 'conforms', tests: [SUITE, VITE_PLANE] },
  }),
  row({
    ref: 19,
    kind: 'upstream',
    api: 'onRequest({ maxInstances, minInstances, concurrency, memory, cpu }, handler)',
    behavior:
      'Requests to one function run concurrently. maxInstances, minInstances, concurrency, memory, and cpu are deploy-time scaling options that pyric reads and does not apply: it has no instance model.',
    evidence:
      'upstream: these options only shape the deployed Cloud Run service (`__endpoint` fields read by firebase-tools at deploy).',
    flip: {
      status: 'unsupported',
      reason:
        'maxInstances, minInstances, concurrency, memory, and cpu size the deployed Cloud Run service; pyric runs one child per session with no instance model, so it serves every request concurrently and applies none of them. The assertion set pins concurrent serving, including for a maxInstances: 1 function.',
      tests: [SUITE],
    },
  }),
  row({
    ref: 20,
    kind: 'pyric',
    api: 'onRequest routing',
    behavior:
      'A request to a discovered function while the child is starting, reloading, or waiting for a sandbox peer answers 503 with a message naming the cause, never a static 404.',
    evidence: 'Pyric-owned lifecycle (`packages/cli/src/functions/development-runtime.ts`).',
  }),
  row({
    ref: 21,
    kind: 'pyric',
    api: 'onRequest execution record',
    behavior:
      'Each request a function serves lands one execution record with an http cause (method, path, status); in browser mode the first slice records it as a log line.',
    evidence:
      'Pyric-owned: `execution_finished` on the sandbox event stream (`packages/cli/src/functions/events.ts`). Owner decision: log lines only in browser mode for the first slice.',
  }),
];

const INTRO = `# Firebase Functions HTTP integration compatibility

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming**: unchanged source matches production under replay |
| ⚠ | **Diverged (documented)**: intentional difference with a written reason |
| ✗ | **Bug**: should match production but does not |
| — | **Not implemented yet**: explicitly outside the implemented slice |
| ? | **Unverified**: production target or local replay is incomplete |
`;

export const functionsHttpRegistry: CompatibilitySurfaceRegistry = {
  surface: 'functions-http',
  label: 'Functions · HTTP',
  compatPath: 'packages/cli/docs/functions-http/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    {
      kind: 'table',
      prefix: '## `onRequest` serving, request, and response contract\n',
      rows: functionsHttpRows,
    },
  ],
};
