# Pyric codebase context

Last checked: 2026-07-13.

Pyric is a Firebase-shaped development sandbox for people and coding agents.
It runs Firestore, Auth, Realtime Database, Storage, Security Rules, and related
tooling locally, in TypeScript, without a Firebase project or Emulator Suite.

The product boundary is deliberate:

- Pyric owns sandbox development, artifact generation, and verification.
- Firebase owns production execution.
- `firebase-tools` and the Firebase Console own production deployment.

`PRIORITIES.md` is law for proposed work. Current work must reduce first-run
friction, simplify the product model, or make the contract and gaps easier to
trust.

## Workspace map

The repository is a Bun workspace with these principal packages:

| Directory | Package | Role |
|---|---|---|
| `packages/pyric` | `pyric` | Firebase Web SDK mirrors, sandbox runtime, rules tooling |
| `packages/pyric-admin` | `pyric-admin` | Firebase Admin-shaped sandbox mirrors |
| `packages/cli` | `@pyric/cli` | `pyric` binary, Vite/Node resolution seams, bridge, verify, assurance |
| `packages/create-pyric` | `create-pyric` | `npm create pyric` scaffolder |
| `packages/ui` | `@pyric/ui` | Headless React components and hooks |
| `packages/studio` | `@pyric/studio` | Local console served by `pyric dev --ui` |
| `packages/site-docs` | `@pyric/site-docs` | Generated Astro documentation site |
| `packages/conformance` | `@pyric/conformance` | Private evidence registry, observations, probes, and gates |
| `packages/playground` | `@pyric/playground` | Private browser agent playground |

Examples live in `examples/`. The Claude Code plugin lives in
`pyric-plugin/`. Repository-local agent skills live in `.agents/skills/`.

All public packages are ESM-only and require Node 22 or later. Prefer public
package subpaths; do not import through another package's source tree.

## Package contracts

### `pyric`

`pyric` mirrors Firebase Web SDK shapes against a sandbox. Important public
subpaths include:

| Subpath | Purpose |
|---|---|
| `pyric/app` | Firebase-shaped client app registry: `initializeApp(options, settings?)`, `getApp`, `getApps`, `deleteApp`, local `FirebaseError`, pinned `SDK_VERSION`, `onLog`, `setLogLevel`, `registerVersion`. Default and named equal-config app containers share one managed sandbox backend; a second Firebase configuration in the same runtime is intentionally rejected. It has no `firebase/app` runtime dependency; production imports stay on `firebase/app`. |
| `pyric/auth` | Sandbox-only modular Auth mirror, identity, providers, and popup/redirect resolver. It has no `firebase/auth` runtime dependency; production imports stay on `firebase/auth`. |
| `pyric/firestore` | Sandbox-only modular Firestore mirror plus Firestore data/inspect tools. It has no `firebase/firestore` runtime dependency; production imports stay on `firebase/firestore`. |
| `pyric/firestore-values` | Firestore value helpers/wrappers. |
| `pyric/database` | Sandbox-only modular Realtime Database mirror. It has no `firebase/database` runtime dependency; production imports stay on `firebase/database`. |
| `pyric/sandbox/database` | Owner controls for installing RTDB rules, seeding data, and reading detached snapshots. |
| `pyric/storage` | Modular Storage mirror and storage admin-style tools. |
| `pyric/storage/internal` | Storage engine seam. |
| `pyric/ai` | Sandbox-only Firebase AI Logic mirror (`getAI`, `getGenerativeModel`, generateContent, streaming, chat, function calling, countTokens). It has no `firebase/ai` runtime dependency; production imports stay on `firebase/ai`. |
| `pyric/ai/scripting` | Scripted answer-engine seam for the AI sandbox. |
| `pyric/messaging` | Cloud Messaging client mirror. |
| `pyric/messaging/sw` | Service-worker messaging entry. |
| `pyric/messaging/internal` | Messaging broker seam. |
| `pyric/rules` | **The whole rules public API** (see below). |
| `pyric/rules/internal` | Engine internals seam. |
| `pyric/rules/internal/node` | Node-only filesystem-backed module resolution. |
| `pyric/rules/internal/extract` | Composite-index extraction. |
| `pyric/rules/internal/rtdb` | Pure RTDB rules engine internals: environment-independent compile/serialize/simulate seams plus replay and constraints. |
| `pyric/sandbox` | Sandbox lifecycle, events, persistence, replay, branches. |
| `pyric/sandbox/firestore` | Firestore-specific sandbox controls: rules, seeding, snapshots, and inspection. Controls receive the owning local `Sandbox`. |
| `pyric/sandbox/internal` | Adapter-only internal protocol. |
| `pyric/sandbox/admin-compat` | Chainable admin-Firestore-shaped sandbox wrapper. |
| `pyric/sandbox/admin-firestore` | Internals backing the admin-compat layer. |

