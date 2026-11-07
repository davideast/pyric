---
title: "Watch your app's calls to a real Firebase project"
navLabel: "Live mode"
group: "Observe & shape"
section: ""
order: 30
description: "Run your app against your real Firebase project and see each Firestore, Realtime Database, Cloud Storage, AI Logic and Auth call, with production's answer, in the chip, Studio and the terminal."
---

# Watch your app's calls to a real Firebase project

Live mode runs your app against your real Firebase project, with its real data. Your app keeps its own Firebase SDK, and that SDK talks to production. Pyric doesn't change what the app sees. It watches each call as it passes and shows it in the chip's Traffic panel, in Studio and in the terminal, with production's answer.

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

For a Node process, such as a server, import the register entry:

```sh
node --import @pyric/live/register server.js
```

A Node process reports its calls to the live host for the same project. Without a Vite dev server, start one with the command:

```sh
npx pyric-live
```

`pyric-live` takes `--port`, `--host`, `--no-open` and `--project <id>`. Pages get their Firebase SDK through Vite and `pyricLive()`, not from this host.

## Check which project it's on

The project comes from your project settings: `--project` (or the plugin's `project` option), `PYRIC_PROJECT`, `pyric.json`, `firebase use` or `.firebaserc`. Pyric holds no production credential. Your app's own Firebase config decides where its calls go.

Every start prints a line that names the project:

```text
pyric-live: live mode for the Firebase project my-project. Your app talks to production with its real data, and production bills each read, write and listener delivery. The chip and Studio show "Live: my-project" while it runs.
```

The chip and Studio show `Live: my-project` from the moment the host starts, before the app makes its first call. When your app's Firebase config names a different project from your project settings, the terminal, the chip and Studio warn you and name both. A host lists up to eight projects. Calls to a project past the eighth still run and still show in traffic, but the label and the warning don't name that project.

## What it forwards

Live mode forwards what your app sends, as it would without pyric:

- **Firestore** reads, queries, listeners and writes on the `(default)` database.
- **Realtime Database** reads, writes, transactions, listeners and `onDisconnect` writes, on the default instance and on named instances.
- **Cloud Storage** uploads, downloads, metadata, lists and deletes, on the default bucket and on any other bucket the app names.
- **Firebase AI Logic** `generateContent`, `generateContentStream` and `countTokens` calls, and a chat's `sendMessage` and `sendMessageStream`.
- **Auth** calls, including the ones that reach real people: account creation and deletion, password reset and sign-in link emails, and SMS sign-in.
- **App Check**, on the same app object as Firestore, Realtime Database, Cloud Storage, AI Logic and Auth.

Each call is a row in traffic, marked as served by production. A row shows the method, such as `setDoc` or `sendPasswordResetEmail`, production's answer (success or an error code such as `permission-denied`), the client that made it (this page, another tab or a Node process), and the signed-in account's id and claim names. It never shows the token.

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

## Calls that skip your Firebase SDK

Pyric sees a call only when it goes through your app's `firebase/app`, `firebase/auth`, `firebase/firestore`, `firebase/database`, `firebase/storage`, `firebase/ai` or `firebase/app-check`, or through the parts of `firebase-admin` live mode observes. Live mode never blocks a request at the network: your app behaves as it does without pyric.

A Node process under `@pyric/live/register`, or the dev server, names each Google or Firebase host it calls that pyric doesn't observe, once, in the terminal:

```text
@pyric/live/register: unobserved call to cloudtrace.googleapis.com (Google APIs). Live mode lets it through, and no row records it. Later calls to this host are not listed.
```

The health report lists the same hosts. These are calls such as a token request, Vertex AI, Cloud Trace or a public key fetch.

Live mode observes the Admin SDK's Firestore, Auth, Realtime Database, Cloud Storage and Cloud Messaging calls. Its App Check calls are checked against your project but don't show in traffic yet, and the process health lists `firebase-admin/app-check` as gated.

Other `firebase-admin` services, such as `firebase-admin/remote-config`, load from your installed SDK. The terminal names each one when it loads:

```text
@pyric/live/register: firebase-admin/remote-config loads unobserved. Live mode lets it reach Google with your credential, and no row records its calls.
```

Live mode still refuses these:

- **`@google-cloud/firestore`** imported by your own code in a Node process under `@pyric/live/register`. The import fails with `PYRIC_REAL_SDK_STOPPED`. Use `firebase/firestore` or `firebase-admin/firestore` instead.
- **An Admin call to another project.** An Admin app that names another project is refused before any request, App Check calls included. So is a Realtime Database instance live mode can't tell is your project's: it accepts `<project>-default-rtdb` and `<project>`, and the instances your firebase.json names. To use another instance of your project, add it to firebase.json's `database` list.
- **A second copy of the SDK on a page.** Importing an SDK file the page already loaded under another URL that reaches the dev server, such as the same URL with an extra query, fails with `PYRIC_LIVE_REFUSED`.

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
