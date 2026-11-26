# `pyric`

Firebase-shaped Web SDK mirrors backed by an in-process sandbox, plus Security
Rules tooling and explicit sandbox controls.

> **Alpha.** Mirrored subpaths are best-effort Firebase contracts. Read the
> generated conformance scores and service matrices for measured coverage,
> fidelity, and known gaps. Pyric-specific sandbox APIs are public alpha.

## Public service fronts

| Subpath | Surface |
|---|---|
| `pyric/app` | Firebase-shaped default and named app registry |
| `pyric/firestore` | Firestore modular mirror and data/inspection tools (plus `pyric/firestore/lite`) |
| `pyric/auth` | Auth modular mirror and sandbox auth helpers |
| `pyric/app-check` | App Check modular mirror with local token minting |
| `pyric/database` | Realtime Database modular mirror |
| `pyric/storage` | Storage modular mirror, `storage/sw`, and rules-aware sandbox tools |
| `pyric/messaging` | Cloud Messaging (FCM) modular mirror and `messaging/sw` |
| `pyric/ai` | Firebase AI Logic modular mirror (plus `pyric/ai/scripting` for deterministic responses) |
| `pyric/functions` | Callable Functions client mirror |
| `pyric/crashlytics` | Local Crashlytics telemetry broker (plus React, Next.js, React Router, and Angular adapters) |
| `pyric/rules` | Firestore, Storage, and RTDB rules lint, simulation, explanation, constraints, and standard library (also published standalone as `@pyric/rules`) |
| `pyric/sandbox` | Sandbox lifecycle, checkpoints, branches, identity, events, persistence, and replay |

Unmodeled Firebase Web subpaths (`pyric/analytics`, `pyric/performance`, `pyric/remote-config`) resolve cleanly and throw `PyricDeferredApiError` on call. The package manifest (`package.json`) is the authority for public exports, including service-specific sandbox controls and adapter-only internal seams.

## Explicit sandbox example

```ts
import { initializeApp } from 'pyric/app';
import { collection, getDocs, getFirestore } from 'pyric/firestore';

const app = initializeApp({ projectId: 'demo-project' });
const db = getFirestore(app);
const snap = await getDocs(collection(db, 'posts'));
```

Application code normally keeps canonical `firebase/*` imports.
`@pyric/cli/vite`, `pyric sandbox`, or `@pyric/cli/register` activates development
resolution to these mirrors. With activation absent, production loads Firebase
directly; `pyric` contains no production dispatch.

Pyric currently accepts one Firebase configuration per runtime. Default and
named apps with equal options are distinct service containers connected to the
same sandbox backend.

## Documentation

- [Cloud Firestore](../site-docs/src/content/build/cloud-firestore.md)
- [Authentication](../site-docs/src/content/build/authentication.md)
- [Realtime Database](../site-docs/src/content/build/realtime-database.md)
- [Cloud Storage](../site-docs/src/content/build/cloud-storage.md)
- [Cloud Messaging](../site-docs/src/content/build/cloud-messaging.md)
- [AI Logic](../site-docs/src/content/build/ai-logic.md)
- [Audit your rules](../site-docs/src/content/secure/audit-your-rules.md)
- [Node host and sandbox lifecycle](../site-docs/src/content/get-started/node-host.md)
- [Conformance scores](https://pyric.dev/docs/conformance-scores/)
