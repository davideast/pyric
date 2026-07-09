# Pyric

Pyric is a development-time layer for Firebase. It runs Firestore, Auth, Realtime Database, Storage, and security rules inside the application process, so Firebase apps and the agents that work on them can be developed without a live project, the emulator, or a network connection. Production builds do not include it: application code keeps its `firebase/*` imports, the sandbox backs them during development, and real Firebase backs them in production.

## Starting a project

Firebase development begins with an account, a project, enabled services, the emulator suite and its Java dependency, and hand-wired switching between emulator and production in the SDK. An agent working in that environment touches real infrastructure, so writes, deploys, and rules changes need supervision.

Pyric starts from one command, in an existing Firebase app or a scaffolded one:

```bash
npx pyric init --template web   # scaffold, or run pyric dev in an existing app
npx pyric dev
```

`pyric dev` serves the app against the in-process sandbox. During web development the sandbox runs in the page itself; in Node it runs in the process. It holds data, identities, and rules that can be seeded, snapshotted, and reset. Live demo: [pyric-playground.web.app](https://pyric-playground.web.app).

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

## Tools an agent can hold

The sandbox and its services are exposed as 51 agent-callable tools, reachable over MCP through `pyric dev --bridge` (the included [Claude Code plugin](pyric-plugin/README.md) auto-wires this) or composed programmatically into any agent framework. The inventory is in [docs/agent-tools.md](docs/agent-tools.md); the ones with no equivalent elsewhere:

- `firestore_simulate_rules` and `rtdb_simulate_access` evaluate a rules verdict for a hypothetical operation without performing it.
- `firestore_simulator_*` runs a stateful Firestore session with seed, execute, batch, transaction, undo, redo, and an inspectable event log.
- `sandbox_inspect`, `firestore_discover_paths`, and `rtdb_crawl_structure` map what exists in the data and how it is shaped.
- `rtdb_validated_write` runs pre-flight checks before writing: it infers the schema at the target path, validates the payload against it, and simulates the rules verdict, returning schema warnings and simulation results alongside the write outcome.
- `firestore_extract_indexes` derives composite-index definitions from the query shapes in source.
- The deploy factories (`firestore_deploy_rules`, `firestore_deploy_indexes`, `rtdb_deploy_rules`, `hosting_deploy`, `functions_deploy`) drive the Firebase control plane over REST, without the `firebase-tools` CLI.

## Work that carries to production

A sandbox session produces the artifacts a production deploy needs. Rules leave the sandbox already exercised against the app's actual behavior; `pyric deploy rules` ships them. Composite indexes come from `firestore_extract_indexes` instead of a hand-maintained `firestore.indexes.json`; `pyric deploy indexes` ships those. And `pyric verify` replays a captured session against a candidate ruleset and reports which operations change verdict before production finds out.

## Holding the sandbox to Firebase's behavior

A sandbox is only useful if it behaves like the real service, so that claim is tested rather than assumed. Probes run against production Firebase and their recorded behavior is committed to the repository as observations, currently 138 of them. CI replays every observation against the sandbox on every change. The public contract is a compatibility matrix of 610 rows, 539 conforming today, and known divergences are documented rather than hidden: [Firestore](packages/pyric/docs/firestore/COMPAT.md), [Auth](packages/pyric/docs/auth/COMPAT.md), [Realtime Database](packages/pyric/docs/database/COMPAT.md), [Storage](packages/pyric/docs/storage/COMPAT.md), and [how the conformance system runs](docs/conformance/how-to-run-the-conformance-system.md). An undocumented divergence is treated as a bug.

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
| `pyric-tools` | The `pyric` CLI: `dev`, `init`, MCP bridge, deploy, verify | [docs](packages/pyric-tools/docs/) |
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
bun test packages/pyric packages/pyric-admin packages/pyric-tools packages/ui
npm run test:packaging
```

Examples: [examples/vite-sandbox-app](examples/vite-sandbox-app/), the shape `pyric init --template web` generates, and [examples/admin-playground](examples/admin-playground/), a `@pyric/ui` showcase.

## Stability

Alpha, `0.1.0-alpha.7`, published as an experimental product. The one stability goal is the Firebase mirror: code written against mirrored surfaces is intended to keep working, tracked in the compatibility matrices. Pyric-specific APIs (sandbox lifecycle, replay, serve and bridge internals) are public-alpha and may change between releases.
