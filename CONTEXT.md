# Pyric codebase context

Last checked: 2026-08-01. Workspace version `0.1.0-alpha.19`, conformance-tested
against Firebase `12.13.0` (`packages/cli/src/version/compat-target.ts`).

Pyric is a Firebase-shaped development sandbox for people and coding agents.
It runs Firestore, Auth, Realtime Database, Storage, Security Rules, and related
tooling locally, in TypeScript, without a Firebase project or Emulator Suite.

The product boundary is deliberate:

- Pyric owns sandbox development, artifact generation, and verification.
- Firebase owns production execution.
- `firebase-tools` and the Firebase Console own production deployment.

`PRIORITIES.md` is law for proposed work, and `AGENTS.md` says so plainly:
judge every proposal against the priority tests before starting it. As of
2026-07-14 the priorities are Top of Funnel, Simplification, Trust, Build
Velocity, and Refactoring and Tech Debt. The season is explicitly not about
building more; the npm alpha shipped and the feature set is the problem, so
work that adds concepts without serving one of those tests waits.

## Workspace map

The repository is a Bun workspace with these principal packages:

| Directory | Package | Role |
|---|---|---|
| `packages/pyric` | `pyric` | Firebase Web SDK mirrors, sandbox runtime, rules tooling |
| `packages/pyric-admin` | `pyric-admin` | Firebase Admin-shaped sandbox mirrors |
| `packages/cli` | `@pyric/cli` | `pyric` binary, Vite/Node resolution seams, bridge, verify, assurance |
| `packages/create-pyric` | `create-pyric` | `npm create pyric` scaffolder |
| `packages/ui` | `@pyric/ui` | Headless React components and hooks |
| `packages/studio` | `@pyric/studio` | Studio console application, mounted by the Astro site and served by `pyric sandbox --ui` |
| `packages/site-docs` | `@pyric/site-docs` | The one Astro site: documentation plus the Studio shell |
| `packages/conformance` | `@pyric/conformance` | Private evidence graph: surfaces, registry, observations, probes, rigs, gates |
| `packages/playground` | `@pyric/playground` | Private browser agent playground |

Examples live in `examples/`: `vite-sandbox-app`, `nextjs-sandbox-app`,
`inpage-todo-app`, `admin-playground`, `ai-chat`, `playground-next`,
`prelease-pyric`. Only some are workspace members; the root `package.json`
`workspaces` array is the list. The cross-agent Pyric plugin lives in
`pyric-plugin/` and ships three skills: `pyric`, `improve-firebase`,
and `pyric-inpage-sandbox`. Repository-local agent skills live in
`.agents/skills/`. `clones/` holds read-only upstream checkouts
(`firebase-js-sdk`, `firebase-tools-ui`) used as reference, not as
dependencies.

All public packages are ESM-only and require Node 22 or later (`@pyric/cli`
and `create-pyric` require 22.15). Prefer public package subpaths; do not
import through another package's source tree.

## Package contracts

### `pyric`

`pyric` mirrors Firebase Web SDK shapes against a sandbox. Important public
subpaths include:

