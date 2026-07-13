<p align="center">
  <img src="https://pyric.dev/pyric-logo.svg" alt="Pyric" width="180" />
</p>

<h1 align="center">Firebase that runs in the browser</h1>

<p align="center">Agentic coding without production consequences</p>

<p align="center"><a href="https://pyric.dev">pyric.dev</a></p>

<p align="center">Conformance-tested against Firebase 12.13.0 — see the <a href="https://pyric.dev/docs/pyric-explanation-versioning-and-compatibility/">versioning and compatibility policy</a> and the <a href="#what-matches-firebase-and-what-doesnt">published coverage</a>.</p>

<br />

Pyric is Firestore, Auth, Realtime Database, Storage, *Messaging soon*, and the Security Rules engine, implemented in TypeScript and running inside the application process. In the browser, that process is the page itself: the whole backend executes in the tab. In Node, it is the Node process, so tests and scripts get the same backend with no browser involved.

## Built for dev, disappears in prod
This is not the Firebase Emulator Suite behind a wrapper. There is no Java process, no localhost port, and no cloud Firebase project connected.

Application code keeps using `firebase/*` imports which are mapped to the sandbox during development. When you ship to production, the map goes away, and the app talks to production services.

Pyric's tooling maps one-to-one to standard Firebase tools.

```bash
npm i pyric       === npm i firebase
npm i pyric-admin === npm i firebase-admin
npm i pyric-tools === npm i firebase-tools
```

The pyric CLI (`@pyric/cli`, often installed as `pyric-tools`) manages the local pyric environment — sandbox serve, verify, MCP bridge — and is not a substitute for `firebase-tools`. Ship rules, indexes, hosting, and functions with the Firebase CLI or Console.

