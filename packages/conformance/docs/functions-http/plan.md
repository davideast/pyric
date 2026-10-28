# Functions HTTP `onRequest`: CDD plan

Status: approved by the owner on 2026-10-21. Base: `origin/main` 9f369b379. PR 0 has since moved `functions-rtdb/*` to `packages/cli/src/functions/`; line references below are to the pre-move files.

## Owner decisions

1. Capture deploy approved on the oracle project: about 12 small v2 functions plus 1 v1 function, and a Hosting preview channel with a 1-day expiry, all deleted after capture.
2. `invoker: 'private'` (row 15): pyric serves the function anyway, warns once, and records a by-design divergence.
3. Uncaught asynchronous error from an HTTP handler (row 12): the shared child catches it rather than restarting, because RTDB triggers share the child. Recorded on the row.
4. Execution records (row 21): log lines only in browser mode for the first slice.

Stack note: the rig manifest (`rigs/functions-http.ts`) lands with the capture in PR 3, and the surface contract's `conformanceSuite` with the red suite in PR 2, because `compat:validate` requires a rig's prefix to match an observation and a declared suite to exist.

## Priority gate

Cloud Functions: "Does this let an app's Cloud Functions run in pyric and behave as they do in production?" An app whose backend is an `onRequest` function has it skipped on its first run today: discovery labels it `https` (`packages/cli/src/functions/endpoints.ts`) and the child serves only RTDB triggers. This surface serves `onRequest` on both planes and on the Node host, as production does, so it passes the test. It is the first line under Cloud Functions in `PRIORITIES.md`.

## What to match (evidence)

Upstream source, read from `node_modules` (firebase-functions 7.2.5, firebase-tools 15.23.0):

- v2 `onRequest` wraps the handler in `withErrorHandler`, optional `cors` middleware, then `withInit` and trace context, and sets `__endpoint.httpsTrigger` with `invoker` (`lib/v2/providers/https.js:44-108`). v1 sets the same `httpsTrigger` with `platform: "gcfv1"` (`lib/v1/providers/https.js:33-50`). One discovery key (`httpsTrigger`) covers both; v1 is cheap.
- A throw or rejected promise inside the handler logs "Unhandled error" and answers `500 Internal Server Error` when headers are unsent (`lib/common/providers/https.js:563-574`). CORS is SDK-side: `cors` package with `origin` from the option (`https.js:53-71`). Both replay unchanged once the child hands the handler a real express `req`/`res`.
- `Request` is `express.Request` plus `rawBody: Buffer` (`lib/common/providers/https.d.ts:6-8`). firebase-functions depends on express 4 and cors, so the child can build the app from the user's own install with no new pyric dependency.
- Production body parsing (functions-framework-nodejs `src/server.ts`, fetched from GitHub): `json` for `application/cloudevents+json` and default json, `text`, `urlencoded({extended:true})`, then `raw({type:'*/*'})`, all saving `rawBody`, limit `1024mb` (Cloud Run caps requests at 32 MiB), `x-powered-by` disabled, a `timeoutMiddleware`. The emulator matches the parser order with a `32mb` limit (`lib/emulator/functionsEmulatorRuntime.js:543-561`).
- Emulator routing: `/{projectId}/:region/:trigger_name` and `/*` under it (`lib/emulator/functionsEmulator.js:151-153`). The trigger key is `region-name`, and an unknown one gets `404 Function X does not exist, valid functions are: ...` (`:1233-1247`). The prefix is stripped so the function sees `/` plus the remainder (`:1264`).
- Emulator divergences from production, which pyric should not copy: it forces `enableCors: true` for every onRequest unless `cors: false` (`functionsEmulator.js:990-993` with `https.js:55-57`), and it never enforces `invoker` (no reference in `lib/emulator`). Timeout: `timeoutSeconds` defaults to 60 (`functionsEmulatorShared.js:97`), and on expiry the emulator destroys the socket instead of answering (`functionsRuntimeWorker.js:115-141`).
- Hosting rewrites: `{"source", "function": "id" | {functionId, region}}`. A rewrite with no region takes the region from the function's source, and falls back to `us-central1` only when the source names none. When the function deploys to several regions and none is `us-central1`, the CLI refuses the rewrite and asks for a region, and so does pyric. A rewritten request that runs past 60 s gets a 504, whatever the function's `timeoutSeconds` (firebase.google.com/docs/hosting/functions). A `regex` rewrite is RE2 in production; pyric matches it as a JavaScript regular expression. The target is `https://{region}-{project}.cloudfunctions.net/{id}` with the original `req.url` appended, so the function sees the full `/api/...` path. Only the `__session` cookie is forwarded, plus `X-Forwarded-Host` and `X-Original-Url` (`lib/hosting/functionsProxy.js:20-31`, `lib/hosting/proxy.js:29-50`).
- Production URLs: v2 serves both `https://{region}-{project}.cloudfunctions.net/{name}` and the Cloud Run `https://{service}-{hash}-{rc}.a.run.app` URL; the service name is the function name lowercased (the RTDB harness relies on this, `src/capture/functions-rtdb/harness.ts` failure filter). These URLs, the path the function sees under each, the platform headers, the timeout status, and the private-invoker refusal are not in upstream source. They need capture.
- maxInstances, minInstances, concurrency, memory, cpu: deploy-time only. Rows say so (`unsupported` with a reason); pyric serves requests concurrently with no instance model.

