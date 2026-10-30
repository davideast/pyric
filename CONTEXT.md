# Pyric codebase context

Last checked: 2026-10-14. Workspace version `0.1.0-alpha.25`, conformance-tested
against Firebase `12.19.0` (`packages/cli/src/version/compat-target.ts`).

Pyric is a Firebase-shaped development sandbox for people and coding agents.
It runs Firestore, Auth, Realtime Database, Storage, Cloud Messaging, Firebase
AI Logic, Security Rules, and related tooling locally, in TypeScript, without a
Firebase project or Emulator Suite.

The product boundary is deliberate:

- Pyric owns sandbox development, artifact generation, and verification.
- Firebase owns production execution.
- `firebase-tools` and the Firebase Console own production deployment.

`PRIORITIES.md` is law for proposed work, and `AGENTS.md` says so plainly:
judge every proposal against the priority tests before starting it. As of
2026-10-14 the priorities, in order, are Ship the Node host (promote
`pyric sandbox --hosted` to the npm `latest` tag), Ship multi-resource support
across services (Firestore named databases and per-bucket Storage rules
reaching the shape RTDB instances already have), Trust, Top of Funnel, and
Build Velocity and Tech Debt. Multi-tenancy and Impersonation and
Simplification are done.

## Workspace map

The repository is a Bun workspace with these principal packages:

| Directory | Package | Role |
|---|---|---|
| `packages/pyric` | `pyric` | Firebase Web SDK mirrors, sandbox runtime, rules tooling |
| `packages/pyric-admin` | `pyric-admin` | Firebase Admin-shaped sandbox mirrors |
| `packages/cli` | `@pyric/cli` | `pyric` binary, Vite/Next/Node resolution seams, Node host, bridge, verify, assurance |
| `packages/create-pyric` | `create-pyric` | `npm create pyric` scaffolder |
| `packages/ui` | `@pyric/ui` | Headless React components, hooks, and listener-owner attribution |
| `packages/studio` | `@pyric/studio` | Studio console application, mounted by the Astro site and served by `pyric sandbox --ui` |
| `packages/site-docs` | `@pyric/site-docs` | The one Astro site: documentation plus the Studio shell |
| `packages/conformance` | `@pyric/conformance` | Private evidence graph: surfaces, registry, observations, probes, rigs, gates |
| `packages/playground` | `@pyric/playground` | Private browser agent playground |
| `packages/flutter-client` | `pyric_firestore` | Pure-Dart Flutter sandbox client (Firestore, Auth, RTDB, debug UI) |
| `packages/kt-client` | `kt-client` | Kotlin/Android sandbox client (Firestore, Auth, RTDB) plus `debug-compose` |
| `packages/swift-client` | `PyricFirestore` | Swift Package sandbox client (`PyricFirestore`, `FirebaseAuth`, `PyricDatabase`, `PyricDebugUI`) |

Examples live in `examples/`: `vite-sandbox-app`, `nextjs-sandbox-app`,
`inpage-todo-app`, `admin-playground`, `ai-chat`, `teams-workspace`,
`runtime-flow-lab`, `flutter-todo-app`, `android-todo-app`, `swift-todo-app`,
and `shared`. Only some are Bun workspace members; the root `package.json`
`workspaces` array is the authoritative list. Repeatable architecture workloads
and paired Pyric-vs-hosted comparisons (`multiplayer/pixel-together`,
`rate-limiting/*`) live in `experiments/`. The cross-agent Pyric plugin lives in
`pyric-plugin/` and ships three skills: `pyric`, `improve-firebase`, and
`pyric-inpage-sandbox`. Repository-local agent skills live in
`.agents/skills/`. `clones/` holds read-only upstream checkouts
(`firebase-js-sdk`, `firebase-tools-ui`) used as reference, not as
dependencies. `test/apps/` holds app scenarios: small real apps run against the
packed packages across the dev server, a register-hooked server process, and
Chromium.

