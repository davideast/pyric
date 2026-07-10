---
title: How the swap works
navLabel: What just happened
outcome: Understand how your firebase imports reached a local backend, and why production is untouched.
status: draft
---

# Where that backend came from

Your app called `getFirestore` and got a working database with rules enforced, and no request left your machine. Here is the whole mechanism, in three parts.

## Your imports resolve differently in dev

Your source says `import { getFirestore } from 'firebase/firestore'`. In development, that specifier resolves to Pyric instead of the Firebase SDK. The swap happens in one of two layers:

| You run | Where the swap happens | Over what |
|---|---|---|
| `pyric dev` | at load time, through an import map on the served page | files that are already built |
| the Vite plugin | at module resolution, before bundling, inside your normal `vite dev` loop | your source and its transitive dependencies |

The Vite path reaches libraries too. A dependency that imports `firebase/firestore` on your behalf lands on the sandbox the same way your own code does.

Either way, the call sites are identical to production code. The Firebase config you pass to `initializeApp` is accepted and ignored in dev, because there is no project to talk to.

## One backend, shared across tabs

The sandbox runs in a SharedWorker, and three things follow:

- Every tab of your dev origin talks to the same backend, so a write in one tab shows up live in another.
- The data is held in IndexedDB and survives a refresh.
- If the browser has no SharedWorker, Pyric falls back to a per-tab sandbox automatically.

This is also why an agent and Studio see what you see. The MCP bridge and the Studio UI route into the same worker. One backend, and everything looks at it.

## Production keeps real Firebase

A plain `vite build` ships the real `firebase` package, using the same config you passed to `initializeApp` all along. Nothing in your app source changes. Not for dev, not for prod, not ever.

- There is no graduation step and no environment flag in your source.
- A sandbox-flavored build carries a marker that `pyric deploy hosting` refuses, so a dev artifact cannot reach production by accident.
- The swap lives in the toolchain on purpose. Remove Pyric from the project and you have a stock Firebase app again.

## Where to go next

Watch the backend work, every read, write, and verdict, in [see what's happening](../observe/see-whats-happening.md). Or start building: [sign users in](../build/sign-in-and-manage-users.md).