The exact contract is `packages/pyric/package.json#exports`. Some exported
internal seams exist for adapters; application code should use the ordinary
service and sandbox fronts.

### `pyric-admin`

`pyric-admin/{app,auth,firestore,database,storage}` provides Admin-shaped
handles for the sandbox. Production server code should import
`firebase-admin/*` directly. During activated development, the CLI resolver can
map those canonical imports to the sandbox mirrors without changing source.

### `@pyric/cli`

`@pyric/cli` has no package-root import. Its public subpaths are exactly:

- `@pyric/cli/credentials/node`
- `@pyric/cli/verify`
- `@pyric/cli/assurance`
- `@pyric/cli/assurance/browser`
- `@pyric/cli/conformance`
- `@pyric/cli/conformance/browser`
- `@pyric/cli/bridge`
- `@pyric/cli/bridge/client`
- `@pyric/cli/discover`
- `@pyric/cli/vite`
- `@pyric/cli/serve/worker`
- `@pyric/cli/remote`
- `@pyric/cli/register`

The package intentionally has no Firebase or Firebase Admin runtime dependency.
The manifest, packaging gates, and generated declaration reference enforce this
surface.

## Package resolution

Application source keeps canonical `firebase/*` and `firebase-admin/*` imports.
The execution environment chooses the implementation.

Browser development:

- `@pyric/cli/vite` maps supported `firebase/*` imports to `pyric/*` while
  Vite is serving development code.
- `pyric dev` serves import maps that point a pre-built/static application at
  the same sandbox mirrors.
- A normal production Vite build leaves the development swap inactive and
  includes Firebase directly.

Node development:

- `pyric dev` runs the child command with `PYRIC_SANDBOX` set and
  `@pyric/cli/register` preloaded through `NODE_OPTIONS`.
- The active resolver maps `firebase/*` to `pyric/*` and `firebase-admin/*` to
  `pyric-admin/*`.
- Without `PYRIC_SANDBOX`, the register module is inert. Normal resolution
  loads Firebase directly.
- Activation is refused under `NODE_ENV=production` unless
  `PYRIC_SANDBOX_FORCE=1` is explicitly set for controlled development or CI.

File presence does not activate package substitution. The invocation does.

## CLI contract

The binary is `pyric`. General commands are:

```text
pyric bridge
pyric can-i-use <feature> [--json]
pyric dev
pyric init
pyric vendor
pyric snapshot
pyric verify
pyric verify cases
pyric mcp
```

Artifact commands use one service-first grammar:

```text
pyric <service> <artifact> <operation>
```

The complete family is:

```text
pyric firestore rules lint <path>
pyric firestore rules validate <path>
pyric firestore rules simulate [--stdin]
pyric firestore rules resolve <path> [--out <path>]
pyric firestore indexes generate <path...> [--out <path>]
pyric storage rules lint <path>
pyric storage rules simulate [--stdin]
pyric database rules lint <path>
pyric database rules validate <path>
pyric database rules simulate [--stdin]
pyric database rules generate [--config <path>] [--out <path>]
```

`packages/cli/src/cli/index.ts` owns top-level dispatch and help.
`packages/cli/src/cli/service-commands.ts` owns the service-first hierarchy.
`packages/cli/docs/reference/cli.md` is the authored reference.

`pyric can-i-use` queries availability, Firebase fidelity, and assurance for a
developer-facing feature. It is discovery, not a rules-verification subcommand.

`pyric verify` replays captured sandbox sessions against candidate Firestore or
RTDB rules. The default engine is local. The Firestore Rules Test API engine
evaluates derived cases on Google's engine; it verifies rules and does not
deploy them.

## Sandbox and bridge

The browser sandbox normally lives in a SharedWorker, giving tabs on one origin
a shared backend. IndexedDB provides browser-local durability. `--persist`
adds the committable `.pyric/state/state.json`; `pyric snapshot` promotes lived
state to a fixture; the session capture at `.pyric/last-session.json` feeds
`pyric verify`.

`pyric/app` mirrors Firebase's default and named registry. Equal-option apps
receive separate service containers and Auth/listener sessions over that one
backend. A second Firebase configuration in the same runtime is rejected rather
than silently creating another persistence domain.

`pyric dev --bridge` mounts MCP on the development server and routes calls to
the same sandbox as the open application and Studio. `pyric bridge` provides a
standalone sandbox bridge. `pyric mcp` is the stdio editor front: it attaches to
a running development bridge when possible or hosts a headless sandbox.