All public JS/TS packages are ESM-only and require Node 22 or later (`@pyric/cli`
and `create-pyric` require 22.15, which also provides `node:sqlite` for Node
host mode). Prefer public package subpaths; do not import through another
package's source tree.

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
| `pyric/auth/internal` | Host-only Auth seam: deterministic default-avatar generator (`/assets/avatar/<uid>`) and email-link/custom-token identity helpers. |
| `pyric/firestore` | Sandbox-only modular Firestore mirror plus Firestore data/inspect tools. It has no `firebase/firestore` runtime dependency; production imports stay on `firebase/firestore`. |
| `pyric/firestore/internal` | Host/adapter seam for listener routing, `monitorFirebaseActivity`, and served read aliases. |
| `pyric/firestore/internal/value-codec` | Worker-only Firestore wire-value rehydration seam; not an application-facing surface. |
| `pyric/firestore/internal/update-fields` | Internal `FieldPath` and field-and-value `update` argument parsing seam. |
| `pyric/database` | Sandbox-only modular Realtime Database mirror. It has no `firebase/database` runtime dependency; production imports stay on `firebase/database`. |
| `pyric/database/internal` | Realtime Database backend seam. |
| `pyric/sandbox/database` | Owner controls for installing RTDB rules, seeding data, and reading detached snapshots. |
| `pyric/storage` | Modular Storage mirror and storage admin-style tools. |
| `pyric/storage/internal` | Storage engine seam. |
| `pyric/storage/sw` | `sandboxStorageFetch` for an app's own service worker: answers production Storage URLs from the Node host's byte route. |
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
| `pyric/sandbox/branches/store` | Persisted branch store (`<project>/.pyric/state/branches/<name>/`), with per-service base/state files and event log. |
| `pyric/sandbox/checkpoints` | Saved-state checkpoint capture, restore, and record-backend primitives. |
| `pyric/sandbox/checkpoints/directory` | Node filesystem backend for checkpoints (`<project>/.pyric/state/checkpoints/<name>.json`). |
| `pyric/sandbox/firestore` | Firestore-specific sandbox controls: rules, seeding, snapshots, and inspection. Controls receive the owning local `Sandbox`. |
| `pyric/sandbox/internal` | Adapter-only internal protocol. |
| `pyric/sandbox/admin-compat` | Chainable admin-Firestore-shaped sandbox wrapper. |
| `pyric/sandbox/admin-firestore` | Internals backing the admin-compat layer. |
| `pyric/{firestore/lite,functions,app-check,analytics,performance,remote-config}` | Deferred Web SDK mirrors. Each exports the exact public runtime symbol names and types so swapped imports link and type-check, and throws `PyricDeferredApiError` if called at runtime. |

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

`pyric-admin` (root `.` and `pyric-admin/{app,auth,firestore,database,storage,messaging}`)
provides Admin-shaped handles for the sandbox. Unmirrored `firebase-admin/*`
subpaths (`app-check`, `data-connect`, `eventarc`, `extensions`, `functions`,
`installations`, `instance-id`, `machine-learning`,
`phone-number-verification`, `project-management`, `remote-config`,
`security-rules`) are exported as deferred entries that link and throw
`PyricDeferredApiError` on invocation. Production server code should import
`firebase-admin/*` directly. During activated development, the CLI resolver
maps those canonical imports to the sandbox mirrors without changing source.
A surface check reads `firebase-admin`'s type declarations, so every member
`pyric-admin` lacks is either a named stub or an allowlist row rather than an
`undefined` at the call site.

### `@pyric/cli`

`@pyric/cli` has no package-root import. Its public subpaths are:

- `@pyric/cli/credentials/node`
- `@pyric/cli/verify`
- `@pyric/cli/repro`
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
- `@pyric/cli/bundler`
- `@pyric/cli/serve/worker`
- `@pyric/cli/remote`
- `@pyric/cli/register`
- `@pyric/cli/register/app-bridge`
- `@pyric/cli/flow`
- `@pyric/cli/next/internal/*` (`ai`, `app`, `auth`, `firestore`,
  `firestore-lite`, `database`, `messaging`, `messaging-sw`, `storage`,
  `react-hook` — bundler alias targets for `withPyric`)

