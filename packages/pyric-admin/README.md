# pyric-admin

Firebase Admin-shaped adapters that can run against either a Pyric sandbox or
real Firebase Admin SDK backends.

Use `pyric-admin` when you want server/admin ergonomics while keeping the same
backend-selection model as the client package.

> **Alpha.** This package is an early alpha. The admin-shaped subpaths are
> best-effort mirror contracts of `firebase-admin` — not guaranteed parity.
> Any exported surface beyond the mirrored shapes is experimental public-alpha
> and may change without notice.

## Subpaths

| Subpath | Surface |
|---|---|
| `pyric-admin/app` | Admin app initialization for sandbox or production |
| `pyric-admin/firestore` | Admin Firestore shape over sandbox or `firebase-admin/firestore` |
| `pyric-admin/auth` | Admin Auth shape over sandbox or `firebase-admin/auth` |
| `pyric-admin/database` | Admin Realtime Database shape over sandbox or `firebase-admin/database` |
| `pyric-admin/storage` | Admin Storage shape over sandbox or `firebase-admin/storage` |

## Example

```ts
import { initializeApp } from 'pyric-admin/app';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin/firestore';

const app = initializeApp({ sandbox: initializeSandbox() });
const db = getFirestore(app);

await db.collection('posts').doc('hello').set({ title: 'Hello' });
```

Production apps pass normal Firebase Admin credentials:

```ts
import { initializeApp, cert } from 'pyric-admin/app';

const app = initializeApp({
  credential: cert(serviceAccount),
});
```

## Docs

- [Firestore docs](docs/firestore/)