| Subpath | Purpose |
|---|---|
| `pyric/app` | Firebase-shaped client app registry: `initializeApp(options, settings?)`, `getApp`, `getApps`, `deleteApp`, local `FirebaseError`, pinned `SDK_VERSION`, `onLog`, `setLogLevel`, `registerVersion`. Default and named equal-config app containers share one managed sandbox backend; a second Firebase configuration in the same runtime is intentionally rejected. It has no `firebase/app` runtime dependency; production imports stay on `firebase/app`. |
| `pyric/app/register` | Node register adapter for canonical `firebase/app` imports. Prepares a process-wide sandbox and loads `firestore.rules` from `firebase.json` when present. |
| `pyric/app/internal` | App-registry seam for adapters. |
| `pyric/auth` | Sandbox-only modular Auth mirror, identity, providers, and popup/redirect resolver. It has no `firebase/auth` runtime dependency; production imports stay on `firebase/auth`. |
| `pyric/firestore` | Sandbox-only modular Firestore mirror plus Firestore data/inspect tools. It has no `firebase/firestore` runtime dependency; production imports stay on `firebase/firestore`. |
| `pyric/firestore/internal/value-codec` | Worker-only Firestore wire-value rehydration seam; not an application-facing surface. |
| `pyric/database` | Sandbox-only modular Realtime Database mirror. It has no `firebase/database` runtime dependency; production imports stay on `firebase/database`. |
| `pyric/database/internal` | Realtime Database backend seam. |
| `pyric/sandbox/database` | Owner controls for installing RTDB rules, seeding data, and reading detached snapshots. |
| `pyric/storage` | Modular Storage mirror and storage admin-style tools. |
| `pyric/storage/internal` | Storage engine seam. |
| `pyric/ai` | Sandbox-only Firebase AI Logic mirror (`getAI`, `getGenerativeModel`, generateContent, streaming, chat, function calling, countTokens, `Schema`). It has no `firebase/ai` runtime dependency; production imports stay on `firebase/ai`. |
| `pyric/ai/scripting` | Scripted answer-engine seam for the AI sandbox. |
| `pyric/ai/internal` | Answer-engine and broker seam used by the CLI's AI proxy. |
| `pyric/messaging` | Cloud Messaging client mirror. |
| `pyric/messaging/sw` | Service-worker messaging entry. |
| `pyric/messaging/internal` | Messaging broker seam. |
| `pyric/rules` | **The whole rules public API.** Everything else in the rules family is an internal seam. |
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

Service fronts accept a bare `Sandbox` handle as well as a `FirebaseApp`:
`getFirestore(sandbox)`, `getDatabase(sandbox)`, `getAuth(sandbox)`,
`getMessaging(sandbox)`, `getAI(sandbox)`, and
`getStorageSandbox(sandbox, { rules })` all work without `initializeApp`.
Repeated calls with the same sandbox return the same instance. This is the
entry path for CLI-free in-page prototypes, documented by the
`pyric-inpage-sandbox` skill and exercised by `examples/inpage-todo-app`.

### `pyric-admin`

`pyric-admin/{app,auth,firestore,database,storage,messaging}` provides Admin-shaped
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
- `@pyric/cli/conformance/docs`
- `@pyric/cli/bridge`
- `@pyric/cli/bridge/client`
- `@pyric/cli/discover`
- `@pyric/cli/vite`
- `@pyric/cli/next`
- `@pyric/cli/serve/worker`
- `@pyric/cli/remote`
- `@pyric/cli/register`
- `@pyric/cli/register/app-bridge`

The package intentionally has no Firebase or Firebase Admin runtime dependency.
The manifest, packaging gates, and generated declaration reference enforce this
surface.

`@pyric/cli/conformance/docs` is the published projection the documentation
site consumes; the site never imports `@pyric/conformance`.

`@pyric/cli/next` exports `withPyric`, a development-only Next.js config
wrapper. It aliases client modules for Webpack and Turbopack, externalises the
server SDKs so the Node loader can intercept them, and adds development
rewrites for the sandbox socket and bridge. `examples/nextjs-sandbox-app` is
the worked example.

### `@pyric/ui` and `@pyric/studio`

`@pyric/ui` publishes headless React components and hooks under
`auth`, `auth/hooks`, `primitives`, `firestore`, `firestore/hooks`, `rtdb`,
`storage`, `storage/hooks`, `traffic`, `traffic/hooks`, `events`,
`events/hooks`, `agents`, `rules`, and `rules/hooks`. Components carry
behaviour and structural `data-*` hooks, no visual styling, and run against a
sandbox, production Firebase handles, or a custom adapter.

`@pyric/studio` is private and unversioned. It exports `./app`, `./routes`,
`./styles`, `./ports`, and `./env`, and is mounted by the Astro site rather
than served on its own.

## Package resolution

Application source keeps canonical `firebase/*` and `firebase-admin/*` imports.
The execution environment chooses the implementation.

Browser development:

- `@pyric/cli/vite` maps supported `firebase/*` imports to `pyric/*` while
  Vite is serving development code.
