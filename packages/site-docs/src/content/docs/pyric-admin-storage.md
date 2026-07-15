---
title: "pyric-admin/storage"
navLabel: "Overview"
group: "pyric-admin / storage"
section: ""
order: 22001
---
# `pyric-admin/storage`

Admin-shaped Cloud Storage for a sandbox. `getStorage(app)` reads the sandbox handle from `pyric-admin/app`:

- **Local sandbox app**: an in-memory object store with real multi-bucket isolation. Covers `save`, `download`, `delete`, `exists`, and a deterministic `getSignedUrl` stub.
- **Remote sandbox app**: operations relay over the worker channel to the browser-hosted sandbox's object store with the admin rules-bypass lens pinned. Single bucket, 8 MiB per-operation cap.

Storage support is experimental, on this surface and on `pyric/storage`. The object API works and is tested; most behavior is not yet pinned to a recorded production observation.

Deferred surfaces (streams, resumable uploads, IAM, ACLs, copy/move) throw a clear "not implemented" error, never bad data. Production code loads `firebase-admin/storage` directly with Pyric activation absent.

```ts
import { initializeApp } from 'pyric-admin/app';
import { getStorage } from 'pyric-admin/storage';
import { initializeSandbox } from 'pyric/sandbox';

const app = initializeApp({ sandbox: initializeSandbox() });
const storage = getStorage(app);

const file = storage.bucket().file('archives/session-1.json');
await file.save(JSON.stringify({ ok: true }), { contentType: 'application/json' });

const [exists] = await file.exists(); // [true]
const [bytes] = await file.download();
console.log(bytes.toString());
```

## Where to go next

- [API reference](../pyric-admin-storage-reference-api/) for the full `Bucket` and `File` surface, including the byte cap and deferred list.
