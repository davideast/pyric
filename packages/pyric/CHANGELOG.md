# Changelog

## Unreleased

## 0.1.0-alpha.31

pyric 0.1.0-alpha.31 is on the `exp` dist-tag. `latest` stays at alpha.26.

```bash
npm create pyric@exp my-app
# or, in an existing project
npm install pyric@exp
npm install -D @pyric/cli@exp
```

This release covers everything merged to `main` since alpha.30.2. Firebase AI Logic requires App Check for every project from November 2, 2026. This release makes App Check in the sandbox call your own providers, fail where the Firebase SDK fails, and work with production AI mode in Next.js. It also brings a large set of rules, Storage, RTDB, Firestore and Auth fixes from the October defect hunts, and closes several ways the Node register could load the real Firebase SDKs.

### Get App Check ready for November 2

From November 2, 2026, production AI Logic answers a request without a valid App Check token with a 403. Sandbox AI mode already refuses such requests (#1535, shipped in alpha.30.2). Here is what an app that uses AI Logic with App Check gets in alpha.31.

#### New in this release

- **A `CustomProvider` is called.** With no debug token set, the sandbox's `firebase/app-check` now calls your `CustomProvider`, and the AI Logic gate checks the token it returns. A token the sandbox signed is accepted, such as one a server mints with `firebase-admin` `createToken`. Any other token, or a provider that rejects, gets production's 403. With `useLimitedUseAppCheckTokens: true`, a provider that rejects stops the request before it is sent, and the call fails with `AIError` code `error`, as the Firebase SDK does. The documented setup, a debug token under `import.meta.env.DEV`, works as before (#1648).
- **A reCAPTCHA provider throws without a `document`.** In a Node process or a server-rendered module, `initializeAppCheck` with `ReCaptchaV3Provider` or `ReCaptchaEnterpriseProvider` throws `ReferenceError: document is not defined`, as the Firebase SDK does. Before, it returned a handle. On a server, use a `CustomProvider` (#1664).
- **Re-initializing and concurrent `getToken` follow the SDK.** A second `initializeAppCheck` that differs from the first in the raw `isTokenAutoRefreshEnabled` value now throws `appCheck/already-initialized`, so an omitted value no longer equals `false`. Concurrent `getToken` calls share one token, and `onTokenChanged` listeners fire once (#1388).
- **Production AI mode works in Next.js.** `withPyric` now reads `PYRIC_AI_MODE`. With `PYRIC_AI_MODE=production`, a Next page gets the Firebase SDK's `firebase/ai` attached to the real `firebase/app-check`, so AI Logic requests carry `X-Firebase-AppCheck`, as on Vite. Before, the page got pyric's scripted answers (#1650).
- **Proxied AI engines work under `pyric sandbox -- next dev`.** alpha.30.2 refused a page served by a wrapped dev server with a 403 when it used the openai engine, or the gemini engine on the SharedWorker or in-page plane. The guarded `/__pyric/*` routes now accept the wrapped dev server's port (#1497, #1438).
- **AI Logic roles match production.** The sandbox refuses role `function` with production's 400. `@firebase/ai` 2.12.0's `ChatSession` sends function responses under role `function`, so a `ChatSession` with tools now fails in the sandbox as it does in production. Send function responses with `generateContent` under role `user` (#1412). Role `assistant` inside `contents` is now accepted, and role `system` is still refused (#1542).

#### Already shipped in alpha.30.1 and alpha.30.2

If you are coming from `latest` (alpha.26) or alpha.30, these App Check fixes also reach you in this release:

- Sandbox AI mode refuses requests without an App Check token on every plane. Call `initializeAppCheck` before `getAI` (#1535).
- Production AI mode verifies the page's real App Check token with firebase-admin's own `verifyToken` (#1558).
- `cert(serviceAccount)` keeps the service account's project id (#1532).
- `initializeAppCheck` names the cause when production AI mode can't create its shadow app (#1534).
- Production AI mode works on plain `pyric sandbox` without Vite (#1537).
- The `create-pyric` chat template, the AI Logic guide, the tutorial and the `ai-chat` example call `initializeAppCheck` before `getAI` (#1392).

#### Known gaps

- The sandbox AI gate doesn't check that a token's project or app id matches the app (#1554).
- The sandbox has no App Check token refresher. It calls a provider only when a token is requested (#1648).
- `consume` replay state is kept per process, not per project (#1297).
- The chat template pins firebase 12.13, but limited-use App Check tokens need 12.14 (#1397).
- After November 2, pyric re-captures production's App Check gate for AI Logic to confirm the sandbox still matches (#1300).

### Behavior changes

Each change moves pyric toward what production does. Code that relied on the old behavior will now see different results. Each entry names the old behavior, the new behavior and the PR.

The register and network guard changes can stop code that ran before: see Security.

#### App Check and AI Logic

- `CustomProvider` with no debug token: before, never called, and the request answered. Now, called, and a token the sandbox didn't sign gets the 403 (#1648).
- reCAPTCHA provider without a `document`: before, returned a handle. Now, throws `ReferenceError: document is not defined` (#1664).
- Second `initializeAppCheck` with a different raw `isTokenAutoRefreshEnabled`: before, returned the existing handle. Now, throws `appCheck/already-initialized`. Concurrent `getToken`: before, two tokens and two listener calls. Now, one token and one listener call (#1388).
- Role `function` in AI Logic `contents`: before, accepted. Now, refused with production's 400. The bad-role error text now lists `MODEL, USER`, as production's does (#1412).
- Role `assistant` in AI Logic `contents`: before, refused. Now, accepted (#1542).
- `PYRIC_AI_MODE=production` in Next.js: before, ignored on the page. Now, the page uses the real `firebase/ai` and `firebase/app-check` (#1650).

#### Firestore and Storage rules

- RE2 patterns and `trim()`: before, `\s` matched Unicode white space, `.` skipped `\r`, `\pL` and the `(?i)` flag in `split()` and `replace()` were misread, and `trim()` stripped Unicode spaces. Now, `\s` is ASCII white space, `.` matches `\r`, `\pL` is the letter class, flags are kept, and `trim()` strips only code units at or below U+0020 (#1295).
- `split()` and `replace()`: before, `split()` returned capture-group text and kept trailing empty pieces. Now, it returns neither, and never returns an empty list. Storage also refuses an oversized pattern from request data (#1449).
- Root `match` path: before, skipped, so a ruleset rooted at another database granted access to `(default)`. Now, compared with the request, so such a ruleset grants nothing outside its root (#1395).
- Ruleset service: before, the in-page `setRules` installed and enforced a `service firebase.storage` ruleset as Firestore rules. Now, every Firestore load path refuses a ruleset whose service is not `cloud.firestore` (#1421).
- Version 1 recursive wildcard: before, `{x=**}` matched zero segments. Now, under version 1 it needs one or more, in Firestore (#1437) and Storage (#1404).
- Large regexes: before, a pattern that expands very large compiled, and the first request that evaluated it could run the process out of memory. Now, Firestore and Storage refuse a pattern past RTDB's size limit at compile time (#1406).
- Timestamps and durations: before, values past production's range computed silently, and a NaN instant was accepted. Now, they are rule errors, as in production, and a NaN instant is refused (#1407).
- `firestore_simulator_create`: before, a ruleset production would not load replaced the rules and documents in force. Now, it is refused with `RULES_REFUSED`, and nothing is reset (#1457).
- Array form of `firestore` in `firebase.json`: before, ignored, so pyric fell back to `firestore.rules` or no rules. Now, the `(default)` entry's rules govern `(default)` on every plane, and each named database gets a startup warning (#1444).
- `request.auth.token` claims: before, `sub`, `aud`, `iss`, `iat`, `exp` and `auth_time` were missing, so rules that read them denied. Now, rules read the values pyric minted. RTDB `iat`, `exp` and `auth_time` are the minted values instead of times taken from the evaluation clock. A recent-login check on `auth_time` now expires (#1504).

#### Storage

- Lookups in Storage rules: before, an interpolated request value holding `/` became several path segments. Now, it is one segment, and a `{rest=**}` capture splices in as a path (#1404).
- Bucket name: before, rules saw `pyric-default`. Now, rules see the app's bucket name on every plane, in `rules.simulate`, the `storage` tool methods and `pyric verify` (#1513).
- Per-bucket rules: before, the first `firebase.json` entry's rules governed every bucket. Now, in the in-page sandbox and under `PYRIC_SANDBOX=local`, each bucket enforces the rules deployed to it, and a bucket with no deployed rules denies every client operation. In page, `getStorage(app, 'gs://other')` keeps its objects apart from the default bucket. The dev server, SharedWorker and Node host still share one ruleset across buckets (#1524).
- `pyric mcp` with no dev server: before, read a root `storage.rules`. Now, enforces the Storage rules file `firebase.json` deploys. The dev server refuses a Storage rules reload the sandbox can't install, and keeps the last good rules (#1462).
- `pyric-admin` remote `bucket.getFiles()`: before, a folder per object could fail with `resource-exhausted`. Now, it lists in name order and stops once a page is full (#1206).

#### Firestore SDK

- Query ordering: before, values were compared without Firestore's type order, so a plain map could rank as a `Timestamp` and `GeoPoint` ranges missed. Now, the in-page engine orders by type tag and full document key, and uses value comparison for `==` and `!=` (#1413).
- `getAggregateFromServer` on a served page or a registered Node process: before, threw `firestore/unsupported-in-served-mode`. Now, returns the aggregate (#1399).
- Served `onSnapshot` with an observer object: before, crashed a registered Node process with `callback is not a function`. Now, accepted in all four call forms (#1455).

#### Realtime Database

- `update()` in the in-page sandbox: before, applied a microtask late, so a `set()` or `remove()` in the same tick could be overwritten. Now, writes land in call order (#1402).
- Snapshot serialization: before, `val()` kept insertion order, and `exportVal()` and `toJSON()` could return arrays. Now, keys follow priority, then key order, `val()` leaves holes in sparse arrays, and `exportVal()` and `toJSON()` never return arrays (#1408).
- `refFromURL` and error texts: before, a URL on another instance's host made a ref in this database. Now, it throws the SDK's host mismatch error. Query and `child()` errors use the SDK's exact text (#1409).
- Served RTDB writes: before, `set(ref, NaN)` reached the host and deleted the value. Now, the SDK's value, priority and update-map checks run before the write is sent, and the call throws (#1461).
- `pyric-admin` RTDB: before, the in-process arm returned stored maps from `val()` and kept `null` and empty children. Now, both arms render arrays and prune as `firebase-admin` does, and throw on `NaN` (#1210).

#### Auth

- Served `signInWithCredential` with an email credential: before, signed in without checking the password or link. Now, a wrong password is refused with `auth/wrong-password`, and `providerId` on the result is `null` (#1467).
- Served `signInWithCredential` with an unknown or look-alike provider id: before, signed in as the account the payload named. Now, refused with `auth/no-mock-configured` (#1483).
- Served `signInWithCredential` with a federated credential: before, signed in as the account the payload named. Now, it signs in only as a result staged with `sandbox.mockSignInResult`, on every plane (#1509).

#### Sandbox clock

- Before, the sandbox clock followed the host clock back when it stepped back, so `request.time` and `serverTimestamp()` could go backward. Now, it holds its last reading until the host passes it (#1401).

### Breaking changes

Each of these refuses something that used to work. Check them before you upgrade.

- **`pyric bridge` no longer accepts a browser sandbox.** A page that calls `connectBridge` against `pyric bridge` is closed with code 4010 and a reason that names `pyric sandbox --bridge`, and the client does not reconnect. `pyric bridge` now lists only the tools that run in its own process (rules, conformance, identity, captures). The forwarded sandbox tools are gone from it, and its banner no longer prints a `sandbox:` WebSocket URL. Run `pyric sandbox --bridge` for an agent that drives a page (#1507).
- **`VITE_GEMINI_API_KEY` is refused.** Before, the gemini engine read it as the Gemini key. Now, the Vite dev server refuses to start while it is set, in the shell or in `.env`, and says to rename it to `GEMINI_API_KEY`. The gemini engine's 401 names only `GEMINI_API_KEY` and `GOOGLE_GENAI_API_KEY`. This moves pyric closer to production, where an AI key never reaches the browser. See Security (#1647).
- **`simulate()` and the MCP `firestore_simulate_rules` tool refuse malformed cases.** `method` must be `get`, `list`, `create`, `update` or `delete` (`read` used to allow). `path` is required. Unknown fields are refused by name. `requestTime` must be ISO-8601 with an offset. A `create` with `resource` is refused. A refused case reports `UNSUPPORTED` with a reason instead of answering. `{__type: ...}` maps are read as maps, and value helpers such as `timestamp('nope')` or `latlng(91, 0)` throw a `TypeError`. Rule fixture files with a refused case are now reported on reload instead of skipped silently. This moves pyric closer to production, because each case now means the same request in the simulator and on the Rules Test API (#1453).
- **`pyric rules simulate --service storage` builds `request.resource` per verb.** Before, `request.resource` was filled from the stored object. Now, it is built as the live upload, update, read or delete would send it. A `get` with `--data` is refused, and an unknown field in `--data` is named and refused. This moves pyric closer to production, where a re-upload carries only the metadata it sends (#1496).

### Security

#### Keep AI keys on the server

- The Vite dev server refuses to start when `VITE_GEMINI_API_KEY` is set, in the shell or in `.env`. Vite serves every `VITE_` variable to the browser, so the key reached every page. Rename it to `GEMINI_API_KEY`. The gemini engine no longer reads `VITE_GEMINI_API_KEY` (#1647).
- Pyric's browser modules no longer read `import.meta.env`, so the Vite dev server no longer adds the app's `VITE_` variables to a pyric module the page loads. Listener attribution reads `process.env.NODE_ENV` instead (#1647).
- On `hosted: true`, the gemini engine masks the server's key and ADC token in every form an upstream error quotes them, using the same masking as the `/__pyric/ai-proxy/gemini` route (#1657).

#### Refuse other local origins

- The sandbox WebSocket (`/__pyric/sandbox`) and the hosted control routes (`/__pyric/mcp`, `/__pyric/hosted/method`) check the Origin's port as well as its hostname, so a page on another local port is refused (#1438).
- `/__pyric/denials` is guarded again. alpha.30.2 left it open to any origin. On this release it refuses other origins and accepts the Next dev server's port that `pyric sandbox` learns (#1431, #1497).
- `pyric bridge` closes any browser socket, so a page on another local port can't register as its sandbox peer (#1507).

#### Stop the real Firebase SDKs and credentials under the register

- Under `@pyric/cli/register`, an import that resolves into the real `firebase-admin`, or into the real `firebase` or `@firebase/*` where pyric didn't choose them, now fails before the file loads with `PYRIC_REAL_SDK_STOPPED`. Code that loads the real SDK on purpose must run without the register (#1522).
- Under `pyric sandbox -- next dev`, `withPyric` makes `PYRIC_GUARD=block` the default, so the Next server refuses live Google and Firebase egress. Set `PYRIC_GUARD_ALLOW=<host>` or `PYRIC_GUARD=warn` for a Google endpoint pyric doesn't mirror (#1474).
- `withPyric` refuses to start `next dev` when `PYRIC_SANDBOX` is set but the register isn't active, for example when `PYRIC_SANDBOX` comes only from `.env`. Pass `{ guard: false }` to turn the check off (#1651).
- Turbopack's renamed `firebase-admin-<hash>` and `firebase-<hash>` imports on Next 16 map to the sandbox. Before, a route handler ran the real `firebase-admin` (#1471).
- Every Node child process of a registered process loads the register, whatever `env`, `NODE_OPTIONS` or `execArgv` it is started with (#1649).
- With `PYRIC_GUARD=block`, the network guard refuses the GCE metadata server in any address spelling, a Firebase host reached through a proxy tunnel, and connections from worker threads (#1445).
- The Functions child started by `pyric sandbox --hosted` sees the sandbox project in `GOOGLE_CLOUD_PROJECT` and `GCP_PROJECT`, and never sees `GOOGLE_APPLICATION_CREDENTIALS` from the host (#1435).

#### Refuse sign-ins pyric can't verify

- Served `signInWithCredential` checks email credentials, refuses unknown provider ids, and signs in a federated credential only as a staged result (#1467, #1483, #1509).

#### Open security issues

- The Vite plugin's `ai.engine.apiKey` for the gemini engine reaches the page (#1591).
- `hosted: true` sends the server's AI key to a `baseUrl` the page chooses (#1599).
- Gemini proxy error masking misses short credentials and mid-stream errors (#1600).

### Everything else

#### Fix the dev server and Vite plugin

- Vite no longer pre-bundles a second copy of `pyric`, so a page that imports `pyric/auth` shares one app registry with the served `firebase/*` entries (#1508).
- Two projects starting `vite dev` at once no longer read each other's half-written SharedWorker bundle (#1217).
- The SharedWorker version-skew warning is reworded in plain language (#1216).

#### Fix the Node host and the register

- A registered process finds its host again after the connection drops, including when the host comes back on another port (#1221).
- A registered process waits for a live but busy host instead of calling `PYRIC_SANDBOX` stale (#1541).

#### Fix the CLI

- `pyric run --sandbox` refuses a Vite server without a hosted sandbox at once and names `pyric({ hosted: true })` (#1582).
- The `pyric` CLI loads a command's modules only when that command runs, so `pyric run` starts in about 60 ms instead of about 475 ms (#1675).
- The CLI's local probes no longer keep the process alive about 10 seconds after a hung connect (#1213).
- `pyric firestore indexes generate` no longer writes an index for a dynamic collection id `{*}`, and the game-rules generator emits only rules production compiles (#1416).
- `firestore_discover_paths` keeps fields named `constructor`, `toString`, `hasOwnProperty` and `valueOf` instead of failing the crawl (#1439).
- Storage `rules.lint` runs the shared security lint (#1496).

#### Update create-pyric

- The Next.js template moves to Next 16 (#1492).

#### Docs

- ADR-0021 proposes Firestore named databases (#1391). ADR-0022, swap or stop, is accepted (#1510).

**Full changelog:** https://github.com/davideast/pyric/compare/v0.1.0-alpha.30.2...v0.1.0-alpha.31

## 0.1.0-alpha.11

### Breaking: `pyric/database` is the canonical sandbox-only mirror

- `pyric/database` exports only the Firebase-shaped modular Database surface
  and sandbox-specific extensions.
- The duplicate `pyric/database/modular` subpath is removed. Import the mirror
  from `pyric/database`.
- Direct mirror calls reject real Firebase apps. Package resolution owns the
  backend swap: inactive production code imports `firebase/database`, while
  Pyric activation maps that canonical import to the sandbox mirror.

### Added: local Realtime Database inspection

- `rtdbRules({ rules: ... }).simulate(cases)` now evaluates compiled RTDB
  rules JSON directly. It does not fetch rules or depend on a prior tool call.
- `pyric/sandbox/database` exposes owner controls for installing RTDB rules,
  seeding data, and reading detached snapshots from a `LocalSandbox`. These
  controls share the same backend used by the `pyric/database` mirror.

### Breaking: `pyric/rules` public API replaced

`pyric/rules` shipped an accidental public surface of roughly 135 exports
spread across six subpaths (`./rules`, `./rules/node`, `./rules/extract`,
`./rules/rtdb`, `./rules/rtdb/constraints`, `./rules/rtdb-constraints`). That
surface exposed parser internals, simulator handlers, resolver plumbing, zod
schemas, and tool factories that were never meant to be part of the contract.
It is replaced, in one clean break, with a small curated front door. This is
an alpha release two days after publish; there are no deprecated aliases.

**Removed subpaths.** `./rules/node`, `./rules/extract`, `./rules/rtdb`,
`./rules/rtdb/constraints`, and `./rules/rtdb-constraints` no longer exist.

**The new `pyric/rules` surface:**

- `firestoreRules(source)` — compiles Firestore rules into a deep,
  safe-by-default handle: `lint()`, `simulate(cases)`, `explain(case)`,
  `toJSON()`. The constructor throws `RulesCompileError` (with `.issues`) on
  unparseable source; past that, `simulate` never throws on a rule outcome.
- `rtdbRules(defOrDocOrJson)` — the same handle for Realtime Database rules,
  accepting a definition, an authored document, or compiled `{ rules }` JSON.
  The `RtdbRulesDocument` that `defineRtdbRules` returns is inert on the
  public surface: the type exposes no methods (no `check()`, `simulate()`,
  `toJSON()`, or `toIR()` on the document itself). It is an authored artifact
  you pass to `rtdbRules()`, which is the one analysis surface. The
  method-bearing document interface remains available to engine consumers on
  the internal seam.
- `lint(source)` — a tolerant free function that accepts any source
  (including broken or empty), never throws, and returns every issue.
- `assertCase` / `explainCase` — the assertion adapter that bridges to a
  throwing test runner, the one throwing verb beyond the constructors.
  `assertCase(result)` asserts an already-simulated `CaseResult`;
  `assertCase(ruleset, oneCase)` (and the `assertCase(source, oneCase)`
  convenience for Firestore) simulates that single case and throws
  `RulesAssertionError` on a failed case or `RulesUnsupportedError` on a
  simulator abstention, with the `explainCase` trace as the message. Runner
  wiring: `for (const c of cases) test(c.description, () => assertCase(ruleset, c))`.
  `explainCase` is the single sanctioned trace renderer.
- `RuleIssue` — one unified diagnostic (`code`, `severity`, `message`,
  `path?`, `line?`, `fix?`, `origin`) replacing the former `LintWarning` /
  `ValidationFinding` / `ParseError` split.
- Distinct `FirestoreCase` and `RtdbCase` shapes (not unified), plus the
  structured trace types (`RuleEvaluation`, `PathResolutionTrace`,
  `PathResolutionEntry`, `ExprTraceEntry`) as plain data.
- Value helpers: `serverTimestamp`, `timestamp`, `bytes`, `latlng`,
  `duration`, `reference`, `vector`.
- The Realtime Database constraints DSL (`defineRtdbRules` and its
  combinators) is re-exported unchanged as siblings.

Storage rules are not covered here yet.

**Migration.** Callers that authored/linted/simulated rules through the old
handlers move to the constructors:

```ts
// before
import { lintFirestoreRules, SimulateFirestoreRulesHandler } from 'pyric/rules';
const { warnings } = lintFirestoreRules(src);
const { data } = new SimulateFirestoreRulesHandler().simulate(src, cases);

// after
import { firestoreRules, lint } from 'pyric/rules';
const issues = lint(src);                       // tolerant, RuleIssue[]
const summary = firestoreRules(src).simulate(cases);
```

The RTDB constraints DSL now imports from `pyric/rules` (it used to live on
`pyric/rules/rtdb` and `pyric/rules/rtdb/constraints`):

```ts
// before
import { defineRtdbRules, allow, deny } from 'pyric/rules/rtdb';
// after
import { defineRtdbRules, allow, deny } from 'pyric/rules';
```

The low-level engine (parser, linter, simulator handlers, resolver,
wrappers, RTDB machinery, agent-tool factories, composite-index extractor)
remains available to deep and tooling consumers on internal seams —
`pyric/rules/internal`, `pyric/rules/internal/node`,
`pyric/rules/internal/rtdb`, and `pyric/rules/internal/extract` — mirroring
the existing `pyric/sandbox/internal` and `pyric/storage/internal` pattern.
These are not part of the public contract and may change without notice.