- `pyric sandbox` serves import maps that point a pre-built/static application at
  the same sandbox mirrors.
- A normal production Vite build leaves the development swap inactive and
  includes Firebase directly.

Node development:

- `pyric sandbox` runs the child command with `PYRIC_SANDBOX` set and
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
pyric sandbox
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
pyric storage rules resolve <path> [--out <path>]
pyric storage rules simulate [--stdin]
pyric database rules lint <path>
pyric database rules validate <path>
pyric database rules simulate [--stdin]
pyric database rules generate [--config <path>] [--out <path>]
```

`packages/cli/src/cli/index.ts` owns top-level dispatch, help, and the usage
text that is the practical reference for flags. `packages/cli/src/cli/service-commands.ts`
owns the service-first hierarchy.

`pyric sandbox` defaults to port 3473 and opens the served page, or Studio under
`--ui`. It runs the project's own dev command (`-- <cmd>`, otherwise the
`package.json` `dev` script) with `PYRIC_SANDBOX` set, discovers a Functions
source from `firebase.json`, hot-reloads Firestore and Realtime Database rules,
and writes the session capture unless disabled.

`pyric can-i-use` queries availability, Firebase fidelity, and assurance for a
developer-facing feature. It is discovery, not a rules-verification subcommand.
A surface prefix such as `firestore-rules/getAfter` disambiguates a name, and
the query runs against the same model MCP serves.

`pyric verify` replays captured sandbox sessions against candidate Firestore or
RTDB rules. `--engine` selects `sandbox` (default), `rules-test-api`, or
`both`. The Rules Test API engine is Firestore-only, evaluates derived cases on
Google's engine, and verifies rules rather than deploying them.

## Sandbox and bridge

The browser sandbox normally lives in a SharedWorker, giving tabs on one origin
a shared backend. ADR-0011 treats that worker transport as a versioned public
API rather than an implementation detail. IndexedDB provides browser-local
durability; Storage falls back to an in-memory store when the browser blocks
IndexedDB (`packages/pyric/src/storage/persistence.ts`). `--persist` adds the committable `.pyric/state/state.json`; `pyric snapshot`
promotes lived state to a fixture; the session capture at
`.pyric/last-session.json` feeds `pyric verify`.

A sandbox can also run entirely in the page with no worker, no CLI, and no dev
server, which is the in-page prototype path described under `pyric` above.

`pyric/app` mirrors Firebase's default and named registry. Equal-option apps
receive separate service containers and Auth/listener sessions over that one
backend. A second Firebase configuration in the same runtime is rejected rather
than silently creating another persistence domain.

`pyric sandbox --bridge` mounts MCP on the sandbox server and routes calls to
the same sandbox as the open application and Studio. `pyric bridge` provides a
standalone sandbox bridge. `pyric mcp` is the stdio editor front: it attaches to
a running development bridge when possible or hosts a headless sandbox.

The default bridge contract is exactly nine tools carrying 30 operations. A
tool is named for a service and, where one applies, an artifact
(`firestore_data`, `firestore_rules`, `sandbox`); its required `op` field
selects the operation. Twenty operations are forwarded to the sandbox
(`firestore_simulator`, `firestore_data`, `sandbox`, `database_data`,
`database_rules`) and ten run in the MCP process without a browser peer
(`firestore_rules`, `rules_stdlib`, `storage_rules`, `pyric`). Each tool is one
record under `packages/cli/src/bridge/tool-records/` (name, order,
description, and per-operation transport, factory, and handler);
`packages/cli/scripts/generate-tool-registry.ts` renders the aggregate that
`packages/cli/src/bridge/server/mcp-contract.ts` pins and that both the MCP
process and the browser dispatcher compose from. The bridge validates each
call against the schema of the operation it names and returns a structured
error naming the valid operations and fields. `getDefaultMcpToolSurface()`
fails closed when a record names a handler its factory does not yield, and
`scripts/tool-parity.mjs` checks that exposed tool registries stay explicit.

### Firestore sandbox engine

The **Firestore sandbox engine** is the module behind `LocalEnvironment`
(`packages/pyric/src/firestore/sandbox/`). `LocalEnvironment` is its permanent
interface; `SandboxImpl` and the admin-compat wrappers are its only callers.
Its internal seams, named by ADR-0009 and used only by the engine's own tests:

- **WriteEngine** — execute/batch/transaction and write application.
- **ListenerDispatch** — snapshot listener registry, delivery scheduling,
  metadata acks, and rules-flip re-evaluation.
- **RulesReadEngine** — rules-gated document reads plus query candidate
  gathering and execution.
- **RulesListAuthorizer** — shared list-rule proof, residual simulation, and
  request/denial event policy for listener and one-shot query reads.
- **EventBus** — sandbox event emission; **History** — undo/redo over the
  event log.
- **TriggerScope** — stack-scoped trigger attribution (`run`/`current`,
  capture-at-schedule); written by WriteEngine and re-evaluation, read by
  ListenerDispatch and EventBus.
- **RulesState** — the deployed rules source and parsed AST, invalidated by
  seed and rules deploys, shared by the read and write engines.

## AI Logic modes

`pyric/ai` mirrors Firebase AI Logic, and the CLI chooses which engine answers.
There are three modes, selected by environment variables read by the Vite
plugin or by explicit `pyric({ ai: … })` options; explicit options win.

- **Scripted (default).** No configuration, no network. `pyric/ai/scripting`
  queues exact responses for tests and prototypes.
- **Local model.** `PYRIC_AI_MODEL` activates the OpenAI-compatible engine and
  is the catch-all mapping for requested Firebase model names.
  `PYRIC_AI_PROXY_UPSTREAM` points at a non-default OpenAI-compatible server
  (Ollama's `http://localhost:11434/v1` is the default). The browser always
  calls the same origin at `/__pyric/ai-proxy`; the dev server makes the
  upstream hop, which is what avoids browser CORS configuration.
