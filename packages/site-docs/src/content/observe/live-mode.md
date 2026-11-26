---
title: "Watch your app's calls to a real Firebase project"
navLabel: "Live mode"
group: "Observe & shape"
section: ""
order: 30
description: "Run your app and its backend against your real Firebase project and see each Firestore, Realtime Database, Cloud Storage, AI Logic, Auth and Admin SDK call, with production's answer, in the chip, Studio and the terminal."
---

# Watch your app's calls to a real Firebase project

Live mode runs your app against your real Firebase project, with its real data. Your app keeps its own Firebase SDK, and that SDK talks to production. Pyric doesn't change what the app sees. It watches each call as it passes and shows it in the chip's Traffic panel, in Studio and in the terminal, with production's answer. A Node backend's `firebase-admin` calls show there too.

Live mode is its own package, `@pyric/live`. Without it installed, nothing in `pyric` or `@pyric/cli` turns live mode on.

## Install it

```sh
npm install --save-dev @pyric/live
```

Your app's `firebase` must be in the range live mode supports: `^12.12.0`. Live mode refuses to start outside that range, and when more than one copy of `@firebase/app` is installed. The message names the version it found, or the path of every copy.

## Start it

For a Vite app, add the plugin. Its dev server is the live host:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { pyricLive } from '@pyric/live/vite';

