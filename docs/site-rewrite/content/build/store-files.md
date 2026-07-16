---
title: Run Cloud Storage locally
navLabel: Store files
outcome: Keep Cloud Storage application code unchanged while objects, metadata, and Security Rules stay local.
status: draft
---

# Run Cloud Storage locally

Keep using the Cloud Storage for Firebase Web API:

```ts
import { getStorage, ref, uploadBytes } from 'firebase/storage';

const storage = getStorage(app);
await uploadBytes(ref(storage, 'attachments/report.txt'), file);
```

During development, the object is written to the local sandbox. A production build runs the same call through Firebase. Use the [Cloud Storage Web documentation](https://firebase.google.com/docs/storage/web/start) for ordinary uploads, downloads, metadata, references, and listing behavior.

## What changes locally

Objects and metadata remain in the browser-local backend. Pyric Studio browses the same object tree used by the application. Local Storage Security Rules evaluate application requests without deploying rules or contacting a Firebase bucket.

The sandbox does not reproduce bucket provisioning, CORS configuration, transfer latency, quotas, billing, or every resumable and streaming behavior. Those remain production concerns.

## Check the supported boundary

Read the generated [Storage conformance matrix](../../../../packages/pyric/docs/storage/COMPAT.md) for the current public API surface, verified operations, documented differences, unsupported behavior, and unverified rows.

Continue with [Inspect and correct](../observe/see-whats-happening.md) or [enforce Storage rules](../../../../packages/pyric/docs/storage/how-to/enforce-rules.md).
