---
title: "Tutorial"
navLabel: "Tutorial"
group: "Overview"
section: ""
order: 20
description: "Build a Firebase chat app with the local development tools I always wanted."
---

# 12 years of Firebase experience distilled into one tool

Atwood's Law states that anything that can be written in JavaScript will be written in JavaScript. Atwood's Law has now come for Firebase.

I worked on Firebase for 12 years. I love how quickly it lets you build, but I also spent those years running into the same problem: developing against a cloud Firebase project.

Firebase provides the Emulator Suite, but it is Java-dependent, can be frustrating to connect to the SDKs, and leaves some production services without a local equivalent. I wanted an emulator that started with the app, required no separate runtime, and could not accidentally write to production. The browser is already one of the safest and most accessible sandboxes in the world, so I put the backend there.

## Meet Pyric

For this tutorial, use the terminal path so every step starts from the same chat template:

```bash
npm create pyric@latest my-chat -- --template chat
cd my-chat
npm install
npm run dev
```

Pyric is a local mirror of Firebase. Open the Vite URL and the app runs Firebase code, but not against a cloud Firebase project. It runs against a local sandbox. Choose a local user, send a message, then open Studio at `/__pyric/ui/studio` to see the data and requests.

A mirror is not a copy of Firebase's production infrastructure. Pyric implements the behavior the application can observe: a user signs in, a rule allows or denies a request, a snapshot changes, or a message arrives. It tests that supported behavior against Firebase and documents where the reflection ends.

We are going to build that chat app piece by piece. One conversation will show what Pyric adds to Authentication, Firestore, Security Rules, AI Logic, Storage, Realtime Database, Cloud Functions, and Cloud Messaging—and why I wanted each tool in the first place.

## Start with `/improve-firebase`

Firebase projects rarely describe themselves in one place. The application imports one set of services, `firebase.json` points to another set of files, Security Rules describe the access model, and Functions add server behavior.

Before changing the app, ask Pyric to read those pieces together:

```text
/improve-firebase
```

The skill inspects the project without editing it. For our chat app, its first pass should find something like this:

```text
Firebase services found:
✓ Authentication
✓ Firestore
✓ Storage
✓ Realtime Database
✓ AI Logic
✓ Cloud Messaging

Missing or unproven:
- local service configuration
- conversation ownership tests
- indexes required by the conversation queries
- a captured journey to verify before production
```

It writes findings and plans under `plans/`. Review a plan, then let the skill carry it out explicitly:

```text
/improve-firebase execute plans/001-local-chat.md
```

This gives us a path through the application based on what is actually present. The first change is to put its Firebase calls behind Pyric during development.

## Add the Vite plugin

Add the Vite plugin to an existing Firebase application:

```bash
npm install --save-dev @pyric/cli
```

Keep the Firebase imports in the application:

```ts
import { getAI } from 'firebase/ai';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const rtdb = getDatabase(firebaseApp);
export const storage = getStorage(firebaseApp);
export const ai = getAI(firebaseApp);
```

Then add Pyric to Vite:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pyric } from '@pyric/cli/vite';

