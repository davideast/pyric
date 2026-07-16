---
title: "How firebase/* imports resolve locally and in production"
navLabel: "How the swap works"
group: "Get started"
section: ""
order: 1002
description: "Understand how your firebase imports reached a local backend, and why production is untouched."
---

# How firebase/* imports resolve locally and in production

In activated development, your app's `firebase/*` imports resolve to a local backend with rules enforced, and no request leaves your machine. With that activation absent in production, the runtime resolves those imports to Firebase directly. Here is the whole mechanism, in three parts.

## Resolve imports to Pyric during development

Your source says `import { getFirestore } from 'firebase/firestore'`. In development, that specifier resolves to Pyric instead of the Firebase SDK. The swap happens in one of two layers:

| You run | Where the swap happens | Over what |
|---|---|---|
| `pyric dev` | at load time, through an import map on the served page | files that are already built |
| the Vite plugin | at module resolution, before bundling, inside your normal `vite dev` loop | your source and its transitive dependencies |

The Vite path reaches libraries too. A dependency that imports `firebase/firestore` on your behalf lands on the sandbox the same way your own code does.

Either way, the call sites are identical to production code. The Firebase config you pass to `initializeApp` is accepted and ignored in development, because there is no project to talk to.

For a Node child process, `pyric dev` sets `PYRIC_SANDBOX` and preloads
`@pyric/cli/register`. While activated, that resolver maps `firebase/*` to
`pyric/*` and `firebase-admin/*` to `pyric-admin/*`.

## One backend, shared across tabs

The sandbox runs in a SharedWorker, and three things follow:

- Every tab of your dev origin talks to the same backend, so a write in one tab shows up live in another.
- The data is held in IndexedDB and survives a refresh.
- If the browser has no SharedWorker, Pyric falls back to a per-tab sandbox automatically.

This is also why an agent and Studio see what you see. The MCP bridge and the Studio UI route into the same worker. One backend, and everything looks at it.

## Production keeps real Firebase

A plain `vite build` leaves the development swap inactive and ships the real `firebase` package, using the same config you passed to `initializeApp` all along. A Node production process does not set `PYRIC_SANDBOX`, so `@pyric/cli/register` is inert and normal resolution loads Firebase directly. Nothing in your app source changes.

- There is no graduation step and no environment flag in your source.
- A sandbox-flavored build carries a marker in `index.html`; production hosting deploys should use an unmarked production build so a sandbox-wired dist never reaches production by accident.
- The swap lives in the toolchain on purpose. Remove Pyric from the project and you have a stock Firebase app again.

## Where to go next

Watch the backend work, every read, write, and verdict, in [see what's happening](../see-whats-happening/). Or start building: [sign users in](../sign-in-and-manage-users/).
