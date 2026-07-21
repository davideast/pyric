---
title: "Run Firebase locally"
navLabel: "Quickstart"
group: "Get started"
section: ""
order: 10
description: "Start a new Firebase application or add Pyric to an existing Vite application without connecting development to production."
---

# Run Firebase locally

Pyric adds a development-only resolution layer to a Firebase application. During Vite development, supported `firebase/*` imports resolve to a browser-local backend. A normal production build resolves those imports to Firebase again.

## Start a new application

Create a Vite application with canonical Firebase imports, Firestore rules, and the Pyric plugin already configured:
```bash
npm create pyric my-app
cd my-app
npm install
npm run dev
```

Open the local URL printed by Vite. The application and Pyric Studio use the same local backend. Studio is mounted at `/__pyric/ui/` on that origin.

Pyric also adds a small, collapsed runtime chip in the bottom-right corner. It stays quiet while the sandbox is healthy and signals when there is an error to inspect or a newer worker to activate. [Resolve runtime errors and stale workers](../observe/resolve-runtime-status.md) covers both actions.

## Add Pyric to an existing Vite application

Install the development plugin:
```bash
npm install --save-dev @pyric/cli
```
Add it to the Vite configuration:
```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';

export default defineConfig({
  plugins: [pyric()],
});
```
Start the normal development server:
```bash
npm run dev
```
No application imports change. Continue using `firebase/app`, `firebase/auth`, `firebase/firestore`, and the other supported Firebase entry points. The plugin uses an explicit `rules` option first, then discovers `firestore.modules.rules`, the path in `firebase.json`, or `firestore.rules`, in that order.

## Use a static application or Node process

`pyric dev` provides the same development-only package swap outside the Vite plugin:
```bash
npm install --save-dev @pyric/cli
npx pyric dev
```
It can serve static files or start an existing development command. The CLI guide covers those paths. [Test in Node](../ship/test-in-node.md) covers an in-process sandbox for tests and scripts.

## What remains local

The mirrored services do not connect to a production Firebase project. Local data changes stay in the sandbox. Local Security Rules changes are enforced there and are not deployed. Firebase configuration passed to `initializeApp(config)` is accepted so the application code stays unchanged, but it does not select a cloud backend during development.

Continue with [How the swap works](./how-the-swap-works.md), then [develop with the Firebase APIs](../build/authentication.md).