The package intentionally has no Firebase or Firebase Admin runtime dependency.
Neither it nor `pyric` installs the agent runtime: the tool handler types
(`ToolHandler`, `ToolResult`, `ToolContext`) are Pyric's own, exported from
`pyric/sandbox/internal`. The manifest, packaging gates, and generated
declaration reference enforce this surface.

`@pyric/cli/conformance/docs` is the published projection the documentation
site consumes; the site never imports `@pyric/conformance`.

`@pyric/cli/next` exports `withPyric`, a development-only Next.js config
wrapper. It aliases client modules for Webpack and Turbopack, externalises the
server SDKs so the Node loader can intercept them, and adds development
rewrites for the sandbox socket and bridge. `examples/nextjs-sandbox-app` is
the worked example.

`@pyric/cli/bundler` exports `pyricExternals`, `pyricRollupExternals`,
`pyricEsbuildExternals`, `pyricViteExternals`, `pyricExternalPackages`, and
`isPyricExternal` so backend bundlers (Rolldown, Rollup, esbuild, tsup, and
Vite SSR) keep `firebase/*` and `firebase-admin/*` external for
`@pyric/cli/register` interception.

`@pyric/cli/flow` exports the browser-side `FlowTreatment` contract for custom
listener highlight treatments in the runtime chip.

### `@pyric/ui` and `@pyric/studio`

`@pyric/ui` publishes headless React components and hooks under
`auth`, `auth/hooks`, `primitives`, `listener-owner`, `firestore`,
`firestore/hooks`, `rtdb`, `storage`, `storage/hooks`, `traffic`,
`traffic/hooks`, `events`, `events/hooks`, `agents`, `rules`, and
`rules/hooks`. Components carry behaviour and structural `data-*` hooks, no
visual styling, and run against a sandbox, production Firebase handles, or a
custom adapter.

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
  `pyric-admin/*` across both ESM `import` and CJS `require()` (via
  `module.registerHooks` on Node 22.15+), and emits a handshake beacon to
  `/__pyric/beacon`.
- Activation also installs the runtime network guard (`packages/cli/src/register/net-guard.ts`)
  over undici's global dispatcher and Node socket/agent connection primitives.
  `PYRIC_GUARD=warn|block|off` defaults to `warn`, reporting any live
  Google/Firebase egress from a sandboxed process and blocking it when set to
  `block`.
- Without `PYRIC_SANDBOX`, the register module is inert. Normal resolution
  loads Firebase directly.
- `PYRIC_SANDBOX=remote` (what `pyric sandbox` prints for commands started by
  hand) finds this project's running host through `.pyric/serve.json`. A
  `remote:<url>` is used only when it names that host; otherwise the client
  falls back to the project's host or fails naming the URL. When a hosted dev
  server restarts, the remote admin client reconnects and resubscribes live
  listeners on ADR-0019's backoff; `@pyric/cli/remote` also exports
  `localStorageUrl` to map stored production Storage download URLs onto the
  host's byte route.
- Activation is refused under `NODE_ENV=production` unless
  `PYRIC_SANDBOX_FORCE=1` is explicitly set for controlled development or CI.

File presence does not activate package substitution. The invocation does.

## CLI contract

The binary is `pyric`. General commands are:

```text
pyric bridge
pyric can-i-use <feature> [--json]
pyric sandbox
pyric sandbox salvage --source=DIR --out=NEW_DIR
pyric init
pyric vendor
pyric snapshot
pyric verify
pyric verify cases
pyric mcp
```

Two more command shapes exist.

Artifact commands, local-tooling and session operations authored one per file
under `packages/cli/src/cli/service-command-records/` and not derived from a
method record:

