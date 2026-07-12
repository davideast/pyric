# Pyric - Context Document

Last updated: 2026-07-12. Refreshed against `main` after a large conformance and
structure effort (~30 merged PRs). The full operating manual for the conformance
system lives in `packages/conformance` (its README is the map; a how-to covers
what to run and how to find gaps by name).

**Orientation, current `main`.** The conformance machinery is now a first-class
package, `packages/conformance` (not `scripts/`). `pyric/rules` has a new,
small public API (clean break). `pyric/app` mirrors the client app registry.
New surfaces admitted since the last refresh: `messaging`, `ai`, and three
native rules surfaces (`firestore-rules`, `storage-rules`, `rtdb-rules`).
Several God-files were split into per-family modules (worker client + host,
firestore entry, sandbox types, admin-firestore). `docs/code-conventions.md`
now records the ratified conventions (one record per file, filename-as-key,
computed aggregation, surface anatomy). Versioning: pyric keeps its own semver;
Firebase compatibility ships as `fb<major>.<minor>` npm dist-tags (see
`docs/`).

Rules production-verified coverage as of this writing: firestore 128/140,
storage 55/55, rtdb 18/55 (climbing). Mirror surface coverage runs from auth
(lowest, ~38%) up; see `bun run compat:coverage` for the live table — always
prefer running it over trusting a number written here.

This is a Bun-managed monorepo for **Pyric: Firebase for agents**. `pyric`,
`pyric-admin`, `pyric-tools`, and `@pyric/ui` published their first npm alpha
on 2026-07-09. The public site (pyric.dev) and a generated docs site are now
part of the repo, `pyric serve` was renamed `pyric dev`, and the sandbox
persistence model gained browser-IndexedDB worker-mode defaults across
Firestore, Auth, RTDB, and Storage.

The old repo context is still useful for intent, but several names, paths, and
release assumptions are stale in the current repository.

## Contents

