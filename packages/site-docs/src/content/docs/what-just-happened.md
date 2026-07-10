---
title: "What just happened"
group: "Get started"
section: ""
order: 3
description: "Understand how your firebase imports reached a local backend, and why production is untouched."
---

# Where that backend came from

Your app called `getFirestore` and got a working database with rules enforced, and no request left your machine. Here is the whole mechanism, in three parts.

## Your imports resolve differently in dev

Your source says `import { getFirestore } from 'firebase/firestore'`. In development, that specifier resolves to Pyric instead of the Firebase SDK.

Under `pyric dev`, the served page carries an import map that points bare `firebase/*` specifiers at sandbox adapters. The swap happens at load time, over files that are already built.

Under the Vite plugin, the swap happens at module resolution, before bundling, inside your normal `vite dev` loop. It reaches transitive dependencies too. A library that imports `firebase/firestore` on your behalf lands on the sandbox the same way your own code does.

Either way, the call sites are identical to production code. The Firebase config you pass to `initializeApp` is accepted and ignored in dev, because there is no project to talk to.

## One backend, shared across tabs

The sandbox runs in a SharedWorker. Every tab of your dev origin talks to the same backend, so a write in one tab shows up live in another. The data is held in IndexedDB and survives a refresh. If the browser has no SharedWorker, Pyric falls back to a per-tab sandbox automatically.

This is also why an agent and Studio see what you see. The MCP bridge and the Studio UI route into the same worker. One backend, and everything looks at it.

## Production keeps real Firebase

A plain `vite build` ships the real `firebase` package, using the same config you passed to `initializeApp` all along. There is no graduation step and no environment flag in your source. And a sandbox-flavored build carries a marker that `pyric deploy hosting` refuses, so a dev artifact cannot reach production by accident.

Nothing in your app source changes. Not for dev, not for prod, not ever. The swap lives in the toolchain on purpose: remove Pyric from the project and you have a stock Firebase app again.

## Where to go next

Watch the backend work, every read, write, and verdict, in [see what's happening](../see-whats-happening/). Or start building: [sign users in](../sign-in-and-manage-users/).