```text
pyric firestore rules validate <path>
pyric firestore rules resolve <path> [--out <path>]
pyric firestore indexes generate <path...> [--out <path>]
pyric storage rules resolve <path> [--out <path>]
pyric database rules validate <path>
pyric database rules generate [--config <path>] [--out <path>]
pyric auth reset [--target <id>]
pyric serve diagnostics [--url URL] [--json]
pyric serve sessions [--json]
pyric serve denials [--json] [--since <ms|duration>] [--service rtdb|firestore]
pyric serve repro capture [--out FILE]
pyric serve repro replay <file> [--plane node|worker] [--json]
```

Service-tool commands, one per method record under
`packages/cli/src/bridge/surface/methods/<tool>/<method>.ts` (109 methods across
ten tools), derived rather than authored, and shared with `pyric mcp`:

```text
pyric <tool> <method> [--<arg> <value>...]
```

`<tool>` is one of the ten service tools (`firestore`, `database`, `storage`,
`auth`, `messaging`, `functions`, `rules`, `sandbox`, `assurance`, `ai_logic`;
six are highlighted in `pyric --help`, and all ten are registered in
`METHODS`). Linting and simulating a ruleset, running assurance, and every
Firestore, Database, Storage, and Auth data operation are service-tool commands:
`pyric rules lint --service firestore --rules-file firestore.rules`,
`pyric firestore setDoc --path posts/p1 --data '{"a":1}'`,
`pyric auth impersonate --uid alice`, and so on.
`docs/decisions/0014-service-tools-with-sdk-methods.md` records the design; a
call's arguments are its method record's schema, under the SDK's own argument
names, with an object or array argument passed as a JSON string on the command
line (or read from disk via `--<arg>-file <path>`).

`packages/cli/src/cli/index.ts` owns top-level dispatch, help, and the usage
text that is the practical reference for flags. `packages/cli/src/cli/service-commands.ts`
owns the artifact-command hierarchy; `packages/cli/src/cli/surface-method-command.ts`
and `surface-method-runner.ts` own the derived service-tool commands.

`pyric sandbox` defaults to port 3473 and opens the served page, or Studio under
`--ui` (and redirects `/` to Studio when no static index exists). It runs the
project's own dev command (`-- <cmd>`, otherwise `pyric.json#command`) with
`PYRIC_SANDBOX` set, discovers a Functions source from `firebase.json`,
hot-reloads Firestore, Realtime Database, and Storage rules (including relative
`2+modules` imports), and writes the session capture unless disabled.

The Firebase project is resolved as the Firebase CLI resolves it, in one place
shared by `pyric sandbox`, the Vite plugin (`project` option), the
`firebase.json` database rules loader, and the Functions child: the explicit
option, `PYRIC_PROJECT`, `pyric.json#project`, the `firebase use` active
project, then the sole `.firebaserc` alias or `projects.default`.

`pyric can-i-use` queries availability, Firebase fidelity, and assurance for a
developer-facing feature. It is discovery, not a rules-verification subcommand.
A surface prefix such as `firestore-rules/getAfter` disambiguates a name, and
the query runs against the same model MCP serves.

`pyric verify` replays captured sandbox sessions against candidate Firestore or
RTDB rules. `--engine` selects `sandbox` (default), `rules-test-api`, or
`both`. The Rules Test API engine is Firestore-only, evaluates derived cases on
Google's engine, and verifies rules rather than deploying them.

## Sandbox, Node host, runtime chip, and bridge

Pyric supports three sandbox hosting topologies:

1. **SharedWorker sandbox (default in browser):** Lives in a browser
   SharedWorker, giving tabs on one origin a shared backend. ADR-0011 treats
   that worker transport (`@pyric/cli/serve/worker`) as a versioned public API
   rather than an implementation detail. IndexedDB provides browser-local
   durability; Storage falls back to an in-memory store when the browser blocks
   IndexedDB (`packages/pyric/src/storage/persistence.ts`). `--persist` adds the
   committable `.pyric/state/state.json`.