export default defineConfig({ plugins: [pyricLive()] });
```

For a Node process, such as a server, run it against a live host with `pyric-live run` (or import the register entry directly):

```sh
npx pyric-live run --wait -- node server.js
# or directly:
node --import @pyric/live/register server.js
```

`pyric-live run` accepts `--host <url>` and `--wait[=<seconds>]` (default 30s), resolves `@pyric/live/register` by file URL, and passes the live host's project when `PYRIC_PROJECT` isn't already set. A Node process reports its calls to the live host for the same project. A backend that uses `firebase-admin` runs the same way: see [Run a backend with the Admin SDK](#run-a-backend-with-the-admin-sdk). Without a Vite dev server, start a live host with the command:

```sh
npx pyric-live
```

`pyric-live` takes `--port`, `--host`, `--no-open` and `--project <id>`. Pages get their Firebase SDK through Vite and `pyricLive()`, not from this host.

## Check which project it's on

The project is the first of these that is set:

1. `--project`, or the plugin's `project` option.
2. The `PYRIC_PROJECT` environment variable.
3. The project `firebase use` made active for your Firebase project folder or a folder above it.
4. The only `.firebaserc` alias, else `.firebaserc` `projects.default`.
5. Under `@pyric/live/register`, the reachable live host's project when none of the above is set.

A value that names a `.firebaserc` alias resolves to that alias's project id. Live mode doesn't read the `project` in `pyric.json`. When none of these is set, live mode doesn't start and says how to set one.

Pyric holds no production credential. Your app's own Firebase config decides where its calls go.

Every start prints a line that names the project:

```text
pyric-live: live mode for the Firebase project my-project. Your app talks to production with its real data, and production bills each read, write and listener delivery. The chip and Studio show "Live: my-project" while it runs.
```

The chip and Studio show `Live: my-project` from the moment the host starts, before the app makes its first call.

Each call from a page or a Node process is checked against that project before your SDK runs it. The call throws `PYRIC_LIVE_REFUSED` when another project is named by:

- **The app's config.** Its `projectId`, or the project in its `databaseURL`, `storageBucket` or `authDomain`.
- **What the call reaches.** A Realtime Database instance or Cloud Storage bucket of another project, such as `getDatabase(app, url)` or `getStorage(app, 'gs://...')`.

The error names the field and both projects, and production hears nothing of the call. Only a field's default form names a project. A custom auth domain, a named or legacy `firebaseio.com` instance, a bucket with its own name, and an emulator address name none, so they aren't checked. Neither are `firebase/app` calls such as `initializeApp`, which make no request, or imports listed in `passThrough`.

When a call that wasn't checked names another project, such as one from a Node process started for another project, the terminal, the chip and Studio warn you and name both. A host lists up to eight projects. Calls to a project past the eighth still run and still show in traffic, but the label and the warning don't name that project.

## Live mode observes, it doesn't block

In live mode your app talks to production as it would without pyric. Pyric never intercepts or blocks requests at the socket or HTTP layer. It records the calls its SDK rows serve, and it reports module-level pass-through and unobserved `firebase-admin` subpaths. Live mode is never riskier than running the same app without pyric.

What you see for each kind of call:

| Call | What happens | What you see |
|---|---|---|
| A call a live row serves, from a page, a Node process or `firebase-admin` | Goes to production | A row in Traffic, Studio and the terminal |
| Any non-SDK HTTP or Google API call from a Node process or the dev server | Goes to production unimpeded | No row (outside the Firebase SDK module boundary) |
| A `firebase-admin` service no row serves | Loads from your installed SDK and goes to production | One line when it loads, and the service in the process health |
| A call from a page or a Node process whose app's config, or the instance or bucket it reaches, names another project | Refused before your SDK runs it | `PYRIC_LIVE_REFUSED`, naming the field and both projects |
| An Admin call whose app names another project | Refused before any request | `PYRIC_LIVE_REFUSED`, and one line in the terminal |
| An Admin Realtime Database call to an instance that isn't your project's | Refused before it connects | `PYRIC_LIVE_REFUSED`, naming firebase.json |

The last three are the only calls live mode refuses because of where they go. See [Check which project it's on](#check-which-project-its-on). Live mode also refuses Firebase imports it doesn't serve, and pyric's own writes. See [What it refuses](#what-it-refuses).

Two health reports list module-level coverage for services pyric doesn't observe:

- **The live host.** `GET <url>/__pyric/health` on the dev server or `pyric-live` has a `live` field, including `passThrough` when imports are passed through.
- **A Node process under `@pyric/live/register`.** Its own servers answer a process health request. The answer lists `unobservedAdmin` for the `firebase-admin` services no row serves, and `gatedAdmin` for the services checked against your project but not recorded. See [Process health on registered processes](../reference/cli.md#process-health-on-registered-processes).

Each list is absent when it is empty. A Node process also sends its lists to the live host. While it is connected, the host's `live.clients` entry for it (`kind: "node"`) carries the same `unobservedAdmin` and `gatedAdmin` lists, named by the client id its events carry. The lists hold service names only, and they go when the host drops the client.

## What it forwards

Live mode forwards what your app sends, as it would without pyric:

- **Firestore** reads, queries, listeners and writes on the `(default)` database.
- **Realtime Database** reads, writes, transactions, listeners and `onDisconnect` writes, on the default instance and on named instances.
- **Cloud Storage** uploads, downloads, metadata, lists and deletes, on the default bucket and on any other bucket the app names.
- **Firebase AI Logic** `generateContent`, `generateContentStream` and `countTokens` calls, and a chat's `sendMessage` and `sendMessageStream`.
- **Auth** calls, including the ones that reach real people: account creation and deletion, password reset and sign-in link emails, and SMS sign-in.
- **App Check**, on the same app object as Firestore, Realtime Database, Cloud Storage, AI Logic and Auth.

Each call is a row in traffic, marked as served by production. A row shows the method, such as `setDoc` or `sendPasswordResetEmail`, production's answer (success or an error code such as `permission-denied`), the client that made it (this page, another tab or a Node process), and the signed-in account's id and claim names. It never shows the token. Claim values (including `email` and `firebase.identities.email`), written fields and read documents stay on your machine so the host can check your local rules and `pyric verify` can replay captured live calls.

Local rules checks evaluate Firestore and Realtime Database calls against the documents and paths observed in this live session's reads, writes and listener deliveries. A rule that reads a path this session hasn't observed yet (or whose snapshot was skipped, invalidated by an uncaptured mutation, or read or delivered optimistically while a Realtime Database write was still in flight) reports `unevaluated` with the missing paths instead of guessing empty state. Writes made outside the observed processes — such as from another client, a Cloud Function, a separate server or the Firebase console — aren't seen until this session reads those paths again or receives them on a listener, so a previously captured snapshot can go stale and report local `allow` (`drift`) where production denies on newer server state.

## Realtime Database calls

Each Realtime Database call is a row in Traffic, and so is each delivery to a listener. The row names the call with its service, such as `rtdb.set`, `rtdb.onValue` or `rtdb.onDisconnect.set`, and shows the path, such as `/items/a`. A call the project's rules deny shows `permission_denied` as production's answer.

- **Named instances.** A call on a named instance, such as `getDatabase(app, 'https://my-project-archive.firebaseio.com')`, is a row too. Traffic doesn't show which instance a row came from yet.
- **`.info` paths.** A call or listener on a path under `/.info`, such as `.info/connected`, runs as your SDK runs it and makes no row. The SDK answers these paths itself, so production never sees them.
- **Not yet shown.** Realtime Database listeners don't appear in the chip's Data tab or Studio's Listeners view, and Realtime Database calls don't add to the billed-call count.

## Cloud Storage calls

Each Cloud Storage call is a row in Traffic. The row names the call with its service, such as `storage.uploadBytes` or `storage.getMetadata`, and shows the object as a `gs://` path, such as `gs://my-project.firebasestorage.app/photos/a.jpg`.

