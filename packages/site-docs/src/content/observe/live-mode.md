---
title: "Watch your app's calls to a real Firebase project"
navLabel: "Live mode"
group: "Observe & shape"
section: ""
order: 30
description: "Run your app against your real Firebase project and see each Firestore and Auth call, with production's answer, in the chip, Studio and the terminal."
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
- **Auth** calls, including the ones that reach real people: account creation and deletion, password reset and sign-in link emails, and SMS sign-in.
- **App Check**, on the same app object as Firestore and Auth.

Each call is a row in traffic, marked as served by production. A row shows the method, such as `setDoc` or `sendPasswordResetEmail`, production's answer (success or an error code such as `permission-denied`), the client that made it (this page, another tab or a Node process), and the signed-in account's id and claim names. It never shows the token.

## What it refuses

Each refusal throws an error with the code `PYRIC_LIVE_REFUSED` before any request leaves, and says what was refused and why:

- **Other services.** Importing Realtime Database, Cloud Storage, Cloud Functions, Cloud Messaging, Firebase AI Logic, Analytics, Remote Config, Performance Monitoring or Firestore Lite. The sandbox doesn't serve them either, so one app never mixes production and sandbox services.
- **Named Firestore databases**, such as `getFirestore(app, 'reports')`.
- **`firebase-admin`** in a Node process under `@pyric/live/register`.
- **Pyric's own writes.** Studio edits, MCP tools that write, `pyric` commands that write, and seed files.
- **Identity switches.** Pyric impersonating a user or switching the account it acts as. Your app signs in and out through its own Auth calls.
- **Calls that act on production for pyric**, such as provisioning Storage or testing rules against a hosted project.

To use any of these, run the app without `@pyric/live`. It gets the sandbox again.

## Calls that skip your Firebase SDK

Pyric sees a call only when it goes through your app's `firebase/app`, `firebase/auth`, `firebase/firestore` or `firebase/app-check`. Live mode refuses these other routes to production, so none of them reaches your project unseen:

- **`@google-cloud/firestore`** in a Node process under `@pyric/live/register`. The import fails with `PYRIC_REAL_SDK_STOPPED`. Use `firebase/firestore` instead.
- **Your own requests to Firestore, Auth or App Check** from a Node process, with `fetch`, `http.request` or `https.request`. Each fails with `PYRIC_GUARD_BLOCKED`, and the terminal names the host.
- **A second copy of the SDK on a page.** Importing an SDK file the page already loaded under another URL, such as the same URL with an extra query, fails with `PYRIC_LIVE_REFUSED`.

## What live mode can't see

Some requests from a page never reach the dev server, so live mode can't refuse or show them:

- **The exact URL of an SDK file the page already loaded.** The browser answers `import()` of that URL from its own module cache, so the page gets the SDK without pyric in between.
- **The page's own `fetch` to the Firestore REST API**, or to Auth or App Check. The browser sends it straight to Google.

In a Node process, a connection your code opens itself with `http2`, `tls` or `@grpc/grpc-js` to `firestore.googleapis.com` looks the same as your Firebase SDK's own, so live mode lets it through without showing it. None of these calls shows in traffic, and production still bills them.

## Count billed calls

The chip and Studio show a running count of your app's Firestore reads, writes and listener deliveries in production. Reads and writes are counted per call, not per document, so a query counts once however many documents production bills for it. Listener deliveries count the documents delivered to listeners. An HMR reload that restarts a listener reads its documents again.

The count is an estimate from the calls pyric observed, and it understates the bill for large queries. It doesn't cap anything. Your project's usage in the Firebase console is the number production charges.

## Related

- [Watch every read, write, and denial live](./see-whats-happening.md) covers the traffic view in sandbox mode.
- [Resolve runtime errors and stale workers](./resolve-runtime-status.md) covers the chip.