2. **Node host mode (`pyric sandbox --hosted` or `pyric({ hosted: true })` in Vite):**
   Runs one authoritative sandbox in a dedicated Node process (requires Node
   22.15+ for `node:sqlite`), shared across all browsers, Studio, mobile
   clients, child `firebase-admin` processes, the service CLI, and `pyric mcp`.
   Metadata is persisted in `.pyric/state/hosted/state.sqlite` (schema v5,
   single-writer lock under `.pyric/state/hosted`), while Storage object bytes
   live in a content-addressed file store at
   `.pyric/state/hosted/objects/<ab>/<sha256>` with chunked staging in
   `objects/.staging/<uploadId>`, background unreferenced-file sweeping, and
   corrupted-blob quarantine via `pyric sandbox salvage` (ADR-0015, ADR-0018).
   Hosted clients move Storage bytes up to `MAX_STORAGE_OBJECT_BYTES` (512 MiB)
   over the HTTP byte route `/__pyric/storage/v0/b/<bucket>/o/<path>` using
   capability tokens for resumable `PUT` uploads (`Content-Range`) and
   persistent revocable `downloadTokens` (or session tokens) for `GET` range
   requests. The host also keeps a bounded operation log (connection frames,
   rules deploys, MCP tool calls) over a starting checkpoint;
   `pyric serve repro capture` writes it as a **repro file**, and
   `pyric serve repro replay` runs that file on a fresh Node or worker host.
3. **In-page prototype:** Runs entirely in the page with no worker, no CLI, and
   no dev server (`getFirestore(sandbox)`, etc.).

`pyric snapshot` promotes lived state to a committable directory containing
`state.json` (which references Storage objects by SHA-256) and `objects/`
(ADR-0018). Seeds (`--seed`) accept both inline JSON fixtures and snapshot
directories. The session capture at `.pyric/last-session.json` feeds
`pyric verify`.

`pyric/app` mirrors Firebase's default and named registry. Equal-option apps
receive separate service containers and Auth/listener sessions over that one
backend. A second Firebase configuration in the same runtime is rejected rather
than silently creating another persistence domain.

A project can have several **RTDB instances**. Each `database` entry in
`firebase.json` loads its own rules file, read as `firebase deploy` reads it,
and the SharedWorker and Node hosts keep one data tree and ruleset per instance
while sharing one Auth. An instance with no deployed rules starts locked
(`.read`/`.write` false at the root, as production creates one) unless the
sandbox runs `--permissive`. `getDatabase(app, url)` and `pyric-admin`'s
`getDatabaseWithUrl` select the instance their URL names.

### Runtime chip and listener overlays

Served and Vite-hosted pages mount the runtime chip (`packages/cli/src/serve/runtime/`),
a Shadow DOM inspector with a collapsed status pill and a four-view panel
(`Identity`, `Data`, `Traffic`, `Sandbox`):

- **Identity:** Switches between the application's own Auth session, Admin
  bypass, and impersonated users (including tenant IDs and custom claims), with
  session persistence across reloads.
- **Data (listeners) & overlays:** Lists active and historical listeners grouped
  by component/DOM owner (retaining the first application stack frames and
  skipping configured data-layer wrapper globs), and drives two page-painting
  modes: **Overview** (highlights DOM regions updated by listener callbacks) and
  **Flow** (paints real-time read/delivery lifecycle flashes with selectable
  `@pyric/cli/flow` treatments).
- **Traffic & denials:** Inspects per-service operation history, explains
  Firestore/RTDB/Storage rule denials with captured rule-clause evidence,
  checks local Firestore composite index coverage, monitors per-service request
  rates against configurable thresholds, and saves investigation captures.
- **Sandbox:** Surfaces active runtime status, AI Logic mode and model routing,
  worker updates, and direct links to Studio.

### MCP and bridge surfaces

