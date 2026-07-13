# Pyric - Context Document

Last updated: 2026-07-12. Refreshed against current `main` after the
conformance system moved into its own workspace package, the `pyric/rules`
public API was replaced in one clean break, and the AI, messaging, and rules
surfaces were admitted to the compatibility registry.

This is a Bun-managed monorepo for **Pyric: Firebase for agents**. `pyric`,
`pyric-admin`, `pyric-tools`, and `@pyric/ui` published their first npm alpha
on 2026-07-09. The public site (pyric.dev) and a generated docs site are part
of the repo, `pyric serve` was renamed `pyric dev`, and the sandbox persistence
model has browser-IndexedDB worker-mode defaults across Firestore, Auth, RTDB,
and Storage.

This document is for someone who knows the codebase and needs catching up.
Every claim below was checked against the tree; the
[Verification Probes](#verification-probes) at the end reproduce the checks.

## Contents

1. [What This Project Is](#what-this-project-is)
2. [Current Shape](#current-shape)
3. [Workspace Layout](#workspace-layout)
4. [Package Surfaces](#package-surfaces)
5. [Architecture](#architecture)
6. [CLI Surface](#cli-surface)
7. [Packaging Contract](#packaging-contract)
8. [The Conformance System](#the-conformance-system)
9. [Versioning And Compatibility](#versioning-and-compatibility)
10. [CI And Setup](#ci-and-setup)
11. [Code Structure Conventions](#code-structure-conventions)
12. [Docs, Skills, And Plugin](#docs-skills-and-plugin)
13. [Known Stale Or Different](#known-stale-or-different)
14. [Release State](#release-state)
15. [Verification Probes](#verification-probes)

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
- `@pyric/conformance` is the private workspace package that holds the trust
  proof: the compatibility registry, the frozen production observations, the
  capture rigs, and the gates that turn them into the published number.

The project is still alpha. Mirrored Firebase surfaces are mirror contracts
backed by the conformance system. Non-mirrored Pyric APIs are public-alpha
surfaces when exported, not stable semver promises.

## Current Shape

Root package: `pyric-monorepo`.

Workspace patterns:

```json
["packages/*", "examples/admin-playground", "examples/vite-sandbox-app"]
```

Package directories:

```text
packages/
  conformance     @pyric/conformance  Private: registry, observations, rigs, gates
  playground      @pyric/playground   Private Astro playground and agent demo
  pyric           pyric               Web SDK mirror + sandbox + rules
  pyric-admin     pyric-admin         Admin SDK mirror
  pyric-tools     pyric-tools         CLI, bridge, dev server, deploy, verify
  ui              @pyric/ui           Headless React components and hooks
  studio          @pyric/studio       Local sandbox console served by --ui
  site-docs       @pyric/site-docs    Astro docs site over every package's docs
```

`packages/conformance` is the significant new package since the last refresh.
The compatibility machinery used to live under `scripts/compat` and
`scripts/oracle`; **both directories are gone.** Everything moved into the
package, and every `compat:*` root script now points there.

Test-file counts (`find packages -name '*.test.ts' -o -name '*.test.tsx'`):

| Package | Test files |
|---|---:|
| `pyric` | 286 |
| `pyric-tools` | 127 |
| `@pyric/playground` | 95 |
| `@pyric/ui` | 84 |
| `pyric-admin` | 45 |
| `@pyric/studio` | 30 |
| `@pyric/conformance` | 8 |
| **Total** | **675** |

The root `test` script runs `pyric`, `pyric-admin`, `pyric-tools`, `@pyric/ui`,
`@pyric/studio`, `@pyric/conformance`, and the tool-parity test. It does not run
the large `@pyric/playground` suite or `@pyric/site-docs`'s own test/audit suite.

The root `overrides.firebase` pins `firebase` to `12.13.0`; `firebase-admin`
resolves to `13.10.0`.

## Workspace Layout

```text
pyric/
  packages/
    pyric/            Core: app, auth, firestore, database, storage, rules,
                      ai, messaging, firestore-values, sandbox.
    pyric-admin/      Admin-shaped app/auth/firestore/database/storage/messaging.
    pyric-tools/      CLI, dev server, bridge, deploy, verify, auth config,
                      discover, credentials, registry, Vite integration.
    conformance/      The conformance system (see below).
    ui/               Headless React components/hooks.
    studio/           Vite/React local console for pyric dev --ui.
    playground/       Private Astro playground / agent workspace.
    site-docs/        Astro docs site composed from every package's docs/.
  examples/
    vite-sandbox-app  Reference app shape generated by pyric init.
    admin-playground  @pyric/ui component showcase.
  docs/
    agent-tools.md    Agent tool inventory.
    code-conventions.md   Ratified code structure conventions.
    conformance/cdd.md    Conformance Driven Development, the process for
                      admitting a new surface.
    site-rewrite/     The outcome-first docs guide (ported onto the site).
  pyric-plugin/       Claude Code plugin: MCP proxy, start skill, agent prompt.
  .agents/skills/     Repo-local skills.
  .github/workflows/  build and simulator parity workflows.
  scripts/            Build, packaging, install matrix. NOT compat/oracle
                      any more — those live in packages/conformance.
```

## Package Surfaces

### `pyric`

Version `0.1.0-alpha.8`, published to npm. ESM-only, subpath-only, Node `>=22`.

| Subpath | Purpose |
|---|---|
| `pyric/app` | Sandbox-only `initializeApp({ sandbox })` plus the mirrored client app registry: `getApp`, `getApps`, `deleteApp`, local `FirebaseError`, pinned `SDK_VERSION`, `onLog`, `setLogLevel`, `registerVersion`. It has no `firebase/app` runtime dependency; production imports stay on `firebase/app`. |
| `pyric/auth` | Modular Auth mirror, sandbox identity, providers, popup/redirect resolver. |
| `pyric/firestore` | Modular Firestore mirror plus Firestore data/inspect tools. |
| `pyric/firestore-values` | Firestore value helpers/wrappers. |
| `pyric/database` | Realtime Database surface and RTDB tooling. |
| `pyric/database/modular` | Tree-shakable RTDB modular SDK shim. |
| `pyric/storage` | Modular Storage mirror and storage admin-style tools. |
| `pyric/storage/internal` | Storage engine seam. |
| `pyric/ai` | Firebase AI Logic mirror (`getAI`, `getGenerativeModel`, generateContent, streaming, chat, function calling, countTokens). |
| `pyric/ai/scripting` | Scripted answer-engine seam for the AI sandbox. |
| `pyric/messaging` | Cloud Messaging client mirror. |
| `pyric/messaging/sw` | Service-worker messaging entry. |
| `pyric/messaging/internal` | Messaging broker seam. |
| `pyric/rules` | **The whole rules public API** (see below). |
| `pyric/rules/internal` | Engine internals seam. |
| `pyric/rules/internal/node` | Node-only filesystem-backed module resolution. |
| `pyric/rules/internal/extract` | Composite-index extraction. |
| `pyric/rules/internal/rtdb` | RTDB rules engine internals. |
| `pyric/sandbox` | Sandbox lifecycle, events, persistence, replay, branches. |
| `pyric/sandbox/internal` | Adapter-only internal protocol. |
| `pyric/sandbox/admin-compat` | Chainable admin-Firestore-shaped sandbox wrapper. |
| `pyric/sandbox/admin-firestore` | Internals backing the admin-compat layer. |

**`pyric/rules` was replaced in one clean break.** It previously shipped an
accidental public surface of roughly 135 exports across six subpaths
(`./rules`, `./rules/node`, `./rules/extract`, `./rules/rtdb`,
`./rules/rtdb/constraints`, `./rules/rtdb-constraints`), exposing parser
internals, simulator handlers, resolver plumbing, zod schemas, and tool
factories that were never part of the contract. Those five extra subpaths are
**gone**. What remains is one subpath and a small curated front door:

- two constructors, `firestoreRules()` and `rtdbRules()`, each yielding a
  ruleset handle with `lint()`, `simulate(cases)`, `explain(case)`, `toJSON()`;
- a tolerant top-level `lint()`;
- `assertCase()` / `explainCase()` for tests;
- the RTDB constraints DSL, re-exported unchanged as siblings.

Engine internals now sit behind the `pyric/rules/internal*` seams. The RTDB
constraints DSL document is inert. `packages/pyric/CHANGELOG.md` records the
break.

### `pyric-admin`

Version `0.1.0-alpha.8` (lockstep with `pyric`). ESM-only, subpath-only,
Node `>=22`. Exports: `pyric-admin/app`, `/auth`, `/firestore`, `/database`,
`/storage`, `/messaging` (messaging is new: the FCM send plane).

It depends on `pyric` and `firebase-admin`. Sandbox backends route into
`pyric/sandbox`; prod backends delegate to real `firebase-admin`.

### `pyric-tools`

Version `0.1.0-alpha.8` (lockstep). ESM-only, Node `>=22`, binary name `pyric`.

Exports: `pyric-tools/deploy`, `/register`, `/registry`, `/credentials`,
`/credentials/node`, `/verify`, `/bridge`, `/bridge/client`, `/discover`,
`/auth`, `/remote`, `/vite`, `/serve/worker`.

The `bridge` export has `node`, `browser`, and `default` import conditions, but
no CommonJS `require` condition.

The SharedWorker surface under `src/serve/worker/` is now split per family
rather than living in two large files: `worker/client/` (auth, firestore-reads,
firestore-writes, firestore-refs, rtdb, storage, rules, ai, snapshots, handles,
studio, admin-firestore, connection, core) and `worker/host/` (the matching host
halves plus dispatch and subscriptions), with `host-ai.ts`, `host-auth.ts`,
`host-events.ts`, `host-messaging.ts` alongside.

### `@pyric/ui`

Version `0.1.0-alpha.8` (lockstep). ESM-only, Node `>=22`, React `>=19`.

Exports: `/auth`, `/auth/hooks`, `/primitives`, `/firestore`, `/firestore/hooks`,
`/rtdb`, `/storage`, `/storage/hooks`, `/traffic`, `/traffic/hooks`, `/events`,
`/events/hooks`, `/agents`, `/rules`, `/rules/hooks`.

Headless: consumers provide styling via `className` and `data-*`.
`@tanstack/react-virtual` is its only runtime dependency.

### `@pyric/conformance`

Version `0.0.1`. **Private workspace package, never published.** This is the
project's trust proof: every "matches prod" claim traces back to a file in this
tree. Consumed only by the root `compat:*` / `oracle:plan` scripts and by CI.

```text
packages/conformance/
  surfaces/       one SurfaceDescriptorRecord per surface; filename is the key.
                  Each declares kind: 'mirror' (measured against an upstream
                  firebase/* module) or 'native' (Pyric's own API, no upstream).
  registry/       one CompatibilitySurfaceRegistry per COMPAT.md doc. Every
                  compatibility row lives here; the docs generate from it.
  observations/   frozen production captures, observations/<surface>/<name>.json
  probes/         probes/<surface>/<name>.ts — a TWIN TREE of observations/.
                  The filename is the join key; the surface directories must match.
  rules-corpus/   rules-corpus/<engine>/<scenario-id>.ts, one scenario per file.
                  A captured rules-* observation with no matching scenario is an
                  orphan and fatal in compat:validate.
  rigs/           one RigManifestRecord per capture rig, deliberately FLAT: a rig
                  is a capture mechanism, not a service (oracle-run alone spans
                  five surfaces).
  exceptions/     one file per observation allowed to exist uncited, with a reason.
  entry-path/     one canonical initialization program per service; the CLIFF gate.
  rules-language/ per-engine construct snapshots + three generated reports.
  assurance-capabilities/  the derived capability graph: what the evidence will
                  and will not back, and why.
  baselines/      committed ratchet baselines (coverage, census, audit).
  src/            all machinery: gates, reports, runners, loaders, tests.
  docs/           the operating manual (see below).
```

Its tests join the root test chain (`bun test --cwd packages/conformance`).

### `@pyric/studio`

Version `0.0.0`. "Firebase console for Pyric", served by `pyric dev --ui`.
Exports `@pyric/studio/ports` and `@pyric/studio/env`.

The root build produces it with base `/__pyric/ui/` and copies it into
`packages/pyric-tools/dist/serve/studio-ui/`. Its CSS is split into
`src/styles/{index,tokens,update-lights}.css`.

Feature surface under `packages/studio/src/features/`: History-API routing, a
Home tab with an activity feed and a command palette (⌘K, live resource
typeahead including Firestore subcollections/collection groups), a Firestore
document tree with a composable create modal, an RTDB console-form tree viewer,
per-user Auth provider editing against the canonical `FEDERATED_PROVIDER_IDS`
from `pyric/auth`, a Storage browser, a Traffic view, and a Rules Inspector
where both allow and deny rows expand in place with matched-rule source, a
sub-expression evaluation trace, and `?inspect=<id>` deep links.

### `@pyric/playground` and `@pyric/site-docs`

Both `0.0.1`, private. Playground is the Astro/React in-browser agent shell
(BYOK/inference, virtual preview bundling, sessions, GitHub import/export,
fixtures, evals, embedded Studio); it builds with base `/__pyric/playground/`
into `pyric-tools`' dist.

`site-docs` composes every `packages/<pkg>/docs` tree into one browsable site
with flat `.md` twins, `/llms.txt`, and `/docs/index.json`. Its port
(`packages/site-docs/scripts/port-content.ts`) walks the docs roots of `pyric`,
`pyric-admin`, `pyric-tools`, and `ui` only, and FAILS the build on an unclaimed
doc in any of them. `packages/conformance/docs/` is deliberately not among those
roots: it is maintainer documentation for a private package, not product docs.

## Architecture

Backend selection belongs to package resolution, not app initialization.

- Browser sandbox processes use the Vite/import-map layer to map canonical
  `firebase/*` imports to `pyric/*` mirrors.
- Node sandbox processes activate the register hook, which performs the same
  package swap before modules load.
- Production processes do not activate the swap and continue loading Firebase.
- Direct `pyric/*` imports mean sandbox behavior. `pyric/app` and
  `pyric/storage` already enforce this invariant; the remaining client service
  mirrors still have legacy production arms that are being removed behind the
  compiled-binding ratchet.

```ts
import { initializeApp } from 'pyric/app';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, collection, getDocs } from 'pyric/firestore';

const app = initializeApp({ sandbox: initializeSandbox() });
const db = getFirestore(app);
const snap = await getDocs(collection(db, 'posts'));
```

The same shape repeats across Auth, Firestore, RTDB, Storage, AI, Messaging,
Admin, tools, UI, Studio, and Playground:

- App code imports Firebase-shaped APIs.
- The resolver either keeps Firebase packages (production) or swaps them to
  Pyric packages (sandbox) before application modules load.
- The sandbox owns local state, rules, identities, event streams, replay, and
  branch/persistence semantics.
- Tools and UI consume public handles rather than private implementation objects.

The alpha split that matters:

- Mirrored Firebase APIs are the product contract, even while incomplete.
- Non-mirrored exported APIs (`pyric-tools/serve/worker`, `pyric/sandbox/internal`,
  the `pyric/rules/internal*` seams, Studio ports, verification helpers) are
  public-alpha utility surfaces. They may change quickly, but they must still
  install, type-resolve, and import correctly from published tarballs.

### Persistence model

`pyric dev`'s default sandbox target runs in a SharedWorker with browser
IndexedDB as the state home. It is acked-means-committed: the worker awaits the
IndexedDB commit before acknowledging any mutating op, for Firestore, Auth, and
RTDB (a `PersistableService` alongside the others). Storage keeps its own
always-on IndexedDB store, separate from the shared persistence registry. Event
history rehydrates at worker boot from the capture file over
`GET /__pyric/capture` (instance-id guarded and capped).

Flags on `pyric dev` layer on top:

- `--persist` mirrors state to `.pyric/state/state.json` on disk, primed at boot.
- `--seed FILE` applies a seed only into an otherwise-empty home.
- `--fresh` requires `--persist` (hard error without it) and discards the
  existing state file, but does not clear browser IndexedDB.

The coverage matrix lives in
`packages/pyric-tools/docs/how-to/serve-persistence-and-multi-tab.md`.

### Sandbox-build mode

The Vite plugin (`pyric-tools/vite`) swaps `firebase/*` imports for the Pyric
sandbox shim always in `vite dev`, and in `vite build` whenever
`mode != production` (or `swapInBuild` is set). Builds carry a marker
(`packages/pyric-tools/src/serve/sandbox-marker.ts`). `pyric dev` hard-refuses to
serve a bundle that inlines the real Firebase SDK, and `pyric deploy hosting`
refuses to deploy a marked sandbox build.

## CLI Surface

The binary is `pyric` from `pyric-tools`. Subcommands:

- `pyric init [dir]`
- `pyric bridge`
- `pyric dev [--port N] [--host H] [--ui] [--bridge] [--seed FILE] [--persist]
  [--fresh] [--no-run] [--no-watch] [--no-open] [--no-capture] [--no-cache]
  [--json] [-- <cmd>]`
- `pyric snapshot [--out=FILE]`
- `pyric verify [fixture|dir]` / `pyric verify cases [fixture]`
- `pyric deploy <rules|indexes|database|hosting|functions>`
- `pyric rules:lint|rules:validate|rules:simulate`
- `pyric database:rules:lint|database:rules:validate|database:rules:simulate|database:rules:generate`
- `pyric auth:configure-provider <id> <enabled>`
- `pyric auth:manage-domains <add|remove|list> [domain]`

`pyric serve` was renamed `pyric dev`; there is no `serve` alias. Default port
is 3473, scanning forward when taken. Current CLI docs:
`packages/pyric-tools/docs/reference/cli.md`.

## Packaging Contract

Publishable packages in the packaging gate: `packages/pyric`,
`packages/pyric-admin`, `packages/pyric-tools`, `packages/ui`. `@pyric/studio`
and `@pyric/playground` are embedded into `pyric-tools` as runtime assets.
`@pyric/conformance` and `@pyric/site-docs` are private and never packed.

Release gates: `bash scripts/build.sh`, `bash scripts/manifest-lint.sh`,
`bash scripts/packaging-test.sh`, `bash scripts/install-matrix.sh`.

The manifest gate runs `publint`, `attw`, and `scripts/lib/check-exports.mjs`
over built packages. The packaging gate packs tarballs, rewrites leftover
`workspace:*` deps, installs into a fresh consumer project, checks runtime
assets, smokes subpath imports (derived at run time from each package's
`exports` map, so it cannot drift behind new exports), and verifies the CLI.

`scripts/pack-packages.sh` swaps the root `README.md` into `pyric`,
`pyric-admin`, and `pyric-tools` at pack time.
`scripts/publish-alpha.sh <version>` drives `npm publish`.

## The Conformance System

The old "compatibility machinery lives under `scripts/compat`" section is
obsolete: **`scripts/compat` and `scripts/oracle` no longer exist.** Everything
lives in `packages/conformance` (layout above), and the generated docs remain at
`packages/pyric/docs/*/COMPAT.md`.

The governing rule is unchanged: **evidence flows in, claims flow out, and only
the registry changes claims.** No generated file is ever hand-edited.

**The daily gate is `bun run compat:check`**, which chains six gates in order:
`compat:validate` (evidence-graph linkage), `compat:census-gate` (no NEW unmapped
upstream symbol), `compat:entry-path` (the CLIFF: a canonical initialization
program per service, no baseline, no tolerance), `generate-docs --check`,
`compat:assurance:check`, and `compat:coverage` (regression-only).

There are seventeen `compat:*` / `oracle:*` commands. Rather than restate them,
**the operating manual is
`packages/conformance/docs/how-to-run-the-conformance-system.md`**: every
command with its real output, what each report means axis by axis, and — the
part worth knowing about — how to find out what is NOT covered *by name* rather
than by percentage (unmapped exports, non-conforming rows by id, uncredited
rules-language constructs, the capabilities the evidence graph refuses to back
and the dependency that sank each one). `packages/conformance/README.md` is the
map of what lives where; `packages/conformance/docs/oracle-project-setup.md` is
the capture-project credential contract.

Surfaces admitted since the last refresh: **messaging** (client + service worker)
and **messaging-admin** (the send plane), **ai** (Firebase AI Logic), and three
**native** rules surfaces — `firestore-rules`, `storage-rules`, `rtdb-rules`.
Classic `rtdb` was reclassified `native` as well: a native surface has no
upstream module, so it is measured against its own public API and its surface
column reads `native` rather than a breadth percentage.

Current published numbers (`bun run compat:coverage`, 2026-07-12):

| | surface (total / intended) | behavior (total / intended) |
|---|---|---|
| OVERALL | 53.5% / 62.9% | 87% / 90.4% |

with 60 `diverged-documented` rows, 13 `unverified`, 5 high-risk unverified, and
0 orphan observations, over 827 registry rows and 225 frozen observations. All
four entry-path programs are green. `intended` excludes only what is genuinely
out of scope; deferred work (intended, not yet built) deliberately stays in the
denominator as coverage debt.

Rules-language production-verified coverage per engine
(`packages/conformance/rules-language/coverage-report.json`): **firestore 91.4%
(128/140), storage 100% (55/55), rtdb 94.5% (52/55)**. Simulator language
coverage is firestore 97.8%, storage 100%, rtdb 100%.

Nine capture rigs are declared (`bun run oracle:plan`). Two run unattended with
no credentials at all (`admin-app`, `app-registry`: pure in-process probes of
installed library code). Six are credentialed. One (`messaging-web`) is
human-witnessed and cannot run headless. **There is no emulator anywhere in the
fleet and there never will be**; every observation is captured against real
production.

New surfaces are admitted under Conformance Driven Development
(`docs/conformance/cdd.md`): rows are authored first and born `unverified`, a red
conformance suite is derived from them, and implementation flips a row only when
its assertion set passes. `bun run compat:climb` is the (non-blocking) lane.

## Versioning And Compatibility

The policy doc is `packages/pyric/docs/explanation/versioning-and-compatibility.md`.

**Pyric keeps its own semver and never borrows Firebase's.** Pyric ships a large
surface Firebase does not have (sandbox runtime, rules tooling, CLI); renaming
itself to match Firebase's version would promise a parity the conformance
numbers do not support.

**Firebase compatibility ships as an npm dist-tag of the form `fb<major>.<minor>`**
(`npm install pyric@fb12.16`). The tag points at the newest pyric release whose
conformance gates pass against that Firebase line. It means "conformance-tested
against Firebase 12.16", not "equal to" or "at parity with" it. Patch levels are
never tagged. A tag moves only through the release script and only when
`compat:check` is green: it is a machine-issued certificate, not an opinion.

The current compat target is `fb12.13`
(`bun run packages/conformance/src/print-fb-tag.ts`). Note that **no `fb*`
dist-tag is published on npm yet** — `npm view pyric dist-tags` shows only
`latest` and `alpha`, both at `0.1.0-alpha.8`. The policy and the machinery
exist; the first tagged release has not happened.

## CI And Setup

Expected local setup:

```bash
bun install
bun run build          # bash scripts/build.sh
bun test
bun run compat:check
bun run lint:manifest
bun run test:packaging
bash scripts/install-matrix.sh npm   # bare `test:install-matrix` has no default PM
```

`.github/workflows/build.yml` runs, in order: `compat:lint-terms`, the audit gate
(`packages/conformance/src/audit-gate.ts`), the observation version guard, the
build, the oracle conformance gate, conformance graph integrity
(`compat:validate` + `compat:census-gate` + `generate-docs --check`),
`compat:entry-path`, `compat:assurance:check`, `compat:coverage` (published to
the job summary), and the tests. Packaging and install-matrix gates run only on
PRs carrying the `ci-packaging` label, so an ordinary green PR has **not** run
them; the full sequence above is mandatory before any publish.

Network-sensitive or live Firebase checks live behind the capture rigs and
should not be assumed hermetic. The gates above are all offline.

## Code Structure Conventions

`docs/code-conventions.md` is ratified and enforceable. The load-bearing rules:

- **One record per file; the filename is the key; the directory is the index.**
  Aggregation is computed by walking the directory, never hand-maintained in a
  barrel. This is why `surfaces/`, `rigs/`, `exceptions/`, `rules-corpus/`, and
  `assurance-capabilities/` each hold one record per file.
- **Junk-drawer prohibition** (testable): no `utils.ts`/`helpers.ts` catch-alls.
- **Barrel-file policy** and file-size/concern discipline.
- **Section 8, "the anatomy of a surface"**, is the canonical ruling:
  surface-local backend, cross-surface-only central sandbox, with an explicit
  dependency direction and a migration table. It also covers native (non-mirror)
  surfaces and the worker/serve entries.

Recent structural work that follows it: the worker client and host split into
per-family modules, the Firestore entry split (`aggregates`, `equality`,
`field-values`, `instances`, `listeners`, `persistence`, `query-constraints`,
`reads`, `refs`, `sandbox-ops`, `snapshots`), the sandbox `types` split
(`auth-state`, `context`, `errors`, `events`, `persistence`, `service`), the
admin-Firestore de-junk-drawering, and the Studio CSS split.

## Docs, Skills, And Plugin

Root docs: `README.md`, `docs/agent-tools.md`, `docs/code-conventions.md`,
`docs/conformance/cdd.md`, `docs/site-rewrite/` (the outcome-first guide).

Package docs: `packages/pyric/docs`, `packages/pyric-admin/docs`,
`packages/pyric-tools/docs`, `packages/ui/docs`,
`packages/conformance/docs`, plus `packages/studio/README.md` and
`packages/playground/README.md`.

`packages/site-docs` composes the first four (plus the guide and the COMPAT
matrices) into one generated site, served at pyric.dev and embedded into
`pyric dev --ui`. It does **not** compose `packages/conformance/docs` — that is
maintainer documentation for a private package.

Repo-local skills: `.agents/skills/playground-prompts`,
`.agents/skills/firebase-auth-model`. The Claude Code plugin is under
`pyric-plugin/`.

## Known Stale Or Different

- `.agents/skills/playground-prompts/SKILL.md` still references
  `examples/playground-next`; the tracked playground is `packages/playground`.
- The RTDB compat registry prose still uses dissolved old names such as
  `@pyric/rtdb`. The real export paths are `pyric/database`,
  `pyric/database/modular`, and the rules API at `pyric/rules`.
- `scripts/build.sh` comments still list four packages even though the build
  also builds/embeds Studio, Playground, and the docs site.
- **The rules-language reports have no freshness gate.** `COMPAT.md` and the
  assurance artifacts each have a `--check` gate; the three
  `packages/conformance/rules-language/*-report.json` files do not. A change that
  fixes the simulator without regenerating leaves the report understating the
  truth, and `compat:assurance` reads those reports. This has actually happened.
  Regenerate them after any change to the corpus, snapshots, or simulator.
- `packages/conformance/src/audit-gate.ts` has no `compat:*` alias; CI and humans
  invoke it by path.
- `bun run compat:census` exits **1** on a healthy tree by design (it reports the
  53 unmapped symbols). `compat:census-gate` is the gate, and it passes. Do not
  wire `compat:census` into a pipeline expecting 0.
- `bun run tool:parity:check` currently exits 1 on unannotated tools; it is
  tracked debt, not a green gate.
- `@pyric/studio` is still `0.0.0`.

## Release State

`pyric`, `pyric-admin`, `pyric-tools`, and `@pyric/ui` published their first npm
alpha on 2026-07-09, all at `0.1.0-alpha.8`, lockstep-versioned. Both the `alpha`
and `latest` dist-tags point at `0.1.0-alpha.8`; no `fb*` compatibility tag is
published yet.

- License Apache-2.0; `LICENSE` copied into each publishable package.
- All four publishable packages set `homepage` to `https://pyric.dev`,
  `repository` to `davideast/pyric` with a per-package `directory`, and `bugs`.
- `packages/pyric/CHANGELOG.md` exists and records the `pyric/rules` break under
  Unreleased.

## Verification Probes

Every command below was run against the current tree; the exit code after each
is what it actually returns.

```bash
git status --short --branch                                     # 0
jq '.workspaces' package.json                                   # 0
for f in packages/*/package.json; do jq -r '.name + " " + (.version // "private")' "$f"; done   # 0
jq -r '.exports | keys[]' packages/pyric/package.json           # 0  (the rules break is visible here)
find packages -name '*.test.ts' -o -name '*.test.tsx' | awk -F/ '{c[$2]++} END {for (p in c) print p, c[p]}' | sort   # 0
npm view pyric dist-tags                                        # 0  (no fb* tag yet)

bash scripts/build.sh                                           # 0  (build first: the census imports built packages)
bun run compat:check                                            # 0  (the daily gate: 6 gates chained)
bun run compat:lint-terms                                       # 0
bun run compat:coverage                                         # 0  (the published number + regression gate)
bun run compat:report                                           # 0  (row inventory, climb, high-risk worklist)
bun run compat:audit                                            # 0  (ranked capture worklist)
bun run oracle:plan                                             # 0  (rig fleet; inert, opens no network)
bun run compat:oracle-versions                                  # 0
bun run compat:oracle-check                                     # 0
bun run compat:climb                                            # 0  (non-blocking CDD lane)
bun run packages/conformance/src/audit-gate.ts                  # 0  (no compat:* alias)
bun run packages/conformance/src/print-fb-tag.ts                # 0  -> fb12.13

bun run compat:census                                           # 1  BY DESIGN — 53 unmapped symbols, named
bun run tool:parity:check                                       # 1  tracked debt, unannotated tools

# Confirm the old machinery is really gone (both should print nothing):
git ls-files | grep -E '^scripts/(compat|oracle)/'
rg -n 'playground-next' packages docs scripts README.md package.json
```

To find out what is not covered, by name rather than by percentage, use the
one-liners in
`packages/conformance/docs/how-to-run-the-conformance-system.md#find-the-gaps-by-name`.
