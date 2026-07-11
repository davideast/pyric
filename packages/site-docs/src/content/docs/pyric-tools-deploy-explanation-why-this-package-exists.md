---
title: "Why this package exists"
group: "pyric-tools / deploy"
section: "Explanation"
order: 75
---
# Why this package exists

Firebase has a deploy CLI (`firebase`) and a TypeScript admin SDK (`firebase-admin`). Both are good at what they do. Neither does what `pyric-tools/deploy` does, which is:

- Deploy from a long-running TypeScript process (agent runtimes, deploy bots, IDE plugins, CI scripts) without spawning a CLI subprocess.
- Run the same code in Node and in a browser.
- Hand the deploy primitives to an LLM-driven agent as structured tools.
- Stay free of `firebase-admin` so callers don't pull a 50 MB transitive graph for what is, mechanically, a handful of HTTPS calls.

This page explains why those four requirements led to a separate package.

## The CLI doesn't compose

The `firebase` CLI is a one-shot tool: you invoke it from a shell, it reads a `firebase.json` config, it does its work, it exits. That model breaks down in two of our common use cases:

- **Agent runtimes.** A deploy agent needs to read intermediate outcomes, decide whether to proceed, and feed structured errors back to the LLM. Parsing CLI stdout is brittle (output format changes), slow (subprocess spawn per call), and lossy (rich `Outcome` shapes degraded to strings).
- **Browser hosts.** The CLI is Node-only. A browser-side agent or deploy UI can't shell out.

`pyric-tools/deploy` exposes primitives directly. Same call site in Node and the browser; same result shape; no subprocess.

## `firebase-admin` carries too much

`firebase-admin` is built around the assumption that you're writing a long-running Node service that uses every Firebase product: Auth, Firestore, Realtime Database, Cloud Messaging, Storage, plus the deploy admin surface. That's the right shape for a backend, but it's wrong for our consumer.

The actual mechanical surface of "deploy a function" or "deploy Hosting files" is small: a handful of REST calls against well-documented endpoints. `firebase-admin` wraps those calls behind classes, interceptors, and a dependency graph that doesn't tree-shake meaningfully.

We use plain `fetch` instead. The package has no Firebase dependencies, only `fflate` (for zip), the package's own helpers, and Node built-ins where unavoidable.

## Agent-shaped surfaces are a goal, not an afterthought

Every primitive takes `ProjectScope` as its first argument. Every operation that can fail returns either a thrown `AdminApiError` (primitives) or an `Outcome` with a coded error (orchestrators). The factory layer (`createFirestoreDeployTools`, etc.) wraps those primitives as `@inbrowser/agent` `ToolHandler`s without bridging code.

The result is that handing the deploy surface to an agent is two lines:
```ts
const registry = createToolRegistry();
for (const h of createFirestoreDeployTools({ scope })) registry.register(h);
```
You don't need a translation layer between "deploy primitives" and "tool handlers" because they were designed together.

## What ends up here

- Hosting deploy (file upload, version finalize, release).
- Hosting sites (create, ensure).
- Cloud Functions Gen 2 deploy (bundle, upload, create, wait, IAM grant).
- Firestore rules (fetch, deploy, inject, check, ensure).
- Firestore indexes (create, deployAll, getStatus).
- Firestore databases (provision).
- Token resolvers (`fromServiceAccount`, `memoizeTtl`).
- Outcome bucketing (`withResolvedScope`).
- Tool factories for all of the above.

## What stays out

- **Data plane** (read / write documents): handled by `pyric/firestore` and `pyric-admin`.
- **Rules tooling** (parse, lint, simulate): handled by `pyric/rules`.
- **Auth admin** (user management, custom claims): not yet implemented, will live here when it lands.
- **Realtime Database deploy**: deferred until a consumer asks.
- **Storage upload**: `pyric/storage` covers the storage data plane; the storage admin surface (CORS, bucket creation) will live here when needed.

The principle: anything that *mutates project configuration* belongs here; anything that *reads or writes data within an already-deployed project* belongs in a sibling package.
