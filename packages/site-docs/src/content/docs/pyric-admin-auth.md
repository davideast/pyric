---
title: "pyric-admin/auth"
navLabel: "Overview"
group: "pyric-admin / auth"
section: ""
order: 20001
---
# `pyric-admin/auth`

Admin-shape Auth with swappable backends. `getAuth(app)` mirrors `firebase-admin/auth` and dispatches on the app handle from `pyric-admin/app`:

- **Production app**: returns the genuine `firebase-admin/auth` `Auth` instance, full surface, unchanged.
- **Local sandbox app**: an in-memory user store keyed off the `Sandbox`. Implements the core user-management subset (`createUser`, `getUser`, `getUserByEmail`, `deleteUser`, `setCustomUserClaims`, `createCustomToken`, `verifyIdToken`).
- **Remote sandbox app**: user CRUD relays over the worker channel to the browser-hosted sandbox, so server-created users land in the one user pool the browser app, Studio, and agents share. Adds `updateUser` and `listUsers` on top of the local subset.

Everything the sandbox arms don't model throws an explicit "not implemented" error with the method name, never bad data.
```ts
import { initializeApp } from 'pyric-admin/app';
import { getAuth } from 'pyric-admin/auth';
import { initializeSandbox } from 'pyric/sandbox';

const app = initializeApp({ sandbox: initializeSandbox() });
const auth = getAuth(app);

const user = await auth.createUser({ uid: 'alice', email: 'a@example.com' });
const token = await auth.createCustomToken(user.uid, { role: 'admin' });
const decoded = await auth.verifyIdToken(token);
console.log(decoded.uid, decoded.role); // 'alice' 'admin'
```
One honest note up front: sandbox tokens are deterministic strings, not real JWTs. They round-trip through the same sandbox backend and nothing else. The [API reference](../pyric-admin-auth-reference-api/) documents the exact format.

## Where to go next

- [API reference](../pyric-admin-auth-reference-api/) for every method, per arm, including the full not-implemented list.
