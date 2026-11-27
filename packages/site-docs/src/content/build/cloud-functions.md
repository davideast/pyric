---
title: "Run Cloud Functions locally"
navLabel: "Cloud Functions"
group: "Build"
section: ""
order: 70
description: "Run local Cloud Functions triggers, HTTP and callable endpoints, .env loading, and MCP inspection against your Pyric sandbox."
---

# Run Cloud Functions locally

Your Cloud Functions run in an isolated Node child process wired straight to your local sandbox. Keep your `firebase-functions`, `firebase-admin/*`, and `firebase/functions` imports unchanged. When `firebase.json` declares a `functions` source, Pyric discovers your exports, swaps `firebase-admin/*` to the local sandbox, and serves HTTP, callable, and background triggers on your machine.

## Start Functions with your app

Declare your built Functions source in `firebase.json` as Firebase expects:

```json
{
  "functions": {
    "source": "functions"
  },
  "hosting": {
    "public": "public",
    "rewrites": [
      { "source": "/api/**", "function": "api" }
    ]
  }
}
```

Build the Functions entry point (`main` in `functions/package.json`, defaulting to `index.js`), then start your dev server:

```bash
pyric sandbox --hosted
```

Pyric starts the Functions child automatically under `pyric sandbox`, the Vite plugin (`pyric()`), and Next.js (`withPyric`). Under `pyric sandbox` without `--hosted`, Functions start once a browser tab connects to the sandbox; with `--hosted`, they start immediately with no browser tab open. If the entry file is not built yet, Pyric logs a warning and starts without Functions rather than crashing.

Only one Functions codebase per session is supported today. Saving a file in the Functions source directory under the Vite plugin reloads the child process automatically (`functions: { watch: false }` disables reload, matching `pyric sandbox`).

## Supported trigger families

Pyric discovers and runs nine Cloud Functions trigger families in one child process:

| Family | Supported triggers | Notes |
|---|---|---|
| HTTP | v2 `onRequest`, v1 `https.onRequest` | Served on the emulator path and via `firebase.json` `hosting.rewrites`. |
| Callable | v2 `onCall`, v1 `https.onCall` | Called via `firebase/functions` `httpsCallable` and `httpsCallableFromURL`. `onCallGenkit` is reported as unsupported. |
| Cloud Firestore | All 8 v2 document triggers (`onDocumentCreated`, `onDocumentUpdated`, `onDocumentDeleted`, `onDocumentWritten`, plus the 4 `WithAuthContext` variants) | Supports named database filters (`database`). |
| Realtime Database | All 4 v2 value triggers (`onValueCreated`, `onValueUpdated`, `onValueDeleted`, `onValueWritten`) | Supports multi-instance filtering (`instance`). |
| Cloud Storage | All 4 v2 object triggers (`onObjectFinalized`, `onObjectDeleted`, `onObjectArchived`, `onObjectMetadataUpdated`) | Supports default and named bucket filters (`bucket`). |
| Identity (blocking) | All 4 v2 blocking triggers (`beforeUserCreated`, `beforeUserSignedIn`, `beforeEmailSent`, `beforeSmsSent`) | Runs synchronously on Auth flows in the sandbox. |
| Cloud Pub/Sub | v2 `onMessagePublished` | Matches configured topic names and resource paths. |
| Cloud Scheduler | v2 `onSchedule` | Parses cron and App Engine schedules with timezone and retry options. |
| Cloud Tasks | v2 `onTaskDispatched` | Connects to `firebase-admin/functions` task queue enqueues with retry and rate-limit validation. |

Exports with `omit: true`, dynamic option expressions (`omit`, `document`, `ref`, `bucket`, `region`, `instance`), `onCallGenkit`, or unrecognized trigger types are skipped and reported in startup diagnostics and `functions.listTriggers`.

## Call HTTP and callable functions

Export HTTP and callable handlers using the standard `firebase-functions/v2/https` API:

```ts
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';

export const api = onRequest(async (req, res) => {
  const snap = await getFirestore().collection('items').get();
  res.json({ count: snap.size, path: req.url });
});

export const greet = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  return { message: `Hello, ${request.auth.uid}` };
});
```

### Direct emulator paths and Hosting rewrites

