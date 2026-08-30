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
| `pyric/firestore` | Firestore modular mirror and data/inspection tools |
| `pyric/auth` | Auth modular mirror and sandbox auth helpers |
| `pyric/database` | Realtime Database modular mirror |
| `pyric/storage` | Storage modular mirror and rules-aware sandbox tools |
| `pyric/rules` | Firestore and RTDB rules lint, simulation, explanation, constraints, and standard library |
| `pyric/sandbox` | Sandbox lifecycle, identity, events, persistence, and replay |

The package manifest is the authority for public exports, including the
service-specific sandbox controls and adapter-only internal seams.

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

- [Firestore](docs/firestore/)
- [Auth](docs/auth/)
- [Realtime Database](docs/database/)
- [Storage](docs/storage/)
- [Rules](docs/rules/)
- [Sandbox](docs/sandbox/)
- [Conformance scores](https://pyric.dev/docs/conformance-scores/)