The default bridge contract is exactly 26 tool names in
`packages/cli/src/bridge/server/mcp-contract.ts`. `scripts/tool-parity.mjs`
checks that exposed tool registries stay explicit.

### Firestore sandbox engine

The **Firestore sandbox engine** is the module behind `LocalEnvironment`
(`packages/pyric/src/sandbox/firestore/`). `LocalEnvironment` is its permanent
interface; `SandboxImpl` and the admin-compat wrappers are its only callers.
Its internal seams, named by ADR-0009 and used only by the engine's own tests:

- **WriteEngine** — execute/batch/transaction and write application.
- **ListenerDispatch** — snapshot listener registry, delivery scheduling,
  metadata acks, and rules-flip re-evaluation.
- **RulesReadEngine** — rules-gated document and collection reads.
- **EventBus** — sandbox event emission; **History** — undo/redo over the
  event log.
- **TriggerScope** — stack-scoped trigger attribution (`run`/`current`,
  capture-at-schedule); written by WriteEngine and re-evaluation, read by
  ListenerDispatch and EventBus.
- **RulesState** — the deployed rules source and parsed AST, invalidated by
  seed and rules deploys, shared by the read and write engines.

## Conformance

Conformance is evidence, not a parity badge. The system separates:

- public runtime surface coverage;
- public exported-type surface coverage; and
- fidelity across tracked behaviour rows.

Public runtime surface is every Firebase runtime export unless its exact name
is classified as private in the authored surface contract. Deprecated,
unsupported, and deferred public APIs remain in the denominator. Naming
conventions such as a leading underscore never classify a runtime export by
themselves; new runtime exports fail closed until the contract reviews them.
Public type surface currently counts non-underscore Firebase exported type
names and ratchets those gaps independently. Private Firebase plumbing and
Pyric-only helpers receive no coverage credit.

Authoritative inputs live under `packages/conformance/`:

- `surfaces/` defines measured surfaces;
- `registry/` owns every published conformance row;
- `observations/` stores frozen Firebase behaviour;
- `probes/` replays observations against Pyric;
- `rules-language/` tracks rules constructs;
- `src/conformance-verdicts.ts` derives what the evidence can support;
- `baselines/` ratchets regressions without turning an absolute percentage
  into an incentive to relabel gaps.

Service `COMPAT.md`, `SCORES.md`, site ports, runtime lookups, and optional
rules-language reports are ignored disposable projections. The CLI and docs
builds derive them from the canonical model on a clean checkout; `compat:check`
validates the authored graph and committed ratchet baselines.

Any PR that changes a published number, status, denominator, snapshot, or
assurance capability needs an adversarial coverage review.

## Documentation

The documentation system has two authored inputs:

- outcome-first guides in `docs/site-rewrite/content/`;
- package documentation under each `packages/*/docs/` tree.

`packages/site-docs/scripts/port-content.ts` owns the generated collection at
`packages/site-docs/src/content/docs/` apart from its explicit keep-list. Never
edit generated projections by hand; edit the source and run:

```bash
bun run --cwd packages/site-docs port
```

The CLI and library declaration receipts are generated by TypeDoc from the
`types` targets in package export maps:

```bash
bun run build
bun run docs:api:generate
bun run docs:api:check
```

The committed `*.api.generated.md` files are mechanical reference receipts.
Hand-written API and CLI pages carry task context and behavioural guidance.

Run the complete documentation gate with:

```bash
bun run --cwd packages/site-docs test
```

That ports sources, builds the site and Markdown twins, verifies the output and
links, and audits documentation rhythm.

## Build and tests

Install with the pinned Bun version from CI, then use the root scripts:

```bash
bun install
bun run build
bun test
bun run compat:check
bun run tool:parity:check
npm run test:packaging
```

`scripts/build.sh` cleans package output, emits declaration stubs for the
workspace, performs strict builds in dependency order, builds Studio and the
documentation site, and embeds those assets into `@pyric/cli`.

The main PR workflow builds every package, checks declaration-document drift,
runs the documentation site gate, validates conformance and assurance
artifacts, checks tool exposure, and runs tests. Packaging and install-matrix
jobs run on PRs carrying the `ci-packaging` label.

## Working conventions

- Read `PRIORITIES.md` before proposing work.
- Read `docs/code-conventions.md` before changing module boundaries.
- Preserve unrelated work in a dirty tree.
- Use public subpaths between packages.
- Keep browser/Node/platform-specific imports at explicit boundary modules.
- Generated sources name their owner command; regenerate rather than editing.
- Use British English in authored documentation.
- Treat unsupported behaviour as an explicit error or documented gap, never a
  silent approximation.
