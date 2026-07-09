# Server adoption — run your firebase-admin app on the pyric sandbox

You have an existing Node server that uses `firebase-admin` — Realtime
Database, Auth, Storage. By the end of this tutorial it runs against the
**pyric in-browser sandbox** with **zero code changes**: no pyric imports,
no config edits, no emulator suite, no Firebase project.

Takes about five minutes.

## Prerequisites

- **Node ≥ 22.15** for full coverage. ESM-only apps work on earlier 22.x,
  but rewriting CJS `require('firebase-admin')` needs 22.15's sync module
  hooks (older Nodes print a warning and skip CJS — see
  [Troubleshooting](#troubleshooting)).
- A server using `firebase-admin` (RTDB / Auth / Storage). A
  `firebase.json` is optional — without one, `pyric dev` warns and serves
  the current directory.

## Step 1 — Install

```bash
npm i -D pyric-tools pyric-admin pyric
```

Three packages, one job each: `pyric-tools` is the CLI + Node loader,
`pyric-admin` and `pyric` are the mirror packages your unchanged
`firebase-admin/*` and `firebase/*` imports resolve to at dev time. None
of them appear in your app code.

## Step 2 — Run it

```bash
npx pyric dev
```

`pyric dev` starts the sandbox host and then runs **your own `dev`
script** with the environment activated (or run an explicit command:
`npx pyric dev -- node server.mjs`). Whenever it runs your server,
`pyric dev` also mounts the WebSocket relay the server's Firebase
calls travel through — no extra flag needed.

Your server needs nothing pyric-shaped. This works as-is:

```js
// server.mjs — zero pyric identifiers
import { createServer } from 'node:http';
import { initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';

initializeApp();
const db = getDatabase();
const auth = getAuth();
const bucket = getStorage().bucket();

createServer(async (req, res) => {
  if (req.url === '/signup') {
    const user = await auth.createUser({ email: `u${Date.now()}@example.com`, password: 'hunter22' });
    await db.ref(`profiles/${user.uid}`).set({ plan: 'free' });
    await bucket.file(`avatars/${user.uid}.txt`).save('placeholder avatar');
    res.end(JSON.stringify({ uid: user.uid }));
    return;
  }
  res.end('ok');
}).listen(8080, () => console.log('api listening on http://localhost:8080'));
```

The terminal shows the host banner, then your dev command's output
prefixed with `[dev]`:

```
=== Serving from '/Users/you/code/your-app'...

✔ hosting  Serving files from: public
✔ hosting  Local server: http://localhost:3473
✔ sandbox  pyric SDK bundles ready (cache)
• rules    no firestore.rules — sandbox runs with default rules
• rules    no database.rules — RTDB sandbox runs with default rules
✔ bridge   MCP endpoint: http://localhost:3473/__pyric/mcp (sandbox peers over ws at /__pyric/sandbox)
✔ capture  session → /Users/you/code/your-app/.pyric/last-session.json (run `pyric verify` to replay it)

  ⚠ the pyric sandbox runs IN the served page — keep the browser tab open.
    Firestore/auth data and persistence stop when no page is open.
✔ run      `npm run dev` — firebase-admin/firebase imports are routed to the sandbox at http://localhost:3473
[dev] pyric-tools/register: active — firebase-admin/firebase imports now resolve to the pyric sandbox (PYRIC_SANDBOX=remote:http://localhost:3473).
[dev]
[dev] > dev
[dev] > node server.mjs
[dev]
[dev] pyric-tools/register: active — firebase-admin/firebase imports now resolve to the pyric sandbox (PYRIC_SANDBOX=remote:http://localhost:3473).
[dev] pyric: firebase-admin routed to sandbox at http://localhost:3473
[dev] api listening on http://localhost:8080
```

(The `register: active` line appears once per Node process — `npm run
dev` is itself a Node process, so seeing it twice is normal.)

A browser tab on <http://localhost:3473> auto-opens — **it is the
backend**, so keep it open. Now:

```bash
curl http://localhost:8080/signup
# {"uid":"user-1"}
```

That user, the RTDB profile, and the stored avatar all landed in the
sandbox your browser tab hosts. Run with `--ui` instead and Pyric Studio
(`http://localhost:3473/__pyric/ui/`) shows the data live as your server
writes it (`--ui` implies `--bridge`).

## How it works

Three small pieces, no magic:

1. **Activator** — `pyric dev` runs your dev command with
   `PYRIC_SANDBOX=remote:<serve url>` set and
   `--import pyric-tools/register` appended to `NODE_OPTIONS`.
2. **Loader** — `pyric-tools/register` rewrites module resolution:
   `firebase-admin/*` → `pyric-admin/*` and `firebase/*` → `pyric/*`,
   every subpath 1:1. Without `PYRIC_SANDBOX` it is completely inert, and
   `pyric-admin`'s bare `initializeApp()` delegates straight to the real
   `firebase-admin` — same code, prod behavior.
3. **Bridge** — each Firebase call becomes an op relayed over a local
   WebSocket to `pyric dev`, then into the browser tab, where the sandbox
   runs in a SharedWorker. Your server, the page's `firebase/*` code,
   Studio, and any MCP agent all operate on the **same** backend.

Because the backend lives in the browser, the tab must stay open. Close
every tab and server calls fail fast with guidance (never a silent no-op).

## What works remotely today

| Service | Works | Not yet (throws a clear error) |
|---|---|---|
| **Realtime Database** | `ref().get/set/update/remove/push`, `once('value')`, `on('value')` live listeners; `update()` is a real multi-path update; `push().key` is sync | other event types (`child_added`, …), queries (`orderBy*`, `limitTo*`, …), `transaction`, `onDisconnect`, priorities |
| **Auth (admin)** | `createUser`, `updateUser` (displayName / email / password / disabled / emailVerified), `deleteUser`, `listUsers`, `getUser` / `getUserByEmail`, `setCustomUserClaims`, `createCustomToken` / `verifyIdToken` | `getUserByPhoneNumber`, bulk ops (`getUsers`, `deleteUsers`, `importUsers`), session cookies, action links, provider configs, `revokeRefreshTokens` |
| **Storage** | `file().save/download/delete/exists` up to **8 MiB per object**, `getSignedUrl` (local stub), single default bucket | streams (`createReadStream`/`createWriteStream`), resumable uploads, named buckets, copy/move, ACL/IAM |
| **Firestore (admin)** | — | everything (coming; see below) |

Behavior notes you will actually hit — each error below is quoted from a
real run:

- **Firestore admin isn't relayed yet.** `getFirestore()` on the sandbox
  throws: `pyric-admin/firestore: Firestore is not yet supported on a
  remote sandbox — the bridge currently carries Realtime Database and
  Auth. Use pyric/firestore in the browser (or the MCP Firestore tools)
  until remote Firestore lands.` Your browser code's `firebase/firestore`
  is fully supported — only the server-side admin arm is pending.
- **Storage is single-bucket.** `bucket('other')` throws:
  `pyric-admin/storage: the remote (browser) sandbox has a single bucket —
  bucket('other') cannot be isolated. Use bucket() (the default
  'pyric-default' bucket) instead.`
- **8 MiB per-op cap, no streams.** An oversized `save()` throws
  `…is 9437184 bytes — over the 8 MiB remote storage op cap. Streaming/
  resumable transfers are not supported on the sandbox backend; split the
  object or keep it under the cap.` `createReadStream`/`createWriteStream`
  throw with the same remedy (`use file.download() (≤ 8 MiB) instead`).
- **`getSignedUrl` is a deterministic local stub** — it returns
  `pyric-sandbox-storage://pyric-default/<path>?expires=…&action=…` and
  the sandbox does **not** serve that URL. It exists so code that
  round-trips signed URLs (logs, fixtures) sees a stable shape.
- **Tokens are sandbox-local.** `createCustomToken` mints a deterministic
  sandbox token and `verifyIdToken` only accepts tokens minted by a pyric
  sandbox — not real Firebase JWTs.
- **`getUser`/`getUserByEmail` go through `listUsers`** plus a client-side
  filter — fine at sandbox scale, worth knowing if you list thousands of
  users in a loop.
- **Missing downloads match prod's message shape:** `No such object:
  pyric-default/missing.bin`, so `catch` blocks that string-match keep
  working. `file.delete()` on a missing object is a no-op.

Everything unsupported **throws a remediating error** naming what to do
instead — nothing silently no-ops.

## Escape hatches

**Your own process manager** (foreman, turborepo, docker-compose, a
second terminal): skip the child runner and set the two env vars
yourself, with `pyric dev --bridge --no-run` (or any `pyric dev --bridge`)
running elsewhere:

```bash
PYRIC_SANDBOX=remote \
NODE_OPTIONS="--import pyric-tools/register" \
node server.mjs
```

`PYRIC_SANDBOX=remote` auto-discovers the running dev server via
`.pyric/serve.json` in your project (written when `--bridge` is on);
`PYRIC_SANDBOX=remote:http://localhost:3473` pins the URL explicitly.
With no dev server running you get: ``no running `pyric dev --bridge`
found (looked for .pyric/serve.json in <cwd> and the default ports) —
start your dev server with the bridge enabled and retry.``

**Explicit wiring for tests** — when you want pyric identifiers on
purpose instead of env-var routing:

```ts
import { connectRemoteSandbox } from 'pyric-tools/remote';
import { initializeApp } from 'pyric-admin/app';
import { getDatabase } from 'pyric-admin/database';

const sandbox = await connectRemoteSandbox(); // fails fast if no serve/tab
const app = initializeApp({ sandbox });
const db = getDatabase(app);
// ...assertions...
sandbox.close();
```

An explicit config always bypasses the environment, so pyric-aware test
code keeps full control even under `pyric dev`.

**Production guard.** Under `NODE_ENV=production` both the loader and
`pyric-admin` refuse to route to a sandbox — the loader prints
`pyric-tools/register: refusing to activate under NODE_ENV=production —
firebase-admin/firebase imports are NOT rewritten.` and your app talks to
real Firebase. Set `PYRIC_SANDBOX_FORCE=1` to override (dev/CI only).

## Troubleshooting

- **`no browser tab is connected to the sandbox — open http://localhost:3473
  in a browser and retry.`** — the backend is browser-resident. Open the
  printed URL (auto-open is suppressed under `--json`, `--no-open`, no
  TTY, and CI). The failure isn't latched: the next call retries. A
  server that fires Firebase calls at boot can race the tab load — the
  first request after the tab is open succeeds.
- **`Unknown method: … — the running sandbox may predate this feature;
  restart pyric dev and reload the browser tab.`** — a SharedWorker
  survives serve restarts and can't hot-update. Restart `pyric dev`,
  then close/reload every tab of the app so the new worker loads.
- **Always use the printed URL.** `http://localhost:3473` and
  `http://127.0.0.1:3473` are *different browser origins* with separate
  SharedWorkers — opening the wrong one splits your backend in two.
- **Where's my data?** Ephemeral by default: it lives in the browser
  worker, survives tab reloads, and stops being served the moment no page
  is open. `pyric dev --persist` additionally writes a committable
  `.pyric/state/state.json` (Firestore docs + auth users) restored on the
  next run — see the [CLI reference](../reference/cli.md#pyric-dev).
- **`this Node version lacks module.registerHooks (needs >= 22.15)`** —
  on older Nodes ESM imports are still rewritten but CJS
  `require('firebase-admin')` is not, so a CJS app half-connects. Upgrade
  Node to ≥ 22.15.

## Where next

- **Every `pyric dev` flag** (`--persist`, `--seed`, `--ui`, `--json`, …):
  the [CLI reference](../reference/cli.md).
- **New app instead of an existing one:**
  [getting started](./getting-started.md).
- **Let an agent drive the same sandbox** over MCP:
  [wire-claude-code.md](./wire-claude-code.md).
