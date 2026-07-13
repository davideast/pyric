# pyric

Firebase-shaped client SDK adapters with a swappable in-process sandbox
backend, plus Pyric's rules tooling and sandbox runtime.

> **Alpha.** This package is an early alpha. The Firebase-mirrored subpaths
> (`pyric/app`, `pyric/firestore`, `pyric/auth`, `pyric/database`,
> `pyric/storage`) are best-effort mirror contracts of the modular Web SDK —
> not guaranteed parity. Non-mirrored exports (e.g. `pyric/sandbox/internal`,
> the rules tooling subpaths) are experimental public-alpha surfaces that may
> change without notice.

`pyric` mirrors Firebase's modular Web SDK subpaths:

| Subpath | Surface |
|---|---|
| `pyric/app` | `initializeApp`, `PyricApp`, sandbox/prod app tags |
| `pyric/firestore` | Firestore modular SDK mirror plus data/inspect tool factories |
| `pyric/auth` | Auth modular SDK mirror plus sandbox auth helpers |
| `pyric/database` | Realtime Database modular SDK mirror plus admin tools |
| `pyric/storage` | Storage modular SDK mirror plus storage admin tools |
| `pyric/rules` | Firestore rules parser, linter, validator, simulator, stdlib tooling |
| `pyric/rules/node` | Node-only rules module resolution helpers |
| `pyric/rules/rtdb` | Realtime Database rules facade: mapper, parser/linter, simulator, deploy/read rule tool factory |
| `pyric/rules/rtdb-constraints` | Realtime Database rules constraint helpers |
| `pyric/sandbox` | In-process Firebase sandbox runtime |
| `pyric/sandbox/database` | Owner controls for local RTDB rules, seed data, and state snapshots |
| `pyric/sandbox/internal` | Adapter-only internal protocol surface |
| `pyric/sandbox/admin-compat` | Chainable admin-compat Firestore wrapper over the sandbox |

## Example

```ts
import { initializeApp } from 'pyric/app';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, collection, getDocs } from 'pyric/firestore';

const app = initializeApp({ sandbox: initializeSandbox() });
const db = getFirestore(app);

const snap = await getDocs(collection(db, 'posts'));
```

To target production Firebase instead, pass normal Firebase app options to
`initializeApp`. Downstream Firestore/Auth/Database/Storage calls keep the same
shape.

## Docs

- [Firestore](docs/firestore/)
- [Auth](docs/auth/)
- [Realtime Database](docs/database/)
- [Storage](docs/storage/)
- [Rules](docs/rules/)
- [Sandbox](docs/sandbox/)
