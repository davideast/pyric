---
title: "Run Firebase Authentication locally"
navLabel: "Sign in and manage users"
group: "Develop with Firebase APIs"
section: ""
order: 2001
description: "Keep Firebase Authentication code unchanged while identities, sessions, and provider flows stay in the local sandbox."
---

# Run Firebase Authentication locally

Keep using the Firebase Authentication Web API:

```ts
import { getAuth, signInAnonymously } from 'firebase/auth';

const auth = getAuth(app);
await signInAnonymously(auth);
```

During development, this creates and signs into a local identity. A production build runs the same call through Firebase. Use the [Firebase Authentication documentation](https://firebase.google.com/docs/auth/web/start) for normal sign-in, account, provider, and observer APIs.

## What changes locally

The sandbox owns the user database and active sessions. No identity is created in a Firebase project. Auth state remains available to Firestore, Realtime Database, and Storage Security Rules through the same Firebase-shaped user and token fields used by the application.

Popup and redirect providers do not contact Google, GitHub, or another identity provider. Pyric presents a local identity picker so provider-dependent application paths can run without OAuth configuration or external accounts.

Pyric Studio shows the local users and current authentication state. It can create, edit, select, and remove test identities without adding those controls to application code.

## Seed identities for tests

Sandbox-only identity controls belong in test or setup code, never in the application path that ships:

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';

const sandbox = initializeSandbox();
const auth = getAuth(sandbox);

authSandbox.seedUsers(auth, [
  {
    uid: 'alice',
    email: 'alice@example.com',
    password: 'local-only',
    customClaims: { role: 'editor' },
  },
]);
```

Those claims reach `request.auth.token` when local Security Rules evaluate an operation.

## Check the supported boundary

Authentication is not a complete reimplementation of every Firebase Auth feature, and auth changes too quickly for a hand-maintained list to stay trustworthy. Ask the central conformance model before choosing a flow:

```bash
pyric can-i-use auth/signInWithEmailLink
pyric can-i-use auth/linkWithCredential
pyric can-i-use auth/sendPasswordResetEmail
```

Each result reports availability separately from behavioral fidelity and assurance, with caveats and a link to its evidence.

Continue with [Store and query data](../store-and-query-data/) or [inspect a local operation](../see-whats-happening/).