Every `onRequest` and `onCall` export answers on the local host origin at `/<projectId>/<region>/<name>`, such as `http://localhost:3473/my-app/us-central1/api`. The function receives `/` plus any trailing path segments and query string.

When `firebase.json` maps a `hosting.rewrites` entry to a function, Pyric mirrors Firebase Hosting routing:

- The function receives the full original path and query string (for example `/api/orders?limit=5`).
- Static files win over Hosting rewrites.
- Only the `__session` cookie is forwarded to the function.
- Rewritten requests are capped at Hosting's 60 second timeout regardless of the function's own `timeoutSeconds`, while the direct emulator path honors the function's configured `timeoutSeconds`.
- A function that sets an invoker other than `'public'`, such as `invoker: 'private'` or a service account, logs a startup warning: production refuses unauthenticated calls with 403, while Pyric serves it locally to the app's own pages and non-browser callers (such as `curl` or server code) and refuses foreign browser pages with 403.

### Call from client code

Keep your canonical `firebase/functions` imports in browser and server code:

```ts
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions(app);
const greet = httpsCallable<{ name: string }, { message: string }>(functions, 'greet');
const { data } = await greet({ name: 'Ada' });
```

Pyric routes `httpsCallable` and `httpsCallableFromURL` (including `cloudfunctions.net` and `run.app` URLs for the active project) to the local Functions gateway and refuses off-machine URLs for other hosts. Under Next.js, `withPyric` automatically proxies `/__pyric/functions/*`, `/<projectId>/<region>/<name>`, and `firebase.json` Hosting function rewrites to the local gateway when Functions are active. See [Next.js development setup](../get-started/nextjs.md).

## Load environment variables with .env files

Pyric reads dotenv files from your Functions source directory before loading user code, using Firebase's precedence order (later files win):

1. `.env`
2. `.env.<projectId>` (or `.env.<alias>` from `.firebaserc` when `.env.<projectId>` is absent)
3. `.env.local`

Files must stay inside the Functions source directory; symlinks pointing outside that directory are ignored.

To preserve sandbox isolation and prevent accidental cloud access, Pyric strips host credential variables and never lets `.env` files override protected keys:

- **Credential and project isolation:** `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_SA_BASE64`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `GCLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, `CLOUDSDK_CONFIG`, `HOME`, `APPDATA`, `USERPROFILE`, `FIREBASE_DEBUG_MODE`, `FIREBASE_DEBUG_FEATURES`.
- **Cloud Functions and Node runtime keys:** `FIREBASE_CONFIG`, `CLOUD_RUNTIME_CONFIG`, `ENTRY_POINT`, `FUNCTION_NAME`, `FUNCTION_TARGET`, `FUNCTION_SIGNATURE_TYPE`, `K_SERVICE`, `K_REVISION`, `K_CONFIGURATION`, `PORT`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`.
- **Reserved prefixes:** any variable starting with `PYRIC_` or `X_GOOGLE_`.

## And from an agent

The `functions` service tool on `pyric mcp` (and the matching `pyric functions` CLI commands) exposes three methods for inspecting and exercising your Functions source locally:

| Method | What it does |
|---|---|
| `listTriggers` | Runs isolated discovery over your Functions source and returns all supported triggers across the nine families along with any `unsupported` exports and reasons. |
| `fire` | Runs a discovered RTDB `onValueCreated` trigger on a synthetic event (`trigger`, `path`, `value`, optional `timeoutMs` up to 60000 ms, default 10000 ms) inside an isolated child process without writing `value` to the database. |
| `executions` | Lists recorded function executions (from `fire` and hosted HTTP `onRequest` calls) with cause, duration, status (`fulfilled`, `rejected`, or `timeout`), and result or error, optionally filtered with a sandbox clock `since` cursor. |

```bash
pyric functions listTriggers
pyric functions fire --trigger onPresenceOnline --path presence/alice --value '{"state":"online"}'
pyric functions executions
```

Ask a connected agent to list your project's discovered and unsupported triggers before refactoring a trigger handler, then verify execution results in the sandbox. See [Connect an agent to the sandbox](../agent/set-up-your-agent.md).

## Where to go next

Wire Functions with [Next.js development setup](../get-started/nextjs.md) or [Vite development setup](../get-started/vite.md), or review deployment checks in [Ship to production](../ship/ship-to-production.md).
