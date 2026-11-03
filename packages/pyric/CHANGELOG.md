# Changelog

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