- **Production pass-through.** `PYRIC_AI_MODE=production` (or `ai.mode`) stops
  intercepting `getAI`/`getGenerativeModel` and brokers requests to Google AI
  or Vertex AI through the server rather than the browser. It requires real
  project credentials and enabled cloud APIs, and rejects `ai.model` or
  `ai.engine` at startup because routing belongs to the production SDK.

`packages/pyric/src/ai/broker/` and `packages/cli/src/serve/vite-ai-config.ts`
own the mode plumbing. Studio's runtime chip surfaces the active mode, the
resolved model alias, and broker rejections.

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

Authoritative inputs live under `packages/conformance/`, following the
file-per-record convention: the filename is the join key, the directory is the
index, and aggregation is computed rather than hand-written.

- `surfaces/` defines each measured surface and what it owns;
- `registry/` owns every published conformance row, one file per service;
- `observations/<surface>/<name>.json` stores frozen Firebase behaviour;
- `probes/<surface>/<name>.ts` replays observations against Pyric;
- `rules-corpus/<engine>/<scenario-id>.ts` holds the Firestore and Storage
  rules scenarios that captured rules observations must match;
- `exceptions/<observation-name>.ts` is the only way an uncited observation may
  exist;
- `rigs/<rig-id>.ts` records capture mechanisms, deliberately flat because a
  rig such as `oracle-run` spans several surfaces;
- `entry-path/<service>.ts` holds one canonical initialisation program per
  service, adapted from Firebase's official quickstart shapes;
- `rules-language/` tracks rules constructs per engine;
- `src/conformance-model.ts` joins census, registries, rules snapshots,
  evidence, and simulator capability into the shared read model;
- `src/conformance-verdicts.ts` derives what the evidence can support;
- `baselines/` ratchets regressions without turning an absolute percentage
  into an incentive to relabel gaps.

Service `COMPAT.md`, `SCORES.md`, site ports, runtime lookups, and optional
rules-language reports are ignored disposable projections written by
`src/generate-projections.ts`. The CLI prebuild derives them from the canonical
model on a clean checkout; `compat:check` runs the gate chain
(`compat:validate`, `compat:census-gate`, `compat:entry-path`,
`compat:conformance:check`, `compat:rules-score`, `compat:coverage`) over the
authored graph and committed ratchet baselines.

