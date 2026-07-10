---
title: "pyric-admin/app"
navLabel: "Overview"
group: "pyric-admin / app"
section: ""
order: 163
---
# `pyric-admin/app`

The entry point where the sandbox-vs-production choice is made for the whole admin surface. `initializeApp` returns a branded `PyricAdminApp` handle, and every other `pyric-admin/*` subpath (`firestore`, `auth`, `database`, `storage`) reads that brand to pick its backend.

Three ways to initialize, one line of difference:
```ts
import { initializeApp } from 'pyric-admin/app';

// Production: delegates to firebase-admin/app
import { applicationDefault } from 'firebase-admin/app';
const prodApp = initializeApp({ credential: applicationDefault() });

// Sandbox: the one pyric-flavored line
import { initializeSandbox } from 'pyric/sandbox';
const sandboxApp = initializeApp({ sandbox: initializeSandbox() });

// Ambient: zero pyric identifiers, the environment decides
const app = initializeApp();
```
The ambient form is the adoption story. Server code with a bare `initializeApp()` runs against real Firebase by default, and against a sandbox when `PYRIC_SANDBOX` is set (for example under `pyric dev`). A guard refuses sandbox routing when `NODE_ENV` is `production`.

The registry (`getApp`, `getApps`, `deleteApp`) mirrors `firebase-admin/app`'s lifecycle, and lifecycle errors reuse firebase-admin's own `FirebaseAppError` class, so error identity matches production.

## Where to go next

- [API reference](../pyric-admin-app-reference-api/) covers every export, the ambient rules, and the error codes.
