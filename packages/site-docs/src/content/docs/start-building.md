---
title: "Run Firebase locally"
navLabel: "Quickstart"
group: "Run locally"
section: ""
order: 1001
description: "Start a new Firebase application or add Pyric to an existing Vite application without connecting development to production."
---

# Run Firebase locally

Pyric adds a development-only resolution layer to a Firebase application. During Vite development, supported `firebase/*` imports resolve to a browser-local backend. A normal production build resolves those imports to Firebase again.

## Start a new application

Create a Vite application with canonical Firebase imports, Firestore rules, and the Pyric plugin already configured:

```bash
npx create-pyric my-app
cd my-app
npm install
npm run dev
```

`npm create pyric my-app` runs the same scaffold.

Open the local URL printed by Vite. The application and Pyric Studio use the same local backend. Studio is mounted at `/__pyric/ui/` on that origin.

## Add Pyric to an existing Vite application

Install the development plugin:

```bash
npm install --save-dev @pyric/cli
```

Add it to the Vite configuration:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { pyricSandbox } from '@pyric/cli/vite';

export default defineConfig({
  plugins: [pyricSandbox()],
});
```

Start the normal development server:

```bash
npm run dev
```

No application imports change. Continue using `firebase/app`, `firebase/auth`, `firebase/firestore`, and the other supported Firebase entry points. The plugin discovers Firestore rules from `firebase.json`, or uses `firestore.rules` when no path is configured.

## Use a static application or Node process

`pyric dev` provides the same development-only package swap outside the Vite plugin:

```bash
npm install --save-dev @pyric/cli
npx pyric dev
```

It can serve static files or start an existing development command. [The CLI guide](../pyric-cli/) covers those paths. [Test in Node](../test-in-node/) covers an in-process sandbox for tests and scripts.

## What remains local

The mirrored services do not connect to a production Firebase project. Local data changes stay in the sandbox. Local Security Rules changes are enforced there and are not deployed. Firebase configuration passed to `initializeApp(config)` is accepted so the application code stays unchanged, but it does not select a cloud backend during development.

Continue with [How the swap works](../how-the-swap-works/), then [develop with the Firebase APIs](../sign-in-and-manage-users/).