1. [What This Project Is](#what-this-project-is)
2. [Current Shape](#current-shape)
3. [Workspace Layout](#workspace-layout)
4. [Package Surfaces](#package-surfaces)
5. [Architecture](#architecture)
6. [CLI Surface](#cli-surface)
7. [Packaging Contract](#packaging-contract)
8. [Compatibility And Oracle Gates](#compatibility-and-oracle-gates)
9. [CI And Setup](#ci-and-setup)
10. [Docs, Skills, And Plugin](#docs-skills-and-plugin)
11. [Known Stale Or Different](#known-stale-or-different)
12. [Release State](#release-state)
13. [Verification Probes](#verification-probes)

## What This Project Is

Pyric is a Firebase-shaped SDK and toolchain built so developers and AI agents
can work against Firebase semantics without immediately touching a live project.

The strategy is still the Firebase mirror:

- `pyric` mirrors the modular Web SDK package shape (`firebase/*`) while adding
  in-process sandboxing, rules tooling, replay, and local test helpers.
- `pyric-admin` mirrors `firebase-admin`.
- `pyric-tools` mirrors the useful local/deploy/control-plane shape of
  `firebase-tools`.
- `@pyric/ui` contains headless React components for Firebase/Pyric admin
  surfaces.
- `@pyric/studio` is the local data-management and debugging console served by
  `pyric dev --ui`.
- `@pyric/playground` is a private in-browser agent playground package. It is
  built into `pyric-tools` for `pyric dev`/embedded playground use, but it is
  not a public npm package.

The project is still alpha. Mirrored Firebase surfaces are best-effort mirror
contracts backed by compatibility docs, tests, and oracle observations where
available. Non-mirrored Pyric APIs are public-alpha surfaces when exported, not
stable semver promises.

## Current Shape

Root package: `pyric-monorepo`.

Workspace patterns:

```json
[
  "packages/*",
  "examples/admin-playground",
  "examples/vite-sandbox-app"
]
```

Package directories:

```text
packages/
  playground      @pyric/playground  Private Astro playground and agent demo
  pyric           pyric              Web SDK mirror + sandbox + rules
  pyric-admin     pyric-admin        Admin SDK mirror
  pyric-tools     pyric-tools        CLI, bridge, dev server, deploy, verify
  ui              @pyric/ui          Headless React components and hooks
  studio          @pyric/studio      Local sandbox console served by --ui
  site-docs       @pyric/site-docs   Astro docs site over every package's docs
```

`packages/site-docs` is new since the previous refresh: an Astro static-site
generator that composes every `packages/<pkg>/docs` directory into one browsable
docs site, plus `/llms.txt` and `/docs/index.json`.

Current test count from `find packages -name "*.test.ts" -o -name "*.test.tsx"`:

| Package | Test files |
|---|---:|
| `@pyric/playground` | 95 |
| `pyric` | 252 |
| `pyric-tools` | 117 |
| `@pyric/ui` | 82 |
| `pyric-admin` | 39 |
| `@pyric/studio` | 29 |
| **Total** | **614** |

The root `test` script runs `pyric`, `pyric-admin`, `pyric-tools`, `@pyric/ui`,
and `@pyric/studio`. It does not run the large `@pyric/playground` test suite
or `@pyric/site-docs`'s own test/audit suite.

The root `overrides.firebase` pins `firebase` to `12.13.0`, while publishable
package manifests generally declare `firebase` as `^12.12.0` or `^12.13.0`.
`firebase-admin` is `^13.0.0`.

## Workspace Layout

```text
pyric/
  packages/
    pyric/            Core package: app, auth, firestore, database, storage,
                      rules, firestore-values, sandbox.
    pyric-admin/      Admin-shaped app/auth/firestore/database/storage.
    pyric-tools/      CLI, dev server, bridge, deploy, verify, auth config,
                      discover, credentials, registry, Vite integration.
    ui/               Headless React components/hooks for auth, Firestore,
                      storage, traffic, events, agents, rules, primitives.
    studio/           Vite/React local console for pyric dev --ui.
    playground/       Private Astro playground / agent workspace.
  examples/
    vite-sandbox-app  Reference app shape generated by pyric init.
    admin-playground  @pyric/ui component showcase.
  docs/
    agent-tools.md    Agent tool inventory.
  pyric-plugin/       Claude Code plugin: MCP proxy, start skill, agent prompt.
  .agents/skills/     Repo-local skills.
  .github/workflows/  build and simulator parity workflows.
  scripts/            Build, packaging, install matrix, compat, oracle gates.
```

Notably absent compared with the old context: `plans/`, `prompts/`, `spike/`,
root `test-skill*.ts`, package husk directories, and `packages/mcp`.

`examples/playground-next` has moved into `packages/playground`; the tracked
playground source of truth is now `packages/playground`.

## Package Surfaces

### `pyric`

Version: `0.1.0-alpha.8`, published to npm. ESM-only, subpath-only, Node `>=22`.

Exports:

| Subpath | Purpose |
|---|---|
| `pyric/app` | `initializeApp`, sandbox/prod app target tagging. |
| `pyric/firestore` | Modular Firestore mirror plus Firestore data/inspect tools. |
| `pyric/auth` | Modular Auth mirror, sandbox identity, providers, popup/redirect resolver. |
| `pyric/database` | Realtime Database surface and RTDB tooling. |
| `pyric/database/modular` | Tree-shakable RTDB modular SDK shim. |
| `pyric/storage` | Modular Storage mirror and storage admin-style tools. |
| `pyric/rules` | The rules public API (see below). |
| `pyric/firestore-values` | Firestore value helpers/wrappers. |
| `pyric/sandbox` | Sandbox lifecycle, events, persistence, replay, branches. |
| `pyric/sandbox/internal` | Adapter-only internal protocol. |
| `pyric/sandbox/admin-compat` | Chainable admin-Firestore-shaped sandbox wrapper. |
| `pyric/sandbox/admin-firestore` | Internals backing the admin-compat layer. |

The full exports set also includes `pyric/messaging`, `pyric/messaging/sw`,
`pyric/ai`, `pyric/app`, and internal-only seams (`pyric/rules/internal*`,
`pyric/storage/internal`, `pyric/sandbox/internal`). `pyric/messaging` and
`pyric/ai` are conformance-held but pack-time stripped from published tarballs
until graduation.

Dependencies include `@inbrowser/agent@0.4.0`, `firebase`, `firebase-admin`,
`ohm-js`, `zod`, hashing helpers, and `fake-indexeddb`.

#### The `pyric/rules` public API

`pyric/rules` was a large accidental surface (~135 exports across five
subpaths); it is now a deliberate one, a **clean break** documented in
`packages/pyric/CHANGELOG.md`. The public surface, on the one `pyric/rules`
subpath:

- `firestoreRules(source)` and `rtdbRules(defOrDocOrJson)` — constructors
  returning safe-by-default handles: `.lint()`, `.simulate(cases)` (never throws
  on a rule outcome), `.explain(case)`, `.toJSON()`.
- `lint(source)` — a tolerant free function (the AI-authoring front door).
- `assertCase(...)` / `explainCase(...)` — the assertion adapter (the only
  throwing verbs).
- The RTDB constraints DSL (`defineRtdbRules` plus the combinators),
  re-exported unchanged; the DSL document is now inert data.

Engine internals (parser, evaluator, IR, tool factories, the composite-index
extractor with its TypeScript-compiler dependency) live behind
`pyric/rules/internal*` seams, not on the public surface. The old
`pyric/rules/{node,extract,rtdb,rtdb/constraints,rtdb-constraints}` subpaths are
gone.

### `pyric-admin`

Version: `0.1.0-alpha.8`, published to npm (lockstep with `pyric`). ESM-only,
subpath-only, Node `>=22`.

Exports:

- `pyric-admin/app`
- `pyric-admin/firestore`
- `pyric-admin/auth`
- `pyric-admin/database`
- `pyric-admin/storage`

It depends on `pyric` and `firebase-admin`. Sandbox backends route into
`pyric/sandbox`; prod backends delegate to real `firebase-admin`.

### `pyric-tools`

Version: `0.1.0-alpha.8`, published to npm (lockstep with `pyric`). ESM-only,
Node `>=22`, binary name `pyric`.

Exports:

| Subpath | Purpose |
|---|---|
| `pyric-tools/deploy` | Programmatic Firebase deploy/control-plane helpers. |
| `pyric-tools/register` | Register/registry composition entry point. |
| `pyric-tools/registry` | MCP/tool registry composition. |
| `pyric-tools/credentials` | Credential abstractions shared by tools. |
| `pyric-tools/credentials/node` | Node credential resolvers/stores. |
| `pyric-tools/verify` | Captured-session replay, fixture, and case derivation APIs. |
| `pyric-tools/bridge` | Conditional server/client bridge export. |
| `pyric-tools/bridge/client` | Client-only bridge surface. |
| `pyric-tools/discover` | Firestore structure discovery. |
| `pyric-tools/auth` | Identity Toolkit provider/domain tools. |
| `pyric-tools/remote` | Remote sandbox dispatch (Firestore, Auth, RTDB, Storage) over the bridge WS. |
| `pyric-tools/vite` | Vite integration. |
| `pyric-tools/serve/worker` | Browser-safe SharedWorker client surface for served Studio/Playground. |

The `pyric-tools/bridge` export has `node`, `browser`, and `default` import
conditions, but no CommonJS `require` condition.

### `@pyric/ui`

Version: `0.1.0-alpha.8`, published to npm (lockstep with `pyric`). ESM-only,
Node `>=22`, React `>=19`.

Exports:

- `@pyric/ui/auth`
- `@pyric/ui/auth/hooks`
- `@pyric/ui/primitives`
- `@pyric/ui/firestore`
- `@pyric/ui/firestore/hooks`
- `@pyric/ui/rtdb`
- `@pyric/ui/storage`
- `@pyric/ui/storage/hooks`
- `@pyric/ui/traffic`
- `@pyric/ui/traffic/hooks`
- `@pyric/ui/events`
- `@pyric/ui/events/hooks`
- `@pyric/ui/agents`
- `@pyric/ui/rules`
- `@pyric/ui/rules/hooks`

The package is headless: consumers provide styling via `className` and `data-*`.
`@tanstack/react-virtual` is its only runtime dependency. React, Firebase,
Pyric, and optional `@inbrowser/agent` are peers.

### `@pyric/studio`

Version: `0.0.0`.

Purpose: "Firebase console for Pyric" served by `pyric dev --ui`.

Exports:

- `@pyric/studio/ports`
- `@pyric/studio/env`

The root build produces the Studio app with base `/__pyric/ui/` and copies it
into `packages/pyric-tools/dist/serve/studio-ui/` so `pyric-tools` ships the UI
inside its `dist` file set.

Feature surface lives under `packages/studio/src/features/`: History-API
routing, a Home tab with an activity feed and a command palette (⌘K, live
resource typeahead including Firestore subcollections/collection groups), a
Firestore document tree with a composable create modal, an RTDB console-form
tree viewer, per-user Auth provider editing against the canonical
`FEDERATED_PROVIDER_IDS` from `pyric/auth`, a Storage browser, a Traffic view
(Timeline / Billable metrics / Subscriptions & Rules tabs with provenance
filtering), and a Rules Inspector where both allow and deny rows expand
in place with matched-rule source, a sub-expression evaluation trace, and
`?inspect=<id>` deep links.

### `@pyric/playground`

Version: `0.0.1`. Private workspace package.

Purpose: Astro/React in-browser playground, agent shell, BYOK/inference flows,
virtual preview bundling, session storage, GitHub import/export, fixtures,
evals, and embedded Studio integration.

It is not exported as a public package. The root build produces the Playground
app with base `/__pyric/playground/` and copies it into
`packages/pyric-tools/dist/serve/playground-ui/`.

### `@pyric/site-docs`

Version: `0.0.1`. Private workspace package, not published.

Purpose: an Astro static-site generator that scans every `packages/<pkg>/docs`
directory and composes it into one browsable docs site, with a directory-format
tree and flat `.md` twins per page, an `/llms.txt` summary, a `/docs/index.json`
search index, and a rhythm-audit page (`_rhythm`) backed by a Playwright suite
in its own tests.

The docs site is built twice from the same source:

- As the public docs section of pyric.dev (`scripts/build-site.sh`).
- Embedded into `pyric-tools` and served locally by `pyric dev --ui` at
  `/__pyric/ui/docs/`, with a `DOCS_BASE=/__pyric/ui/` env var parameterizing
  the base path (see `scripts/build.sh`). The Studio header's Docs tab probes
  `<base>/docs/index.json` at runtime and only renders the tab when a docs
  build was actually composed alongside it.

## Architecture

Backend selection still happens once, at app initialization.

```ts
import { initializeApp } from 'pyric/app';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, collection, getDocs } from 'pyric/firestore';

const app = initializeApp({ sandbox: initializeSandbox() });
const db = getFirestore(app);
const snap = await getDocs(collection(db, 'posts'));
```

The same shape repeats across Auth, Firestore, RTDB, Storage, Admin, tools, UI,
Studio, and Playground:

- App code imports Firebase-shaped APIs.
- Pyric dispatches on a target marker to sandbox or prod.
- The sandbox owns local state, rules, identities, event streams, replay, and
  branch/persistence semantics.
- Tools and UI packages consume the same public handles rather than private
  implementation objects where possible.

The important alpha split:

- Mirrored Firebase APIs are the product contract, even while incomplete.
- Non-mirrored exported APIs such as `pyric-tools/serve/worker`,
  `pyric/sandbox/internal`, Studio ports, and verification helpers are
  public-alpha utility surfaces. They may change quickly, but they still must
  install, type-resolve, and import correctly from published tarballs.

### Persistence model

`pyric dev`'s default sandbox target runs in a SharedWorker with browser
IndexedDB as the state home. It is acked-means-committed: the worker awaits
the IndexedDB commit before acknowledging any mutating op, for Firestore,
Auth, and (as of 2026-07-09) RTDB, which is now registered as a
`PersistableService` alongside the others. Storage keeps its own always-on
IndexedDB store, separate from the shared persistence registry. Event history
rehydrates at worker boot from the capture file over `GET /__pyric/capture`
(instance-id guarded and capped).

Flags on `pyric dev` layer on top of that default:

- `--persist` mirrors state to `.pyric/state/state.json` on disk, primed once
  at boot.
- `--seed FILE` applies a seed only into an otherwise-empty home (a guardrail
  against clobbering live state).
- `--fresh` requires `--persist` (a hard error without it) and discards the
  existing state file, but does not clear browser IndexedDB.

The coverage matrix for these interactions lives in
`packages/pyric-tools/docs/how-to/serve-persistence-and-multi-tab.md`. A
further persistence-API redesign (three explicit state homes — memory,
browser, file — a `--reset` handshake, and storage unification) is designed
but not built; treat it as direction, not shipped behavior.

### Sandbox-build mode

The Vite plugin (`pyric-tools/vite`) swaps `firebase/*` imports for the Pyric
sandbox shim always in `vite dev`, and in `vite build` whenever `mode !=
production` (or the `swapInBuild` plugin option is set). Builds produced this
way carry a marker (`packages/pyric-tools/src/serve/sandbox-marker.ts`).
`pyric dev` hard-refuses to serve a bundle that inlines the real Firebase SDK,
and `pyric deploy hosting` refuses to deploy a marked sandbox build. Marked
pages get meta-only sandbox injection at serve time — the bundle itself owns
the runtime. `pyric dev` also ships a fallback favicon for served apps that
don't provide one.

## CLI Surface

The binary is `pyric` from `pyric-tools`.

Documented subcommands include:

- `pyric init [dir]`
- `pyric bridge`
- `pyric dev [--port N] [--host H] [--ui] [--bridge] [--seed FILE] [--persist]
  [--fresh] [--no-run] [--no-watch] [--no-open] [--no-capture] [--no-cache]
  [--json] [-- <cmd>]`
- `pyric snapshot [--out=FILE]`
- `pyric verify [fixture|dir]`
- `pyric verify cases [fixture]`
- `pyric deploy <rules|indexes|database|hosting|functions>`
- `pyric rules:lint <path>`
- `pyric rules:validate <path>`
- `pyric rules:simulate`
- `pyric database:rules:lint <path>`
- `pyric database:rules:validate <path>`
- `pyric database:rules:simulate`
- `pyric auth:configure-provider <id> <enabled>`
- `pyric auth:manage-domains <add|remove|list> [domain]`

`pyric serve` was renamed `pyric dev`; there is no `serve` alias. Default port
is 3473 ("FIRE" on a phone keypad), and it scans forward when taken. `pyric
dev` wraps a child dev-script runner by default; `--no-run` skips running a
child command for users with their own process manager (`--json` implies
`--no-run`).

The current CLI docs live under `packages/pyric-tools/docs/reference/cli.md`.

## Packaging Contract

Publishable packages in the packaging gate:

- `packages/pyric`
- `packages/pyric-admin`
- `packages/pyric-tools`
- `packages/ui`

`@pyric/studio` and `@pyric/playground` are embedded into `pyric-tools` as
runtime assets, not packed as part of the packaging gate.

The release gates:

- `bash scripts/build.sh`
- `bash scripts/manifest-lint.sh`
- `bash scripts/packaging-test.sh`
- `bash scripts/install-matrix.sh`

The manifest gate runs `publint`, `attw`, and `scripts/lib/check-exports.mjs`
over built packages. The packaging gate packs tarballs, rewrites leftover
`workspace:*` dependencies, installs into a fresh consumer project, checks
runtime assets, smokes subpath imports, and verifies the CLI binary.

Previously the runtime-smoke subpath lists in `scripts/packaging-test.sh` were
hand-maintained and had drifted behind package manifests (a P0 fixed before
launch). They are now derived at run time from each package's
`package.json` `exports` map (`exported_subpaths()` in that script), so the
smoke test cannot drift behind newly added public exports again.

`scripts/pack-packages.sh` also swaps the root `README.md` into
`packages/pyric`, `packages/pyric-admin`, and `packages/pyric-tools` at pack
time (copy, not symlink, restored after), so the npm-facing README for those
three packages is the repo root README rather than the in-repo package doc.
`scripts/publish-alpha.sh <version>` drives the actual `npm publish` step.

## The Conformance System

The conformance system is its own workspace package: `packages/conformance`
(private, `@pyric/conformance`). It moved out of `scripts/compat` and
`scripts/oracle` entirely; those directories are gone. Its tests run in the
root test chain, so its integrity checks gate CI by construction.

Its layout follows one convention at every level: **one record per file, the
filename is the join key, the directory is the index, aggregation is always
computed.** Nothing is hand-aggregated.

```text
packages/conformance/
  surfaces/<surface>.ts        intent records; kind: 'mirror' | 'native'
  registry/<surface>.ts        claims (rows) — the ONLY place a claim lives
  observations/<surface>/<name>.json   ┐ twin trees: identical paths,
  probes/<surface>/<name>.ts           ┘ different extensions
  rules-corpus/<engine>/<scenario-id>.ts   declarative rules scenarios
  rigs/<rig-id>.ts             capture-rig records (flat: rigs are mechanisms)
  exceptions/<name>.ts         typed per-observation exceptions
  rules-language/              per-engine construct snapshots + coverage reports
  assurance-capabilities/      authored dependency records + GENERATED statuses
  entry-path/                  quickstart programs (the cliff gate's corpus)
  baselines/                   committed ratchets
  src/                         machinery; capture apps under src/capture/
```

The evidence chain: an **oracle rig** probes production and freezes an
**observation**; a **registry row** cites it as evidence; **generated COMPAT
docs** render the rows; **gates** enforce that every link resolves. A probe file
and the observation it produces are filename twins, so evidence can always be
re-captured.

### Surfaces

`kind: 'mirror'` surfaces diff against an upstream `firebase/*` module (census).
`kind: 'native'` surfaces are pyric's own — no upstream to diff, so they declare
a `symbolSource` instead and publish no breadth percentage.

Mirror: `app`, `auth`, `firestore`, `rtdb-modular`, `storage`, `messaging`,
`messaging-admin`, `ai`. Native: `rtdb` (the agent-tools/host surface),
`firestore-rules`, `storage-rules`, `rtdb-rules`.

### Gates

`bun run compat:check` is the aggregate, and it runs in CI. It chains:

- `compat:validate` — registry/observation/rig referential integrity, both directions
- `compat:census-gate` — a ratchet over unmapped upstream exports
- `compat:generate --check` — the COMPAT docs match the registry
- `compat:entry-path` — a **cliff** (not a ratchet): the quickstart programs must run
- `compat:assurance:check` — the derived assurance capabilities are not stale
- `compat:coverage` — the published numbers, guarded against regression

Other commands: `compat:report` (inventory, high-risk unverified rows),
`compat:audit` (the evidence ratchet), `oracle:plan` (the capture-rig fleet and
what each needs to run), `compat:oracle-versions`, `compat:oracle-check`,
`compat:climb`, `compat:assurance`, `compat:census`, `compat:lint-terms`.

### Coverage axes

Three, and they are never conflated:

1. **Surface coverage** (mirrors only): mirrored exports over upstream exports.
   `total` counts everything; `intended` subtracts only what is genuinely out of
   scope. Work that is merely unbuilt stays in `intended` as honest debt.
2. **Behavior conformance**: `conforms` rows over evaluated rows. This is the
   fidelity of the implemented slice, never a completeness grade.
3. **Rules-language coverage** (rules engines): *language coverage* (constructs
   the simulator implements) and **production-verified coverage** (constructs
   exercised by a scenario whose verdicts production itself supplied). The second
   is the trust number: it cannot be authored, only earned by capture.

Every gate is a **ratchet, not a threshold** — the build fails when a number gets
worse, never for being low. The one exception is the entry-path cliff, because an
initialization failure breaks every user immediately.

### Assurance

`packages/conformance/assurance-capabilities/` holds authored records declaring
what each assurance capability *depends on*; the generator derives whether it
`supported` / `qualified` / `unsupported` from the graph (snapshot status,
capability probe, production-verified constructs, and divergence rows — a
diverged row downgrades every capability that depends on the diverged behavior).
A capability status is not authorable, and drift fails `compat:check`.

## CI And Setup

Expected setup:

```bash
bun install
bun run build
bun test
bun run lint:manifest
bun run test:packaging
bash scripts/install-matrix.sh npm   # the bare `bun run test:install-matrix`
                                      # script has no default PM and errors;
                                      # CI runs it once per npm/pnpm/bun
```

Network-sensitive or live Firebase checks live behind oracle/deploy/credential
flows and should not be assumed hermetic.

## Docs, Skills, And Plugin

Root docs:

- `README.md`
- `docs/agent-tools.md`

Package docs:

- `packages/pyric/docs`
- `packages/pyric-admin/docs`
- `packages/pyric-tools/docs`
- `packages/ui/docs`
- `packages/studio/README.md`
- `packages/playground/README.md`

`packages/site-docs` builds all of the `docs/` directories above (plus the
root README) into one generated site, served both at pyric.dev and embedded
into `pyric dev --ui` (see [Package Surfaces](#package-surfaces)).

Repo-local skills:

- `.agents/skills/playground-prompts`
- `.agents/skills/firebase-auth-model`

(See [Known Stale Or Different](#known-stale-or-different) for a stale path
reference in `playground-prompts`.)

The Claude Code plugin remains under `pyric-plugin/`.

## Known Stale Or Different

Compared with the original `firebase-agent-sdk` context and the first Pyric
port:

- `examples/playground-next` is no longer the tracked playground package.
  Current tracked source lives at `packages/playground`.
- `packages/playground` is private and additive; it should not drive pre-npm
  public API priority except where `pyric-tools` embeds it as a runtime asset.
- `pyric` now exposes RTDB modular/rules paths that were not present in the
  earlier migration snapshot.
- `pyric-tools` now exposes `pyric-tools/verify`, `pyric-tools/remote`,
  `pyric-tools/register`, and ships more RTDB deploy and serve support.
- `scripts/build.sh` comments still list four packages even though the build now
  also builds/embeds Studio, Playground, and the docs site.
- Several comments and docs still cite missing `plans/...` files.
- Several docs/comments still use dissolved old names such as `@pyric/rtdb`,
  `@pyric/firestore-rules`, `@pyric/deploy`, `@pyric/auth`, and
  `@pyric/sandbox`. Some are harmless historical comments; some should be
  migrated to current import paths before broad documentation polish. The RTDB
  compat registry (`scripts/compat/registry/rtdb.ts`) is the largest remaining
  concentration of `@pyric/rtdb` prose.
- `.agents/skills/playground-prompts/SKILL.md` still references
  `examples/playground-next`; it should point at `packages/playground`.
- `@pyric/studio` is still versioned `0.0.0` (it is not published, so this is
  plausibly intentional, but it is the last unpublished package still on
  `0.0.0`; `pyric-admin` and `@pyric/ui` moved to `0.1.0-alpha.8` at launch).

## Release State

`pyric`, `pyric-admin`, `pyric-tools`, and `@pyric/ui` published their first
npm alpha on 2026-07-09, all at `0.1.0-alpha.8`, lockstep-versioned. Both the
`alpha` and `latest` dist-tags point at `0.1.0-alpha.8`.

- License: Apache-2.0. `LICENSE` lives at the repo root and is copied into
  each publishable package directory (`packages/pyric`, `packages/pyric-admin`,
  `packages/pyric-tools`, `packages/ui`).
- Package metadata: all four publishable packages set `homepage` to
  `https://pyric.dev`, `repository` to `davideast/pyric` with a per-package
  `directory`, and `bugs` to the GitHub issues URL.
- `scripts/pack-packages.sh` swaps the root README into `pyric`, `pyric-admin`,
  and `pyric-tools` at pack time (the root README is the npm-facing doc for
  those three; `@pyric/ui` keeps its own package README).
- `scripts/publish-alpha.sh <version>` drives the publish step.
- The packaging runtime-smoke subpath drift called out in earlier snapshots of
  this doc is fixed: `scripts/packaging-test.sh` now derives its subpath list
  from each package's `package.json` `exports` at run time instead of keeping
  a hand-maintained array.

Recommended next work (not launch-blocking):

- Build the shared mirror ledger / export contract so package exports,
  compatibility docs, oracle evidence, and runtime smoke coverage stop drifting.
- Add characterization tests before any SharedWorker data-plane refactor.
- Decide whether `@pyric/studio` should move off `0.0.0` even though it stays
  unpublished, for internal version-tracking consistency.

## Verification Probes

Useful commands for future audits:

```bash
git status --short --branch
jq '.workspaces' package.json
for f in packages/*/package.json; do jq -r '.name + " " + (.version // "private")' "$f"; done
find packages -name '*.test.ts' -o -name '*.test.tsx' | awk -F/ '{count[$2]++} END {for (p in count) print p, count[p]}' | sort
npm view pyric dist-tags
rg -n 'playground-next' .agents packages docs examples scripts README.md package.json
rg -n 'plans/' .agents packages docs examples scripts README.md package.json
rg -n '@pyric/(auth|firestore|firestore-rules|rtdb|database|deploy|sandbox|storage)' packages docs examples scripts README.md .agents
bun run build
bun run lint:manifest
bun run test:packaging
bash scripts/install-matrix.sh npm
```