`pyric mcp` is the stdio editor front. When a project's `.pyric/serve.json`
already points to a running SharedWorker bridge at startup, `pyric mcp` relays
stdio to `/__pyric/mcp` (`--attach` requires a running server and exits if none
is found). When no bridge is running (or `--in-process` is passed), `pyric mcp`
starts an in-process server (persisted to `.pyric/state/in-process.json` plus a
storage sidecar) and advertises the **product surface**: **ten** service tools
(`firestore`, `database`, `storage`, `auth`, `messaging`, `functions`, `rules`,
`sandbox`, `assurance`, `ai_logic`, pinned as `DEFAULT_MCP_TOOL_NAMES` in
`packages/cli/src/bridge/server/mcp-contract.ts`), each carrying
`{ method, args }` calls rendered from the 109 method records under
`packages/cli/src/bridge/surface/methods/` (ADR-0014). Per ADR-0016, the
in-process server's `TargetRouter` checks `.pyric/serve.json` on each call and
automatically routes calls to a live Node host for the same project (reporting
`_pyric.target` as `host` or `in-process` and announcing switches), unless
`--in-process` is set. `--surface <id>` selects an evaluation rendering, and
`--allow-production` (or `PYRIC_ALLOW_PRODUCTION=1`) enables `production`-effect
methods.

Each method record declares where its handler runs. A `runsIn: 'sandbox'`
record is given only a `SandboxSurfaceContext` (`surface/sandbox-context.ts`)
and imports nothing Node-only, so a host can run it wherever its sandbox lives;
`surface/methods/sandbox-registry.ts` loads just these records from the
generated `manifest.sandbox.generated.ts`. A `runsIn: 'bridge'` record reads the
project directory, imports a Node-only module, or dispatches an in-process tool
family, and runs only in the bridge process.

The served bridge (`pyric sandbox --bridge`) advertises a
second, separate contract: the **bridge transport surface** a browser sandbox
peer executes, plus the rules, conformance, identity, and capture tools that
run in the bridge process without a peer. The standalone `pyric bridge` has no
browser socket and advertises only the in-process tools. It is **47** tool names (`BRIDGE_TOOL_NAMES`):
**29** forwarded to the sandbox (`BRIDGE_FORWARDED_TOOL_NAMES`, including
Firestore simulator/CRUD, RTDB inspect/simulate, `sandbox_inspect`,
`auth_create_user` through `auth_custom_token`, and `messaging_deliveries`) and
**18** in-process tools (`BRIDGE_IN_PROCESS_TOOL_NAMES`, including Firestore and
service-neutral rules lint/simulate/stdlib/resolve tools, `pyric_can_i_use`,
`auth_impersonate`, `auth_reset`, `auth_whoami`, `auth_sessions`, and the five
`sandbox_*_capture` tools). Each tool family is one record under
`packages/cli/src/bridge/tool-family-records/`;
`packages/cli/scripts/generate-tool-family-registry.ts` renders the aggregate.
`getBridgeToolSurface()` fails closed when a factory drifts, and
`scripts/tool-parity.mjs` checks that exposed tool registries stay explicit.

### Firestore sandbox engine and Rules engine

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
- **FirestoreEventBus** & **EventLog** — bounded sandbox event emission;
  **HistoryControls** — in-memory undo/redo over the event log.
- **TriggerScope** — stack-scoped trigger attribution (`run`/`current`,
  capture-at-schedule); written by WriteEngine and re-evaluation, read by
  ListenerDispatch and EventBus.
- **RulesState** — the deployed rules source and parsed AST, invalidated by
  seed and rules deploys, shared by the read and write engines.