- **The calls.** `uploadBytes`, `uploadString`, `uploadBytesResumable`, `getDownloadURL`, `getBytes`, `getBlob` (on a page), `getStream` (in a Node process), `getMetadata`, `updateMetadata`, `list`, `listAll` and `deleteObject`.
- **Every bucket.** A call on another bucket, such as `getStorage(app, 'gs://my-project-uploads')`, is a row too, and its path names that bucket.
- **One row per upload task.** An `uploadBytesResumable` task is one row however many chunks it sends, and a pause and resume stay on that row. The row appears when the task finishes, fails or is canceled. Progress isn't shown.
- **Denials.** A call the project's rules deny shows `storage/unauthorized`, and the row reads "Production denied".
- **Download URLs.** Fetching the URL `getDownloadURL` returns isn't observed. See [Calls that skip your Firebase SDK](#calls-that-skip-your-firebase-sdk).
- **Observed Storage browser.** Successful uploads, metadata reads and updates, listings, download URLs and deletes from `firebase/storage` and `firebase-admin/storage` populate a read-only Storage metadata browser in Studio (`/storage`) for the current session under its own bounded LRU budget. Studio shows bucket tabs, folder prefixes, complete-listing pruning, session delete tombstones, object metadata and `customMetadata` as returned by Firebase, plus `Copy gs:// URI` / `Copy path` controls and an external Storage download URL link when `getDownloadURL` returned an allowlisted Firebase/GCS URL. Live mode retains zero raw object bytes in host memory or `.pyric/`, and seeding `.pyric/state/hosted` never fabricates placeholder blobs.
- **Not counted.** Cloud Storage calls don't add to the billed-call count.

## AI Logic calls

Each Firebase AI Logic call is a row in Traffic. The row names the call with its service, such as `ai.generateContent` or `ai.chat.sendMessage`, and shows the model it asked for, such as `gemini-flash-lite-latest`, and the model production reported answering with when it reports one.

- **The calls.** `generateContent`, `generateContentStream` and `countTokens` on a model from `getGenerativeModel` or `new GenerativeModel`, and `sendMessage` and `sendMessageStream` on a chat from `startChat`.
- **Token counts.** A row's detail shows production's input and output tokens, such as "Input tokens 9" and "Output tokens 2". A stream's counts cover the whole stream. A `countTokens` row shows "Counted tokens". Traffic doesn't total the counts or cap them, and every call bills by token.
- **No prompt or response.** A row never records a prompt, a response's text, a function call or a header. A successful row's detail reads "Response content was not recorded for this request.", and a failed row's reads "No successful response was returned."
- **App Check.** A call without an App Check token, on a project that enforces App Check for AI Logic, reads as failed with the code `unauthenticated`, as production answers it with a 401. A model production doesn't serve reads as failed with `not_found`.
- **On-device answers.** A model set to run only on device makes no row, and neither does a hybrid answer made on device. Production never saw them.
- **Not counted.** AI Logic calls don't add to the billed-call count.

Live mode refuses the parts of `firebase/ai` it doesn't observe. Each throws `PYRIC_LIVE_REFUSED` before any request leaves:

- **The Live API.** `getLiveGenerativeModel`, `new LiveGenerativeModel`, `new LiveSession` and `startAudioConversation`, before the Live API's WebSocket opens.
- **Server prompt templates.** `getTemplateGenerativeModel` and `new TemplateGenerativeModel`, and `getTemplateImagenModel` and `new TemplateImagenModel`.
- **Imagen**, on firebase versions below 12.19 that still export it: `getImagenModel` and `new ImagenModel`.

## What it refuses

