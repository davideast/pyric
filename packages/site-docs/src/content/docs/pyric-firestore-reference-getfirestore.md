---
title: "getFirestore"
group: "pyric / firestore"
section: "Reference"
order: 11011
---
# `getFirestore`

Constructs a Firestore handle owned by the Pyric sandbox mirror.

## Signatures
```ts
function getFirestore(context: SandboxContext): Firestore;
function getFirestore(sandbox: Sandbox): Firestore;
function getFirestore(app: PyricApp): Firestore;
```
`PyricApp` is the sandbox app returned when package resolution has swapped
canonical `firebase/app` imports to `pyric/app`.

## `SandboxContext`
```ts
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
```
The identity is frozen when the handle is constructed. Use this form for tests
that name the acting identity explicitly.

## `Sandbox`
```ts
const db = getFirestore(sandbox);
```
Each operation reads `sandbox.currentUser`. This form follows authentication
changes made through the matching `pyric/auth` sandbox.

## `PyricApp`
```ts
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const app = initializeApp({ projectId: 'demo' });
const db = getFirestore(app);
```
When a Pyric activation seam is active, both canonical imports resolve to the
sandbox packages and `app` owns a `Sandbox`. Without activation, both imports
remain Firebase and Firebase's own `getFirestore` runs instead.

## Invalid input

A direct `pyric/firestore` call rejects real Firebase apps and unrecognised
objects:
```text
TypeError: pyric/firestore is a sandbox-only mirror. Package resolution must
leave firebase/firestore unchanged for production ...
```
This error indicates that package selection happened at the wrong layer. Do
not add a production branch to the direct mirror; import `firebase/firestore`
without Pyric activation.

## Related functions

- `actingAs(sandbox, identity)` constructs a frozen-identity handle.
- `getAdminFirestore(sandbox)` constructs a rules-bypassing sandbox handle.
- `initializeFirestore(owner, settings)` delegates to `getFirestore`; cache and
  network settings are inert in the sandbox.
- `connectFirestoreEmulator(db, host, port, options)` is a no-op because the
  sandbox is already local.
