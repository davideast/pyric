# Functions callable `onCall`: CDD plan

Status: approved by the owner with every recommended decision. Base: `origin/main` 218e49984. Tracking issue: #1308.

## Owner decisions

1. Token verification gap: land a pyric-admin auth fix before or inside the serving PR. It checks `exp` against the sandbox clock, checks `aud` and `iss` against the project, and adds an integrity tag like the one sandbox App Check tokens carry. Rows 6, 8, and 9 cite the gap.
2. Fixture placement: a separate codebase, `pyric-functions-callable-oracle` (`src/capture/functions-callable/`), with its own `firebase.json` and Hosting rewrite. The functions-http fixture, its `firebase.json`, and its unknown-function listing stay frozen.
3. Capture grants on the oracle project: Firebase Authentication Admin for one run-scoped test user, created and deleted each run, and Firebase App Check Admin for the run's debug token. No second project: row 8's wrong-audience case is stated from firebase-admin source.
4. `run.app` URLs in `httpsCallableFromURL` map through the lowercased service name, with a warning when the mapping is ambiguous. Any other unmapped URL is an off-machine call the guard refuses (row 16).
5. `connectFunctionsEmulator` is accepted, calls keep routing to pyric's gateway, and pyric warns once (row 24).
6. Production AI mode: `firebase/functions` stays the mirror in every mode, because the function is the user's own local code. A real App Check token from the shadow app sent to an `enforceAppCheck` callable is an `unsupported` row with a follow-up (row 25).
7. A registered Node process keeps reaching client SDKs only through the Node host (`offHostRefusal`), even though a callable is plain HTTP.
8. The App Check consumed set stays per process for now (#1297). The child and the page track consumed tokens separately (row 12).
9. Streaming (functions-6): served if the SDK's stream passes through the proxy unbuffered, otherwise row 14 becomes `unsupported` with a reason.

## Priority gate

Cloud Functions: "Does this let an app's Cloud Functions run in pyric and behave as they do in production?" An app that calls a callable function fails on first use today: `pyric/functions` is a deferred stub that throws `PyricDeferredApiError`, and the Functions child labels an `onCall` export `callable` and skips it. This surface is the target list for serving it on both planes and on the Node host, so it passes the test. Callable is the next line under Cloud Functions in `PRIORITIES.md`.

## What to match (evidence)

Upstream source, read from the workspace install: firebase-functions 7.2.5, firebase-admin 13.10.0, and @firebase/functions 0.14.0 (firebase 12.19.0).

- v2 `onCall` and v1 `https.onCall` both return the SDK's `onCallHandler` (`lib/common/providers/https.js:377-386`): the `cors` middleware, then `wrapOnCallHandler`, which validates the request (`isValidRequest`, `:126-154`), verifies tokens (`checkTokens`, `:283-375`), decodes `data`, runs the handler, encodes the result, and maps errors (`:392-548`). The export carries `__endpoint.callableTrigger`. Pyric serves that handler unchanged in the functions-http child server; it adds no error mapping of its own.
- Token checks call `getAuth(getApp()).verifyIdToken` and `getAppCheck(getApp()).verifyToken(token, { consume })`. The child runs under `@pyric/cli/register`, so both land in pyric-admin. pyric-admin's `verifyToken` has arity 2, so the SDK's "Unsupported version of the Admin SDK" check passes.
- Pyric's token gap: `verifySandboxIdToken` (`packages/pyric-admin/src/auth/verify-token.ts`, `token-decoders.ts`) accepts any `sandbox-id-token-<uid>:{json}`, never compares `exp` with the clock, and never checks `aud`. Its defaults are `iss: https://sandbox.pyric.dev` and `aud: pyric-sandbox`; production uses `https://securetoken.google.com/<project>` and `<project>`.
- Client: `callAtURL` posts `{data}` with `Authorization`, `X-Firebase-AppCheck`, and `Firebase-Instance-ID-Token` headers, races a 70 s default timeout, and maps the answer with `_errorForResponse`. Version 0.14.0 appends ` [<httpStatus>]` to the message and sets `customData.url`; 0.13.4 did not, so the mirror ports 0.14.0. `streamAtURL` reads `data:` frames and has no timeout.
- What source cannot settle, and the capture records: the platform's headers and status codes in front of the SDK, the body parser's answer to malformed JSON, the claim names of a real ID token, `alreadyConsumed` for a regular token, the SSE content type and buffering, and the `run.app` and Hosting paths.

## CDD shape

New surface `functions-callable`: kind `integration`, contractSource `firebase-functions/v2/https#onCall`, prefix `functions-callable-`, `climb: true`, compatPath `packages/cli/docs/functions-callable/COMPAT.md`, plus `assurance-node-counts/functions-callable/base.json` (25). `captureRigs` is `[]` and there is no `conformanceSuite` until those files exist, so `compat:validate` stays green. The census pair for `firebase/functions` lands with the mirror.

Rows, all born `unverified` (O = needs a production observation, U = from upstream source, P = pyric-owned):

| # | Row | Kind | Probes |
|---|---|---|---|
| 1 | `{data}` in, `{result}` out; `null` and `undefined` | O | `data-roundtrip` |
| 2 | Encoding of Date, Int64Value and UInt64Value, NaN and Infinity | O | `encoding`, `client-encoding` |
| 3 | Each `HttpsError` code maps to its status and `{error:{status,message,details}}` | O | `https-error-codes` |
| 4 | A throw that is not an `HttpsError` becomes 500 `INTERNAL` | O | `plain-throw` |
| 5 | Wrong method, wrong content type, missing `data`, or extra keys give 400 `INVALID_ARGUMENT` "Bad Request" | O | `bad-request` |
| 6 | Valid ID token: the claim names in `request.auth` and v1 `context.auth` | O | `auth-valid`, `client-signed-in` |
| 7 | No token gives `auth` undefined | O | `auth-missing`, `client-signed-in` |
| 8 | A forged token, a non-JWT, a non-Bearer scheme, or a wrong audience gives 401 | O | `auth-invalid` |
| 9 | An expired token gives 401 | U | none |
| 10 | `enforceAppCheck` with no token, or an invalid one, gives 401 | O | `app-check-enforced` |
| 11 | Without enforcement, an invalid App Check token is served | O | `app-check-unenforced` |
| 12 | `consumeAppCheckToken`: `alreadyConsumed` false, then true | O | `app-check-consume`, `client-limited-use` |
| 13 | CORS default (`cors` true on v2, origin true on v1) and the preflight | O | `cors` |
| 14 | Streaming frames, the final `{result}` frame, an error frame, and the heartbeat | O | `streaming`, `client-stream` |
| 15 | v1 `onCall`, and v1 with `Accept: text/event-stream` gives 400 | O | `v1` |
| 16 | `httpsCallableFromURL` with a `cloudfunctions.net` URL and a `run.app` URL | O | `client-from-url` |
| 17 | A Hosting rewrite to a callable, and `getFunctions(app, origin)` | O | `hosting-rewrite`, `client-custom-domain` |
| 18 | Client `FunctionsError` code, message, details, and `customData` for rows 3 to 10 | O | `client-errors` |
| 19 | Client `timeout` gives `deadline-exceeded` | U | none |
| 20 | `limitedUseAppCheckTokens` sends a fresh limited-use token per call | O | `client-limited-use` |
| 21 | Before the child is ready, the client gets `unavailable` and the terminal names the cause | P | none |
| 22 | An admin write in the callable is visible to the page before the result arrives | P | none |
| 23 | One execution line per call | P | none |
| 24 | `connectFunctionsEmulator` is accepted and ignored with a warning | P | none |
| 25 | Production AI mode keeps the mirror | P | none |

Probe names drop the `functions-callable-` prefix in the table above. Wire probes (`kind: 'wire'`) send raw HTTP through the functions-http sender and name the tokens they carry by kind (`valid`, `forged`, `limited-use-shared`, ...); the runner mints each token, so no token value lives in a probe or an observation. Client probes (`kind: 'client'`) run one scenario of `src/capture/functions-callable/browser-source.ts` in headless Chromium with the real `firebase/functions`; the suite bundles the same program against `pyric/functions`.

## Fixture

`src/capture/functions-callable/fixture/index.cjs`, five functions, deployed then deleted per run:

- `pyricCallableEcho`: v2, default options. Echoes a report of `data`, `auth`, `app`, `acceptsStreaming`, and request header names, and takes `{ mode }` for returns, `HttpsError` throws, plain throws, delays, and an admin write (local replay only).
- `pyricCallableEnforced`: `enforceAppCheck: true`.
- `pyricCallableConsume`: `enforceAppCheck: true`, `consumeAppCheckToken: true`.
- `pyricCallableStream`: `heartbeatSeconds: 1`; sends chunks, can pause before its result, and can fail after the first chunk.
- `pyricCallableV1`: v1 `https.onCall` with the echo's modes.

`firebase.json` rewrites `/pyricCallableEcho` to `pyricCallableEcho`. Reports carry claim names, never token values.

## Stack

1. Admission (this PR): the surface, registry, count directory, probes, probe types, page source, fixture, and this plan. No runtime change.
2. Red suite: `packages/cli/test/functions-callable/oracle-conformance.test.ts` and the surface's `conformanceSuite`, gated on `PYRIC_CLIMB=1`; every row fails.
3. Capture (owner-gated): `observations/functions-callable/*.json` and `rigs/functions-callable.ts`, extending the functions-http deploy-and-delete harness. Cleanup in a `finally` deletes the test user, the debug token, the functions, the images, and the preview channel.
4. Serving on both planes, with the pyric-admin token fix (decision 1) and a `functions-callable-hosted` app scenario.
5. The `pyric/functions` mirror, its census pair, and the `functions-callable` app scenarios.

Graduation: zero `unverified` rows; every gap `conforms`, a classified `diverged-documented`, or `unsupported` with a reason; no orphan `functions-callable-` observations; and the unchanged fixture passes on both planes and the Node host.

## Out of scope

`authPolicy`, `onCallGenkit`, the `Firebase-Instance-ID-Token` header, other trigger families, a dedicated 5001 port, and deploying functions.