The **Rules engine** (`packages/pyric/src/rules/`) compiles, lints, and
simulates Firestore (`rules_version = '2'` and `'2+modules'`), Storage, and
Realtime Database rules. Firestore and Storage rules share CEL-aligned
evaluation semantics (commutative `RuleError` absorption, strict type
comparisons, production compile limits, and the 1,000-expression evaluation
budget `EXPRESSION_BUDGET` with production-measured per-call stdlib costs) and
ship 18 `2+modules` standard-library user modules under
`packages/pyric/src/rules/modules/stdlib/` (`atomic`, `auth`, `content`,
`counters`, `fairness`, `geometry`, `joining`, `lifecycle`, `lobby`,
`membership`, `results`, `spaces`, `state`, `storage/objects`, `timing`,
`transitions`, `turns`, `validation`).

RTDB rules have no functions, so their standard library is TypeScript instead:
`rtdbStdlib` from `pyric/rules` (`packages/pyric/src/rules/rtdb/stdlib/`)
groups constraint builders into modules (`auth`, `collections`, `counters`,
`lifecycle`, `lobby`, `membership`, `presence`, `results`, `timing`, `turns`,
`validation`) that return whole `.write` or `.validate` expressions for
`defineRtdbRules`. `rtdbRules` reads raw `database.rules.json` text (comments
and trailing commas included) as well as parsed objects, and
`rtdbRules.fromFirebaseJson` with `RtdbCase.instance` simulates rules across
multiple RTDB instances.

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
own the mode plumbing. Studio and the runtime chip surface the active mode,
resolved model routing, request rates, and broker rejections.

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

- `surfaces/` defines each measured surface and what it owns (Web surfaces
  `app`, `auth`, `firestore`, `rtdb`, `rtdb-modular`, `storage`, `messaging`,
  `messaging-sw`, `ai`; Admin/Node surfaces `messaging-admin`, `storage-admin`,
  `functions-rtdb`; Rules surfaces `firestore-rules`, `rtdb-rules`,
  `storage-rules`; and native mobile integration surfaces
  `{auth,firestore,rtdb}-{flutter,kotlin,swift}`);
- `registry/` owns every published conformance row, one file per service;
- `observations/<surface>/<name>.json` stores frozen Firebase behaviour;
- `probes/<surface>/<name>.ts` replays observations against Pyric;
- `rules-corpus/<engine>/<scenario-id>.ts` holds the `firestore`, `rtdb`, and
  `storage` rules scenarios that captured rules observations must match;
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

`firestore` (104/104 runtime, 78/78 types), `rtdb-modular` (44/44 runtime,
15/15 types), and `messaging` (5/5 runtime, 8/8 types) currently report 100%
public runtime and exported-type surface coverage (`overall` baseline: 91.3%
runtime, 73.3% types). Rules conformance is oracle-backed across Firestore,
RTDB, and Storage: constructs are scored per engine and published as scorecards
through `compat:rules-score`.

Any PR that changes a published number, status, denominator, snapshot, or
assurance capability needs an adversarial coverage review (`coverage-adversary`
skill) and must satisfy the engine↔evidence coupling gate
(`scripts/ci/conformance-coupling-gate.sh`).

## Documentation and the site

One Astro build owns both the documentation and the Studio shell (ADR-0010).
`DOCS_BASE` selects the root for the public site or `/__pyric/ui/` for the tree
embedded into `@pyric/cli`. Documentation stays static HTML and starts no
SharedWorker; Studio entry pages hydrate the shared React application.

Authored documentation is plain nested markdown with plain-YAML front matter
under `packages/site-docs/src/content/`, organised by outcome rather than by
package: `get-started/`, `build/`, `secure/`, `observe/`, `ship/`, `agent/`,
`trust/`, `reference/`, `examples/`, plus `overview.md`, `tutorial.md`,
`rhythm.md`, and `examples.md`. Authored pages have no content collection and
no zod schema; they are discovered by `import.meta.glob` (`src/lib/content.ts`)
and validated by the build's own assertions. Pages link each other by relative
`.md` path, and `src/lib/remark-doc-links.ts` resolves those to routes and
fails the build on a broken link.

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
groups, broken links, guide import specifiers/exports, and every
`pyric can-i-use` example; a broken doc fails the build.

## Build and tests

