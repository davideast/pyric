---
title: "How to run an existing Firebase application in the Firestore sandbox"
navLabel: "Use in existing code"
group: "pyric / firestore"
section: "How-to"
order: 12004
---
# How to run an existing Firebase application in the Firestore sandbox

Keep the application's Firebase imports unchanged. Add a Pyric activation seam
around the application instead of replacing imports with `pyric/firestore`.

## Node applications

Given existing code such as:
```ts
import { initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore } from 'firebase/firestore';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const snapshot = await getDoc(doc(db, 'notes/n1'));
```
run it through the register hook:
```bash
PYRIC_SANDBOX=local node --import @pyric/cli/register app.mjs
```
The hook resolves `firebase/app` and `firebase/firestore` to the sandbox
mirrors. Without the environment variable and preload, Node resolves the real
Firebase packages.

## Vite applications

Add the plugin to the development configuration:
```ts
import { defineConfig } from 'vite';
import { pyricSandbox } from '@pyric/cli/vite';

export default defineConfig({
  plugins: [pyricSandbox()],
});
```
The plugin swaps canonical Firebase specifiers for application code and its
dependencies. Production builds remain Firebase unless sandbox build swapping
is explicitly enabled.

## Sandbox controls

Rules, fixtures, and state inspection are intentionally separate from the
Firebase-shaped data plane:
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';

const sandbox = initializeSandbox();
setRules(sandbox, rulesSource);
seedDocuments(sandbox, {
  'notes/n1': { title: 'fixture' },
});
```
Use direct sandbox construction in tests that need these controls. Application
modules should continue using canonical Firebase imports.

## Unsupported imports

The mirror does not implement every Firebase Firestore export. In particular,
bundle loading, named queries, and persistent-cache index management remain
outside the sandbox surface. The compatibility matrix is the authoritative
list of supported and diverged behaviour.

Do not work around a missing export by importing the real Firebase module from
inside sandbox code. That would bypass the package boundary and make the test
capable of reaching production.

## Verify the migration

Run three checks:

1. An active Node or Vite smoke test completes a write and read through
   canonical Firebase imports.
2. The same Node import without activation remains real Firebase.
3. The built `pyric/firestore` artifact has no `firebase/firestore` import.

These checks prove both sides of the switch and guard against internal
production dispatch returning later.
