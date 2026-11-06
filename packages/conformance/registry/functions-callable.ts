/**
 * Functions callable `onCall` and the `firebase/functions` client: every row
 * born `unverified` under CDD (`docs/conformance/cdd.md`). The row universe and
 * its evidence plan are `packages/conformance/docs/functions-callable/plan.md`.
 *
 * Each row names its evidence kind:
 * - `observed`: needs a production observation from the functions-callable capture.
 * - `upstream`: stated from firebase-functions 7.2.5, firebase-admin 13.10.0,
 *   and @firebase/functions 0.14.0 (firebase 12.19.0) source.
 * - `pyric`: pyric-owned behavior with no production counterpart.
 *
 * Upstream line references are to `lib/common/providers/https.js` in
 * firebase-functions 7.2.5 unless a row names another file.
 */
import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

type EvidenceKind = 'observed' | 'upstream' | 'pyric';

interface RowSeed {
  ref: number;
  api: string;
  behavior: string;
  evidence: string;
  kind: EvidenceKind;
}

const RISK_BY_KIND: Record<EvidenceKind, { risk: string; riskScore: number; reason: string }> = {
  observed: {
    risk: 'unobserved',
    riskScore: 2,
    reason: 'Production behavior is not captured yet; the functions-callable capture owns the observation.',
  },
  upstream: {
    risk: 'unobserved',
    riskScore: 1,
    reason:
      'Behavior stated from the firebase-functions 7.2.5, firebase-admin 13.10.0, and @firebase/functions 0.14.0 source; no production capture backs it.',
  },
  pyric: {
    risk: 'pyric-owned',
    riskScore: 1,
    reason: 'Pyric-owned development behavior with no production counterpart; a unit or integration assertion backs it at flip.',
  },
};

const buildRow = defineRows({
  surface: 'functions-callable',
  defaults: { section: '`firebase-functions/v2/https.onCall`', featureKeys: ['onCall'] },
});

function row(seed: RowSeed): CompatibilityRow {
  const { ref, kind, ...rest } = seed;
  const risk = RISK_BY_KIND[kind];
  return buildRow({
    ...rest,
    rowRef: String(ref),
    oracleObservations: [],
    status: 'unverified',
    automation: 'unverified',
    risk: [risk.risk],
    riskScore: risk.riskScore,
    riskReasons: [risk.reason],
  });
}

const CLIENT = '@firebase/functions 0.14.0 `dist/esm/index.esm.js`';

