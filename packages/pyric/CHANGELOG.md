# Changelog

## 0.1.0-alpha.35

This release has three themes. A Node backend can now run `firebase-admin` in live mode, and its Admin calls show in Traffic as production rows that bypass Security Rules (#2304). Live mode now monitors an app the way sandbox mode does: listeners, Rates, billed counts, local rules verdicts, index checks, clients and the data a session saw (#2305). And pyric's local surfaces are locked down: they check a session token, the Origin and the Host, and the records they serve keep what Firebase returned, unscrubbed (ADR 0024, #2575, #2578, #2571).

Live mode also changes its model. It observes and never blocks at the network: a call no row records goes to production as it would without pyric (ADR 0022, second amendment, #2445). pyric no longer watches the network at all, in either mode. It swaps or stops Firebase imports, and stops a runtime where it can't (ADR 0023, #2547).

### New in this release

- **`firebase-admin` in live mode.** Under `node --import @pyric/live/register` on Node 23 or later, `firebase-admin` 13 loads with the process's own credential. Its Firestore, Auth, Realtime Database, Cloud Storage and Messaging calls are rows named `<Class>.<method>`, such as `DocumentReference.set`, marked as Admin calls that bypass Security Rules (#2393, #2401, #2417, #2421, #2422, #2426, #2437, #2470, #2548).
- **More live rows.** `firebase/database` (#2205), `firebase/storage` (#2261), `firebase/ai` (#2267), `firebase/messaging` and `firebase/messaging/sw` (#2301) are served and observed on the page and in Node processes.
- **`pyricLive({ passThrough })`.** A list of Firebase imports live mode has no row for, such as `firebase/functions`. Each loads the app's installed SDK, unobserved (#2121). A Node process under the live register reads the same list from its host (#2133).
- **`pyric-live run`.** Starts a Node process against a running live host: `npx pyric-live run -- node server.mjs`. It finds the host from `.pyric/serve.json`, or takes `--host <loopback url>`, and loads `@pyric/live/register` for the child. `--wait` waits up to 30 seconds for the host to answer, and `--wait=<seconds>` sets the limit. It exits 1 on a usage error or a runtime it can't swap, 2 when no live host answers, and otherwise with the child's code (#2581).
- **Observed session data.** On a live host, the Firestore documents and Realtime Database values your app's successful calls saw, from the client SDK and from `firebase-admin`, are kept in the host's memory, up to 2,000 documents and 8 MiB. Studio's Data and Realtime Database views show them read-only, marked "Observed · Client", "Observed · Admin" or both. `GET /__pyric/live/session-data` returns them. Values pyric can't hold are counted in `skips` (#2498, #2549).
- **`pyric sandbox seed-from-live`.** Copies the observed session data into the local sandbox. `--confirm` merges it into `.pyric/state/hosted`, `--confirm --replace` clears the local data first, and `--out=<file>` writes a seed file for `pyric sandbox --seed`. With none of these, it refuses. Typed Firestore values and Realtime Database priorities survive the trip (#2498, #2510, #2563).
- **Observed Storage in Studio.** On a live host, Studio's Storage page is a read-only browser of the objects the app's client and Admin Storage calls touched this session: buckets, folders, metadata, objects deleted this session and their download URLs. It keeps no file bytes. Seeding from live copies Firestore and Realtime Database only (#2548, #2572).
- **The chip on a live host.** A Live tab shows the project, each connected client and when it was last seen, which imports are observed or `passThrough`, and what this session billed (#2331). The Identity tab shows the production user the app's Auth holds, with a Sign out button that calls the app's own `signOut` (#2484). A From select scopes Traffic and Rates to this page, one client, one user, signed-out calls or every client (#2488).
- **Studio Traffic by client.** On a live host, Studio's Traffic has the same From select, kept in `?from=`. Every live row has the same columns, and a row opens in place with its source, identity, outcome and rules detail (#2505).
- **Production denials in the terminal.** When production denies an observed Firestore, Realtime Database or Storage call, the live dev server prints the service, method, path, code, production's message, the client and the user. A rejected AI Logic request, or an answer production withheld for safety, prints a block too. Repeats are held back (#2487, #2489).
- **Reload after a host restart.** A page that outlives a restart of the dev server prints one console warning, and the chip offers a Reload page button (#2496).
- **Process health.** Every HTTP server in a process under `@pyric/cli/register` or `@pyric/live/register` answers a request to `/__pyric/health` that carries `x-pyric-process-health: 1` with its mode, and its project or sandbox instance (#2371).
- **The proxy check.** At start, the Vite plugin asks each `server.proxy` target on this machine what it is. It warns when the target is in another mode or on another project, and lists each verdict in the health report's `proxyTargets`. It never refuses (#2378).
- **Live calls replay in `pyric verify`.** The capture file keeps each live call with production's answer, the local rules verdict and the values it carried, and `pyric verify` replays them against the rules you have now (#2386).
- **Storage rules by bucket.** `pyric verify` takes `--rules storage:<bucket>=<path>` and the `firebase.json` storage array, so each bucket replays under its own rules (#2348, #2356). `rules.simulate` for Storage takes a `bucket` (#2374).
- **`pyric verify --static` and `pyric assurance derive`.** Both read your app's Firebase calls from source and check them against your Firestore, Realtime Database and Storage rules. They report a `list` query the rules can't allow, with the `where(...)` to add, and a Storage upload that breaks a bucket's content type, size or metadata limits. They also report a call no rule covers, a rule no code uses, and a write rule that only checks `request.auth != null`. By default they fail only on proven findings, and `--fail-on heuristic` fails on the rest. Invalid rules or `firebase.json` is a finding and exits 1. `pyric assurance derive` also turns each finding into a campaign you can open in Studio, and is the MCP tool `assurance.derive` (#2530, #2534, #2536, #2538, #2539, #2573).
- **Storage in assurance probes.** Campaigns now test Storage rules on default and named buckets: uploads past the rules' limits, writes and deletes in another user's path, a forged owner field, and access by a non-member under rules that read Firestore. Attaching a running sandbox now brings its Storage objects and rules (#2528, #2529, #2564).
- **Realtime Database index generation.** `pyric database indexes generate <path...>` reads the `orderByChild` and `orderByValue` queries in your code and adds the `.indexOn` entries your rules need, without removing any. The MCP tool is `extract_database_indexes` (#2527).

### Behavior changes

Each entry names the old behavior, the new behavior and the PR.

#### Local routes, tokens and records

These can stop a script or a setup that worked before.

- Local routes in live mode (`pyric-live`, `pyricLive()`): before, a local caller could use them without a token. Now, every `/__pyric/*` route, MCP endpoint, event stream and the `/__pyric/sandbox` WebSocket needs the session token, and no option turns it off. Without it, a caller gets 401, or a closed socket. `/__pyric/health` and `/__pyric/init.json` answer without it, with only status, mode, instance id and whether the sandbox is connected, so the health report's `live` and `proxyTargets` need the token too (#2575, #2578).
- Local routes in sandbox mode (`pyric sandbox`, `pyric()`, `pyric bridge`): `/__pyric/workspace*`, `/__pyric/projects*`, `/__pyric/ai-proxy*` and `/__pyric/live/*` now need the session token. Other routes answer a caller on this machine without it. `--session-token`, `pyric({ sessionToken: true })` or `"sessionToken": true` in `pyric.json` requires it on every route (#2575, #2578).
- How to send the token: pages the dev server serves get an `HttpOnly` `__pyric_session` cookie, and built-in commands, Studio and `pyric mcp` send it for you. A script or an HTTP MCP client sends the `x-pyric-session-token` header, with `token` from `.pyric/serve.json` or `.pyric/session.json`. Before, `?token=` in a URL worked. Now, it is ignored, and `mcpUrl` in `.pyric/serve.json` carries no token. Those files are readable only by your OS user (#2575, #2577, #2578).
- A request whose `Origin` is another port or site, or whose `Sec-Fetch-Site` is `cross-site` or `same-site`: before, allowed. Now, 403, before the token is checked, even with a valid cookie (#2575, #2578).
- The `Host` check on `/__pyric/*`: before, Vite's `server.allowedHosts: true` let any Host through, and `/__pyric/health` checked only for loopback (#2370). Now, a loopback name, the bound host or a named `--allowed-host` entry passes, and `allowedHosts: true` widens nothing. A tunnel name reaches only the routes that check the token (#2575, #2578).
- The network guard: before, pyric blocked Google hosts such as `oauth2.googleapis.com` and the metadata server at the socket, in sandbox and live processes. Now, it is gone. pyric swaps or stops the `firebase`, `firebase-admin` and `@firebase/*` imports, and nothing else. A direct `@google-cloud/storage` call, a raw `fetch` to `*.googleapis.com` or a bundle with the SDK already inlined reaches Google. `PYRIC_GUARD` and `PYRIC_GUARD_ALLOW` are ignored, with one deprecation line (#2547).
- What pyric records: before, it replaced values that looked like secrets, and emails, with markers such as `[REDACTED]` and `[email]`. Now, it keeps what Firebase returned and what the call carried. That covers Traffic previews, Storage `customMetadata` and download URLs with their tokens, query field paths, error messages, email addresses, AI response text, and the values in local rules traces. `.pyric/` files, `pyric verify` fixtures and repro files can now hold these values, so keep them out of version control and anything you share. Rules that read such values now get the same local verdict as in production (ADR 0024, #2537, #2565, #2571, #2572).
- `pyric serve repro capture`: before, it replaced JWTs with `{ "__redactedJwt": ... }` and PEM and service account fields with `"[redacted]"`. Now, it records them as they were. An old repro file's `__redactedJwt` markers are no longer turned back into tokens on replay (#2571).
- A federated credential (Google, Apple, GitHub, OIDC and others) in a served app's `signInWithCredential`, `linkWithCredential` or `reauthenticateWithCredential`: before, its `idToken`, `accessToken` and `rawNonce` went to the host and into `.repro.json` files. Now, only `providerId` and `signInMethod` go. The MCP `signInWithCredential` method and the `sign_in_credential` action drop their `idToken` and `accessToken` arguments, which the sandbox never checked. `pyric-admin/app`'s `refreshToken()` no longer keeps the token it was given (#2567).
- An AI upstream URL with a username and password, such as `http://user:secret@gateway/`: before, they showed in the page's config, AI errors, proxy errors, the terminal and the broker's events. Now, they are removed everywhere, and the server still uses them upstream (#2343).
- A child of a process under `@pyric/cli/register` started with `NODE_ENV=production`: before, it loaded the real `firebase-admin`. Now, it stays in the sandbox, as do its own children. A job that needs the real SDK starts outside the sandbox, or sets `PYRIC_SANDBOX_FORCE=0` in its child's env (#2494).

#### Live mode

- A Google call from a Node process under `@pyric/live/register` that no row serves, such as a token exchange, Cloud Trace, Vertex AI or a key fetch: before, refused with `PYRIC_GUARD_BLOCKED`. Now, it goes out with no line, as it would without pyric. The live Vite dev server does the same (#2469, #2547).
- `@pyric/live/register` in a folder whose config names no project: before, failed with `PYRIC_LIVE_NO_PROJECT`. Now, it takes the project of the live host it reaches, and sets `PYRIC_PROJECT` for its child processes. A project your config names still wins (#2581).
- A call from an app whose config names another project than the live host's: before, it went to that project. Now, it is refused with `PYRIC_LIVE_REFUSED` before the SDK runs, and no row is made. The check reads `projectId`, `databaseURL`, `storageBucket` and `authDomain`, and the Realtime Database instance and Storage bucket the call reaches. `getDatabase(app, url)` on another project's default instance is refused too. So are Auth calls that take an action code or a `User`, such as `applyActionCode`, `confirmPasswordReset` and `reload`, and a Storage reference with an invalid bucket name (#2311, #2319, #2326, #2338, #2342, #2563).
- `firebase/database`, `firebase/storage`, `firebase/ai`, `firebase/messaging` and `firebase/messaging/sw` on a live page or in a live Node process: before, refused with `PYRIC_LIVE_REFUSED`. Now, served by live rows. Listing one of them in `passThrough` stops the dev server at start with `passThrough lists <import>, which live mode already serves and observes; remove it.` The imports `passThrough` takes are `firebase/analytics`, `firebase/functions`, `firebase/performance` and `firebase/remote-config` (#2205, #2261, #2267, #2301).
- Messaging's `register`, `unregister`, `onRegistered` and `onUnregistered` in live mode: throw `PYRIC_LIVE_REFUSED` before any request (#2301).
- `new LiveGenerativeModel`, `LiveSession`, `TemplateGenerativeModel` and the Imagen classes from `firebase/ai` in live mode are refused with `PYRIC_LIVE_REFUSED` at construction, before any request (#2240).
- A Firestore rules write from a page or Studio on a live host: before, it succeeded and changed sandbox rules the live app never uses. Now, refused with `PYRIC_LIVE_REFUSED` (#2353).
- A data read through the host's MCP tools or `pyric <service> <method>` on a live host: before, answered from the empty sandbox. Now, an open tab of the app answers it from production as its signed-in user, for Firestore and Realtime Database reads and Storage lists and metadata. The tab answers only for a database instance or bucket it has opened. Otherwise, or with no open tab, it is refused (#2402, #2406, #2411, #2563).
- The MCP tools `auth_impersonate`, `auth_reset`, `sandbox_save_capture`, `sandbox_rename_capture` and `sandbox_delete_capture` on a live host: now refused with `PYRIC_LIVE_REFUSED` (#2563).
- An observed call production denied: before, its event read `result: 'error'`. Now, `deny`, so `events({ kind: 'denials' })` lists it (#2359).
- A live `onSnapshot`: before, the chip's Listeners view stayed empty. Now, it lists the listener and its deliveries (#2088). Each Firestore and Realtime Database listener's attach and detach now reach the host, including `onSnapshotResume`, so `pyric sandbox listeners` and `pyric sandbox activity` see a live app's listeners (#2466, #2471, #2478).
- Chip Rates on a live host: before, counted this page's own calls. Now, count every observed call from the host's event stream, with production's sizes (#2403). The health report's `live.billed`: before, one per call. Now, the documents production billed for each call (#2377). A `writeBatch` commit is one call that counts its writes and deletes (#2424).
- Live Firestore rows: now carry the document or collection path (#2362) and the query's shape, with a hash in place of every filter value (#2429). They feed the chip's index check and Studio's Billable metrics (#2454). A query production refused for a missing index shows the Index badge, and other `failed-precondition` answers still read Failed (#2504).
- Each observed Firestore, Realtime Database and Storage call now carries a local verdict from the app's rules files, beside production's answer: "local rules would allow" or "would deny". A Storage call is checked against its bucket's rules, using metadata and size, never bytes. A rule that reads stored data is checked against the data this session saw, and a path it didn't see makes the verdict `unevaluated` with the path in `missingPaths`. Its Traffic row opens the same rules evaluation view a sandbox row uses (#2368, #2380, #2382, #2405, #2409, #2497, #2499, #2546, #2562).
- Studio's Traffic subtabs on a live host: before, Billable metrics dropped Realtime Database and Storage calls, Rules showed no evaluations, and Listeners showed no deliveries. Now, each counts live calls. Each kind of traffic keeps its own last 500 events, and a Timeline selection scopes Rules and Billable metrics (#2532, #2545).
- Studio's Auth, Storage, Data and Realtime Database pages on a live host: before, showed the local sandbox's users, objects and data. Now, Auth says the user list is unavailable in live mode, and the others show only observed data. Studio no longer subscribes to sandbox data there, and its tabs are not listed in `live.clients`. Settings says its controls change the local sandbox, not the project (#2498, #2503, #2516, #2531).
- A live row in a module service worker: before, its calls never reached Traffic. Now, they reach the host on the worker's own connection, and the row reads "Service worker" (#2284, #2292).
- The live register and `pyric-live`: before, refused to start from a folder below the Firebase project, or when `pyric`, `@pyric/live` or `firebase` were installed in a sibling or app folder. Now, they find the nearest folder with `.firebaserc` or `firebase.json`, and resolve the app's `firebase` from the entry script's folder first (#2115, #2133, #2147, #2159, #2164, #2187).
- The live health report: `live.observed` lists the `firebase/*` imports the app resolved to live rows (#2332, #2349). `live.clients` lists each connected page, service worker and Node process by the client id its events carry, with the page's user and email (#2352, #2366, #2471). A service worker names its path and a Node process its entry script, such as `server.mjs` (#2485). A tab that signs out or switches accounts no longer keeps the old user (#2561). A Node process's `unobservedAdmin` and `gatedAdmin` lists show under its client (#2473, #2547).

#### Admin SDK in live mode

- A `firebase-admin` import under `@pyric/live/register`: before, refused with `PYRIC_LIVE_REFUSED`. Now, on Node 23 or later, it loads and its calls are observed (#2437). On Node 22, each import is still refused, and the start line names Node 23. A Node 22 child of a Node 23 or later process refuses it the same way and prints the same line (#2437, #2475).
- `firebase-admin` with `require-in-the-middle` or `import-in-the-middle` installed, as tracing tools do: before, false `PYRIC_REAL_SDK_STOPPED` errors. Now, it loads and is observed (#2531).
- A `firebase-admin` service no row serves, such as `firebase-admin/remote-config`: before, refused at import. Now, it loads unobserved, with one line in the terminal, and the process health lists it in `unobservedAdmin`. `firebase-admin/app-check` is checked against the project but makes no row, and is listed in `gatedAdmin` (#2469, #2470).
- An Admin app whose project resolves to another project: refused with `PYRIC_LIVE_REFUSED` on every call, before any request. The project is read in `firebase-admin`'s own order: `projectId`, the `cert()` credential, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, then application default credentials (#2392, #2437). A count query is checked too (#2461).
- At start, with `firebase-admin` installed: the register refuses when `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT` or the `projectId` in `FIREBASE_CONFIG` names another project. When `GOOGLE_CLOUD_PROJECT` is unset, it sets it to the live project. A `firebase-admin` major other than 13 stops the start (#2437).
- An Admin Realtime Database call to an instance that isn't the live project's: refused before it connects. Accepted instances are `<project>-default-rtdb`, the legacy `<project>`, and the instances `firebase.json` names. `acme-prod-default-rtdb` belongs to `acme-prod`, not `acme`. An instance the row can't read is refused too, and so are `getRules`, `getRulesJSON` and `setRules` on such an instance (#2469, #2470).
- An Admin Storage call to another project's default bucket, such as `other.appspot.com`: refused before the SDK runs (#2437).
- A callback-style Admin Storage or Realtime Database call is recorded when it settles, and its callback hears a refusal (#2452).
- A live backend's `verifyIdToken` or `verifySessionCookie` on a token a pyric sandbox issued rejects with `auth/argument-error` and `pyricCode: 'PYRIC_MODE_MISMATCH'`, before any request (#2452).
- Admin calls count in Rates and `live.billed` as the client method that bills the same way, with the documents they read or wrote. `Query.get` counts as `getDocs`, for example (#2452, #2461).
- `pyricLive({ passThrough: ['firebase-admin'] })` stops the dev server at start with `passThrough lists firebase-admin, which live mode already serves and observes; remove it.` The health report's `live.admin` reads `{ mode: 'observed', observed: true, bypassesRules: true }` (#2437, #2438, #2464).
- When an emulator variable such as `FIRESTORE_EMULATOR_HOST` is set, the register prints one line naming the service and the address its calls go to (#2437).

#### Auth

- A sandbox backend's `verifyIdToken` on an ID token production issued: before, `auth/argument-error`. Now, the same code, plus `pyricCode: 'PYRIC_MODE_MISMATCH'` and a message that names the sandbox instance (#2321).
- The `pyric dev` sign-in dialog: before, it cleared what you typed when the account list arrived. Now, it keeps it (#2126).
- A user created with `pyric-admin` `createUser`: before, kept in a store the client didn't read. Now, the client and Admin share one user store, so that user can sign in with `signInWithEmailAndPassword` (#2523).
- Claims from `signInWithCustomToken`: before, written to the stored user, so a later password sign-in kept them. Now, they last for that session only, as production does (#2523).
- `pyric-admin` Auth on a served sandbox: `verifyIdToken(token, true)` after `revokeRefreshTokens` rejects with `auth/id-token-revoked`, and `listUsers` pages with a page token, as in process. A handle kept after `deleteApp` fails with `app/app-deleted` (#2557).

#### Firestore and Rules

- A rules lookup path with an interpolated value that holds `/`, such as `/users/$(owner)`: before, the value split into segments and could name a nested document. Now, it is one segment, as production reads it (#2177).
- `allow` statements on a root `match /{path=**}` block: before, ignored, so every request was denied. Now, applied (#2179).
- An int and a float past 2^53 in Sets and `diff()`: before, `9007199254740993` matched the double it rounds to. Now, they compare by exact value (#2181).
- `matches()` with a script class such as `\p{Cyrillic}`: before, matched no character. Now, matches the script. A class range outside the Basic Multilingual Plane, such as `[😀-😂]`: before, `setRules` refused it. Now, it compiles (#2206).
- `lower()` and `upper()`: before, mapped every letter, so `'ÉVE@X.COM'.lower()` was `'éve@x.com'`. Now, only A to Z, as production does, in Firestore and Storage rules (#2216, #2242).
- `split()` and `replace()`: now run on the same linear RE2 matcher as `matches()`. `split('(a+)+b')` on 40 `a`s takes about 3 ms, down from 515 ms. Scoped flags, `\pL`, `(?U)`, POSIX classes, `\Q..\E` and code points read as production reads them (#2268, #2277).
- `\x{5e}` and `\x{2d}` inside `[...]` in a rules regex: before, read as a negation or a range. Now, literal characters. Octal escapes such as `\101` compile (#2552).
- `--1`, `- -1` and `-(9223372036854775808)`: before, compiled. Now, refused at compile with production's messages (#2256).
- A rules file with a `firebase.storage` block before its `cloud.firestore` block: before, failed to parse. Now, it loads and the Firestore block applies. Two `cloud.firestore` blocks fail with `Duplicate service name declaration.` from `firestoreRules()` and `pyric sandbox` (#2258, #2262).
- A Firestore rules source of 262,144 bytes or more: before, it loaded. Now, refused with `Total size of sources must be smaller than 262144.` A counted regex past 10,000 positions, such as `(a{1000}){11}`: before, refused. Now, it compiles, up to 200,000 matcher states (#2285).
- `lint(source)` on rules `firestoreRules()` refuses to compile: before, no issue. Now, `DOUBLE_MINUS`, `INVALID_NUMBER_LITERAL`, `DUPLICATE_SERVICE` or `SOURCE_SIZE` with `origin: 'parse'` and the line (#2459). On `2+modules` rules that import the bundled helpers: before, false `SEC-3` and `SEC-6` errors. Now, none, and a name `'auth'` doesn't export reports `SEM-4` (#2552).
- `is` and `in`: `is` now binds tighter than `==`, and `in` looser, as production's compiler reads them (#2522).
- An unknown property on a `Timestamp`, `Duration`, `LatLng`, `Bytes` or `Path`, such as `request.time.year`: before, null. Now, an error, so the rule denies (#2522).
- `request.query.orderBy`: before, the first ordered field's name, or `null`. Now, a map of field to `'ASC'` or `'DESC'`, as production gives it, and `{}` when unordered (#2554).
- A document reference field: before, `is path` was false, and it didn't equal its `/databases/(default)/documents/...` path. Now, both are true, in Firestore rules and through Storage's `firestore.get()` (#2495, #2569).
- `map.get(keys, default)` with a key that is not a string: before, read as a string or the default. Now, an error that denies (#2444).
- A helper function: now resolves the wildcards of the block that declares it, not a nested block that reuses the name (#2491, #2554).
- `list` queries: an `in` filter must meet the rule for every value, or the query is denied. A `hasAny` or `hasAll` list that holds `request.auth.uid` denies a signed-out query. An `||` branch that doesn't depend on the document id now proves the query it allows (#2491, #2554).
- A batch with several writes to one document: `getAfter()` and `existsAfter()` see the document after the whole batch, and a `set` then `update` on a new document is checked once as `create` (#2522, #2554).
- `tx.get(query)` in `runTransaction`: before, a concurrent change to a matching document didn't cause a retry. Now, the commit retries. A query read after a write rejects with `failed-precondition`, and a callback that catches a read-after-write error no longer commits (#2515, #2523, #2558).
- `count()` with `sum()` or `average()` counts only documents that have the field (#2523). Objects from `data()`, `val()` and snapshot callbacks are copies, so changing one no longer changes the sandbox (#2558).
- A field named `__proto__`: before, lost on write. Now, stored and read as a field (#2543, #2561).
- `mergeFields` with a `FieldPath` holding a dot, such as `new FieldPath('meta.v1')`: now one field, on the page, in served apps and in `pyric-admin` (#2515, #2520). A `writeBatch` used after `commit()` throws `failed-precondition` (#2515). `getDocs` results and `pyric-admin` `Query.get()` have `docChanges()` (#2515, #2520).
- `auth: { tenant }` in `firestoreRules().simulate()` and test cases: before, ignored. Now, sets `request.auth.token.firebase.tenant` (#2493).
- A rules test case sent to production's Rules Test API with `serverTimestamp()`: before, sent as a map. Now, as the request time (#2456).
- `onSnapshotResume` listeners: now counted in the chip's Rates, as `onSnapshot` is (#2354).

#### Realtime Database

- A `-0` write over a stored `0`: before, fired `onValue` and `child_changed`. Now, it is stored as `0` and fires nothing, as production does. The CLI worker compares values the same way (#2168, #2171).
- A hosted page left in a hidden tab for more than five minutes: before, it reconnected and its `onDisconnect` writes ran while the page was still open. Now, it keeps its connection (#2103).
- A listener cancelled by a permission error: before, it came back after a later sign-in in a served app. Now, it stays cancelled, as in the Firebase SDK. A served denial arrives as an `Error` with `code: 'PERMISSION_DENIED'` (#2462, #2502).
- A `.read` rule that uses `now`: before, an open listener kept receiving data after the time passed. Now, the next write cancels it (#2555).
- Listener events: now fire deepest path first, and in production's order within a ref: `child_removed`, `child_added`, `child_moved`, `child_changed`, then `value` (#2523).
- A multi-path `update` denied by both `.write` and `.validate`: now reports the `.write` denial. A trailing `/.priority` key sets the priority, where before it wrote a child named `.priority`. A rules regex class that starts with `]` parses (#2493).
- `serverTimestamp()` or `increment()` as a priority resolves before `.validate`. Writing a child under a leaf clears its priority. A transaction's result on a path the user can't read shows only what the user wrote (#2555).
- A literal rules key beside a `$wildcard`: before, took the wildcard's `.indexOn`. Now, it doesn't, so a query there needs its own (#2491).
- `update()` with an array or `NaN`, and `runTransaction` on `.info/connected`: now throw at once (#2502).
- `pyric-admin/database` in the same process as `pyric/database`: before, kept its own data. Now, both share one tree. `ServerValue` resolves in process, `onComplete` callbacks run, and `Reference.toString()` returns an `https://<instance>.firebaseio.com/` URL (#2520, #2558).
- Snapshots, checkpoints, branches and `captureFullState`: before, dropped named database instances. Now, each instance, its rules and its data survive a restore, `fork` and `promote`. Storage objects keep their generation and download tokens, and a phone-only user is kept (#2556).

#### Storage

- Buckets with their own rules in `firebase.json`: before, the dev server, SharedWorker, in-page runtime and Node host gave every bucket the first entry's rules. Now, each bucket enforces its own. `pyric mcp` and the `--in-process` CLI load each bucket's rules too (#2323, #2369).
- In permissive mode, a bucket with no rules deployed: before, locked. Now, open, as an undeployed Realtime Database instance is (#2334).
- `pyric rules set --service storage` on the Node host, before any page names the default bucket: before, reported success. Now, refuses with `default-bucket-name-unknown` and exits 2 (#2335).
- A path wildcard named `request` or `resource`: before, read as the global. Now, read as the wildcard inside its block (#2249).
- A coarse `write` with a payload over a stored object: before, checked as `update`. Now, as `create`, as production checks an upload (#2251).
- One allowed upload over the hosted byte route: before, two `create` decisions. Now, one (#2360).
- A Storage call's activity source: before, `pyric-default/<path>`. Now, `gs://<bucket>/<path>`, the same string as its Traffic row (#2259).
- `storage/unauthorized-app` from production: before, read as failed. Now, as a production denial (#2234).
- An invalid literal regex in `.matches(...)`, such as `'['`: before, loaded and denied at request time. Now, the rules fail to load with `Storage rules do not compile`. So do two `firebase.storage` blocks (#2443).
- `service cloud.storage` and several top-level `match` blocks: now accepted. `request.resource` and `resource` now have `md5Hash`, `crc32c`, `etag` and the cache and content headers (#2522, #2552).
- A path literal such as `/a/b/c`: before, cost one extra unit of the expression limit. Now, it costs what production charges (#2455).
- `getStorage(app, 'gs://b')` returns the same instance as `getStorage(app, 'b')`, and a root path rejects with `storage/invalid-root-operation` (#2502). A second Admin app with its own `storageBucket` keeps its own files (#2557).

#### Indexes and `pyric verify`

- `pyric firestore indexes generate`: before, missed a `query(...)` passed straight to `getDocs` or `onSnapshot`, one stored under another name, one through an alias or `export *`, and chained `firebase-admin` queries. Now, it writes their indexes, and warns `unresolved-query` with the file and line when it can't read one. Your `firestore.indexes.json` may list more indexes (#2490, #2534).
- `array-contains` or `array-contains-any` with `orderBy` on the same field: before, no index. Now, the composite index production needs (#2495).
- The JSDoc tags `@firestore-mutex`, `@firestore-required` and `@firestore-budget`: no longer read (#2527).
- A rules or config path that leaves the project root through `../` or a symlink: now refused by index generation and the static checks. A flag that takes a value but gets none exits 2 (#2538).
- `pyric verify` replays a `writeBatch` or transaction as one unit, and Storage rules that read Firestore see the data as it was at the upload (#2495, #2559).
- `pyric verify --engine staging` on Realtime Database data with integer keys: before, reported `state-drift` for an array. Now, both sides compare in the stored shape (#2553).
- `pyric firestore rules validate` and `pyric verify` resolve relative imports in `2+modules` rules (#2559).

#### CLI and Studio

- `pyric sandbox -- <cmd>` and `pyric run -- <cmd>` with `bun`, `bunx` or `deno`: before, ran, with Firebase imports left unswapped. Now, stop with `PYRIC_UNSUPPORTED_RUNTIME` and exit 1. The `pyric()` Vite plugin under Bun stops the same way (#2547).
- `@pyric/cli/register` and the `pyric()` Vite plugin on Node earlier than 22.15: before, left `require('firebase-admin')` unswapped. Now, stop with `PYRIC_UNSUPPORTED_NODE_VERSION` (#2547).
- `withPyric()` with a Next.js route or middleware on the Edge runtime: now stops the dev server with `PYRIC_EDGE_RUNTIME_UNSUPPORTED`. Set `export const runtime = 'nodejs'`, or set `PYRIC_ALLOW_UNSWAPPED_EDGE=1` to skip the stop (#2547).
- A server-rendered import of an `@firebase/*` package or a `firebase-admin` alias under `vite dev` with `ssr.noExternal: true`: before, bundled, so it ran the real SDK or failed. Now, stops with `PYRIC_REAL_SDK_STOPPED` (#2492).
- A Vite dev server that serves HTTPS: before, its server-rendered modules failed with `fetch failed`. Now, they reach it over `https` and `wss`, trusting its own certificate for its address only, and `.pyric/serve.json` records `https://` (#2570).
- `pyric sandbox -- next dev` with a stale `.pyric/serve.json` from a dead host: before, `ECONNREFUSED`. Now, it uses the host this command started (#2519).
- `pyric --help`, the bridge banner, `/health` and the MCP server's version: before, `0.0.0`. Now, the installed `@pyric/cli` version. `pyric bridge --port 0` binds a free port (#2580).
- Rules deployed through the CLI or MCP tools with no host running: now kept until you edit the rules file. `sandbox.reset({ scope: 'all' })` clears every service, named database instances included, and keeps rules (#2559).
- `inspect_sandbox`: now reports a summary of every service, with previews opt-in through `includeData` (#2528).
- `/__pyric/health` on the dev server: before, answered any Host the server allowed. Now, answers only a loopback or bound Host, and 403 to others. See Local routes for the token (#2370, #2575).
- Traffic labels: a client SDK call from a Node process now reads "Node process" (was "Server (client SDK)"), and a `firebase-admin` call "Node process, Admin SDK" (was "Server (admin)"). A service worker's rows read "Service worker" (was "Other tab") (#2286, #2408).
- Storage rows in the chip and Studio now name their bucket as `gs://<bucket>/<path>` (#2235). A Messaging row shows its Installations and FCM registration requests (#2296). An observed AI Logic row shows its model and token counts (#2213).
- The chip's on and off controls are one switch style, and its view pickers are a segmented control (#2418). In live mode its header is one line: pyric and the project name (#2307).
- Every event's caller now carries `clientId`: one per browser profile, service worker or Node process (#2310, #2320).
- A worker thread given its own `env` in a registered process: before, it loaded the real SDK with no guard. Now, it inherits the sandbox (#2339).
- `PYRIC_GUARD_ALLOW`: before, a child kept its own value, even `''`. Now, ignored, with a deprecation line (#2102, #2547).
- `pyricViteExternals()` in a Vite SSR build: before, kept only `firebase` and `firebase-admin` external. Now, every installed `@firebase/*` package and every npm alias of a Firebase SDK too (#2344).

### Known gaps

- Some Admin calls go out unobserved, and the project check doesn't see them: Firestore's `Query.stream`, `BulkWriter` and `recursiveDelete`, Storage's `File.createReadStream`, and any method the rows don't patch, such as `createCustomToken`, `createSessionCookie`, `verifySessionCookie` and `getSignedUrl`. Treat them as a gap in what pyric shows, not as checked (#2472, #2548).
- Admin `subscribeToTopic` and `unsubscribeFromTopic` go to `iid.googleapis.com` with no project in the request. The check reads the app's project, but the project the call reaches comes from the credential and the registration tokens (#2470).
- pyric doesn't see requests outside the Firebase SDKs. A `fetch` to `firestore.googleapis.com`, a `@google-cloud/*` client or a bundle with the SDK inlined goes out with no row and no line, in sandbox and live mode (#2469, #2547).
- Admin App Check calls are checked against the project but make no row. Observed App Check rows in the chip and Studio wait on a design review (#2470).
- The Admin rows need Node 23 or later. On Node 22, `firebase-admin` is refused in live processes, because Node 22's `require()` doesn't reach the register's hooks (#2437, #2475).
- A separate process such as `pyric mcp` or `PYRIC_SANDBOX=remote` can't reach a Vite dev server that serves HTTPS (#2570).

## 0.1.0-alpha.34

pyric 0.1.0-alpha.34 is on the `exp` dist-tag, and it is the first publish of `@pyric/live`. The full list of its changes is in its release pull request, #2075. The entries below shipped in it.

### Behavior changes

#### Auth

- `pyric-admin` `verifyIdToken` on a custom token from `createCustomToken`, or on any plain string: before, resolved with the uid and claims the string named. Now, rejects with `auth/argument-error`, as production does. A custom token must be exchanged with `signInWithCustomToken` first, and the ID token the client gets verifies (#1949).
- `verifyIdToken` on an ID token: before, any token that decoded verified. Now, it checks as firebase-admin 13.10 does. A token whose signature fails, whose `kid` or `alg` is not the sandbox's, or whose `aud`, `iss` or `sub` is wrong rejects with `auth/argument-error`, and an expired token rejects with `auth/id-token-expired`. The project is the admin app's project ID, or `pyric-sandbox` when it names none. A token that is not a string throws `auth/argument-error` synchronously (#1949).
- `signInWithCustomToken` on a token from `pyric-admin` `createCustomToken`: before, rejected with `auth/invalid-custom-token`. Now, signs in as the token's uid, and the ID token carries its developer claims and verifies with `verifyIdToken` (#1952).
- `createCustomToken` in `pyric-admin` and the CLI (the `auth` `createCustomToken` method and the `auth_custom_token` tool): before, minted `pyric-sandbox-custom:<uid>:<claims>` (`pyric-admin`) or base64url `{uid, claims}` (the CLI). Now, both mint firebase-admin's JWT shape for the minting app's project, lasting one hour, signed with a sandbox key. `SANDBOX_TOKEN_PREFIX` is no longer exported from `pyric-admin/auth` (#1952).
- `signInWithCustomToken` on a custom token in firebase-admin's shape: before, read without checks. Now, an edited token or one past its `exp` on the sandbox clock rejects with `auth/invalid-custom-token`, and one for another project rejects with `auth/custom-token-mismatch`. A token signed with a real service account key is refused, since the sandbox cannot verify it (#1952).
- `signInWithCustomToken` on an unsigned custom token: before, signed in as whatever uid and claims it named, even past its `exp`. That covered the JSON `{uid, claims}` shape, its base64url form, a JWT for another audience or none, and a custom-token-audience JWT whose payload carried `=` padding. Now, each rejects with `auth/invalid-custom-token`, as production does, in the page, the SharedWorker host and the Node host. Mint the token with `pyric-admin` `createCustomToken` or the CLI's `auth` `createCustomToken`. Repro replay mints a fresh token for each custom-token session it restores (#2009).
- The client ID token shape alpha.33 and earlier mint (`sandbox-id-token-<uid>-<n>:<claims>`): before, `verifyIdToken` decoded it. Now, rejects with `auth/argument-error`. The client now mints a JWT, which verifies (#1836, #1949).

**Full changelog:** https://github.com/davideast/pyric/compare/v0.1.0-alpha.33...v0.1.0-alpha.34

## 0.1.0-alpha.33

pyric 0.1.0-alpha.33 is on the `exp` dist-tag. `latest` stays at alpha.30.2. No other dist-tag moves, and this release carries no `fb` compatibility tag.

```bash
npm create pyric@exp my-app
# or, in an existing project
npm install pyric@exp
npm install -D @pyric/cli@exp
```

This release covers everything merged to `main` since alpha.32. It moves pyric to firebase 12.19, keeps sandbox routes on the machine that runs them, serves Cloud Functions `onRequest` exports locally, and computes rules ints as production does.

### App Check and AI Logic

App Check enforcement for AI Logic is a per-project mode, not one date for everyone. Firebase's automatic enforcement starts on November 2, 2026, and a setting on each project can delay it, up to January 21, 2027. A project that is not enforced can answer an AI request with no token with 200. This corrects the alpha.31 notes, which said every project was required from November 2.

- **The sandbox still refuses.** It doesn't read your project's mode. A request with no App Check token, a malformed one, the web SDK's placeholder or a token whose signature fails gets a 403 `PERMISSION_DENIED`, so an app finds a missing token before production does. A valid token answers. See Known gaps for what isn't settled about enforced projects (#1676).
- **Limited-use tokens last 300 seconds.** A limited-use token the sandbox mints, from `getLimitedUseToken` or `useLimitedUseAppCheckTokens`, now has a TTL of 300 seconds, where it had 3600. Other sandbox tokens stay at 3600 (#1676).
- **Minted tokens carry `lu`.** Every token the sandbox mints now has an `lu` claim, limited-use or not, and so does one `firebase-admin`'s `createToken` mints under pyric. The captures record only the claim's name, so its value is the placeholder `pyric-sandbox`. With a `CustomProvider` and no debug token set, your provider's token is still used as given, so neither the 300 seconds nor `lu` applies to it (#1676).

### New in this release

- **`onRequest` functions run locally.** `pyric sandbox` and the `pyric()` Vite plugin serve Cloud Functions `onRequest` exports, v2 and v1, unchanged, at `/{projectId}/{region}/{name}`. Before the functions are running, a request gets a 503 that names the cause (#1202).
- **Hosting rewrites reach functions.** A `firebase.json` rewrite such as `{ "source": "/api/**", "function": "api" }` reaches the function with the full original URL, and with only the `__session` cookie. A request is cut with a 504 at `timeoutSeconds` (60 when unset, at most 3600) on the function's own path, and at 60 seconds at most through a rewrite. Each served request prints one execution line. `pyric sandbox --hosted` serves functions too (#1204).
- **Firebase 12.19.** Pyric is conformance-tested against firebase 12.19.0, up from 12.13.0, and scaffolded apps pin `~12.19.0`. `firebase` is a dev dependency of `pyric` and `@pyric/cli`, so upgrading pyric doesn't change the firebase version an existing app installs (#1676).
- **New firebase names import, then throw on use.** Through the served `firebase/*` modules, `AgentPlatformBackend`, Firestore's `maximum` and `minimum`, and messaging's `register`, `unregister`, `onRegistered` and `onUnregistered` load, and calling one throws `<service>/unsupported-in-served-mode`. A service worker gets `onRegistered` and `onUnregistered` the same way. `firebase/firestore/lite`, which is deferred as a whole, gains `maximum` and `minimum`, which throw its own deferred error. `pyric/ai`, `pyric/firestore` and `pyric/messaging` don't export these names (#1676).
- **A Google dialog sign-in reports a verified email.** A new Google identity from the sandbox dialog has `emailVerified: true` on the user, the ID token and `request.auth.token`, so a rule that requires `email_verified` admits it. An existing account keeps its own flag (#1801).

### Behavior changes

Each entry names the old behavior, the new behavior and the PR. The changes that can stop code that ran before are also under Breaking changes.

#### Firebase 12.19

- `SDK_VERSION` from `pyric/app`: before, `12.13.0`. Now, `12.19.0` (#1676).
- A second `initializeApp` under an existing name with different options or settings: `app/duplicate-app` now has the 12.19.0 message, which names the mismatched parameter and quotes both values as JSON: `Firebase App named '[DEFAULT]' already exists with different options. Existing: '{...}'. New: '{...}'.` (#1676).
- A second `initializeAppCheck` that differs only in omitting `isTokenAutoRefreshEnabled` versus passing `false`: before, threw `appCheck/already-initialized`. Now, returns the same instance (#1676).

#### Sandbox routes and clients on other machines

The connection's peer address decides who is on this machine, so `--allowed-host` and Vite's `allowedHosts` don't open these routes to another machine.

- Sandbox, Studio, MCP, service command and Storage byte routes under `/__pyric`: before, the Host, Origin and session token checks decided, whichever machine the client was on. Now, a client on another machine gets 403, with the message `this route answers clients on this machine only`. The bridge socket is closed to that client (#1808).
- `/__pyric/init.json` for a client on another machine: before, the full payload. Now, 200 with `remotePeer: true` and no session token, seed, rules or project data (#1808).
- A client on another machine that reaches the host through a dev server: before, the forwarding server's loopback connection made it look local. Now, it gets the same answers as from the host's own port. This covers the `withPyric` Next rewrite, a Vite `server.proxy` and a Node proxy that forwards the incoming headers. A Node server under `pyric sandbox` or `withPyric` sets `x-pyric-remote-peer` on a request from another machine. The header only takes access away: its presence means remote whatever its value (#1821).
- Still answered for every client: hosted pages, SDK bundles, the docs and Studio shells, avatars and Functions HTTP routes (#1808).

#### Project files

- `pyric sandbox` with no `hosting` block in `firebase.json`, or no `firebase.json`: before, served the current directory. Now, serves no static files and prints a `hosting  Off` line that says to add `hosting.public`. `/` still opens Studio (#1798).
- A `hosting` block without `public`: before, served `.`. Now, serves `public`, and `pyric sandbox` stops at startup with `hosting.public directory does not exist` if there is no such directory. A block with only function rewrites deploys with no directory, so it stops here too: see Known gaps (#1798, #1825).
- With a `hosting` block: before, every file under the directory. Now, what a default deploy would upload. Dot files and dot directories such as `.pyric/`, `.env` and `.well-known/`, `node_modules` and a root `firebase.json` answer 404, whatever the project's own `ignore` says. So does a link that leaves the public directory (#1798).
- Studio's workspace routes: `.pyric/`, `.env`, `.env.*`, `.envrc` and `node_modules` now answer 403 for read, write, list and remove, on this machine too, and are left out of listings (#1808).
- The Vite plugin: `.pyric/` is refused by path, by query form and through `/@fs`, and a request whose real path is in `.pyric/` or is an env file is refused too. Vite keeps serving `node_modules` (#1798, #1808).

#### Firestore and Storage rules

- Ints: before, JavaScript doubles, so `9223372036854775807 + 1 > 0` allowed. Now, signed 64-bit, and overflow is an error value that denies, and that `|| true` and `&& false` absorb. The exception is the minimum int divided by `-1`, which returns the minimum, as production does. A literal past the int64 range fails to compile with `Invalid number literal` (#1776).
- Ints above 2^53: before, rounded. Now, they compare and print exactly, and a trace shows such an int as a string of digits (#1776).
- A host number that isn't a safe integer, such as `2 ** 53` in document or request data: before, an int. Now, a float: `is int` is false and `string()` prints `9.007199254740992E15`. In Firestore, a rule that interpolates such a field into a path, or compares it to an int in a list, now denies. An integral custom claim inside int64 stays an int, and a fractional claim such as `1.5` now reads as a float (#1796).
- `-duration`: before, an error. Now, it negates the duration (#1495, #1776).
- Storage, a method no type defines, such as `'a'.foo()`: before, an error `||` couldn't absorb. Now, production's `Function not found error`, which `||` and `&&` absorb. Namespace calls such as `hashing.foo()` still fail closed (#1495).
- Storage, a coarse request in `evaluateStorageRules` or `pyric simulate`: before, `request.method` was the word `read` or `write`. Now, `read` evaluates as `get` then `list`, a `write` with `request.resource` as `create` then `update`, and a `write` without one as `delete` (#1495).
- Storage, an invalid `now` passed to `evaluateStorageRules`: now throws a `TypeError` at the call (#1495).
- Storage, a path built in a helper function: an interpolated string is now one segment even if it holds `/` (#1495).

#### Next.js and AI

- `withPyric` keeps an npm-aliased `firebase-admin` and every installed `@firebase/*` package out of Next server bundles. Before, a server route that imported them loaded the real package. Now, it stops with `PYRIC_REAL_SDK_STOPPED` (#1755).
- Upstream fetch errors on both AI planes: before, text that quoted the key or bearer token reached the page, the `/__pyric/ai-proxy` 502 body and the terminal. Now, the request's credentials are masked as `***` (#1765).

### Breaking changes

Each of these refuses something that used to work. Check them before you upgrade.

- **No `hosting` block, no static files.** A project that relied on `pyric sandbox` serving its directory now gets 404s. Add `"hosting": { "public": "." }` to `firebase.json`, or name your site's directory (#1798).
- **A `hosting` block without `public` needs a `public` directory.** Without one, `pyric sandbox` stops at startup. Name a directory in `hosting.public`. That includes a block with only function rewrites, which `firebase-tools` accepts with no directory (#1798, #1825).
- **Dot files, `node_modules` and `firebase.json` aren't served from Hosting.** That includes `/.well-known/`, even if your own `ignore` would upload it (#1798).
- **Hosted pages and servers on another machine lose the sandbox.** A hosted page opened over the LAN loads, but its Firebase calls fail with an error saying the host answers its own machine only. On the in-page sandbox, such a page reads and writes Firestore in its own browser, with no project data, and Storage is denied. A server on another machine can't attach with `PYRIC_SANDBOX=remote:<url>` (#1808, #1821).
- **Imagen is gone.** Firebase 12.19.0 removed the Imagen API from `firebase/ai`. `pyric/ai` no longer exports `ImagenAspectRatio`, `ImagenPersonFilterLevel` and `ImagenSafetyFilterLevel`. The served `firebase/ai` no longer exports those, `getImagenModel`, `ImagenModel`, `ImagenImageFormat`, `getTemplateImagenModel` or `TemplateImagenModel`, so a page that imports one fails to load, even with an older firebase installed (#1676).
- **Rules that relied on the old number handling now deny.** An int overflow denies, as production's captures do (#1776). An `is int` check on a stored number of 2^53 or more denies too; that boundary comes from the SDK sources, not a rules capture: see Known gaps (#1796).
- **`withPyric` refuses a `transpilePackages` entry it keeps external.** The error names the package. Next refused this already, without naming pyric (#1755).

### Known gaps

#### App Check and AI Logic

- What an enforced project answers isn't settled. Two captures on a project reading `ENFORCED` answered 401 to every request, including valid tokens, and the cause is unknown. The 403 the sandbox replays was captured on a project reading `UNENFORCED`. So the sandbox's refusal is a deliberate early check, not a replay of a confirmed enforced answer (#1300).
- The AI Logic guide and the tutorial still say AI Logic requires App Check from November 2, 2026, with no mention of the per-project setting. These notes are the correct statement.
- The sandbox has no token refresher, so `onTokenChanged` and auto-refresh differ from production (#1656).
- A registered Node process has no `initializeServerApp` (#1644).
- In production AI mode, app code can still load a real `firebase/app` or `firebase/app-check` file by absolute path (#1735).
- For a Node process connected with `PYRIC_SANDBOX=remote:<url>`, the dev server terminal still prints the browser App Check hint (#1736).
- An error event inside a successful Gemini stream reaches the app, masked. The Firebase SDK drops such a chunk (#1753).
- A username and password in an AI upstream base URL aren't masked in error text (#1766).
- A `VITE_GEMINI_API_KEY` set only in `.env` doesn't get the banner note (#1743).

#### Firebase 12.19 and tags

- npm's `latest` firebase is 13.2.0, and pyric is tested on the 12 line. Pyric's suites fail against npm's latest firebase and firebase-admin (#1602, #1188). Stay on `~12.19.0`, as scaffolded apps do.
- The new names above throw until pyric implements them: `maximum` and `minimum` (#1672), messaging's four (#1673), `AgentPlatformBackend` (#1674).
- The versioning page tells readers to run `npm install pyric@fb12.19`. No such tag exists yet: this release moves no `fb` tag, and `fb12.13` still points at alpha.24.

#### Other machines

- These still count as local: a forwarder that doesn't pass on the header, a forwarder not running under the preload (a non-Node process, or a Node process started outside `pyric sandbox` without `withPyric`), an HTTP/2 server, an app's own server code calling the host, and a tunnel (#1808, #1821).
- A published container port should count as another machine, but that comes from reasoning and isn't tested (#1808).
- Functions HTTP routes answer clients on other machines and can write through `firebase-admin`, so a backend bound with `--host` isn't private on your network (#1808).
- Hosted pages still show the project directory to other machines (#1813).
- Under `vite --host`, Vite itself keeps serving the app's source to other machines, except what the plugin refuses (#1808).

#### Functions

- `pyric sandbox` stops at startup on a `hosting` block with only function rewrites and no `public/` directory, which `firebase-tools` accepts (#1825).
- `pyric sandbox` exits at startup when `firebase.json` declares a Functions source whose `main` hasn't been built, so a fresh clone can stop before anything starts (#1812).
- No production capture backs Functions HTTP yet: 16 of its 21 rows are unverified, and scaling options are unsupported.
- A `regex` rewrite runs as a JavaScript regular expression, where production uses RE2, so a pattern can match in pyric and fail to deploy (#1204).
- Rewrite responses skip Hosting's cache-control, set-cookie and `Vary` handling. No app scenario covers a catch-all `"**"` function rewrite under Vite, where it could claim a dev-only virtual module path (#1204).
- On the Node host, served requests don't reach the host's event stream (#1768).

#### Auth and rules

- With Email Enumeration Protection on, production answers `auth/invalid-credential` where the sandbox answers `auth/wrong-password` and `auth/user-not-found` (#1819).
- `verifyBeforeUpdateEmail` (#1693), linking an email credential onto an anonymous user (#1698) and `getAdditionalUserInfo().providerId` (#1699) differ from production.
- A Google sign-in links onto an existing unverified account, where production overwrites it for `@gmail.com` (#1814). No production capture of a Google sign-in backs the verified email above.
- `signInWithPopup` throws on a served page that runs in-page (#1802).
- The host-number boundaries come from the SDK sources and sign-in captures, not from a rules capture (#1796). Open divergences: a bare float in a Storage lookup path (#1815), an int field incremented past 2^53 (#1816), an integral claim between 2^53 and 2^63 (#1817), and `-0`, NaN and infinities after JSON (#1794).
- `(true ? data.parent() : null).exists()` loads in pyric and is refused at deploy in production (#1820).
- `pyric can-i-use getAfter` reads `unverified` until a capture backs the batch sibling-merge row (#1769).

#### Dev server

- `/__pyric/rate-captures` and the Storage byte route still answer before reading the whole body without closing the connection (#1721).

### Everything else

#### Conformance

- Rules scores, conformant constructs: Firestore 135/140, up from 128, and Storage 122/140, up from 113, both from pyric matching captures (#1495, #1776). RTDB 90/91, down from 91/91 because a new row records the deploy refusal above (#1676).
- Public surface coverage fell because firebase 12.19.0 added names, with nothing reclassified: Firestore runtime 98.1%, messaging runtime 55.6%, messaging types 88.9% (#1676).
- `@pyric/cli` now depends on `minimatch` 6.2.3, the version superstatic resolves (#1204).

#### Docs

- The guides gain "Call your HTTP functions" and say HTTP functions run locally. The `--host` reference says what stays reachable from another machine, and the Node host and Start building guides say which directory is served (#1204, #1798, #1808).

**Full changelog:** https://github.com/davideast/pyric/compare/v0.1.0-alpha.32...v0.1.0-alpha.33

## 0.1.0-alpha.32

pyric 0.1.0-alpha.32 is on the `exp` dist-tag. `latest` stays at alpha.30.2.

```bash
npm create pyric@exp my-app
# or, in an existing project
npm install pyric@exp
npm install -D @pyric/cli@exp
```

This release covers everything merged to `main` since alpha.31. It closes more ways a Gemini key or the real Firebase SDK can reach code that shouldn't have it, gives App Check hints that work where they are printed, and makes sandbox AI errors, RTDB `onDisconnect` and the dev server's 413 answers behave as production and the Firebase SDK do.

### New in this release

- **Production AI mode stops app code's own `@firebase/*` imports.** Under `@pyric/cli/register` with `PYRIC_AI_MODE=production`, app code that imports `@firebase/app`, `@firebase/app-check`, `@firebase/ai` or `@firebase/util` itself now fails with `PYRIC_REAL_SDK_STOPPED`, as it already did in sandbox AI mode. `firebase/ai` still loads the real SDK. The stop message names the `firebase/*` import to use instead, except for `@firebase/util`, where it says pyric serves no `firebase/*` import for it (#1732).
- **App Check hints fit where they are printed.** A Node process or a server-rendered module now gets a hint it can follow: set `globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true` beside a `CustomProvider`, or return a token minted with `firebase-admin`'s `createToken`. Pages and their workers keep the browser hint. A page that uses AI Logic on the in-page sandbox without Firestore, RTDB or Storage now prints AI refusals in the dev server terminal too (#1733).
- **Sandbox AI errors quote the URL the SDK builds.** On a `VertexAIBackend` handle, the URL in an error names the Vertex AI path with its location. On every backend, a stream's error URL ends with `?alt=sse` (#1738).
- **The Gemini key refusal follows `envPrefix`.** The Vite dev server refuses a Gemini key that Vite would serve to the page under the app's `envPrefix`, and leaves alone one it would not (#1739).
- **The startup banner explains an ignored `VITE_GEMINI_API_KEY`.** When it is the only Gemini key set, the AI line says it is ignored and to rename it to `GEMINI_API_KEY` (#1742).
- **A pending `onDisconnect` stays pending on close.** Closing the client no longer rejects an RTDB `onDisconnect` the host hasn't answered, so the presence sample from the Firebase docs, which runs on the web hosted client, no longer logs an unhandled rejection or ends a Node process (#1722). The Node remote client does the same when it closes (#1727).
- **A 413 for an oversized body closes the connection.** Each dev server route that answers an oversized body with 413 now closes the connection and ends the socket, so the next request is answered on a fresh connection under Node and Bun. `/__pyric/rate-captures` and the Storage byte route still answer 400 and keep the connection open: see Known gaps (#1720).

### Behavior changes

Each change moves pyric toward what production does. Code that relied on the old behavior will now see different results. Each entry names the old behavior, the new behavior and the PR.

The production AI mode import stop and the `envPrefix` key refusal can stop code that ran before: see Breaking changes.

#### App Check and AI Logic

- App Check hint in a process with no `document`: before, the browser hint, which says to set `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true`, a line that throws in Node. Now, a hint that names `globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN` beside a `CustomProvider`, or a token minted with `firebase-admin`'s `createToken` (#1733).
- AI refusals from a page that uses AI Logic on the in-page sandbox without Firestore, RTDB or Storage: before, shown only in the browser console. Now, also printed in the dev server terminal, with blocked responses and model substitutions (#1733).
- Sandbox AI error URL on a `VertexAIBackend` handle: before, `projects/sandbox/models/<model>`. Now, `projects/sandbox/locations/<location>/publishers/google/models/<model>`. On every backend, a stream's error URL now ends with `?alt=sse`. Only the URL in error messages changes (#1738).
- Gemini engine errors: before, an upstream error's `status` field and an error event inside a successful stream could carry the server's key. Now, both are masked as `***`, on the SharedWorker, in-page and `hosted: true` planes. The masked event still reaches the app (#1740).

#### Vite dev server and Gemini keys

- `VITE_GEMINI_API_KEY` with an `envPrefix` that leaves out `VITE_`: before, the dev server refused to start. Now, it starts, because Vite doesn't serve that variable (#1739).
- AI banner line when `VITE_GEMINI_API_KEY` is the only Gemini key set: before, `no engine configured` or `gemini (no API key; set GEMINI_API_KEY)`. Now, it says `VITE_GEMINI_API_KEY` is set and ignored, and to rename it to `GEMINI_API_KEY`. This shows on `pyric dev` and `pyric sandbox`, and on the Vite dev server's gemini line when `envPrefix` leaves out `VITE_` and the variable is set in the shell (#1742).

#### Realtime Database

- Pending `onDisconnect` when the web hosted client closes, through `deleteApp` or a port close: before, rejected with "The hosted sandbox connection is closed." or `app-deleted`, so with no handler a page logged an unhandled rejection and a Node process exited. Now, it never settles, as in `@firebase/database` 1.1.3. Every other outstanding call still rejects (#1722).
- Pending `onDisconnect` when the Node remote client closes or its transport fails: before, rejected with "remote sandbox connection closed by the client". Now, it never settles. Every other outstanding call still rejects. One held while the client reconnects still fails at the 10-second hold deadline (#1727).

#### Dev server

- Oversized bodies on `/__pyric/beacon`, `/__pyric/diagnostics`, `/__pyric/activity` and `/__pyric/hosted/method`: before, a 413 that kept the connection open, so the next request on that socket could get a 400 under Node or hang under Bun. Now, the 413 closes the connection and ends the socket. `/__pyric/denials` and the AI proxies also end the socket now, which fixes the hang under Bun (#1720).
- Oversized bodies on `/__pyric/hosted/repro`, `/__pyric/thresholds` and `/__pyric/indexes`: before, 400. Now, 413 with the same JSON error body, and the connection closes (#1720).

#### CLI

- `pyric sandbox` peer wait after a process pause: before, the deadline was read from the wall clock, so after a pause the wait could poll again for nearly its whole timeout. Now, it reads the monotonic clock its timers run on, and gives up once its timeout is spent (#1724).

### Breaking changes

Each of these refuses something that used to work. Check them before you upgrade.

- **Production AI mode stops app code's own `@firebase/*` imports.** With `PYRIC_AI_MODE=production` under `@pyric/cli/register`, an app import of `@firebase/app`, `@firebase/app-check`, `@firebase/ai` or `@firebase/util` fails with `PYRIC_REAL_SDK_STOPPED`. Before, it loaded the real package. Import `firebase/app`, `firebase/app-check` or `firebase/ai` instead. Pyric serves no `firebase/*` import for `@firebase/util`, and the stop message says so. See Security (#1732).
- **The Vite dev server refuses a Gemini key its `envPrefix` serves.** The dev server refuses to start while a Gemini key sits in a name that starts with one of the app's `envPrefix` entries: `GEMINI_` refuses `GEMINI_API_KEY`, and `GOOGLE_` refuses `GOOGLE_GENAI_API_KEY`. Before, it started, and Vite served the key to every page. The message names the prefix that serves the key and says to rename the key or change `envPrefix`. `vite build` and `vite preview` are not refused. See Security (#1739).

### Security

#### Keep AI keys on the server

- The Vite dev server refuses to start while a Gemini key sits in a variable the app's `envPrefix` serves to the browser. A prefix refuses only the key names that start with it: `VITE_` refuses `VITE_GEMINI_API_KEY`, under the default prefix or any `envPrefix` that includes `VITE_`, `GEMINI_` refuses `GEMINI_API_KEY`, and `GOOGLE_` refuses `GOOGLE_GENAI_API_KEY`. The message never quotes the key (#1739).
- The gemini engine and the `/__pyric/ai-proxy/gemini` route mask the server's key in an upstream error's `status` field and in error events inside a successful stream (#1740).
- The AI Logic guide has a section on keeping a Gemini key on the server. It warns that a Vite `define` of `process.env.GEMINI_API_KEY` writes the key into every module that reads it, which pyric does not stop (#1742).

#### Stop the real Firebase SDKs under the register

- In production AI mode, the `@firebase/*` packages load only when a real SDK file the register allowed imports them. App code that imports them directly stops with `PYRIC_REAL_SDK_STOPPED` (#1732).

### Known gaps

- `/__pyric/rate-captures` and the Storage byte route still answer before reading the whole body without closing the connection (#1721).
- In production AI mode, app code can still load a real `firebase/app` or `firebase/app-check` file by importing it by absolute path (#1735).
- For a Node process connected with `PYRIC_SANDBOX=remote:<url>`, the dev server terminal still prints the browser App Check hint. The process's own output has the server hint (#1736).
- Network error text from the upstream fetch is not masked on either AI plane (#1737).
- An error event inside a successful Gemini stream reaches the app, masked since #1740. The Firebase SDK drops such a chunk, so an app never sees it in production (#1753).
- The Vite plugin reads `.env` before Vite resolves its config, and a `VITE_GEMINI_API_KEY` set only in `.env` doesn't get the banner note (#1743).

### Everything else

#### Docs

- The AI Logic guide adds "Keep a Gemini API key on the server": the key in `GEMINI_API_KEY` or `GOOGLE_GENAI_API_KEY`, why not `VITE_GEMINI_API_KEY`, keeping `envPrefix` off `GEMINI_` and `GOOGLE_`, and the `define` warning (#1742).

**Full changelog:** https://github.com/davideast/pyric/compare/v0.1.0-alpha.31...v0.1.0-alpha.32

## 0.1.0-alpha.31

pyric 0.1.0-alpha.31 is on the `exp` dist-tag. `latest` stays at alpha.30.2.

```bash
npm create pyric@exp my-app
# or, in an existing project
npm install pyric@exp
npm install -D @pyric/cli@exp
```

This release covers everything merged to `main` since alpha.30. alpha.30.1 and alpha.30.2 shipped some of those fixes first, from their own release line. Firebase AI Logic requires App Check for every project from November 2, 2026. This release makes App Check in the sandbox call your own providers, fail where the Firebase SDK fails, and work with production AI mode in Next.js. It also brings a large set of rules, Storage, RTDB, Firestore and Auth fixes from the October defect hunts, and closes several ways the Node register could load the real Firebase SDKs.

### Get App Check ready for November 2

From November 2, 2026, production AI Logic answers a request without a valid App Check token with a 403. Sandbox AI mode already refuses such requests (#1535, shipped in alpha.30.2). Here is what an app that uses AI Logic with App Check gets in alpha.31.

#### New in this release

- **A `CustomProvider` is called.** With no debug token set, the sandbox's `firebase/app-check` now calls your `CustomProvider`, and the AI Logic gate checks the token it returns. A token the sandbox signed is accepted, such as one a server mints with `firebase-admin` `createToken`. Any other token, or a provider that rejects, gets production's 403. With `useLimitedUseAppCheckTokens: true`, a provider that rejects stops the request before it is sent, and the call fails with `AIError` code `error`, as the Firebase SDK does. The documented setup, a debug token under `import.meta.env.DEV`, works as before (#1648).
- **A reCAPTCHA provider throws without a `document`.** In a Node process or a server-rendered module, `initializeAppCheck` with `ReCaptchaV3Provider` or `ReCaptchaEnterpriseProvider` throws `ReferenceError: document is not defined`, as the Firebase SDK does. Before, it returned a handle. On a server, use a `CustomProvider` (#1664).
- **Re-initializing and concurrent `getToken` follow the SDK.** A second `initializeAppCheck` that differs from the first in the raw `isTokenAutoRefreshEnabled` value now throws `appCheck/already-initialized`, so an omitted value no longer equals `false`. Concurrent `getToken` calls share one token, and `onTokenChanged` listeners fire once (#1388).
- **Production AI mode works in Next.js.** `withPyric` now reads `PYRIC_AI_MODE`. With `PYRIC_AI_MODE=production`, a Next page gets the Firebase SDK's `firebase/ai` attached to the real `firebase/app-check`, so AI Logic requests carry `X-Firebase-AppCheck`, as on Vite. Before, the page got pyric's scripted answers (#1650).
- **Proxied AI engines work under `pyric sandbox -- next dev`.** alpha.30.2 refused a page served by a wrapped dev server with a 403 when it used the openai engine, or the gemini engine on the SharedWorker or in-page plane. The guarded `/__pyric/*` routes now accept the wrapped dev server's port (#1497, #1438).
- **AI Logic roles match production.** Inside `contents`, the sandbox now accepts only roles `user`, `model` and `assistant`. Role `function` gets production's 400. `@firebase/ai` 2.12.0's `ChatSession` sends function responses under role `function`, so a `ChatSession` with tools now fails in the sandbox as it does in production. Send function responses with `generateContent` under role `user`. Roles `system`, `system_1`, `developer`, `context` and `user_context`, which the sandbox accepted before, also get production's 400 (#1412, #1542).

#### Already shipped in alpha.30.1 and alpha.30.2

If you are coming from alpha.30 or earlier, these fixes from alpha.30.1 and alpha.30.2 also reach you in this release:

- Sandbox AI mode refuses requests without an App Check token on every plane. Call `initializeAppCheck` before `getAI` (#1535).
- Production AI mode verifies the page's real App Check token with firebase-admin's own `verifyToken` (#1558).
- `cert(serviceAccount)` keeps the service account's project id (#1532).
- `initializeAppCheck` names the cause when production AI mode can't create its shadow app (#1534).
- Production AI mode works on plain `pyric sandbox` without Vite (#1537).
- The `create-pyric` chat template, the AI Logic guide, the tutorial and the `ai-chat` example call `initializeAppCheck` before `getAI` (#1392).
- The gemini engine on the SharedWorker and in-page planes sends through the dev server, which adds the Gemini key from its own environment. An app that initialized App Check gets Gemini's answer instead of `process is not defined` (#1592).
- The dev server's AI proxy routes refuse requests from pages on other origins and bodies over their size limit (#1431, #1592).

#### Known gaps

- The sandbox AI gate doesn't check that a token's project or app id matches the app (#1554).
- The sandbox has no App Check token refresher. It calls a provider only when a token is requested (#1656).
- `consume` replay state is kept per process, not per project (#1297).
- The chat template pins firebase 12.13, but limited-use App Check tokens need 12.14 (#1397).
- After November 2, pyric re-captures production's App Check gate for AI Logic to confirm the sandbox still matches (#1300).

### Behavior changes

Each change moves pyric toward what production does. Code that relied on the old behavior will now see different results. Each entry names the old behavior, the new behavior and the PR.

The register, network guard and Storage lint changes can stop code that ran before: see Breaking changes.

#### App Check and AI Logic

- `CustomProvider` with no debug token: before, never called, and the request answered. Now, called, and a token the sandbox didn't sign gets the 403 (#1648).
- reCAPTCHA provider without a `document`: before, returned a handle. Now, throws `ReferenceError: document is not defined` (#1664).
- Second `initializeAppCheck` that omits `isTokenAutoRefreshEnabled` where the first passed `false`, or the reverse: before, returned the existing handle. Now, throws `appCheck/already-initialized`. Concurrent `getToken`: before, two tokens and two listener calls. Now, one token and one listener call (#1388).
- Role `function` in AI Logic `contents`: before, accepted. Now, refused with production's 400. The bad-role error text now lists `MODEL, USER`, as production's does (#1412).
- Roles `system`, `system_1`, `developer`, `context` and `user_context` in AI Logic `contents`: before, accepted. Now, refused with production's 400. Role `assistant` is still accepted (#1412, #1542).
- `PYRIC_AI_MODE=production` in Next.js: before, ignored on the page. Now, the page uses the real `firebase/ai` and `firebase/app-check` (#1650).

#### Firestore and Storage rules

- RE2 patterns and `trim()`: before, `\s` matched Unicode white space, `.` skipped `\r`, `\pL` and the `(?i)` flag in `split()` and `replace()` were misread, and `trim()` stripped Unicode spaces. Now, `\s` is ASCII white space, `.` matches `\r`, `\pL` is the letter class, flags are kept, and `trim()` strips only code units at or below U+0020 (#1295).
- `split()` and `replace()`: before, `split()` returned capture-group text and kept trailing empty pieces. Now, it returns neither, and never returns an empty list. Storage also refuses an oversized pattern from request data (#1449).
- Root `match` path: before, skipped, so a ruleset rooted at another database granted access to `(default)`. Now, compared with the request, so such a ruleset grants nothing outside its root (#1395).
- Ruleset service: before, the in-page `setRules` installed and enforced a `service firebase.storage` ruleset as Firestore rules. Now, every Firestore load path refuses a ruleset whose service is not `cloud.firestore`, and `pyric rules lint --service firestore` on a Storage ruleset fails at once with that compile error (#1421).
- Version 1 recursive wildcard: before, `{x=**}` matched zero segments. Now, under version 1 it needs one or more, in Firestore (#1437) and Storage (#1404).
- Large regexes: before, a pattern that expands very large compiled, and the first request that evaluated it could run the process out of memory. Now, Firestore and Storage refuse a pattern past RTDB's size limit at compile time, and a repeat count over 1000, such as `a{1001}`, is refused too (#1406).
- Timestamps and durations: before, values past production's range computed silently, and a NaN instant was accepted. Now, they are rule errors, as in production, and a NaN instant is refused (#1407).
- `firestore_simulator_create`: before, a ruleset production would not load replaced the rules and documents in force. Now, it is refused with `RULES_REFUSED`, and nothing is reset (#1457).
- Array form of `firestore` in `firebase.json`: before, ignored, so pyric fell back to `firestore.rules` or no rules. Now, the `(default)` entry's rules govern `(default)` on every plane, and each named database gets a startup warning (#1444).
- `request.auth.token` claims: before, `sub`, `aud`, `iss`, `iat`, `exp` and `auth_time` were missing, so rules that read them denied. Now, rules read the values pyric minted. RTDB `iat`, `exp` and `auth_time` are the minted values instead of times taken from the evaluation clock. A recent-login check on `auth_time` now expires. RTDB used to fill `exp` as `iat + 3600`, and now uses the minted token, which lasts 100 years, so an RTDB rule that checks `exp - iat` against 3600 used to pass and now denies. Production's ID tokens last 3600 seconds, and this gap is open as #1502 (#1504).

#### Storage

- Lookups in Storage rules: before, an interpolated request value holding `/` became several path segments. Now, it is one segment, and a `{rest=**}` capture splices in as a path (#1404).
- Bucket name: before, rules saw `pyric-default`. Now, rules see the app's bucket name on every plane, in `rules.simulate`, the `storage` tool methods and `pyric verify` (#1513).
- Per-bucket rules: before, the first `firebase.json` entry's rules governed every bucket. Now, in the in-page sandbox and under `PYRIC_SANDBOX=local`, each bucket enforces the rules deployed to it, and a bucket with no deployed rules denies every client operation. In page, `getStorage(app, 'gs://other')` keeps its objects apart from the default bucket. The dev server, SharedWorker and Node host still share one ruleset across buckets (#1524).
- `pyric mcp` with no dev server: before, read a root `storage.rules`. Now, enforces the Storage rules file `firebase.json` deploys. The dev server refuses a Storage rules reload the sandbox can't install, and keeps the last good rules. It also refuses to start with such rules, for example an `import` under `rules_version = '2'`, where before it started and the worker failed (#1462).
- `pyric-admin` remote `bucket.getFiles()`: before, a folder per object could fail with `resource-exhausted`. Now, it lists in name order and stops once a page is full (#1206).

#### Firestore SDK

- Query ordering: before, values were compared without Firestore's type order, so a plain map could rank as a `Timestamp` and `GeoPoint` ranges missed. Now, the in-page engine orders by type tag and full document key, and uses value comparison for `==` and `!=` (#1413).
- `getAggregateFromServer` on a served page or a registered Node process: before, threw `firestore/unsupported-in-served-mode`. Now, returns the aggregate (#1399).
- Served `onSnapshot` with an observer object: before, crashed a registered Node process with `callback is not a function`. Now, accepted in all four call forms (#1455).
- Served snapshots: before, a listen error with no error callback was dropped, query documents took the query's `hasPendingWrites`, and `data()` returned the same object on each call. Now, the error is logged with `console.error`, query documents no longer take the query's `hasPendingWrites`, and `data()` returns a new object on each call (#1455).

#### Realtime Database

- `update()` in the in-page sandbox: before, applied a microtask late, so a `set()` or `remove()` in the same tick could be overwritten. Now, writes land in call order, and listeners on the updated path fire before `update()` returns, as they do for `set()` (#1402).
- Snapshot serialization: before, `val()` kept insertion order, and `exportVal()` and `toJSON()` could return arrays. Now, keys follow priority, then key order, `val()` leaves holes in sparse arrays, and `exportVal()` and `toJSON()` never return arrays (#1408).
- `refFromURL` and error texts: before, a URL on another instance's host made a ref in this database. Now, it throws the SDK's host mismatch error. Query and `child()` errors use the SDK's exact text (#1409).
- Served RTDB writes: before, `set(ref, NaN)` reached the host and deleted the value. Now, the SDK's value, priority and update-map checks run before the write is sent, and the call throws. `update()` and `onDisconnect().update()` with an array, a string or `null` throw the SDK's text (#1461).
- `pyric-admin` RTDB: before, the in-process arm returned stored maps from `val()` and kept `null` and empty children. Now, both arms render arrays and prune as `firebase-admin` does, and throw on `NaN` (#1210).

#### Auth

- Served `signInWithCredential` with an email credential: before, signed in without checking the password or link. Now, a wrong password is refused with `auth/wrong-password`, and `providerId` on the result is `null` (#1467).
- Served `signInWithCredential` with an unknown or look-alike provider id: before, signed in as the account the payload named. Now, refused with `auth/no-mock-configured` (#1483).
- Served `signInWithCredential` with a federated credential: before, signed in as the account the payload named. Now, it signs in only as a result staged with `sandbox.mockSignInResult`, on every plane (#1509).
- `pyric-admin` `verifyIdToken` on a client ID token: before, `auth_time` was the time of the `verifyIdToken` call. Now, `auth_time`, `iat` and `exp` are the values the token carries, as `firebase-admin` returns them (#1504).

#### Sandbox clock

- Before, the sandbox clock followed the host clock back when it stepped back, so `request.time` and `serverTimestamp()` could go backward. Now, it holds its last reading until the host passes it (#1401).

### Breaking changes

Each of these refuses something that used to work. Check them before you upgrade.

- **`pyric bridge` no longer accepts a browser sandbox.** A page that calls `connectBridge` against `pyric bridge` is closed with code 4010 and a reason that names `pyric sandbox --bridge`, and the client does not reconnect. `pyric bridge` now lists only the tools that run in its own process (rules, conformance, identity, captures). The forwarded sandbox tools are gone from it, and its banner no longer prints a `sandbox:` WebSocket URL. Run `pyric sandbox --bridge` for an agent that drives a page (#1507).
- **`VITE_GEMINI_API_KEY` is refused.** Before, the gemini engine read it as the Gemini key. Now, the Vite dev server refuses to start while it is set, in the shell or in `.env`, and says to rename it to `GEMINI_API_KEY`. The gemini engine's 401 names only `GEMINI_API_KEY` and `GOOGLE_GENAI_API_KEY`. This moves pyric closer to production, where an AI key never reaches the browser. See Security (#1647).
- **`simulate()` and the MCP `firestore_simulate_rules` tool refuse malformed cases.** `method` must be `get`, `list`, `create`, `update` or `delete` (`read` used to allow). `path` is required. Unknown fields are refused by name. `requestTime` must be ISO-8601 with an offset. A `create` with `resource` is refused. A refused case reports `UNSUPPORTED` with a reason instead of answering. `{__type: ...}` maps are read as maps, and value helpers such as `timestamp('nope')` or `latlng(91, 0)` throw a `TypeError`. Rule fixture files with a refused case are now reported on reload instead of skipped silently. This moves pyric closer to production, because each case now means the same request in the simulator and on the Rules Test API (#1453).
- **`pyric rules simulate --service storage` builds `request.resource` per verb.** Before, `request.resource` was filled from the stored object. Now, it is built as the live upload, update, read or delete would send it. A `get` with `--data` is refused, and an unknown field in `--data` is named and refused. This moves pyric closer to production, where a re-upload carries only the metadata it sends (#1496).
- **Storage `rules.lint` fails on error-severity findings.** It now runs the shared security lint, as Firestore lint does. Public rules fail, and Firebase's documented per-user rules (`match /{allPaths=**}` with an auth check, or a write that doesn't check `request.resource`) get error-severity SEC-5 and SEC-6 findings. A lint step that passed before can fail (#1496).
- **The register stops the real Firebase SDKs.** Under `@pyric/cli/register`, an import that resolves into the real `firebase-admin`, or into the real `firebase` or `@firebase/*` where pyric didn't choose them, fails before the file loads with `PYRIC_REAL_SDK_STOPPED`. Before, it loaded. This applies in every Node child of a registered process too, whatever `env`, `NODE_OPTIONS` or `execArgv` the child is started with, with two exceptions: a shell command that sets `NODE_OPTIONS` itself, such as `NODE_OPTIONS=--max-old-space-size=4096 node server.js` in a package script, and asynchronous children under Bun (#1649). Run code that loads the real SDK on purpose without the register. Production AI mode's App Check verifier still loads `firebase-admin`, on Node 22 as on Node 24 (#1709). See Security (#1522).
- **`pyric sandbox -- next dev` refuses live Google and Firebase egress by default.** `withPyric` makes `PYRIC_GUARD=block` the default for the Next server. A route handler that calls a Google endpoint pyric doesn't mirror needs `PYRIC_GUARD_ALLOW=<host>` or `PYRIC_GUARD=warn`. See Security (#1474).
- **`withPyric` refuses to start `next dev` when `PYRIC_SANDBOX` is set but the register isn't active.** Before, it started. Pass `{ guard: false }` to turn the check off (#1651).

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
- Under `pyric sandbox -- next dev`, `withPyric` makes `PYRIC_GUARD=block` the default, so the Next server refuses live Google and Firebase egress. Set `PYRIC_GUARD_ALLOW=<host>` or `PYRIC_GUARD=warn` for a Google endpoint pyric doesn't mirror. Once the real `firebase-admin` loads, the guard switches to `block` for the rest of the process, even under `PYRIC_GUARD=warn` (#1474).
- `withPyric` refuses to start `next dev` when `PYRIC_SANDBOX` is set but the register isn't active, for example when `PYRIC_SANDBOX` comes only from `.env`. Pass `{ guard: false }` to turn the check off (#1651).
- Turbopack's renamed `firebase-admin-<hash>` and `firebase-<hash>` imports on Next 16 map to the sandbox. Before, a route handler ran the real `firebase-admin` (#1471).
- Every Node child process of a registered process loads the register, whatever `env`, `NODE_OPTIONS` or `execArgv` it is started with. Two kinds of child still start without it: one started by a shell command that sets `NODE_OPTIONS` itself, such as `NODE_OPTIONS=--max-old-space-size=4096 node server.js` in a package script, and an asynchronous child under Bun. In a package script, append to `$NODE_OPTIONS` instead of replacing it (#1649).
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
- `/__pyric/denials` and the AI proxies close the connection when they refuse an oversized body with 413. Before, a client that sent its next request on the same socket, as Bun's `fetch` does, got a 400 for that request (#1706, #1708).

#### Fix the Node host and the register

- A registered process finds its host again after the connection drops, including when the host comes back on another port (#1221).
- A registered process waits for a live but busy host instead of calling `PYRIC_SANDBOX` stale (#1541).

#### Fix the CLI

- `pyric run --sandbox` refuses a Vite server without a hosted sandbox at once and names `pyric({ hosted: true })` (#1582).
- The `pyric` CLI loads a command's modules only when that command runs, so `pyric run` starts in about 60 ms instead of about 475 ms (#1675).
- The CLI's local probes no longer keep the process alive about 10 seconds after a hung connect (#1213).
- `pyric firestore indexes generate` no longer writes an index for a dynamic collection id `{*}`, and the game-rules generator emits only rules production compiles (#1416).
- `firestore_discover_paths` keeps fields named `constructor`, `toString`, `hasOwnProperty` and `valueOf` instead of failing the crawl (#1439).
- Storage `rules.lint` runs the shared security lint, and fails on its error-severity findings. See Breaking changes (#1496).

#### Update create-pyric

- The Next.js template moves to Next 16 (#1492).

#### Docs

- ADR-0020, one MCP tool list routed per call, is accepted (#865). ADR-0021 proposes Firestore named databases (#1391). ADR-0022, swap or stop, is accepted (#1510).

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
