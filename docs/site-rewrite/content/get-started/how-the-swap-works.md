---
title: How the swap works
navLabel: How the swap works
outcome: Understand how your firebase imports reached a local backend, and why production is untouched.
status: draft
---

# How the swap works

In development, your app's `firebase/*` imports resolve to a local backend with rules enforced, and no request leaves your machine. In production they resolve to Firebase, unchanged. Here's how, in three parts.

## Imports resolve differently in dev

Install `pyric-tools`, globally for the CLI or as a dev dependency for the Vite plugin, and `pyric` comes along as a real dependency. Its package.json exports one subpath per Firebase service, `pyric/firestore`, `pyric/auth`, `pyric/database`, `pyric/storage`, mirroring `firebase/firestore` and its siblings.

Your source still says `import { getFirestore } from 'firebase/firestore'`. In dev, that resolves to one of those files instead of the real SDK. It happens in one of two layers:

| You run | Where the swap happens | Over what |
|---|---|---|
| `pyric dev` | at load time, through an import map on the served page | files that are already built |
| the Vite plugin | at module resolution, before bundling, inside your normal `vite dev` loop | your source and its transitive dependencies |

The Vite path reaches libraries too: a dependency that imports `firebase/firestore` on your behalf lands on the sandbox the same way your own code does. Either way, the Firebase config passed to `initializeApp` is accepted and ignored: there's no project to talk to.

## One backend, shared across tabs

The sandbox runs in a SharedWorker, and three things follow:

- Every tab of your dev origin talks to the same backend: a write in one tab shows up live in another.
- The data is held in IndexedDB and survives a refresh.
- If the browser has no SharedWorker, Pyric falls back to a per-tab sandbox automatically.

An agent and Studio see what you see too: both route into that worker.

## Production keeps real Firebase

A plain `vite build` ships the npm `firebase` package, so `firebase/firestore` resolves to the real SDK, the same config you passed to `initializeApp` all along. Nothing in your source changes, not for dev, not for prod.

- No graduation step, no environment flag in your source.
- A sandbox-flavored build carries a marker `pyric deploy hosting` refuses, so it can't reach production.
- The swap lives in the toolchain on purpose: remove Pyric and you have a stock Firebase app again.

## Where to go next

Watch the backend work, every read, write, and verdict, in [see what's happening](../observe/see-whats-happening.md). Or start building: [sign users in](../build/sign-in-and-manage-users.md).
