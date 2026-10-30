---
title: "How firebase/* imports resolve locally and in production"
navLabel: "How the swap works"
group: "Get started"
section: ""
order: 40
description: "Follow one import from your source to the local sandbox in development and to real Firebase in a production build."
---

# How firebase/* imports resolve locally and in production

Your app contains this line:

```ts
import { getFirestore, addDoc, collection } from 'firebase/firestore';
```

Where does that import actually go? The answer depends on who is resolving it — and that is the entire mechanism. Your source never changes; the resolver does.

## In development: the specifier resolves to Pyric

With the Vite plugin, the swap happens at module resolution, before bundling:

```ts
// vite.config.ts
import { pyric } from '@pyric/cli/vite';
export default { plugins: [pyric()] };
```

When the bundler reaches `firebase/firestore` in browser code, it gets Pyric's mirror instead of the Firebase SDK. Your `addDoc` call lands in a local backend with your rules enforced. No request leaves your machine. Because resolution happens before bundling, the swap reaches your dependencies too. A library that imports `firebase/firestore` on your behalf lands on the sandbox exactly like your own code.

### Server-rendered modules

Under `vite dev`, modules Vite loads for server rendering get the swap too: `server.ssrLoadModule`, an environment runner, and the SSR entry and loaders of a framework built on Vite. They get the same modules a Node process started with `node --import @pyric/cli/register` gets.

| In a server-rendered module | `pyric({ hosted: true })` | the default SharedWorker sandbox |
|---|---|---|
| `firebase/app`, `auth`, `database`, `firestore`, `storage` | reach the dev server's sandbox, signed in as the server's own user, under your rules | each call fails with `failed-precondition`, naming `hosted: true` |
| `firebase/ai`, `firebase/messaging` | each call fails with `failed-precondition` | the same |
| `firebase/app-check` | `initializeAppCheck` and token calls work in the server's process; tokens are minted locally with production's shape, except that a `CustomProvider` is called when no debug token is set | the same |
| `firebase/analytics`, `firestore/lite`, `functions`, `performance`, `remote-config` | imports resolve; each call fails with `PyricDeferredApiError` naming the subpath | the same |
| `firebase-admin/*` | reaches the dev server's sandbox as admin, past your rules | each call fails with `failed-precondition`, naming `hosted: true` |

Server code has one signed-in user for the whole dev server process, shared by every request, as a Node server that calls `initializeApp` has in production. Browser sessions are separate.

Vite's default externalization and `ssr.noExternal` both work. A server environment Vite does not run in its own Node process, such as a Cloudflare Workers runtime, gets a module that throws when it loads.

The dev server's network guard stays on for Firebase code the swap does not reach: other `firebase/*` subpaths, an installed package that imports `firebase` itself, and your Vite config's own imports. The dev server log names each refused host.

`pyric sandbox` does the same swap for a static page or a Node process. The served page carries an import map, so the browser makes the same substitution without Vite.

One detail that surprises people: `initializeApp(firebaseConfig)` still works, and no request reaches the project it names. The sandbox reads some options the way Firebase does. When no project is configured for the dev server, `projectId` names the default Realtime Database instance and selects the `.firebaserc` deploy targets that `firebase.json` names. `storageBucket` names the bucket that `getStorage(app)` and `storage.bucket()` use, which is the host's default bucket. Keep the config your production build uses, and give a Node process the same options as your pages.

## In production: nothing happens

A production build has no import map and no plugin activation, so `firebase/firestore` resolves the way it always did: to the Firebase SDK, talking to your real project. There is no Pyric code in the bundle to remove, because none was ever added — the swap lives in the resolver, not in your app.

That is the whole contract: same call sites, two resolvers.

## Where your writes actually live

In development the sandbox runs in a SharedWorker, which has three consequences you will notice:

- Every tab of your dev origin shares one backend — write in one tab, watch it appear in another.
- Data sits in IndexedDB and survives a refresh.
- No SharedWorker in your browser? Pyric falls back to a per-tab sandbox automatically.

This is also why Pyric Studio and an MCP-connected agent see exactly what your app sees: they route into the same worker.

A SharedWorker can outlive a Vite module update, so a refreshed page may otherwise reconnect to an older sandbox runtime. Pyric compares the running worker's build identity with the one the dev server is currently serving. When they differ, the runtime chip offers an update. Activating it lets the old worker finish accepted work and flush captured state before it tells every connected tab to reload onto the new generation. See [Resolve runtime errors and stale workers](../observe/resolve-runtime-status.md) for the recovery steps and configuration.

## Node processes

For a Node child process, `pyric sandbox` sets `PYRIC_SANDBOX` and preloads `@pyric/cli/register`, which maps `firebase/*` to `pyric/*` and `firebase-admin/*` to `pyric-admin/*` for that process. The rule is the same as the browser. With activation present, it uses the sandbox. Without activation, it uses Firebase.

Every `firebase-admin/*` subpath maps into `pyric-admin`, including the services the sandbox does not model, such as `firebase-admin/remote-config`, `firebase-admin/security-rules`, and `firebase-admin/installations`. Those subpaths resolve, their exports link, and `get<Service>(app)` (or `admin.<service>(app)`) returns an `App`-bound handle without network calls so servers that initialize unmodeled services at module load start cleanly. Calling a method on that handle (or using a non-service export directly) fails with `PyricDeferredApiError`, naming the symbol and subpath:

```text
pyric-admin/remote-config: RemoteConfig.getTemplate is not implemented in pyric-admin/remote-config sandbox backend. The sandbox does not model this API; calls fail with this message.
```

The sandbox never hands these imports to the real `firebase-admin`, so code under `pyric sandbox` does not reach a production service.

## Prove which one you're on

Don't take the page's word for it. In development, kill your network and run a write — it succeeds, because nothing left the machine. Open [Pyric Studio](../agent/watch-and-review.md) and the write is sitting in the local backend. A production build with the network killed fails the same call. The swap is observable, not declared.
