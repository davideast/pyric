# `pyric-admin/app`

This subpath owns the sandbox admin app registry. `initializeApp` returns a
branded `PyricAdminApp`, and every other `pyric-admin/*` subpath uses that app's
sandbox.

Use an explicit sandbox in tests and scripts:

```ts
import { initializeApp } from 'pyric-admin/app';
import { initializeSandbox } from 'pyric/sandbox';

const app = initializeApp({ sandbox: initializeSandbox() });
```

Or use a bare `initializeApp()` in canonical server code running under `pyric
dev`. The activated `@pyric/cli/register` resolver supplies the remote sandbox
factory. Outside activated development, canonical `firebase-admin/app` imports
resolve directly to Firebase Admin; this package is not loaded.

The registry exports `getApp`, `getApps`, and `deleteApp`, with Firebase-shaped
names and lifecycle errors.

## Where to go next

- [`pyric-admin/app` API reference](https://pyric.dev/docs/pyric-admin-app-reference-api/)
- [Package resolution](../../../cli/docs/reference/package-and-resolution.md)
