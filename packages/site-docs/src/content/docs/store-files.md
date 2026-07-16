---
title: "Run Cloud Storage locally"
navLabel: "Store files"
group: "Develop with Firebase APIs"
section: ""
order: 2004
description: "Keep Cloud Storage application code unchanged while objects, metadata, and Security Rules stay local."
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

Storage support changes as the mirror grows, so this guide does not duplicate an availability list. Ask the central conformance model instead:

```bash
pyric can-i-use storage/getDownloadURL
pyric can-i-use storage/uploadBytesResumable
pyric can-i-use storage/list
```

The answer separates availability from fidelity and assurance, and points to the evidence behind the result.

Continue with [Inspect and correct](../see-whats-happening/) or [enforce Storage rules](../pyric-storage-how-to-enforce-rules/).
