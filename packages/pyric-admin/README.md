# `pyric-admin`

Firebase Admin-shaped adapters for a Pyric sandbox.

Use these subpaths when tests, development servers, or scripts need
`firebase-admin` ergonomics against local or browser-hosted sandbox state. In
activated development, `@pyric/cli/register` resolves canonical
`firebase-admin/*` imports here. With activation absent, production execution
loads `firebase-admin` directly.

> **Alpha.** These are best-effort mirror contracts of `firebase-admin`. Read
> the conformance matrices and service references for implemented behaviour and
> explicit gaps.

## Subpaths

| Subpath | Sandbox surface |
|---|---|
| `pyric-admin/app` | Admin app registry and sandbox binding |
| `pyric-admin/firestore` | Admin Firestore shape |
| `pyric-admin/auth` | Admin Auth shape |
| `pyric-admin/database` | Admin Realtime Database shape |
| `pyric-admin/storage` | Admin Storage shape |
| `pyric-admin/messaging` | Admin Cloud Messaging send plane |

## Explicit sandbox setup

```ts
import { initializeApp } from 'pyric-admin/app';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin/firestore';

const app = initializeApp({ sandbox: initializeSandbox() });
const db = getFirestore(app);

await db.collection('posts').doc('hello').set({ title: 'Hello' });
```

For unchanged server source, keep `firebase-admin/*` imports and run the
development command through `pyric dev`. Production runs the same source
without sandbox activation and therefore resolves Firebase Admin directly.

## Documentation

- [App registry and activation](docs/app/)
- [Firestore](docs/firestore/)
- [Auth API](https://pyric.dev/docs/pyric-admin-auth-reference-api/)
- [Realtime Database API](https://pyric.dev/docs/pyric-admin-database-reference-api/)
- [Storage API](https://pyric.dev/docs/pyric-admin-storage-reference-api/)
- [Messaging API](https://pyric.dev/docs/pyric-admin-messaging-reference-api/)