## Reuse (AGENTS.md rule 4)

What generalizes today: project discovery (`functions-rtdb/project.ts`), module loading (`module-loader.ts`, duplicated inside `child.ts:291-317`), endpoint walking (`discovery.ts:46-70`), the spawn, IPC, and stop handshake (`child.ts:176-274`), the child env and admin activation (`child.ts:148-173`, `cli/sandbox-runner.ts:183-200`), the start, reload, and close lifecycle with peer readiness (`development-runtime.ts`, already family-neutral apart from type names), and the execution log and events (`execution-log.ts`, `events.ts`, whose `cause` is RTDB-shaped). Proposed structure, as one mechanical move PR before any HTTP code:

```
packages/cli/src/functions/
  project.ts            discoverFunctionsProject (renamed, unchanged rules)
  module-loader.ts      the single loader; child.ts imports it
  endpoints.ts          listFirebaseEndpoints, endpoint type (+httpsTrigger, platform, timeoutSeconds), classify -> family
  unsupported.ts        family registry; replaces the label chain in child.ts:459-482
  child/spawn.ts        host side: spawn, IPC protocol, env (PYRIC_FUNCTIONS_CHILD=1)
  child/main.ts         child entry: admin init, load, start each family adapter, report ready
  development-runtime.ts, execution-log.ts, events.ts   cause becomes {kind:'rtdb',ref,params} | {kind:'http',method,path,status}
  rtdb/                 discovery, projection, reference-pattern, event, execution, delivery adapters
  http/discovery.ts     inspectOnRequest: export name, region (v1 and v2), invoker, cors, timeoutSeconds
  http/child-server.ts  express app in the child on 127.0.0.1:0; port reported in `ready`
  http/routes.ts        route table: emulator path, hosting rewrites, unknown and not-ready answers
  http/proxy.ts         host-side request forwarding, timeout, execution record
```

The ready message grows from `{triggerCount, unsupportedTriggers}` to per-family counts plus `http: {port, functions[]}`. Consumers to update: `cli/serve.ts:1092-1133`, `serve/vite-functions-development.ts`, `serve/vite-generation-functions.ts:52` (built child path), `bridge/surface/functions-runtime.ts`, `bridge/surface/methods/functions/*`, and the RTDB suite import. `functions.listTriggers` gains HTTP entries with their local URL. The `pyric/functions` client stub stays deferred: onRequest needs no client SDK, and callable is out of scope.

## Where requests enter, per plane

One HTTP listener per child, loopback, ephemeral port. Every plane forwards to it, so there is one request path to test.