export const functionsCallableRows: CompatibilityRow[] = [
  row({
    ref: 1,
    kind: 'observed',
    api: 'onCall(handler): {data} and {result}',
    behavior:
      'A POST of {"data": x} reaches v2 request.data (v1: the data argument) for every JSON value kind, and the return value answers 200 application/json {"result": value}. A handler that returns null or undefined answers {"result": null}.',
    evidence:
      'upstream: `wrapOnCallHandler` decodes `req.body.data` and answers `res.status(200).send({ result })` (`:462`, `:516-524`); `encode` maps null and undefined to null (`:164-167`). Production behavior needs `functions-callable-data-roundtrip`.',
  }),
  row({
    ref: 2,
    kind: 'observed',
    api: 'callable data encoding',
    behavior:
      'Request data: an Int64Value or UInt64Value {"@type", value} wrapper decodes to a JavaScript number (so precision past 2^53 is lost); a wrapper whose value is not a number, and any other @type, answer 500 INTERNAL. Result data: a Date encodes as {} on the server, NaN and Infinity cannot be encoded and answer 500 INTERNAL, and an integer above 2^53 is sent as a plain JSON number. Client side: httpsCallable sends a Date as its ISO string and undefined data as null, and rejects NaN and Infinity in request data before sending.',
    evidence: `upstream: server \`encode\` and \`decode\` (\`:156-230\`) run inside the handler's try, so their throws become INTERNAL (\`:528-534\`); client \`encode\` and \`decode\` in ${CLIENT} (\`:41-108\`). Production behavior needs \`functions-callable-encoding\` and \`functions-callable-client-encoding\`.`,
  }),
  row({
    ref: 3,
    kind: 'observed',
    api: 'HttpsError(code, message, details)',
    behavior:
      'Each code answers its HTTP status: ok 200, cancelled 499, unknown 500, invalid-argument 400, deadline-exceeded 504, not-found 404, already-exists 409, permission-denied 403, unauthenticated 401, resource-exhausted 429, failed-precondition 400, aborted 409, out-of-range 400, unimplemented 501, internal 500, unavailable 503, data-loss 500. The body is {"error": {"message", "status": "<CANONICAL_NAME>", "details"}}, with details omitted when the handler passed none. An unknown code throws in the HttpsError constructor and answers 500 INTERNAL.',
    evidence:
      'upstream: `errorCodeMap` and `HttpsError.toJSON` (`:29-124`), and the catch that answers `res.status(status).send({ error })` (`:528-542`). Production behavior needs `functions-callable-https-error-codes`.',
  }),
  row({
    ref: 4,
    kind: 'observed',
    api: 'onCall handler failure',
    behavior:
      'A handler that throws an Error, returns a rejected promise, or throws a value that is not an Error answers 500 {"error": {"message": "INTERNAL", "status": "INTERNAL"}} on v2 and v1. The thrown message never reaches the client.',
    evidence:
      'upstream: a throw that is not an HttpsError is logged as "Unhandled error" and replaced by `new HttpsError("internal", "INTERNAL")` (`:530-534`). Production behavior needs `functions-callable-plain-throw`.',
  }),
  row({
    ref: 5,
    kind: 'observed',
    api: 'callable request validation',
    behavior:
      'A request that is not POST, whose Content-Type is not application/json (a charset parameter is allowed), that has no body, whose JSON has no data key, or whose JSON has keys besides data answers 400 {"error": {"message": "Bad Request", "status": "INVALID_ARGUMENT"}} before the handler runs. {"data": null} is served. Malformed JSON gets the answer production\'s body parser gives, which the capture records.',
    evidence:
      'upstream: `isValidRequest` (`:126-154`) and the throw it guards (`:419-422`). The body parser runs before the SDK, in functions-framework-nodejs. Production behavior needs `functions-callable-bad-request`.',
  }),
  row({
    ref: 6,
    kind: 'observed',
    api: 'request.auth (v2), context.auth (v1)',
    behavior:
      'With Authorization: Bearer <valid ID token>, v2 request.auth and v1 context.auth have exactly the keys uid, token, and rawToken, and uid equals token.sub. token carries the claim names production\'s verifyIdToken returns (iss, aud, auth_time, user_id, sub, iat, exp, uid, and firebase with identities and sign_in_provider), with iss https://securetoken.google.com/<projectId> and aud <projectId>. The client SDK attaches the signed-in user\'s ID token to every call.',
    evidence:
      'upstream: `checkAuthToken` calls `getAuth(getApp()).verifyIdToken` and sets `{ uid, token, rawToken }` (`:308-335`). Pyric today: `verifySandboxIdToken` defaults iss to https://sandbox.pyric.dev and aud to pyric-sandbox (`packages/pyric-admin/src/auth/token-decoders.ts`), so the claim forms differ until plan decision 1 lands. Production behavior needs `functions-callable-auth-valid` and `functions-callable-client-signed-in`.',
  }),
  row({
    ref: 7,
    kind: 'observed',
    api: 'request.auth (v2), context.auth (v1)',
    behavior:
      'With no Authorization header the call is served, and v2 request.auth and v1 context.auth are undefined. After signOut the client SDK sends no Authorization header.',
    evidence:
      'upstream: a missing header is `MISSING`, which refuses nothing (`:309-312`, `:441-443`); the client adds the header only when Auth returns a token (' +
      CLIENT +
      ' `makeAuthHeaders`). Production behavior needs `functions-callable-auth-missing` and `functions-callable-client-signed-in`.',
  }),
  row({
    ref: 8,
    kind: 'observed',
    api: 'callable ID token verification',
    behavior:
      'A Bearer ID token whose signature does not verify, a Bearer value that is not a JWT, an Authorization scheme other than Bearer, and an ID token issued for another project (wrong aud) each answer 401 {"error": {"message": "Unauthenticated", "status": "UNAUTHENTICATED"}} before the handler runs, on v2 and v1, with or without enforceAppCheck.',
    evidence:
      'upstream: a failed `verifyIdToken` or a non-Bearer header is `INVALID`, which throws `unauthenticated` (`:313-316`, `:331-334`, `:441-443`). Owner decision (plan decision 3): no second project, so the wrong-audience case is stated from firebase-admin 13.10.0 `lib/auth/token-verifier.js:218-226` and not captured. Pyric today: `verifySandboxIdToken` accepts any `sandbox-id-token-<uid>:{json}` with no signature (`packages/pyric-admin/src/auth/verify-token.ts`); plan decision 1 adds the check. Production behavior needs `functions-callable-auth-invalid`.',
  }),
  row({
    ref: 9,
    kind: 'upstream',
    api: 'callable ID token verification',
    behavior:
      'An ID token past its exp answers 401 {"error": {"message": "Unauthenticated", "status": "UNAUTHENTICATED"}}: firebase-admin rejects it with auth/id-token-expired, which the SDK reads as an invalid token.',
    evidence:
      'upstream: firebase-admin 13.10.0 `lib/auth/token-verifier.js:268` ("has expired") and `checkAuthToken` (`:331-334`). Pyric today: `verifySandboxIdToken` never compares exp with the clock; plan decision 1 adds the check against the sandbox clock. The SDK debug feature `skipTokenVerification` must never be set in the child.',
  }),
  row({
    ref: 10,
    kind: 'observed',
    api: 'onCall({ enforceAppCheck: true }, handler)',
    behavior:
      'With enforceAppCheck: true (from the options, else setGlobalOptions), a call with no X-Firebase-AppCheck header, or with a token that does not verify, answers 401 {"error": {"message": "Unauthenticated", "status": "UNAUTHENTICATED"}} before the handler runs. A valid token reaches the handler as request.app with appId and token.',
    evidence:
      'upstream: `checkAppCheckToken` calls `getAppCheck(getApp()).verifyToken` (`:337-375`) and enforcement throws on `INVALID` or `MISSING` (`:444-453`); v2 resolves `enforceAppCheck` from the options, then global options (`lib/v2/providers/https.js:132`). Production behavior needs `functions-callable-app-check-enforced`.',
  }),
  row({
    ref: 11,
    kind: 'observed',
    api: 'onCall(handler) without enforceAppCheck',
    behavior:
      'Without enforceAppCheck, a call with a token that does not verify is served with request.app undefined, and so is a call with no token. A valid token still sets request.app (v1: context.app).',
    evidence:
      'upstream: an `INVALID` App Check result only logs "Allowing request with invalid AppCheck token because enforcement is disabled" (`:444-450`). Production behavior needs `functions-callable-app-check-unenforced`.',
  }),
  row({
    ref: 12,
    kind: 'observed',
    api: 'onCall({ consumeAppCheckToken: true }, handler)',
    behavior:
      'With consumeAppCheckToken: true, request.app.alreadyConsumed is false on the first use of a limited-use token and true on its second. The capture also records what a regular token reports. Pyric keeps the consumed set per process (#1297), so the Functions child and the page track consumed tokens separately.',
    evidence:
      'upstream: `verifyToken(token, { consume: true })` (`:355-361`) and firebase-admin 13.10.0 `lib/app-check/app-check.js:76-80`. pyric-admin `verifyToken(token, options?)` has arity 2, so the SDK\'s "Unsupported version of the Admin SDK" check passes. Owner decision (plan decision 8): accept the per-process set for now. Production behavior needs `functions-callable-app-check-consume` and `functions-callable-client-limited-use`.',
  }),
  row({
    ref: 13,
    kind: 'observed',
    api: 'onCall({ cors }, handler)',
    behavior:
      'A v2 onCall with cors unset uses cors: true: a preflight from any origin answers with Access-Control-Allow-Origin reflecting that origin, Access-Control-Allow-Methods POST, and the requested headers (authorization, content-type, x-firebase-appcheck) allowed, and a cross-origin POST reflects the origin. A v1 onCall answers the same way. The capture records the status and any headers the platform adds.',
    evidence:
      'upstream: v2 defaults `cors` to true with `methods: "POST"` (`lib/v2/providers/https.js:117-144`); v1 always uses `origin: true` (`lib/v1/providers/https.js:56-63`); the `cors` middleware runs before the handler (`:377-386`). Production behavior needs `functions-callable-cors`.',
  }),
  row({
    ref: 14,
    kind: 'observed',
    api: 'request.acceptsStreaming, response.sendChunk',
    behavior:
      'With Accept exactly text/event-stream, a v2 callable answers 200 with each sendChunk(x) as a data: {"message": x} frame, then a data: {"result": ...} frame, and a ": ping" comment every heartbeatSeconds (30 when unset) while no chunk is sent. A throw after the stream began sends a data: {"error": {...}} frame on the same 200 response. Without that exact header (none, or text/event-stream, */*), acceptsStreaming is false, sendChunk resolves false, and the answer is plain JSON. The client .stream() yields each message, resolves data with the result, and rejects both on an error frame.',
    evidence: `upstream: \`wrapOnCallHandler\` streaming path (\`:392-548\`), \`DEFAULT_HEARTBEAT_SECONDS = 30\` (\`:19\`); client \`streamAtURL\` and \`createResponseStream\` in ${CLIENT}. Owner decision functions-6: served if the SDK's stream passes through the proxy unbuffered, otherwise unsupported with a reason. Production behavior needs \`functions-callable-streaming\` and \`functions-callable-client-stream\`.`,
  }),
  row({
    ref: 15,
    kind: 'observed',
    api: 'functions.https.onCall(handler) (v1)',
    behavior:
      'A v1 functions.https.onCall export is served like v2: the handler gets (data, context) with context.rawRequest, context.auth, and context.app, and its return answers {"result"}. A v1 call with Accept: text/event-stream answers 400 {"error": {"message": "Unsupported Accept header \'text/event-stream\'", "status": "INVALID_ARGUMENT"}}.',
    evidence:
      'upstream: v1 sets `callableTrigger` with `platform: "gcfv1"` (`lib/v1/providers/https.js:52-79`) and the shared handler refuses streaming for gcfv1 (`:458-461`). Production behavior needs `functions-callable-v1`.',
  }),
  row({
    ref: 16,
    kind: 'observed',
    api: 'httpsCallableFromURL(functions, url)',
    behavior:
      'httpsCallableFromURL with https://{region}-{projectId}.cloudfunctions.net/{name} and with the function\'s run.app URL reaches the same v2 callable and returns its result. In pyric a page maps the cloudfunctions.net URL to /{projectId}/{region}/{name} on its own origin and a run.app URL through the lowercased service name, warning when that mapping is ambiguous; any other URL is an off-machine call the guard refuses.',
    evidence:
      `upstream: \`callAtURL\` posts to the given URL unchanged (${CLIENT}). Owner decision (plan decision 4): the run.app mapping and warning. Production behavior needs \`functions-callable-client-from-url\`.`,
  }),
  row({
    ref: 17,
    kind: 'observed',
    api: 'firebase.json hosting.rewrites[].function to a callable',
    behavior:
      'A hosting rewrite { source, function } to a callable serves the callable protocol on the Hosting origin: a POST answers {"result"}, an HttpsError answers its status and {"error"} body, and a GET answers 400 Bad Request. getFunctions(app, origin) with that origin calls <origin>/<name> and returns the result.',
    evidence:
      `upstream: \`FunctionsService._url\` builds \`\${customDomain}/\${name}\` (${CLIENT}). The rewrite and its forwarding follow functions-http#17. Production behavior needs \`functions-callable-hosting-rewrite\` and \`functions-callable-client-custom-domain\`.`,
  }),
  row({
    ref: 18,
    kind: 'observed',
    api: 'FunctionsError',
    behavior:
      'For the answers in rows 3 to 10, the client rejects with a FunctionsError (name FirebaseError) whose code is functions/<code> from the body\'s status, or from the HTTP status when the body has none; whose message is "<message> [<httpStatus>]"; whose details are decoded from the body; and whose customData carries url. A plain throw gives functions/internal with message "INTERNAL [500]"; an enforced call with no App Check token gives functions/unauthenticated; an unknown function name gives the code production\'s 404 answer maps to. An HttpsError with code ok rejects with functions/internal "Response is missing data field.".',
    evidence: `upstream: \`codeForHTTPStatus\`, \`_errorForResponse\`, and \`callAtURL\` in ${CLIENT}; 0.14.0 appends " [<httpStatus>]" and customData.url, which 0.13.4 did not. Production behavior needs \`functions-callable-client-errors\`.`,
  }),
  row({
    ref: 19,
    kind: 'upstream',
    api: 'httpsCallable(functions, name, { timeout })',
    behavior:
      'When no answer arrives within timeout ms (70000 when unset), the call rejects with FunctionsError functions/deadline-exceeded, message "deadline-exceeded", without aborting the request. .stream() has no timeout.',
    evidence: `upstream: \`failAfter\` and \`callAtURL\` (\`options.timeout || 70000\`) in ${CLIENT}; \`streamAtURL\` takes only a signal.`,
  }),
  row({
    ref: 20,
    kind: 'observed',
    api: 'httpsCallable(functions, name, { limitedUseAppCheckTokens: true })',
    behavior:
      'With limitedUseAppCheckTokens: true each call sends a fresh limited-use App Check token, so a consuming callable reports alreadyConsumed: false on every call. Without it the cached token is sent again and the second call reports true. With no App Check initialized no X-Firebase-AppCheck header is sent.',
    evidence: `upstream: \`ContextProvider.getAppCheckToken\` calls \`getLimitedUseToken\` or \`getToken\`, and \`makeAuthHeaders\` omits the header when the token is null (${CLIENT}). Production behavior needs \`functions-callable-client-limited-use\`.`,
  }),
  row({
    ref: 21,
    kind: 'pyric',
    api: 'callable routing before the child is ready',
    behavior:
      'A call to a discovered callable while the Functions child is starting, reloading, failed, or waiting for a sandbox peer answers 503, so the client rejects with functions/unavailable (never not-found, internal, or a network error), and pyric\'s terminal names the cause.',
    evidence:
      'Pyric-owned lifecycle, shared with functions-http#20 (`packages/cli/src/functions/development-runtime.ts`, `functions/http/gateway.ts`). The client maps a 503 with no {error} body to unavailable (`codeForHTTPStatus`).',
  }),
  row({
    ref: 22,
    kind: 'pyric',
    api: 'firebase-admin inside onCall',
    behavior:
      'A firebase-admin write the handler awaits is visible to a page of the same sandbox before the call\'s result arrives.',
    evidence:
      'The child runs with PYRIC_SANDBOX=remote:<serveUrl> and pre-initializes the ambient firebase-admin app, as for functions-http#18. The fixture\'s admin-write mode writes `pyric_oracle_callable/{id}`.',
  }),
  row({
    ref: 23,
    kind: 'pyric',
    api: 'onCall execution record',
    behavior:
      'Each call a callable serves prints one execution line naming the export, the callable kind, the HTTP status, and the duration; a streamed call prints one line when its stream ends.',
    evidence:
      'Pyric-owned, extending functions-http#21 (`packages/cli/src/functions/http/report.ts`).',
  }),
  row({
    ref: 24,
    kind: 'pyric',
    api: 'connectFunctionsEmulator(functions, host, port)',
    behavior:
      'connectFunctionsEmulator is accepted, calls keep routing to pyric\'s gateway, and pyric warns once that the emulator origin is ignored; no call goes to the named host and port.',
    evidence:
      'Owner decision (plan decision 5): honoring port 5001 would send calls to a server that is not running. Upstream sets `emulatorOrigin` and builds `${origin}/${projectId}/${region}/${name}` (' +
      CLIENT +
      ').',
  }),
  row({
    ref: 25,
    kind: 'pyric',
    api: 'pyric/functions in production AI mode',
    behavior:
      'In production AI mode pyric/functions stays the mirror: calls reach the app\'s local callable through pyric\'s gateway, never the deployed function. Sending a real App Check token from the production shadow app to an enforceAppCheck callable is unsupported, with a follow-up.',
    evidence:
      'Owner decision (plan decision 6): the function is the user\'s own local code, so firebase/functions is not passed through. On main, production AI mode swaps only firebase/ai and firebase/app-check.',
  }),
];

const INTRO = `# Firebase Functions callable integration compatibility

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming**: unchanged source matches production under replay |
| ⚠ | **Diverged (documented)**: intentional difference with a written reason |
| ✗ | **Bug**: should match production but does not |
| — | **Not implemented yet**: explicitly outside the implemented slice |
| ? | **Unverified**: production target or local replay is incomplete |
`;

export const functionsCallableRegistry: CompatibilitySurfaceRegistry = {
  surface: 'functions-callable',
  label: 'Functions · Callable',
  compatPath: 'packages/cli/docs/functions-callable/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    {
      kind: 'table',
      prefix: '## `onCall` protocol, tokens, and `firebase/functions` client contract\n',
      rows: functionsCallableRows,
    },
  ],
};
