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

When the bundler reaches `firebase/firestore`, it gets Pyric's mirror instead of the Firebase SDK. Your `addDoc` call lands in a local backend with your rules enforced. No request leaves your machine. Because resolution happens before bundling, the swap reaches your dependencies too. A library that imports `firebase/firestore` on your behalf lands on the sandbox exactly like your own code.

`pyric dev` does the same swap for a static page or a Node process: the served page carries an import map, so the browser makes the same substitution without Vite.

One detail that surprises people: `initializeApp(firebaseConfig)` still works. The config is accepted and ignored — there is no project to talk to.

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

For a Node child process, `pyric dev` sets `PYRIC_SANDBOX` and preloads `@pyric/cli/register`, which maps `firebase/*` to `pyric/*` and `firebase-admin/*` to `pyric-admin/*` for that process. Same rule as the browser: activation present, sandbox; activation absent, Firebase.

## Prove which one you're on

Don't take the page's word for it. In development, kill your network and run a write — it succeeds, because nothing left the machine. Open [Pyric Studio](../agent/watch-and-review.md) and the write is sitting in the local backend. A production build with the network killed fails the same call. The swap is observable, not declared.