- `pyric sandbox` and `pyric sandbox --hosted` (`cli/serve.ts`; `pyric dev` is the older name in docs and tests): add a `functionsHandler` seam to `StaticServerOptions` that runs after the `/__pyric/` namespace and before the GET/HEAD-only 405 (`serve/server.ts:346-354`). It routes (a) `/{projectId}/{region}/{name}[/*]` when that key is discovered (the emulator shape, so existing curl habits and `http://127.0.0.1:{port}/...` URLs work once the port changes) and (b) firebase.json hosting rewrites whose destination is `function`, matched with the same glob as Hosting, extending `extractHosting` (`cli/serve.ts:73-93`).
- Vite plugin `pyric()`: the same routes as a `server.middlewares.use` beside `/__pyric` (`serve/vite-generation-middleware.ts:17`), owned by `vite-functions-development.ts`. The page reaches a function same-origin through the rewrite path, which is also how production Hosting avoids CORS.
- Before the child is ready (in browser mode, no tab connected yet, `development-runtime.ts:199-216`), a matched route answers 503 with a message naming the cause instead of falling through to a static 404.
- Not in slice 1: rerouting Node-process fetches to `*.cloudfunctions.net` (the net guard blocks them today, `register/net-guard.ts`, `google-endpoints.ts:74-82`), and a dedicated `--functions-port` listener on 5001.
- firebase-admin inside a handler: confirmed already handled. The child runs with `PYRIC_SANDBOX=remote:<serveUrl>` and `--import @pyric/cli/register` (`sandbox-runner.ts:187-192`), pre-initializes the ambient app (`child.ts:368-371`), and a user's own bare `initializeApp()` returns that ambient app rather than throwing (`pyric-admin/src/app/index.ts:131-139`). No worker protocol change (rule 3): HTTP never crosses `packages/cli/src/serve/` worker frames.

## CDD shape

New surface `functions-http`: kind `integration`, contractSource `firebase-functions/v2/https#onRequest`, prefix `functions-http-`, rig `functions-http`, suite `packages/cli/test/functions-http/oracle-conformance.test.ts`, `climb: true`, compatPath `packages/cli/docs/functions-http/COMPAT.md`, plus `assurance-node-counts/functions-http.json`. It is a separate surface because `functions-rtdb`'s scope note defers other families and its contract source is one export.

Rows, all born `unverified` (O = needs a production observation, U = upstream-documented, P = pyric-owned and unit-backed at flip):

1. Discovered v2 onRequest is served at `/{project}/{region}/{name}`; region from options or global options. (P, U emulator)
2. v1 `functions.https.onRequest` and `functions.region(r).https.onRequest` are served the same way. (O)
3. `req.method`, `req.query`, and request headers reach the handler; the platform-added and stripped header names match production. (O)
4. Path under the function: `req.path`/`req.url` after the name, root `/`, on both production URLs. (O)
5. JSON body parsed to `req.body`, `rawBody` holds the exact bytes. (O)
6. text, urlencoded (extended), octet-stream, unknown type, and empty body map as production does. (O)
7. Malformed JSON is refused before the handler with production's status and body. (O)
8. Status, headers, `res.json`, `res.redirect`, and streamed `res.write` chunks arrive unchanged; no `x-powered-by`. (O)
9. Sync throw or rejected promise answers 500 `Internal Server Error`. (O, U SDK)
10. Throw after headers are sent ends the response; the client sees what production shows. (O)
11. A handler that never responds is cut at `timeoutSeconds` with production's status (slow scenario). (O)
12. An uncaught asynchronous exception: production outcome, and pyric keeps RTDB triggers in the same child alive. (O)
13. `cors` unset: no CORS headers, and OPTIONS reaches the handler, unlike the emulator. (O)
14. `cors: true`, a string list, and a RegExp: preflight answered by middleware, origin reflected or refused. (O)
15. `invoker: 'private'`: production refuses unauthenticated calls with 403; pyric's side is an owner decision (recommend by-design divergence: serve and warn once). (O)
16. Unknown function name: production 404 shape. (O)
17. Hosting rewrite routes the full original path, honors `region`, forwards only `__session` among cookies. (O, needs a Hosting preview channel)
18. An awaited firebase-admin write in the handler is visible to a client before the response arrives. (P)
19. Requests run concurrently; maxInstances, concurrency, memory, and cpu are `unsupported` with a written reason. (U)
20. A request during reload or before peer readiness gets 503 with a cause; never a static 404. (P)
21. Each request lands one `execution_finished` record with an `http` cause. (P)