Firestore currently reports 100% public runtime and exported-type surface
coverage. Rules conformance is oracle-backed: constructs are scored per engine
and published as scorecards through `compat:rules-score`.

Any PR that changes a published number, status, denominator, snapshot, or
assurance capability needs an adversarial coverage review.

## Documentation and the site

One Astro build owns both the documentation and the Studio shell (ADR-0010).
`DOCS_BASE` selects the root for the public site or `/__pyric/ui/` for the tree
embedded into `@pyric/cli`. Documentation stays static HTML and starts no
SharedWorker; Studio entry pages hydrate the shared React application.

Authored documentation is plain nested markdown with plain-YAML front matter
under `packages/site-docs/src/content/`, organised by outcome rather than by
package: `get-started/`, `build/`, `secure/`, `observe/`, `ship/`, `agent/`,
`trust/`, `examples/`, plus `overview.md`, `tutorial.md`, and `rhythm.md`.
Authored pages have no content collection and no zod schema; they are
discovered by `import.meta.glob` (`src/lib/content.ts`) and validated by the
build's own assertions. Pages link each other by relative `.md` path, and
`src/lib/remark-doc-links.ts` resolves those to routes and fails the build on a
broken link.

Generated documentation is never committed and is no longer written to disk.
`src/content.config.ts` defines two data collections whose Astro content-layer
loaders produce those pages at build time:

- `src/lib/loaders/conformance.ts` consumes the published
  `@pyric/cli/conformance/docs` projection and applies site-side table
  presentation. No model derivation happens in the site.
- `src/lib/loaders/api-reference.ts` supplies the TypeDoc API reference.

Both loaders require built packages and say so when `@pyric/cli` is missing.

```bash
bun run build                              # packages + embedded site
bun run --cwd packages/site-docs build     # site only, needs built packages
bash scripts/build-site.sh                 # composed public site into dist/site
bash scripts/deploy-site.sh                # Firebase Hosting deploy of dist/site
```

The site build audits front matter, route clashes, conflict markers, unknown
groups, broken links, and every `pyric can-i-use` example; a broken doc fails
the build.

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

`scripts/build.sh` runs three phases: clean every `dist/`, emit declaration
stubs for the workspace, then strict builds in dependency order. `pyric` is
built early because the CLI prebuild derives its conformance projections from
the live export surface. The final phase builds the unified Astro site at
`/__pyric/ui/` and copies it into `packages/cli/dist/serve/site-ui/`.
`--packages-only` skips that phase and is what `pretest` uses.

`.github/workflows/build.yml` starts with a fail-closed proof-selection job
(`scripts/ci/plan.ts`, itself tested) and then runs package builds and CLI
tests, library/UI/Studio tests, the conformance suite, the conformance gate
chain (`scripts/ci/conformance-gates.sh`), Playwright jobs for the served app,
the CLI-hosted Studio and the public Studio, and the release-wrapper contract.
Packaging and install-matrix jobs run on PRs carrying the `ci-packaging` label.
`oracle-recapture.yml`, `simulator-parity.yml`, and `playground-contract.yml`
are the other workflows.

## Working conventions

- Read `PRIORITIES.md` before proposing work.
- Read `docs/code-conventions.md` before changing module boundaries. It extends
  the file-per-record convention to source: one public entry barrel per
  mirrored surface, one file per API family, sandbox code under `X/sandbox/`,
  tests mirroring the source path.
- Ratified decisions live in `docs/decisions/` (ADR-0001 to ADR-0011). The two
  that shape the current tree most are ADR-0009 (Firestore engine deepening)
  and ADR-0010 (the unified Astro site).
- Preserve unrelated work in a dirty tree.
- Use public subpaths between packages.
- Keep browser/Node/platform-specific imports at explicit boundary modules.
- Generated sources name their owner command; regenerate rather than editing.
- Use British English in authored documentation.
- Treat unsupported behaviour as an explicit error or documented gap, never a
  silent approximation.