Each refusal throws an error with the code `PYRIC_LIVE_REFUSED` before any request leaves, and says what was refused and why:

- **Other services.** Importing Cloud Functions, Cloud Messaging, Analytics, Remote Config, Performance Monitoring or Firestore Lite. The sandbox doesn't serve them either, so one app never mixes production and sandbox services.
- **Named Firestore databases**, such as `getFirestore(app, 'reports')`.
- **AI Logic's Live API, server prompt templates and Imagen.** See [AI Logic calls](#ai-logic-calls).
- **Pyric's own writes.** Studio edits, MCP tools that write, `pyric` commands that write, and seed files.
- **Identity switches.** Pyric impersonating a user or switching the account it acts as. Your app signs in and out through its own Auth calls.
- **Calls that act on production for pyric**, such as provisioning Storage or testing rules against a hosted project.

To use any of these, run the app without `@pyric/live`. It gets the sandbox again.

## Pass other services through

An app that needs a service live mode doesn't serve can list its import in `passThrough`. The app then loads that service from its own installed SDK, unobserved:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { pyricLive } from '@pyric/live/vite';

export default defineConfig({
  plugins: [pyricLive({ passThrough: ['firebase/functions'] })],
});
```

Its calls don't show in Traffic, and production still bills them. The start line, the chip and Studio each name it:

```text
@pyric/live/vite: firebase/functions passes through to production: its calls are not observed and still bill.
```

A Node process under `@pyric/live/register` reads the same list from its live host, so start it after the host.

A list that names an import live mode serves stops the dev server at start. Live mode serves `firebase/database`, `firebase/ai` and `firebase/storage`, so an app that lists one must remove the entry:

```text
@pyric/live/vite: passThrough lists firebase/database, which live mode already serves and observes; remove it.
```

## Run a backend with the Admin SDK

A Node backend under `@pyric/live/register` can use `firebase-admin` with its own credential, as it would without pyric. Pyric holds no credential and never reads a key or a token. It reads only the project id, through `firebase-admin`'s own objects.

```sh
node --import @pyric/live/register server.js
```

Admin calls bypass Security Rules. A write from your backend changes production data whatever your rules say, as it does without pyric.

The backend needs:

- **Node 23 or later.** On Node 22, the register can't see `firebase-admin`'s `require()` calls. The start line says `firebase-admin` is refused in this process and names Node 23, and each `firebase-admin` import throws `PYRIC_LIVE_REFUSED`. A child process on Node 22, started by a backend on Node 23 or later, refuses `firebase-admin` the same way and prints the same line. The rest of the process runs in live mode as usual.
- **`firebase-admin` 13.** With another major version installed, the register stops at start and prints the install command.

The start line says what is observed:

```text
@pyric/live/register: firebase-admin is observed for the Firebase project my-project. This process uses its own credential, and its Admin calls bypass Security Rules. Its Firestore, Auth, Realtime Database, Storage and Messaging calls are observed. Its App Check calls are checked against the project but not observed, so they do not show in traffic. Any other firebase-admin service loads unobserved, and a line names it when it loads.
```

When an emulator variable such as `FIRESTORE_EMULATOR_HOST` is set, one more line names the service and the address its calls go to instead of production.

### What it observes

Each observed call is a row in Traffic, marked as an Admin call that bypassed Security Rules. The row is named `<Class>.<method>`, such as `DocumentReference.set` or `Auth.verifyIdToken`, and shows production's answer.

- **Firestore.** `DocumentReference` `get`, `set`, `update`, `delete`, `create`, `listCollections` and `onSnapshot`. `CollectionReference` `add` and `listDocuments`. `Query` `get` and `onSnapshot`, and a count query's `get`. `WriteBatch.commit`. `Firestore` `getAll` and `runTransaction`.
- **Auth.** `verifyIdToken`, `getUser`, `getUserByEmail`, `getUserByPhoneNumber`, `getUsers`, `listUsers`, `createUser`, `updateUser`, `deleteUser`, `deleteUsers`, `setCustomUserClaims` and `revokeRefreshTokens`.
- **Realtime Database.** `get`, `once` and `on`, and `set`, `update`, `remove`, `transaction`, `setWithPriority` and `push`.
- **Cloud Storage.** `File` `save`, `createWriteStream`, `download`, `delete`, `exists`, `getMetadata`, `setMetadata`, `copy` and `move`. `Bucket` `getFiles`, `upload` and `deleteFiles`.
- **Cloud Messaging.** `send`, `sendEach`, `sendEachForMulticast`, `subscribeToTopic` and `unsubscribeFromTopic`.
- **App Check.** `verifyToken` and `createToken` are checked against your project, but make no row yet. The process health lists `firebase-admin/app-check` in `gatedAdmin`.

Beyond the path a call targets, an Admin row in Traffic and in terminal or repro logs never records a document value, a Realtime Database value, an object's bytes, a metadata value, a token, a password, an account email, a phone number or a message.

Successful Admin Firestore reads, listener deliveries, writes, `WriteBatch.commit`, `Firestore.getAll` and committed `Firestore.runTransaction` calls, successful Admin Realtime Database reads, listener deliveries, writes, `push` and committed `transaction` calls, and successful Admin Cloud Storage uploads, metadata calls, listings and deletes also send bounded deltas to the live host's in-memory session store (`8 MiB` and `2,000` Firestore documents, plus an isolated `8 MiB`, `2,000`-object, `32`-bucket Storage metadata catalog that retains zero object bytes) while stripping `sessionData` from Traffic events, terminal output and repro files. Studio's Data, Realtime Database and Storage views show those observed entries read-only alongside the SDK source badge (`Observed · Admin` or `Observed · Client + Admin`). Calls using custom converters, `Query.select()` projections, `getAll` field masks or server-transform sentinels (`FieldValue.serverTimestamp`, `increment`, `arrayUnion`, `arrayRemove`, or Realtime Database `ServerValue` transforms) count as `unsupported`, failed or rolled-back calls are never added, and nothing is written to `.pyric/` unless you explicitly click **Seed local sandbox…** or **Export seed JSON** (or run `pyric sandbox seed-from-live`).

### Which project it reaches

Every observed or checked Admin call passes a project check first. Pyric works out the project the way `firebase-admin` does, in this order:

1. The app's `projectId` option.
2. The credential's project, for a service account key from `cert()`.
3. `GOOGLE_CLOUD_PROJECT`, then `GCLOUD_PROJECT`.
4. The project application default credentials report.

When `firebase-admin` is installed, the register refuses to start when `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT` or the `projectId` in `FIREBASE_CONFIG` names another project. When `GOOGLE_CLOUD_PROJECT` is unset, the register sets it to your project, so an app that names no project gets yours.

An app that resolves to another project is refused on every call, before any request leaves. The terminal gets one line:

```text
@pyric/live: firebase-admin is refused in live mode, from a Node process: options.projectId names the project 'other-project', and this live host serves 'my-project'. No Admin request left. Point the Admin SDK at 'my-project', or start live mode for 'other-project'.
```

Realtime Database is also checked by instance, before any connection opens. Live mode accepts:

- `<project>-default-rtdb`, on firebaseio.com or a regional firebasedatabase.app host;
- the legacy `<project>` instance;
- the instances your firebase.json names in its `database` list, directly or through a `.firebaserc` database target.

Any other instance is refused, even one whose name starts with your project id: with the project `acme`, `acme-prod-default-rtdb` is the default instance of the project `acme-prod`. To use another instance of your project, add it to firebase.json's `database` list and start again. The app's own `databaseURL` can't add one, because it is the thing being checked. `getRules`, `getRulesJSON` and `setRules` get the same checks.

Cloud Storage is also checked by bucket. A bucket in another project's default form, such as `other-project.appspot.com` or `other-project.firebasestorage.app`, is refused.

Some calls carry no project the check can read:

- **A bucket with a name of its own.** A call to it from an app on your project goes out, whichever project owns the bucket.
- **`subscribeToTopic` and `unsubscribeFromTopic`** go to `iid.googleapis.com` with no project in the request. The check reads the app's project, but the project the call reaches comes from the credential and the registration tokens.

### Services no row serves

Other `firebase-admin` services, such as `firebase-admin/remote-config`, load from your installed SDK and reach Google with your credential. The terminal names each one when it loads:

```text
@pyric/live/register: firebase-admin/remote-config loads unobserved. Live mode lets it reach Google with your credential, and no row records its calls.
```

The process health lists each one in `unobservedAdmin`.

### Calls that go out unobserved

These calls go to production with no row, and the project check doesn't see them. Treat them as a gap in what pyric shows, not as checked:

- Firestore's `Query.stream`, `BulkWriter` and `recursiveDelete`.
- Cloud Storage's `File.createReadStream`.
- Any other method of a served service that the lists above don't name, such as `createCustomToken`, `createSessionCookie` and `verifySessionCookie` in Auth, or `getSignedUrl` in Cloud Storage.

## Calls that skip your Firebase SDK

Pyric sees a call only when it goes through your app's `firebase/app`, `firebase/auth`, `firebase/firestore`, `firebase/database`, `firebase/storage`, `firebase/ai` or `firebase/app-check`, or through the parts of `firebase-admin` live mode observes. Direct HTTP calls (`fetch`, `https.request`) to Google or third-party APIs bypass the Firebase SDK module boundary and go out unimpeded with no row or terminal notice.

Live mode still refuses these:

- **`@google-cloud/firestore`** imported by your own code in a Node process under `@pyric/live/register`. The import fails with `PYRIC_REAL_SDK_STOPPED`. Use `firebase/firestore` or `firebase-admin/firestore` instead.
- **An Admin call to another project**, and a Realtime Database instance live mode can't tell is your project's. See [Which project it reaches](#which-project-it-reaches).
- **A second copy of the SDK on a page.** Importing an SDK file the page already loaded under another URL that reaches the dev server, such as the same URL with an extra query, fails with `PYRIC_LIVE_REFUSED`.

## A page and a backend in different modes

A page in live mode can sit in front of a backend on a pyric sandbox, or the other way round. Two checks catch it.

**Tokens.** A live backend's `verifyIdToken` and `verifySessionCookie` refuse an ID token a pyric sandbox issued, before any request and with no row. The error keeps `firebase-admin`'s code, `auth/argument-error`, so your error handling runs as usual, and adds `pyricCode: 'PYRIC_MODE_MISMATCH'`:

```text
This backend runs in live mode for my-project, and the request carries an ID token a pyric sandbox issued. Start this backend under pyric run --sandbox, or sign in on the live page.
```

A sandbox backend's `verifyIdToken` refuses an ID token production issued the same way, with the same `pyricCode`.

**The proxy check.** When the dev server starts, it asks each `server.proxy` target on this machine what it is, and warns in the terminal when the target is in another mode or on another project. It never refuses. The host's health report lists each verdict in `proxyTargets`. See [Check a dev server's proxy targets](../reference/cli.md#check-a-dev-servers-proxy-targets).

## What live mode can't see

Some requests from a page never reach the dev server, so live mode can't refuse or show them:

- **The exact URL of an SDK file the page already loaded.** The browser answers `import()` of that URL from its own module cache, so the page gets the SDK without pyric in between.
- **That URL with a fragment added**, such as `#copy`. The browser keeps the fragment to itself, so the dev server sees the URL it already served, and the page gets a second copy of the SDK.
- **The page's own `fetch` to the Firestore REST API**, or to Auth or App Check. The browser sends it straight to Google.
- **The page's own `fetch` of a download URL**, or any request to `firebasestorage.googleapis.com`. The browser sends it straight to Google.
- **The page's own `fetch` or `WebSocket` to `firebasevertexai.googleapis.com`**, the AI Logic host. The browser sends it straight to Google.
- **The page's own `WebSocket` or `fetch` to a Realtime Database host**, such as `my-project-default-rtdb.firebaseio.com`. The browser sends it straight to Google.

In a Node process, your own request to a host your Firebase SDK reaches, such as `firestore.googleapis.com`, looks the same as the SDK's traffic. Live mode lets it through without naming it.

None of these calls shows in traffic, and production still bills them.

## Count billed calls

The chip and Studio show a running count of your app's Firestore reads, writes and listener deliveries in production. Reads and writes are counted per call, not per document, so a query counts once however many documents production bills for it. Listener deliveries count the documents delivered to listeners. An HMR reload that restarts a listener reads its documents again.

The count is an estimate from the calls pyric observed, and it understates the bill for large queries. It doesn't cap anything. Your project's usage in the Firebase console is the number production charges. Realtime Database, Cloud Storage and AI Logic calls aren't in the count.

## Related

- [Watch every read, write, and denial live](./see-whats-happening.md) covers the traffic view in sandbox mode.
- [Resolve runtime errors and stale workers](./resolve-runtime-status.md) covers the chip.