Observations (one fixture codebase, `pyric-functions-http-oracle`, one probe file each under `probes/functions-http/`): `functions-http-onrequest-basic-get`, `-subpath`, `-body-parsing`, `-malformed-json`, `-response-shapes`, `-handler-failure`, `-headers-sent-failure`, `-no-response-timeout` (`timeoutSeconds: 5`), `-uncaught-async`, `-cors-unset`, `-cors-configured`, `-invoker-private`, `-not-found`, `-v1`, and `functions-http-hosting-rewrite`. The harness follows `src/capture/functions-rtdb/harness.ts` (deploy, curl both URLs, freeze, `functions:delete` in `finally`) with its own rig manifest beside `rigs/functions-rtdb.ts`.

Deploy (planned, not run; needs owner approval for spend on genkit-idx): about 12 small v2 functions plus 1 v1 function, one Cloud Build each, invocations inside the free tier, Artifact Registry images to delete afterward, and a Hosting preview channel with a 1-day expiry. Credentials: `PYRIC_ORACLE_SA_PATH`, needing Cloud Functions Developer, Service Account User, Cloud Run Admin (to read the `run.app` URL and the invoker binding), Firebase Hosting Admin, and Logs Viewer. Until capture lands, the O rows carry `unobserved` risk exactly as `registry/functions-rtdb.ts` does.

Red suite: one `describe('functions-http#N')` per row, gated by `PYRIC_CLIMB=1` like `test/functions-rtdb/oracle-conformance.test.ts:40`. It drives the real `startServe` plus the built child and a fixture functions dir, sends real HTTP with `fetch`, replays observation values, and ends with the prefix completeness gate. Rows 11 and 12 wait on real time and go in a `slow` group. Climb lane: `compat:climb` picks the surface up from `climb: true`, on demand on the WIP branch.

Graduation: (1) zero `unverified` rows; every gap is `conforms`, a classified `diverged-documented`, or `unsupported` with a reason; (2) `compat:report` shows no orphan `functions-http-` observations; (3) the same unchanged fixture source passes on both planes. App scenarios under `test/apps/functions-http-hosting-rewrite` (`pyric sandbox` with packed packages: Chromium page fetches `/api/...`, the function writes Firestore through firebase-admin, the page reads it) and `test/apps/functions-http-vite` (the `pyric()` plugin, same page) plus a `curl` of the emulator path. The suite then joins the blocking run.

## Size, order, risks, scope

PRs, each a draft: (0) move to `src/functions/` with no behavior change, about 25 files mostly renames; (1) admission, rows, rig, probes, harness, fixture, counts, about 12 files; (2) red suite, 2 files; (3) capture, after owner approval, 15 observations; (4) child HTTP server, discovery, routes, proxy, and both plane hookups, about 10 files; (5) hosting rewrites, timeouts, execution log, app scenarios, about 6 files. Roughly 70 files touched in total, most of them moves and observation JSON, and about 2,500 new lines. Effort is about 6 to 9 agent-days plus owner review and the capture window.

Risks: an uncaught exception in the shared child takes RTDB triggers down with it (decide catch versus restart, row 12); the PR 0 move collides with any in-flight functions-rtdb work (run `start-work` first); a request body consumed by Vite or the static server before forwarding; route collision when a static directory is named after the project id (only discovered keys match); in browser mode the host holds no LocalSandbox, so the execution record for row 21 needs a bridge path or stays log-only (decide in PR 5); timeout statuses that differ between `cloudfunctions.net` and `run.app`.

Out of scope: `onCall` and `pyric/functions` (`httpsCallable`), Firestore, Storage, Pub/Sub, scheduler, task queues, more RTDB events, Auth blocking functions, multiple codebases, secrets and params beyond what the SDK resolves locally, IAM beyond the invoker row, the Node-fetch reroute of `cloudfunctions.net`, and a dedicated 5001 port.