### Backed by conformance
The services are an independent implementation of Firebase's observable behavior, and that claim is tested rather than assumed: probes run against production Firebase, their recorded behavior is committed as observations, and CI replays every observation against the sandbox on every change. The section [What matches Firebase and what doesn't](#what-matches-firebase-and-what-doesnt) has the numbers.

Because the services live in the process, the backend becomes local state. Data, identities, security rules, and time-ordered events can be seeded, snapshotted, reset, and replayed the way source code is edited.

## Where a coding agent runs Firebase code
Agents already know the Firebase SDK. They don't need a new API to learn, they need somewhere to run the code they already write. Pyric is that target: the same `firebase/*` calls, executed against a local sandbox instead of production. On the map of an agent's tools it doesn't sit beside Firebase as an alternative, it sits under the code the agent already generates, as the thing that code runs against during development. Because the sandbox is fully local, there is no Firebase project and no account in the loop.

Traditionally, Firebase development begins with an account, a project, enabled services, the Emulator Suite and its Java dependency, and hand-wired switching between emulator and production in the SDK. An agent working in that environment touches real infrastructure, so writes, deploys, and rules changes need supervision.

A backend that runs inside the app removes the infrastructure from the loop. A developer gets a full Firebase stack in the first ten seconds of a project. An agent gets the whole backend as an inspectable, resettable tool surface it can exercise without supervision.

## Getting Started

Install the CLI in an existing Firebase app or a new one:

```bash
npm i -g pyric-tools            # installs the `pyric` command
pyric init --template web       # scaffold, or skip this in an existing app
npm install                     # install the scaffolded app's deps
pyric dev
```

`pyric dev` serves the app against the in-process sandbox. The app's own `firebase/*` imports resolve to the sandbox during development; nothing in the application source changes. The sandbox holds data, identities, and rules, and everything it does is observable through the mechanisms below.

## Security rules as a library

Pyric includes a rules engine for Firestore and Realtime Database rules: parser, linter, validator, and simulator, usable in-process and from the CLI.

```bash
pyric rules:lint firestore.rules
pyric rules:simulate --stdin
pyric database:rules:validate database.rules.json
```

Rules edits take effect in the running app without a deploy. Realtime Database `.validate` rules are evaluated on writes, matching production behavior.

## Everything the sandbox does is an event

The sandbox emits a typed event for every operation it performs: reads, writes, auth transitions, and rules verdicts, including denials with the rule, path, and data that produced them. The diagnostics are consumers of that stream:

- Traffic inspection: what the app actually did, live, in the `pyric dev --ui` console or through the `@pyric/ui` traffic and events components.
- Denial inspection: a rejected operation carries its verdict instead of a bare `permission-denied` error.
- Capture and replay: `pyric snapshot` records state, and captured sessions replay through the same event stream, which is what `pyric verify` is built on.

## Browser Sandbox connected to local MCP

Pyric provides a local MCP server whose tool surface mirrors the sandbox (the default bridge registers on the order of three dozen tools; consolidation is ongoing). Pyric connects the browser sandbox to the server over a web socket bridge (the included [Claude Code plugin](pyric-plugin/README.md) auto-wires this) or you import factories into any agent framework. The inventory is in [docs/agent-tools.md](docs/agent-tools.md). Tools unique to this environment include:

- `firestore_simulate_rules` and `rtdb_simulate_access` evaluate a rules verdict for a hypothetical operation without performing it.
- `firestore_simulator_*` runs a stateful Firestore session with seed, execute, batch, transaction, undo, redo, and an inspectable event log.
- `sandbox_inspect` and `rtdb_crawl_structure` map what exists in the sandbox and how it is shaped.
- `firestore_extract_indexes` (library / CLI generate path) derives composite-index definitions from the query shapes in source.

## Work that carries to production

A sandbox session produces the artifacts a production deploy needs. Rules leave the sandbox already exercised against the app's actual behavior; ship them with `firebase deploy` (or the Console). Composite indexes can come from `firestore_extract_indexes` / `pyric firestore:indexes:generate` instead of a hand-maintained `firestore.indexes.json`. And `pyric verify` replays a captured session against a candidate ruleset and reports which operations change verdict before production finds out.

## What matches Firebase and what doesn't

A sandbox is only useful if it behaves like the real service. The evidence: 138 committed observations of production Firebase behavior, replayed against the sandbox in CI on every change, and a public compatibility matrix of 610 rows, 539 conforming today. Known divergences are documented rather than hidden, and an undocumented divergence is treated as a bug.

Per service: [Firestore](packages/pyric/docs/firestore/COMPAT.md), [Auth](packages/pyric/docs/auth/COMPAT.md), [Realtime Database](packages/pyric/docs/database/COMPAT.md), [Storage](packages/pyric/docs/storage/COMPAT.md). How the system works: [running the conformance system](packages/conformance/docs/how-to-run-the-conformance-system.md).

## Using the packages directly

Most apps never import Pyric. For tests, Node scripts, and programmatic control of sandboxes, the `pyric/*` and `pyric-admin/*` packages mirror the Firebase SDKs' shape:

```js
import { initializeSandbox } from 'pyric/sandbox';
import { initializeApp } from 'pyric-admin/app';
import { getDatabase } from 'pyric-admin/database';

initializeApp({ sandbox: initializeSandbox() }); // the only non-firebase-admin line
const db = getDatabase();
await db.ref('rooms/lobby').set({ topic: 'launch day' });
```

| Package | Purpose | Docs |
|---|---|---|
| `pyric` | Web SDK mirror, rules tooling, sandbox runtime | [docs](packages/pyric/docs/) |
| `pyric-admin` | `firebase-admin` mirror over sandbox or production | [docs](packages/pyric-admin/docs/firestore/) |
| `@pyric/cli` (`pyric-tools`) | The `pyric` CLI: `dev`, `init`, MCP bridge, verify | [docs](packages/cli/docs/) |
| `@pyric/ui` | Headless React admin components and hooks | [docs](packages/ui/docs/) |
| `@pyric/studio` | The local console behind `pyric dev --ui` | [README](packages/studio/README.md) |

```bash
npm install -D pyric-tools    # the CLI; sufficient for most apps
npm install pyric pyric-admin # for direct sandbox control
```

Node 22 or later. All packages are ESM-only with subpath exports (`pyric/firestore`, not `pyric`).

## Development

Requires Bun and Node 22 or later.

```bash
bun install
bun run build
bun test packages/pyric packages/pyric-admin packages/cli packages/ui
npm run test:packaging
```

Examples: [examples/vite-sandbox-app](examples/vite-sandbox-app/), the shape `pyric init --template web` generates, and [examples/admin-playground](examples/admin-playground/), a `@pyric/ui` showcase.

## Stability

Alpha, `0.1.0-alpha.8`, published as an experimental product. The one stability goal is the Firebase mirror: code written against mirrored surfaces is intended to keep working, tracked in the compatibility matrices. Pyric-specific APIs (sandbox lifecycle, replay, serve and bridge internals) are public-alpha and may change between releases.
