---
title: "Select the Storage runtime"
navLabel: "Switch backends"
group: "pyric / storage"
section: "How-to"
order: 14004
---
# Select the Storage runtime

Keep application imports canonical:
```ts
import { initializeApp } from 'firebase/app';
import { getStorage, ref, uploadBytes } from 'firebase/storage';

const app = initializeApp(firebaseConfig);
const storage = getStorage(app);
await uploadBytes(ref(storage, 'sessions/n1'), bytes);
```
The package resolver chooses the implementation before this code runs.

## Development uses the sandbox mirror

With `pyricSandbox()` or `pyric dev`, `firebase/storage` resolves to the Pyric
served entry. The Firebase config and optional bucket argument are accepted,
but the single-bucket sandbox stores bytes in IndexedDB and enforces the rules
loaded by the development runtime.

`getDownloadURL` returns a page-local `blob:` snapshot. Revoke it when done:
```ts
const url = await getDownloadURL(ref(storage, 'avatars/ada.png'));
image.src = url;
image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
```
## Production uses Firebase directly

A normal production build does not activate the Pyric swap. The same
`firebase/storage` import resolves to Firebase, so `getStorage(app)` reaches the
configured bucket and `getDownloadURL` returns Firebase's token-signed HTTPS
URL. `pyric/storage` is not loaded and does not delegate the call.
```text
firebase/storage import
├── Vite dev / pyric dev ──> Pyric sandbox mirror
└── production build ──────> Firebase Storage
```
## Direct Pyric imports are sandbox-only

Use `getStorageSandbox(target, options?)` when a test or tool explicitly owns a
`Sandbox` or `SandboxContext`:
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, uploadBytes } from 'pyric/storage';

const sandbox = initializeSandbox();
const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }));
await uploadBytes(ref(storage, 'sessions/n1'), bytes);
```
There is no Pyric production factory. Import `firebase/storage` for production.

## Where to look next

- Use the Vite plugin
- [Enforce Storage rules](../pyric-storage-how-to-enforce-rules/)
- [`StorageOptions`](../pyric-storage-reference-storage-options/)
- Run `pyric can-i-use storage/<symbol>` to check current support