export default defineConfig({
  plugins: [react(), pyric()],
});
```

Run the app:

```bash
npm run dev
```

Under Vite, `firebase/firestore` and the other supported `firebase/*` imports resolve to Pyric. During a production build, they resolve to Firebase as usual. The application source does not need a local version and a production version.

The browser backend has two main pieces:

```text
Tab A ─┐
       ├── SharedWorker ── IndexedDB
Tab B ─┘
```

A **SharedWorker** is a background browser process that multiple tabs can use together. **IndexedDB** is the database built into the browser. Pyric combines them so every tab on the same development origin shares local users and data. If the browser does not support SharedWorker, Pyric falls back to a sandbox contained in each tab.

Open the chat app twice. Create a Firestore document in the first tab and attach an `onSnapshot` listener in the second:

```ts
onSnapshot(doc(db, 'conversations', 'welcome'), (snapshot) => {
  console.log(snapshot.data());
});
```

The second tab receives the update. There is no database server waiting on another port. For this application, the browser is the server.

Open Pyric Studio at `/__pyric/ui/studio`. The new document appears there too because Studio connects to the same sandbox. The app, its other tabs, Studio, and a connected coding agent all see the same local state.

## Connect a coding agent with Pyric MCP

Enable the MCP bridge in Vite:

```ts
pyric({ bridge: true })
```

Pyric mounts an MCP server at `http://localhost:<vite-port>/__pyric/mcp`. Most MCP clients can use the port-discovering stdio configuration instead of a fixed URL:

```json
{
  "mcpServers": {
    "pyric": {
      "command": "npx",
      "args": ["--package", "@pyric/cli", "pyric", "mcp"]
    }
  }
}
```

The MCP server handles Rules tools locally. For data tools, it forwards the agent's call over a WebSocket bridge to the SharedWorker that owns the browser sandbox. Keep the app open while the agent works, and do not start a second Pyric server beside Vite—that would create a second sandbox.

See [Connect an agent to the sandbox](./agent/set-up-your-agent.md) for Claude Code, Cursor, Codex, and generic MCP configuration.

## Sign in without an OAuth provider

Google sign-in normally needs an OAuth provider and a cloud Firebase project. The chat app still uses the ordinary Firebase call:

```ts
const provider = new GoogleAuthProvider();
const credential = await signInWithPopup(auth, provider);
console.log(credential.user.uid);
```

In production, that opens Google's OAuth flow. Under Pyric, it opens a local account picker. Create Alice and Bob. The app receives normal Firebase users, and we can immediately test that Alice owns her conversation while Bob does not.

## Give Security Rules the module system they need

Security Rules are some of the most important code in a Firebase application. They are also written in a language with no module system.

After enough projects, one Rules file becomes a collection of copied helpers, naming conventions, and comments asking everyone to keep three almost-identical functions in sync. Security code deserves a better foundation than copy and paste.

Pyric's `2+modules` format adds imports:

```rules
rules_version = '2+modules';

import { isAuthenticated, isOwner } from 'auth';
import { hasRequired, hasOnly, validString } from 'validation';
import { immutableFields, onlyFieldsChanged, isServerTimestamp } from 'lifecycle';

service cloud.firestore {
  match /databases/{database}/documents {
    match /conversations/{conversationId} {
      allow create: if isAuthenticated()
        && isOwner(request.resource.data.ownerUid)
        && hasRequired(['ownerUid', 'title', 'createdAt', 'updatedAt'])
        && hasOnly(['ownerUid', 'title', 'createdAt', 'updatedAt'])
        && validString('title', 1, 120)
        && isServerTimestamp('createdAt')
        && isServerTimestamp('updatedAt');

      allow update: if isOwner(resource.data.ownerUid)
        && immutableFields(['ownerUid', 'createdAt'])
        && onlyFieldsChanged(['title', 'updatedAt'])
        && isServerTimestamp('updatedAt');
    }
  }
}
```

Firebase never sees these imports. Resolve them before deployment:

```bash
pyric firestore rules resolve firestore.modules.rules --out firestore.rules
```

The resolver follows imports and their dependencies, renames private helpers so modules cannot collide, and produces an ordinary `rules_version = '2'` file. We get modules. Firebase gets the format it already understands.

Pyric loads `firestore.modules.rules` while Vite is running, so an edit takes effect without resolving the file first. `firestore.rules` remains the production artifact.

## A Standard Library for Security Rules

Imports solve how to share a Rules function. They do not solve whether that function is safe.

I wanted a Standard Library for Security Rules: functions for the checks almost every application writes, followed by functions for the checks most applications avoid because they are difficult to get right.

The library begins with `auth`, `validation`, `lifecycle`, `membership`, `transitions`, and `counters`. Every module has executable allow-and-deny cases that run continuously against Pyric's Rules engine. The more difficult modules are also checked against Firebase rather than merely agreeing with Pyric's own implementation.

The chat rules already use the common end of that library:

```rules
isOwner(request.resource.data.ownerUid)
hasRequired(['ownerUid', 'title', 'createdAt', 'updatedAt'])
validString('title', 1, 120)
immutableFields(['ownerUid', 'createdAt'])
isServerTimestamp('updatedAt')
```

The `timing` module makes rate limiting possible in Security Rules. Suppose a conversation title may only change once every two seconds:

```rules
import { cooldownElapsed } from 'timing';
import { isServerTimestamp } from 'lifecycle';

allow update: if isOwner(resource.data.ownerUid)
  && onlyFieldsChanged(['title', 'updatedAt'])
  && cooldownElapsed('updatedAt', 2)
  && isServerTimestamp('updatedAt');
```

`cooldownElapsed()` compares the previous trusted timestamp with `request.time`. It only works for updates because a new document has no previous value. Pair it with `isServerTimestamp()` so the client cannot forge the next timestamp. The comparison is strict: a write at the exact boundary is denied, while the first write after it is allowed.

The `geometry` module makes games possible. Geometry is what made it possible to build chess in Firestore Security Rules: the rule can read the stored piece, check its legal destination, and reject an impossible move before it reaches the database. The Standard Library distills that work into config-driven movement helpers:

```rules
import { validSimpleMove, validJumpMove } from 'geometry';

function config() {
  return get(/databases/$(database)/documents/gameConfig/checkers).data;
}

allow update: if ownsGame()
  && moveIntegrity()
  && (validSimpleMove(config())
    || (validJumpMove(config()) && captureValid()));
```

The configuration document records which starting and ending cells form a valid move. For a jump, it also records the cell that must be captured. The helper reads the moving piece from the stored board, not from a client claim, and uses the configuration to reject an impossible move. The surrounding checks still enforce ownership, board integrity, and the captured piece; geometry is one tested part of the complete rule.

Our chat app does not need checkers geometry. That is not the point. The same library spans “is this my document?” and “is this a legal jump over the correct board position?” It is accumulated Security Rules work that the next project should not have to rediscover.

Ask a connected agent to inspect the library rather than guess a helper name:

> List the Standard Library functions for ownership, document validation, and update timing. Show their signatures and tests before using them.

The agent uses `rules_stdlib.list` and `rules_stdlib.get` with `service` set to `firestore`. Once our rules are assembled, `firestore_rules.lint` checks their syntax and Firebase limits. `firestore_rules.simulate` tests the actual boundary:

```text
ALLOW  create conversations/c1 as alice
DENY   create conversations/c1 as bob
Reason: request.auth.uid does not match ownerUid
```

Changing only the user makes this a useful test. We are not checking whether a request can succeed. We are checking who is allowed to make it.

## See each request, not just its error

Create `conversations/c1` as Alice, switch to Bob, and try to read it. Studio's Traffic view puts both decisions together:

```text
ALLOW  alice  create  conversations/c1
DENY   bob    get     conversations/c1
```

Open the denial to see the request data and Rules result. This is the answer I always wanted instead of a bare `permission-denied`.

A coding agent sees the same backend:

> Inspect the local backend. Show the loaded rules, document counts, and recent denied requests. Do not change anything.

```text
Firestore rules: loaded from firestore.modules.rules
Documents: conversations 1
Recent denial: bob tried to read conversations/c1
```

Studio is the visual view. `sandbox.inspect` is the agent's view. Neither reads production data.

## Generate indexes without breaking a query

The chat app lists Alice's conversations by their latest update:

```ts
query(
  collection(db, 'conversations'),
  where('ownerUid', '==', uid),
  orderBy('updatedAt', 'desc'),
  limit(100),
);
```

It also lists the messages in a conversation:

```ts
query(
  collection(db, 'conversations', conversationId, 'messages'),
  where('ownerUid', '==', uid),
  orderBy('createdAt', 'desc'),
  limit(100),
);
```

Firestore usually teaches you about a composite index by breaking the query. The application runs, the query fails, and the error gives you a link that fills out part of the Firebase Console. The alternative is to keep the query open in your editor while entering the same fields, directions, and scope by hand.

Neither is a good workflow. One requires a failure. The other requires describing the same query twice. I always wanted a query analyzer that could read the query and generate the index, so that is what Pyric has:

```bash
pyric firestore indexes generate src --out /tmp/pychat-indexes.json
```

For those two queries, it produces:

```json
{
  "indexes": [
    {
      "collectionGroup": "conversations",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "ownerUid", "order": "ASCENDING" },
        { "fieldPath": "updatedAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "messages",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "ownerUid", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

The equality filter supplies `ownerUid`. The sort supplies the date field and its direction. Pyric derives both indexes from the application code; Firebase still creates them in production.

## Answer AI Logic with a model on your machine

Firebase AI Logic is an amazing service. It gives a browser application a Firebase-shaped API for working with generative models. The chat app uses it without a Pyric-specific call:

```ts
const model = getGenerativeModel(ai, { model: 'gemini-2.5-flash' });
const result = await model.generateContentStream({ contents });
```

With no AI configuration, Pyric answers that call with a deterministic scripted response. This makes the first run and automated tests predictable without installing a model.

For development, I also wanted to keep the real model loop local. If Ollama is already running on my machine, the Firebase call should be able to use it. Start the app with both the server and model named:

```bash
PYRIC_AI_MODEL=qwen3:4b \
PYRIC_AI_PROXY_UPSTREAM=http://localhost:11434/v1 \
npm run dev
```

The **upstream** is the OpenAI-compatible server Pyric forwards to. The **model** is the model name sent to that server. Ollama's default upstream is already `http://localhost:11434/v1`, but writing both here makes the relationship visible.

The variables must prefix `npm run dev`. This does not pass them to Vite:

```bash
PYRIC_AI_MODEL=qwen3:4b PYRIC_AI_PROXY_UPSTREAM=http://localhost:11434/v1 && npm run dev
```

The `&&` ends the assignment command before Vite starts. For a persistent setup, put the same values in `.env.local` and restart Vite:

```dotenv
PYRIC_AI_MODEL=qwen3:4b
PYRIC_AI_PROXY_UPSTREAM=http://localhost:11434/v1
```

The Vite configuration stays `pyric()`. Pyric reads the environment, maps the Firebase model request to the selected local model, and proxies the browser request through Vite so Ollama needs no browser CORS configuration. The app still calls `firebase/ai`; only the destination changed.

## Check attachments with local Storage

A message can include a file. The application uploads it with the Firebase Storage SDK:

```ts
const path = `users/${uid}/conversations/${conversationId}/attachments/${attachmentId}/${file.name}`;
await uploadBytes(ref(storage, path), file, { contentType: file.type });
```

Pyric's Storage mirror stores the bytes locally and evaluates `storage.rules`. The chat rule does more than compare the path UID. It reads the conversation from Firestore and confirms that the uploader owns it:

```rules
allow write: if request.auth != null
  && request.auth.uid == uid
  && firestore.get(
    /databases/(default)/documents/conversations/$(conversationId)
  ).data.ownerUid == request.auth.uid
  && request.resource.size <= 10 * 1024 * 1024;
```

Upload as Alice, then try the same path as Bob. Studio shows the stored file for Alice and the denied request for Bob. The Storage mirror and Firestore mirror are not isolated toys; the Storage rule can consult the same local Firestore data.

## Write Realtime Database Rules with TypeScript

Presence uses Realtime Database because its live tree is a natural fit for who is online:

```ts
await set(ref(rtdb, `presence/${user.uid}`), {
  state: 'online',
  displayName: user.displayName,
  at: serverTimestamp(),
});
```

Open a second tab and watch Alice appear. The RTDB mirror sends the update through the same browser backend.

Realtime Database Rules are normally strings inside a JSON tree. They also cascade: a `.write` granted at one path grants every path below it, and a child cannot take that permission back. Pyric's constraints system lets us write the access rules and data schema in TypeScript before either becomes JSON.

Install Zod, then define the data once in `src/firebase/rtdb-schema.ts`:

```bash
npm install zod
```

```ts
import { z } from 'zod';

export const PresenceRecordSchema = z.object({
  state: z.enum(['online', 'offline']),
  displayName: z.union([z.string(), z.literal(null)]),
  at: z.number(),
});

export type PresenceRecord = z.infer<typeof PresenceRecordSchema>;

export const NotificationRequestSchema = z.object({
  title: z.string(),
  body: z.string(),
  conversationId: z.string(),
  createdAt: z.number(),
});

export type NotificationRequest = z.infer<typeof NotificationRequestSchema>;
```

`z.infer` creates the application types. Pyric compiles the same schemas into RTDB `.validate` rules, so the types and backend validation cannot quietly drift apart.

Use those schemas in `database.rules.ts`:

```ts
import {
  authenticated,
  defineRtdbRules,
  deny,
  pathOwnerOnly,
} from 'pyric/rules';
import {
  NotificationRequestSchema,
  PresenceRecordSchema,
} from './src/firebase/rtdb-schema';

export default defineRtdbRules({
  paths: {
    '/': { read: deny(), write: deny() },

    '/presence': { read: authenticated() },
    '/presence/$uid': {
      write: pathOwnerOnly('$uid'),
      schema: PresenceRecordSchema,
    },

    '/notify/$uid': {
      read: pathOwnerOnly('$uid'),
      write: pathOwnerOnly('$uid'),
      children: {
        '/$pushId': {
          schema: NotificationRequestSchema,
        },
      },
    },
  },
});
```

The root starts closed. `pathOwnerOnly('$uid')` combines authentication with the path check, so Alice can write `/presence/alice` but not `/presence/bob`. Under `/notify`, the owner grant cascades to each pushed notification while its schema checks every expected value.

Compile the constraints into the JSON that Pyric and Firebase load:

```bash
pyric database rules generate
pyric database rules lint database.rules.json
```

The TypeScript file is the source people edit. `database.rules.json` is the generated deployment artifact. The schema compiler currently supports objects composed from strings, numbers, booleans, enums, literals, unions, nested objects, and optional fields. Unsupported shapes fail generation instead of becoming weaker Rules.

Now test the four boundaries that matter:

```text
ALLOW  write /presence/alice as alice
DENY   write /presence/alice signed out
DENY   write /presence/alice as bob
DENY   write /presence/alice as alice with state: "nearby"
```

Use `database_rules.simulate` against the running sandbox for these checks. Pass the same constraints to `rtdbRules(...)` for in-process tests.

The current chat template still authors `database.rules.json` directly. Moving it to this constraints source is a follow-up; the rule behavior shown here is the target rather than a file the template already contains.

Pyric mirrors RTDB `onDisconnect` for deterministic lifecycle boundaries: explicit `goOffline`, app deletion, and the playground's `pagehide` cleanup. Queued writes are registered per client, execute once, and notify other clients. An unannounced total renderer or process loss is a documented boundary of the in-memory sandbox: browser `MessagePort` close delivery is not reliable enough to guarantee that case without a durable host-owned lease system.

## Run Cloud Functions against the browser backend

The notification path needs server code. When Alice comes online, an RTDB `onValueCreated` Cloud Function stamps her Firestore profile. There is an odd consequence to running that Function locally: server code needs to reach a backend living in the browser.

The chat app runs a Function when `/presence/{uid}` is created:

```js
export const onPresenceOnline = onValueCreated('/presence/{uid}', async (event) => {
  const profile = getFirestore().collection('users').doc(event.params.uid);
  const snapshot = await profile.get();
  const now = FieldValue.serverTimestamp();

  await profile.set(
    snapshot.data()?.firstSeenAt
      ? { lastSeenAt: now }
      : { firstSeenAt: now, lastSeenAt: now },
    { merge: true },
  );
});
```

During development, Pyric starts the supported RTDB `onValueCreated` Functions in a Node child process. It maps `firebase-admin/*` imports to Pyric's Admin SDK mirror and connects that process to the browser sandbox through a WebSocket bridge:

```text
Node Function
     │
     │ WebSocket bridge
     ▼
SharedWorker ── IndexedDB
     ▲
     │
browser tabs and Studio
```

Yes, the server connects to the browser. It sounds backward until you remember that the browser sandbox is the source of truth for this development session.

Create Alice's presence record. The Function reads her local Firestore profile through the Admin SDK mirror, writes `firstSeenAt`, and the open tabs receive that update. Admin writes bypass client Security Rules, matching the trusted role of a deployed Function.

Pyric currently runs RTDB `onValueCreated` triggers locally and reports other trigger types as unsupported. That boundary keeps a working local path from turning into a broader promise.

## Deliver a notification without production Messaging

Cloud Messaging has always been difficult to develop locally because its normal path keeps reaching into production. The browser needs a registration token. The backend needs credentials. Delivery leaves the machine and eventually finds its way back to the browser.

Pyric keeps that loop local. The app still uses the Firebase Messaging SDK:

```ts
const token = await getToken(getMessaging(firebaseApp), {
  serviceWorkerRegistration,
});

onMessage(getMessaging(firebaseApp), (message) => {
  showToast(message.notification?.title ?? 'New message');
});
```

Pyric creates a local token. The app saves it to Alice's Firestore profile. When the assistant reply is ready, it writes a notification request to `/notify/alice/{pushId}`. A local Function reads the token with the Admin SDK mirror and calls `getMessaging().send()`.

A **service worker** is a browser script that can receive a notification while the page is hidden. Pyric sends a message to `onMessage` while the page is visible and to the service worker's `onBackgroundMessage` handler while it is hidden. Test both paths: keep the chat visible for the first reply, then hide it before sending the second.

The Firebase-shaped path is intact—client token, backend send, foreground or background delivery—but the notification never passes through Firebase Cloud Messaging. Keep at least one app page open because closing every page ends the local backend. Production delivery after every page is closed remains Firebase behavior.

## See when the browser backend needs attention

A SharedWorker can outlive a Vite update. The runtime chip warns when new application code is connected to an older Pyric worker.

Collapsed, it shows two indicators:

- sandbox errors;
- an available worker update.

Open it to copy an error, update the worker, or launch Studio. Updating finishes accepted work, saves captured state, and reloads the connected tabs. The chip is development-only.

## Check the conversation before production

To save a reusable local backend, enable disk persistence in Vite:

```ts
pyric({ persist: true })
```

Once it contains useful users and conversations, promote that state to a fixture. Use the Vite port printed by `npm run dev`:

```bash
pyric snapshot --port 5173 --out fixtures/chat-ready.json
```

`pyric snapshot` saves the Firestore documents and Auth users. Passwords are redacted by default. Use that fixture as the starting state later:

```ts
pyric({ seed: 'fixtures/chat-ready.json' })
```

Seeds apply to an empty sandbox. Reset the existing sandbox in Studio before expecting the fixture to replace earlier browser state.

A snapshot preserves the starting point. A captured session preserves what the app did next.

Exercise the complete conversation:

1. Sign in as Alice.
2. Create a conversation and send a message.
3. Switch to Bob and confirm that the conversation read is denied.
4. Return to Alice and receive the AI reply.
5. Upload an attachment.
6. Write Alice's presence.
7. Let the Functions update her profile and send a notification.

Pyric records those Firestore and RTDB operations, their users, and their Rules results in `.pyric/last-session.json`. Replay that journey against the current Rules:

```bash
pyric verify --rules firestore=firestore.rules
```

A changed ownership rule might report:

```text
now-denied: create conversations/c1 as alice
```

`now-denied` means a request that worked in the capture is rejected now. `now-allowed` means a previous denial is now allowed. The snapshot gives the test its state; the session gives it the behavior to check.

For an important Firestore Rules change, compare the same cases with Firebase's Rules Test API:

```bash
pyric verify \
  --service firestore \
  --engine both \
  --project my-app \
  --rules firestore=firestore.rules
```

This comparison requires Firebase credentials, but it does not deploy Rules or change production data. Hosted comparison currently covers Firestore, not RTDB or Storage.

Pyric is not a complete implementation of Firebase. That is why these trust boundaries matter. The goal is to learn as much as possible locally, show what was actually tested, and make the remaining production step deliberate.

## Prepare for a Firebase Cloud Project

Prepare the generated Rules and indexes, then run the application's checks:

```bash
npm run rules:resolve
pyric database rules generate
pyric firestore indexes generate src --out firestore.indexes.json
npm test
npm run typecheck
```

Build with the normal production mode:

```bash
npm --prefix functions install
npm run build
```

The production build resolves `firebase/*` and `firebase-admin/*` to the real Firebase packages. Pyric Studio, the runtime chip, local users, local data, and the development mirrors are absent.

Pyric tests the supported behavior your application can observe. It does not reproduce a cloud project's IAM, quotas, latency, regional configuration, billing, or every Firebase API. Before deployment, use a separate Firebase project to check:

- real OAuth redirects and authorized domains;
- deployed Firestore, RTDB, and Storage Rules;
- composite index creation;
- Cloud Functions triggers and Admin SDK permissions;
- Cloud Messaging tokens and background delivery;
- the hosted AI model and its limits.

Be diligent here. Local confidence should make cloud testing smaller and more focused, not replace it. Deploy with the Firebase CLI when those checks pass:

```bash
npx firebase-tools deploy
```

We started with Firebase calls in a chat app and followed them into a local sandbox. That sandbox signed in users, synchronized data between tabs, evaluated modular Security Rules, served files, tracked presence, answered AI Logic through Ollama, connected to server code through the Admin SDK bridge, and delivered a local notification.

Along the way, we used the tools I wanted during 12 years of Firebase development: a Security Rules module system, a heavily tested Standard Library, an index analyzer, a backend we could inspect, and a way to check the complete journey before production.

The application stayed Firebase. Development stayed local. That is Pyric.

Continue with [How the swap works](./get-started/how-the-swap-works.md), [The Rules Standard Library](./secure/rules-standard-library.md), or [Ship to production](./ship/ship-to-production.md).