Install with the pinned Bun version from CI (`1.3.11`), then use the root
scripts:

```bash
bun install
bun run build
bun test
bun run compat:check
bun run tool:parity:check
npm run test:packaging
```

`scripts/build.sh` runs four phases: clean every `dist/`, emit declaration
stubs for the workspace (building `pyric` first so the CLI prebuild can derive
its ignored conformance projections from the live export surface), run full
strict builds in topological order, and finally build the unified Astro site at
`/__pyric/ui/` and copy it into `packages/cli/dist/serve/site-ui/`.
`--packages-only` skips the Astro phase (preserving any existing `site-ui/`
build across the clean) and is what `pretest` uses.

`.github/workflows/build.yml` starts with a fail-closed proof-selection job
(`scripts/ci/plan.ts`, `CI_SELECTION_MODE: enforce`) and then runs:

- `deletion-guard` on pull requests, which fails a PR that deletes test files
  or CI jobs unless its body carries a `Removes tests: <reason>` line;
- `knip-audit`, advisory (`continue-on-error`) on full check sets;
- `build-packages` (with content-keyed `.github/actions/restore-dist` caching,
  observation-version guard, and `tool:parity:check`);
- 2-shard `build-and-test` (`test:ci:cli`);
- `rtdb-differential`, which runs seeded RTDB operation sequences on the
  in-page sandbox, the SharedWorker host, and the Node host and compares them;
- `app-scenarios` (the `test/apps/` suite) when `plan.ts` selects it;
- 2-shard `library-tests` (`test:ci:libraries:core`: `packages/pyric` split
  by `scripts/ci/test-shard.ts --package=pyric`, the rest on shard 2) and
  `conformance-suite` (`packages/conformance`), split onto separate runners to
  avoid CPU contention;
- `conformance-gates` (`scripts/ci/conformance-coupling-gate.sh` and
  `scripts/ci/conformance-gates.sh`);
- `browser-conformance` (Playwright suites for served app + SharedWorker,
  runtime identity, Flow treatments, listener overlay contract, CLI-hosted
  Studio, public Studio, and `test:hosted-smoke` for the Node host);
- `native-conformance` (Kotlin, Flutter, and Swift client test suites);
- conditional `packaging`, `install-matrix` (`npm`, `pnpm`, `bun`),
  `standalone`, and `release-contract` jobs when `plan.ts` selects packaging or
  the `ci-packaging` label is present; and
- `required` (`scripts/ci/required.ts`), which verifies every selected proof
  passed.

`oracle-recapture.yml`, `simulator-parity.yml`, and `playground-contract.yml`
are the other workflows.

## Working conventions

- Read `PRIORITIES.md` before proposing work.
- Read `docs/code-conventions.md` before changing module boundaries. It extends
  the file-per-record convention to source: one public entry barrel per
  mirrored surface, one file per API family, sandbox code under `X/sandbox/`,
  tests mirroring the source path.
- Ratified and proposed decisions live in `docs/decisions/` (ADR-0001 to
  ADR-0016, plus ADR-0018 to ADR-0020). Key architectural records include ADR-0009
  (Firestore engine deepening), ADR-0010 (unified Astro site), ADR-0011 (worker
  transport as public API), ADR-0014 (ten service tools carrying SDK method
  names), ADR-0015 (chunked Storage transfer), ADR-0016 (`pyric mcp` following
  the Node host), ADR-0018 (Storage object bytes by reference and HTTP byte
  route), ADR-0019 (native bridge clients reconnect and restore their
  listeners), and ADR-0020 (`pyric mcp` serves one tool list and routes each
  call to a live host, with SharedWorker hosts running method records over a
  `method-call` bridge frame).
- Preserve unrelated work in a dirty tree.
- Use public subpaths between packages.
- Keep browser/Node/platform-specific imports at explicit boundary modules.
- Generated sources name their owner command; regenerate rather than editing.
- Treat unsupported behaviour as an explicit error or documented gap, never a
  silent approximation.
