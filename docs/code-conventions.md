# Code structure conventions

This document extends the ratified data-record convention to source code. It is a rulebook. It states rules and the tests that decide whether code follows them.

## What this builds on

The data-record convention is already ratified. These rules are settled and are not relitigated here:

- Authored data is one record per file.
- The filename is the join key and exists nowhere else.
- The directory is the index. There are no hand-maintained barrels or aggregates over authored records.
- Aggregation is always computed, never hand-written.
- Generated artifacts are never edited or merged. They are regenerated.
- Ordering uses stable keys, never global counters.
- Captured evidence follows regenerate-don't-merge.

The exemplars in the tree are the compat registry (`packages/conformance/registry/*.ts`, one record file per service), the oracle observations (`packages/conformance/observations/*.json`, one observation per file, filename is the key, directory is the index), and the generated `COMPAT.md` documents. Source code now inherits the same discipline.

## 1. Directory shape for a mirrored surface

A mirrored surface is one Firebase capability the project reproduces: firestore, auth, database, storage, rules. Every surface has four parts. The rule fixes where each part lives.

Rule. For a surface named `X` in `packages/pyric/src`:

- The public entry is `X/index.ts`. It is a re-export barrel and nothing else. It is the package export contract.
- The public API implementation is one file per API family under `X/`. Families are `refs`, `reads`, `writes`, `query`, `aggregation`, `listeners`, `field-values`, `transactions`, and the surface's own additions. No family file exceeds the size limit in section 2.
- The sandbox implementation is under `X/sandbox/` or under `sandbox/X/`, one concept per file. It never lives in the public entry.
- The types are `X/types.ts` for a small surface, or `X/types/` (one file per subsystem, computed barrel) for a large one.
- The tests mirror the source path under `test/`, one test file per source concept.

The class of defect this fixes. Today the firestore public entry is `src/firestore/index.ts` and holds the client implementation inline, while the sandbox implementation lives in `src/sandbox/firestore/` and the admin adapter lives in a third place. The public entry and its implementation must live in one directory. A reader who opens the surface directory sees the whole surface.

Reference to align to. `firestore/sandbox/admin-compat/` already follows the one-concept-per-file rule: `batch.ts`, `doc-ref.ts`, `collection-ref.ts`, `collection-group-query.ts`, `query.ts`, `snapshots.ts`, `transaction.ts`, `paths.ts`, and a barrel; shared query ordering lives in `firestore/sandbox/query-value-order.ts`. Match that shape. The database surface partly follows it too: `database/sandbox/` already separates `query.ts`, `data-tree.ts`, `normalize.ts`, `rules-eval.ts`.

## 2. File size and concern discipline

One concept per file. A concept is one API family, one class and its private helpers, or one coherent algorithm.

Rule. A file must split when any of these is true:

- It exceeds 600 lines of source.
- It holds more than one exported class.
- It holds more than one API family.
- Its exports serve two audiences that change on independent schedules.

600 lines is the trigger, not the target. A file well under 600 lines that mixes two concepts still splits. A generated file is exempt from the line limit because it is never read for edits.

The God-object rule. A single class longer than 400 lines is a design smell, not a fact of life. Extract collaborators. The class that remains is a facade that wires collaborators and owns lifecycle. It does not own every algorithm.

## 3. Naming conventions

- Directories are lower-case, hyphen-free where one word suffices, hyphenated where two words are needed: `firestore`, `admin-firestore`, `field-values`. A directory name states the surface or the concept, never a role like `utils` or `helpers` or `misc`.
- Files are lower-case, hyphenated, and name the concept: `query-execution.ts`, `token-minting.ts`, `read-translation.ts`. A file name is a noun phrase for what the file is, not where it sits.
- The public barrel is always `index.ts`.
- Test files are the source file name plus `.test.ts`, at the mirrored path under `test/`. A test file tests exactly one source file.
- No file is named `utils`, `helpers`, `misc`, `common`, `shared`, or `index` with implementation in it. These names are the audit signal for a junk drawer.

## 3a. Documentation has one home per audience

- All user-facing product documentation lives under
  `packages/site-docs/src/content/`, as
  plain nested markdown with plain-YAML front matter (`title`, `group`, `order`,
  …). There is no second copy in a package's own `docs/` tree, and no content
  collection or zod schema — pages are discovered by `import.meta.glob` and
  validated by the site build's own assertions.
- Repository-maintainer runbooks live under root `docs/`. They document
  contributor-only operations such as publishing and local package testing and
  are not duplicated into the user-facing product documentation.
- A generated project template may include a README containing only the
  artifact-local commands and configuration needed to run that generated
  project. Canonical product concepts, explanations, and reference material
  remain under `packages/site-docs/src/content/`; template READMEs link there
  rather than becoming a second documentation set.
- Generated documentation is never committed: the conformance matrices and the
  TypeDoc API reference are written into `packages/site-docs/src/content/_generated/`
  (gitignored) by `bun run generate` immediately before `astro build`.
- Authored pages link each other by relative `.md` path; the site's remark
  plugin resolves those to routes and fails the build on a broken link.

## 3b. Conditional and fallback logic states its policy

Rule.

- Nested ternary expressions are prohibited.
- Prefer explicit `if`/`else` branches or a named helper over a ternary.
- A ternary is acceptable only when the complete expression fits on one line
  and both outcomes are short, simple values.
- If a ternary needs to wrap, performs work in either branch, or introduces a
  second condition, replace it with explicit control flow.
- Nullish-coalescing and logical-operator chains may express one obvious default.
  They must not encode precedence among values with different semantic roles.
- When fallback order is part of the behaviour, write one explicit branch per
  fallback and give each value a domain-specific name.
- Do not select a fallback and transform it in the same expression. Select the
  value first, then validate or transform it in a separate statement or named
  helper.
- Keep a condition inline when it expresses one obvious fact. Extract a
  positively named predicate when a compound or negated condition encodes a
  domain boundary, policy, eligibility rule, or state classification.
- The call site states the decision. The predicate contains the boolean
  mechanics and uses domain vocabulary rather than a generic name such as
  `isValid`.

The review test: can a reader identify every fallback, its precedence, and the
reason for it without mentally evaluating operators? If not, replace the
shorthand with explicit control flow.

The condition review test: can the condition be stated as one domain question?
If it can, the call site should ask that question through a named predicate
rather than restating its boolean algebra.

## 3c. Configuration assembly is explicit

Configuration objects must be assembled declaratively. Do not use conditional
object spreads, nested ternaries, or function calls hidden inside conditional
properties. Compute meaningful values first, make presence decisions with
explicit control flow, assign the finalized object to a descriptive variable,
and then pass it across the boundary.

Object spread is allowed for unconditional copying or extension of an already
complete object. It must not encode whether a property or feature exists.

If `undefined` and an absent property are equivalent, assign the named value
directly. If they differ, use explicit branches. Do not use truthiness as a
proxy for presence unless every falsy value intentionally means “absent.”

The review test: can the reviewer point to separate lines that compute, decide,
assemble, and invoke? If not, the expression is probably hiding too much.

## 4. Barrel-file policy

The ratified rule is: the directory is the index, and aggregation is computed, not hand-maintained. Source barrels align to it with one carve-out.

Rule.

- A barrel is a file whose only content is re-exports. A barrel holds no implementation. The moment a barrel declares a function body, it stops being a barrel and is subject to the split rules in section 2.
- Re-export barrels are allowed only where they are the package export contract, that is, a directory `index.ts` named in `package.json` `exports`. `./firestore`, `./auth`, `./database`, `./storage` point at these. They exist to give the package a stable import path.
- A public barrel re-exports from the family files in its own directory. It is regenerable by listing the directory. It carries no logic and no ordering that a global counter would impose. Its order follows the directory.
- Internal grab-bag barrels that exist only to shorten imports are not allowed. Import from the concept file.

The test. Open every `index.ts`. If it contains a function body, a class, or a branch, it is not a barrel and it violates section 2. `src/firestore/index.ts` fails this test today: it has 4 re-export lines and 84 inline function implementations. `src/sandbox/index.ts` passes: it re-exports a type family and one factory, with no implementation.

## 5. Junk-drawer prohibition (testable)

A junk drawer is a file that accumulates unrelated additions because it is the path of least resistance. It is the enemy of parallel work because every contributor appends to the same place.

Rule. A file is a prohibited junk drawer if any of these holds:

- It is named `utils`, `helpers`, `misc`, `common`, or `shared`.
- It is a public entry barrel (section 4) that also contains implementation.
- It exceeds 600 lines and its exports belong to more than one API family or subsystem.
- Its git history shows independent features appending to it in unrelated commits (a co-change fan-out across three or more subsystems).

The last clause is measurable from history and is the strongest signal. A shared type file that co-changes with five subsystems is a junk drawer even if every line in it is correct, because it is a shared write target. Split it so each subsystem owns its records.

## 6. Merge-conflict design rules for parallel agent work

Parallel agents implement surface gaps concurrently. The structures below make their edits land in separate files by construction.

Rule: one feature, one place. The implementation of one surface gap lives in one file that the change creates or in one family file it extends. If implementing one gap requires editing three large files, the surface is mis-structured. This is why the public API surface splits by family: a new operator becomes a new file or a small edit to one family file, not an append to a 2000-line entry.

Rule: append-friendly structures are per-record, not per-list. A shared list, registry, or switch that every feature must edit is a conflict generator. Replace it with one record per file and a computed aggregation. This is the data-record convention applied to code. The compat registry and the oracle observations already work this way and never conflict on additions. In source, `packages/cli/src/cli/service-command-records/` and `packages/cli/src/bridge/tool-records/` follow the same convention: one record per file, keyed by filename, with the aggregate rendered by a generator rather than maintained by hand.

Rule: shared registries and lists must be computed or per-file. If the system needs a list of all X, it computes that list by reading the directory of X records at build or load time. No source file holds a hand-maintained master list that all contributors edit. A global counter for ordering is banned for the same reason; order by a stable key on each record.

Rule: keep the seam stable, not the file small. Where files co-change because they implement one protocol across a boundary (client, host, wire protocol), splitting them further does not reduce conflict. Stabilize the shared contract, the protocol or type file, and change it deliberately and rarely. Treat a high-fan-out shared type file as a fragile contract.

Rule: symmetric surfaces split symmetrically. When the same API is mirrored in two places, the client surface and the tools transport, both split the same way with the same family names. A contributor who learns one surface's layout knows the other's.

## 7. Migration policy

Restructures are not a project. They happen per surface, just in time, and never bundle behavior change with a move.

Rule.

- A restructure happens just before that surface's next climb, not speculatively and not all at once. The surface that is about to receive feature work is the surface that gets restructured first.
- Characterization tests come first. Before any move, the existing behavior is pinned by tests. If the characterization net is thin, thicken it before moving. The strongest existing suites (firestore simulator, auth conformance) are the model for what a net looks like.
- Pure mechanical moves are their own commits, separate from behavior change. A commit that moves code changes no behavior and passes the same tests it started with. A commit that changes behavior moves no files. A reviewer can tell which is which from the diff alone.
- Shared state is hoisted before functions move. When splitting an API surface, the shared module state and symbols are lifted into one state file first, in isolation, so the family moves that follow are clean.
- The public export path does not change during a restructure. The barrel keeps its import path; only what it re-exports from moves. Consumers see no change.

# 8. The anatomy of a surface (canonical)

Section 1 fixed the four parts of a mirrored surface but left one choice open:
the sandbox implementation lives "under `X/sandbox/` or under `sandbox/X/`."
That "or" was the most foundational open convention in the tree. Every
hill-climb that touches a backend has to answer it, and today six surfaces
answer it six different ways. This section closes it.

## 8.0 What is decided now, and what moves when

This section fixes the target shape. It does not schedule a
tree-wide move.

- **The decisions are settled.** The anatomy, dependency direction, and
  enforcement checks in this section are canonical.
- **Moves happen just in time, per surface, per climb.** No surface is
  restructured speculatively. A surface is restructured in the commit that
  precedes its next behavior climb, under the section 7 rules (characterization
  first, mechanical move as its own commit, export path unchanged).
- **New code lands in target shape immediately.** Under this convention, code a
  climb writes goes where this section says, even in a surface that has not yet
  been migrated. New backend concepts go in `X/sandbox/`, never in central
  `sandbox/`.

## 8.1 What each surface does today (the motivating exhibit)

Six mirror surfaces, six placements of the backend. This is the inconsistency
this section removes.

| Surface | Public entry | Where its sandbox backend lives today | Shape | Direction |
|---|---|---|---|---|
| firestore | `firestore/index.ts` barrel + per-family modules | `sandbox/firestore/` (engine) + `sandbox/admin-firestore/` (Admin chainable face) + `sandbox/admin-compat.ts` | central, one concept per file | central. the outlier |
| auth | `auth/index.ts` | `auth/sandbox-backend.ts` | surface-local, one 2173-line file | surface-local |
| database | `database/index.ts` | `database/sandbox/` (backend, data-tree, normalize, query, rules-eval, sentinels, push-id) | surface-local dir, one concept per file | surface-local. conforms |
| storage | `storage/index.ts` (+ `storage/internal`) | rules engine in `storage/sandbox/rules*.ts`; remaining backend across `storage/service.ts`, `enforce.ts`, `persistence.ts`, `internal.ts` | surface-local, partially migrated into `sandbox/` | surface-local |
| messaging | `messaging/index.ts` (+ `sw`, `internal`) | `messaging/broker/` | surface-local dir | surface-local. conforms |
| ai | `ai/index.ts` (+ `scripting`) | `ai/broker/` + `ai/backend.ts` + `ai/sandbox-plane.ts` | surface-local dir | surface-local. conforms |

Read the last column top to bottom. The newest surfaces (ai, messaging) and the
database surface already keep the backend inside the surface directory. Auth
keeps it surface-local but in one oversized file. Storage is midway through its
surface-local split: rules evaluation is isolated under `storage/sandbox/`,
while service and persistence pieces remain at the surface root. Firestore,
the oldest, is the only surface that puts its backend in central `sandbox/`.

The convention ratifies what the newest code already does, not what the
oldest code did. The target is surface-local. Firestore is the migration.

## 8.2 The ruling: surface-local backend, cross-surface-only central sandbox

Rule. For a surface `X` in `packages/pyric/src`:

- `X/index.ts` is the public subpath barrel. Re-exports only (section 4).
- `X/` holds the public API family modules and the dual-target routing
  (`target.ts` / `state.ts`) and the public types (`types.ts` or `types/`).
- `X/sandbox/` holds that surface's no-network backend, one concept per file,
  with a `backend.ts` facade. This is the resolution of the section 1 "or": the
  backend is `X/sandbox/`, never `sandbox/X/`.
- `X/internal.ts` (or `X/internal/`) holds the host-only seam when the surface
  has one (storage already does; the sandbox host reaches it through a published
  `./internal` subpath).

The central `sandbox/` directory holds the cross-surface runtime and nothing
else. A thing belongs in central `sandbox/` only if more than one surface
depends on it. That is the whitelist:

```
packages/pyric/src/sandbox/
  index.ts            the pyric/sandbox barrel
  internal/           sandbox-impl + host protocol (getInternalEnv, ...)
  sandbox-context.ts  the SandboxContext identity handle
  types/              service-agnostic event / context / service / auth-state types
  persistence/        snapshot to IndexedDB or a custom backend
  tab-sync/           cross-tab realtime over BroadcastChannel
  replay/             re-issue a captured session against a fresh sandbox
  branches/           fork / apply / diff / promote / discard
  remote.ts           remote-sandbox brand + channel contract
```

Everything in that list is consumed by every surface or by none in particular.
Nothing in it names a Firebase capability. `sandbox/firestore/`,
`sandbox/admin-firestore/`, and `sandbox/admin-compat.ts` name a capability, so
they do not belong here. They are the exhibit, and they move (8.6).

### The canonical tree

```
packages/pyric/src/
  <surface>/                one Firebase capability: firestore, auth, database, storage, messaging, ai
    index.ts                public subpath barrel. re-exports only
    <family>.ts             public API families: refs, reads, writes, query-constraints,
                            aggregates, listeners, field-values, transactions, ...
    target.ts | state.ts    dual-target brand (TARGET_SYMBOL) + routing + finalizers
    types.ts | types/       public handle/reference/snapshot/converter types
    sandbox/                THIS surface's no-network backend
      backend.ts            the service facade (wires collaborators, owns lifecycle)
      <concept>.ts          state, query, converters/, rules-eval, sentinels, ...
    internal.ts | internal/ host-only seam (optional; published below ./internal)
  sandbox/                  CROSS-SURFACE runtime only (whitelist above), including
    internal/client-app.ts  neutral FirebaseApp-to-runtime adapter seam
  app/                      FirebaseApp registry + app-owned runtime/lifecycle
  rules/                    native surface (no prod/sandbox split)
```

### Alternatives considered

Keep the backend in central `sandbox/X/`. This is firestore's current shape. It
splits one capability across two top-level directories, so a reader who opens
`firestore/` sees half the surface and has to know that the other half is under
`sandbox/`. It also makes central `sandbox/` a shared write target that every
surface's backend work touches, which is the junk-drawer failure mode section 5
bans. Rejected.

Full colocation, backend and cross-surface runtime both inside the surface. This
would put persistence, replay, and tab-sync inside whichever surface first
needed them, and every other surface would then import sideways into that
surface to reach shared runtime. That is the direction violation 8.3 bans, at
the level of the runtime itself. The runtime is genuinely cross-surface and has
to sit above the surfaces. Rejected.

Recommended: surface-local backend in `X/sandbox/`, cross-surface runtime in
central `sandbox/`. One capability, one directory. Central `sandbox/` stays a
small, stable, multi-tenant runtime that no single surface owns.

## 8.3 Dependency direction

Rule. Dependencies point one way:

```
app registry  ->  app runtime  ->  sandbox/ runtime
                       |
                       v
              sandbox/internal/client-app  <-  surface service factories

surface barrel  ->  X/ families  ->  X/sandbox/ backend
                                      ->  sandbox/ runtime  ->  firestore/internal/value-codec (leaf)
```

A surface depends downward on its backend and the shared runtime. A surface
never depends sideways on another surface's non-barrel internals. The app
runtime owns the FirebaseApp-to-sandbox association and installs the neutral
adapter in `sandbox/internal/client-app`; service factories resolve app handles
through that seam, so surfaces do not import `app`. The app registry does not
import or dispatch to surface barrels. Tools depend on surface barrels from
outside the package (8.5).

Today's sideways edges, enumerated:

1. **database -> rules/rtdb, rule evaluation only.** The database mirror owns
   RTDB state, listeners, and Firebase-shaped operations. The native rules
   surface owns the environment-independent RTDB parser, constraints compiler,
   compiled rules tree, and simulator under `rules/rtdb/`. The database sandbox
   reaches that engine only from its `sandbox/rules-eval.ts` adapter. Ruling:
   permitted, because rule evaluation is a native engine capability rather than
   a database transport or state concern. The dependency stays private: the
   `pyric/database` barrel exports no rules-engine symbol. Encode this exception
   narrowly (8.7 check 2). The engine's compiled tree contains only rule
   structure and parsed expressions—never a database URL, service selector, or
   cache lifecycle. Ohm grammar and semantics construction is lazy behind
   `rules/rtdb/expression-engine.ts`, so importing `pyric/rules` does not compile
   the RTDB grammar.

2. **firestore/internal/value-codec -> rules/simulator/wrappers/*, deep leaf import.**
   `firestore/internal/value-codec.ts` imports the seven wrapper value classes (Timestamp,
   Bytes, LatLng, Duration, Reference, Path, Vector) by their direct leaf paths,
   to avoid executing the `pyric/rules` barrel (which pulls the parser, linter,
   and simulator, roughly 10 MB) into every serve page. This is a real sideways
   deep import. It is tolerated today only because the imported files are
   zero-dependency leaves. Ruling: this is a misfiled shared primitive, not a
   value-codec-specific dependency. The wrapper value classes are a leaf that
   both `rules` and the internal codec should depend on downward. Target (low
   priority, no climb blocks on it): host the wrapper classes as a shared
   `values/` leaf and have
   `rules/simulator` import them from there. That dissolves the sideways edge.
   Until then it is a whitelisted exception (8.7 check 2). The
   `storage/sandbox/rules*.ts` engine became the wrapper leaf's SECOND sideways
   consumer when it adopted the
   RULES-B5 float model (`wrappers/float.js`, PR #333) — same ruling, and a
   second vote for the shared-leaf move: when the leaf lands, both edges
   dissolve together.

3. **storage -> rules grammar and module compiler, no foreign evaluator.** Firebase Security
   Rules is one language (#150); `storage/sandbox/rules.ts` parses via the shared Ohm
   grammar (`rules/grammar/FirestoreParser.js`, `rules/grammar/FirestoreAST.js`)
   and converts the shared AST into its own evaluator shapes. Storage service
   setup also calls the browser-safe module compiler
   (`rules/modules/resolver-browser.js`) to lower `2+modules` source after its
   service contracts have rejected incompatible exports and bindings. Ruling:
   permitted, because grammar and module lowering are engine-neutral compiler
   capabilities and the alternative is service-specific parser/compiler drift.
   Storage imports no Firestore simulator, linter, or evaluation code from
   `rules/` (the float wrapper edge above is tracked separately). Encode
   narrowly (8.7 check 2).

4. **app/dispatch.test.ts -> firestore/auth/database barrels.** An app-registry
   integration test importing surface barrels to exercise their public service
   factories. Test-only composition is the intended direction. Not a violation.

No mirror surface imports another mirror surface's family or backend files. The
direction rule holds today except for the documented native-engine and
shared-syntax edges above (cases 1–3).

## 8.4 Native (non-mirror) surfaces

A native surface reproduces no prod backend, so it has no dual-target split and
no `X/sandbox/`. It still obeys the barrel, family, size, and direction rules.

- **rules.** In-process engine. `rules/index.ts` is the barrel; the engine
  (`simulator/`, `grammar/`, `linter/`, `modules/`, `rtdb/`) is engine-internal and is
  reached by package-internal consumers through the published `rules/internal`
  subpaths. No prod/sandbox split. The database sandbox consumes the RTDB engine
  through the private adapter described in 8.3 case 1.
- **Firestore's internal value codec.** A leaf module with two consumers (the
  sandbox persistence serializer and the serve worker client). Its interface is
  published only as `pyric/firestore/internal/value-codec`; it is not a native
  product surface. It must stay small so the per-page bundle does not drag the
  rules engine. See 8.3 case 2 for its one sideways edge.
- **The `pyric/sandbox` public API** is itself a native surface: `sandbox/index.ts`
  is its barrel, `sandbox/types/` its types, and the whitelist in 8.2 its
  implementation. It is the runtime every mirror surface sits on, so it lives at
  the top level, not inside any surface.

`app` is not a service surface. It is the FirebaseApp registry and app-owned
runtime: `initializeApp`, `getApp`, `getApps`, `deleteApp`, the private
FirebaseApp-to-sandbox association, service caching, and app lifecycle. It
depends on the shared sandbox runtime and installs the neutral
`sandbox/internal/client-app` adapter. Service surfaces consume that neutral
seam; surfaces do not import `app`, and `app` does not dispatch to their barrels.

## 8.5 Worker and serve entries, and tools

The serve worker and its per-surface entries live in `@pyric/cli`, not in the
surface directories. They are the transport that hosts the sandbox in a
SharedWorker and bridges it to a page. They depend on the surfaces; the surfaces
do not know they exist.

Rule.

- Serve worker host and client and entries stay in `@pyric/cli`
  (`serve/worker/host-<surface>.ts`, `serve/worker/client/<surface>.ts`,
  `serve/entries/<surface>.ts`). Confirmed today: `host-auth.ts` imports
  `pyric/auth`, `host-ai.ts` imports `pyric/ai`, `entries/auth.ts` imports
  `pyric/auth`. Direction is downward, `@pyric/cli` onto `pyric` barrels.
- A worker entry imports a surface through its published barrel or its published
  `./internal` subpath. It never reaches into a surface's non-exported files by
  relative path. A host that needs bypass or host-only seams uses the surface's
  `./internal` subpath (storage already exposes `pyric/storage/internal` for
  exactly this; the sandbox exposes `pyric/sandbox/internal`).
- In-surface tool factories (`firestore/tools.ts`, `rules/tools.ts`,
  `storage/admin/tools.ts`) stay in the surface. They are part
  of that surface's public contract. The MCP registry composition that wires
  them into a server lives in the tools/bridge layer, not in the surface.
- Symmetric surfaces split symmetrically (section 6). The worker client family
  split (`client/firestore-reads.ts`, `firestore-refs.ts`, `firestore-writes.ts`)
  mirrors the surface family names (`reads`, `refs`, `writes`). Keep that mirror.

## 8.6 Migration table

Per surface: current shape, target shape, the climb that moves it, and what
moves. Restructures follow section 7 (characterization first, mechanical move as
its own commit, export path unchanged).

| Surface | Current shape | Target shape | When it moves | What moves |
|---|---|---|---|---|
| firestore | engine + Admin face in central `sandbox/firestore/`, `sandbox/admin-firestore/`, `sandbox/admin-compat.ts`; `sandbox/firestore/local-environment.ts` remains oversized | `firestore/sandbox/` (engine) + the Admin face under firestore (see 8.8) | dedicated mechanical follow-up before the next Firestore behavior climb ([ADR 0007](decisions/0007-firestore-runtime-splits-follow-up.md)) | `sandbox/firestore/*` -> `firestore/sandbox/*`; split `local-environment.ts` in the same move; Admin face per 8.8; package.json subpaths `pyric/sandbox/admin-firestore` and `pyric/sandbox/admin-compat` remap to the new dist path so the export contract is unchanged |
| shared sandbox runtime | cross-surface `sandbox/internal/sandbox-impl.ts` facade remains above the class/file triggers | `SandboxImpl` lifecycle facade with persistence/service-registry and event-history collaborators | dedicated mechanical follow-up before the next shared-runtime behavior climb ([ADR 0007](decisions/0007-firestore-runtime-splits-follow-up.md)) | extract collaborators without changing the `Sandbox` contract, service-registration ordering, or persistence lifecycle |
| auth | one file `auth/sandbox-backend.ts`, 2173 lines (over the 600 trigger) | `auth/sandbox/backend.ts` facade + one concept per file | the next auth climb (blocking-function / before-state work) | `auth/sandbox-backend.ts` splits into `auth/sandbox/*`. Location is already correct (surface-local); the split only deepens it. The `auth-backend-split` branch target conforms (8.8) |
| database | `database/sandbox/*`, one concept per file | unchanged. this is the reference example | no move | RTDB rule evaluation delegates through `database/sandbox/rules-eval.ts` to the native engine; no parser/compiler lives under the mirror |
| storage | rules engine split under `storage/sandbox/rules*.ts`; service, enforcement, persistence, and host seam remain at the surface root | finish extracting the backend into `storage/sandbox/` (StorageService and IDB store), keep `storage/internal` as the host seam | the next Storage service/persistence climb | remaining non-public backend logic moves to `storage/sandbox/*`; family and `internal` files stay; `pyric/storage/internal` subpath unchanged |
| messaging | `messaging/broker/*` | unchanged. reference example | no move | nothing |
| ai | `ai/broker/*` + `ai/backend.ts` + `ai/sandbox-plane.ts` | conforms. optional tidy: fold `backend.ts` and `sandbox-plane.ts` under `ai/sandbox/` for symmetry | opportunistic, next time ai backend is touched | low priority; not blocking |
| rules | Firestore engine under `rules/*`; RTDB engine historically under `database/{grammar,constraints,simulation}` | both native engines under `rules/`, with RTDB isolated in `rules/rtdb/` | RTDB pure-engine relocation | move the RTDB grammar, constraints compiler, compiled tree, simulator, and their tests under `rules/rtdb/`; keep `pyric/rules` and `pyric/rules/internal/rtdb` import paths stable |
| Firestore internal value codec | leaf codec, deep-imports rules wrappers | unchanged near-term; long-term depend on a shared wrapper leaf (8.3 case 2) | deferred, no climb blocks on it | eventually the wrapper value classes move to a shared leaf; not scheduled |

New code rule, restated for the table: under this convention, any firestore
backend concept a climb adds goes in `firestore/sandbox/` even before the bulk
move; any auth backend concept goes in `auth/sandbox/`; and so on. The climb
does not append to `sandbox/firestore/` or to `auth/sandbox-backend.ts`.

## 8.7 Enforcement

A structural test (a conventions linter over `packages/pyric/src`) can decide
every rule in this section mechanically.

1. **Barrel purity.** Parse every `index.ts`. It must contain only re-exports,
   type declarations, and doc comments. Any function body, class, or branch
   fails it. This is section 4's test, automated. It catches a surface entry
   that grows inline implementation.

2. **No sideways surface imports.** For any file under `src/<A>/`, a relative
   import that crosses into another surface `src/<B>/` fails, with five
   whitelisted exceptions: (a) `database/sandbox/rules-eval.ts` importing the
   private `rules/rtdb` engine described in 8.3; (b) the
   `firestore/internal/value-codec -> rules/simulator/wrappers/*` leaf edge,
   listed explicitly
   so it is visible and removable; (c) `storage/sandbox/rules.ts` importing the shared
   syntax layer `rules/grammar/{FirestoreParser,FirestoreAST}.js` (8.3 case 3,
   parse-only); (d) `storage/sandbox/rules.ts` and
   `storage/sandbox/rules-{evaluator,methods,values}.ts` importing
   `rules/simulator/wrappers/float.js` (8.3 case 2's misfiled shared primitive,
   second consumer — dissolves with the shared-leaf move); (e)
   `storage/service.ts` importing the browser-safe module compiler
   `rules/modules/resolver-browser.js` (8.3 case 3, compile-only). Any other
   cross-surface deep import fails.

3. **Central-sandbox whitelist.** The top-level entries of `src/sandbox/` must
   match the whitelist in 8.2 (`index.ts`, `internal`, `sandbox-context.ts`,
   `types`, `persistence`, `tab-sync`, `replay`, `branches`, `remote.ts`). Any
   entry that names a capability (`firestore`, `admin-firestore`, `admin-compat`,
   `auth`, ...) fails. This is the check that keeps firestore's backend from
   drifting back in, and that fails today until the firestore move lands.

4. **Surface sandbox-dir contents.** `<surface>/sandbox/` contains backend
   concept files only. It holds no public API family and no re-export barrel that
   feeds the published surface. The published surface is `<surface>/index.ts`;
   `<surface>/sandbox/` is not on the export map.

5. **File-size trigger.** Section 2's 600-line trigger, run as a test. It fails
   today on `auth/sandbox-backend.ts` (2173 lines), which is precisely the file
   the auth migration splits.

Checks 3 and 5 both fail on the current tree by design. They pass as each
surface migrates, so they double as the migration's definition of done.

## 8.8 The sharpest ruling, and the two in-flight splits

### The settled ruling: where the Admin Firestore face goes

The firestore capability has one sandbox engine and two adapter faces:

- the modular Web SDK face, `pyric/firestore`, in `src/firestore/`;
- the Admin-SDK-shaped chainable face, consumed by the `pyric-admin` package and
  published as `pyric/sandbox/admin-firestore` (plus the `pyric/sandbox/admin-compat`
  shim), today in `src/sandbox/admin-firestore/` and `src/sandbox/admin-compat.ts`.

The modular face is built on top of the chainable face (`firestore/sandbox-ops`
wraps `pyric-admin`'s chainable adapter), and both faces sit on the same engine
(`sandbox/firestore/local-environment.ts` and siblings). So the engine is shared
by two faces, one of which has an external consumer and a stable published
subpath. That is why this is the sharp decision. The choices:

- **(A) One firestore directory.** Move the engine to `firestore/sandbox/` and
  the Admin face under it (`firestore/sandbox/admin-compat/`, with the remote arm
  alongside). Remap the two `pyric/sandbox/*` subpaths in `package.json` to the
  new `dist/firestore/...` paths so the export contract does not change. Result:
  central `sandbox/` is pure cross-surface runtime; every firestore concept is in
  `firestore/`.
- **(B) Promote admin-firestore to its own top-level surface** `src/admin-firestore/`,
  a peer adapter surface with its own directory, keeping the engine in
  `firestore/sandbox/` and having admin-firestore depend downward on it. Result:
  the export subpath maps to `dist/admin-firestore/`; the two firestore faces are
  siblings, not nested.

Decision: (A). The Admin face is not a peer capability, it is a second face on
the firestore capability, and the locality diagnosis that motivates this whole
section says one capability lives in one directory. The engine is firestore's,
not cross-surface, so it fails the central-`sandbox/` whitelist and belongs in
`firestore/sandbox/`. Keep the two published subpaths stable through the exports
map (section 7 already forbids changing the public import path during a
restructure; this satisfies it). The one cost of (A) is that the Admin face
nests under firestore rather than reading as a top-level surface, which is
accurate: it is firestore's Admin face.

### Do the two in-flight engine splits conform?

- **auth-backend-split.** Conforms. The branch is currently identical to
  `origin/main` (0 commits ahead, 0 behind), and on main the auth backend is the
  single surface-local file `auth/sandbox-backend.ts`. Its location is already
  the target location (surface-local, not central). The split this section calls
  for deepens that file into `auth/sandbox/backend.ts` plus concept files. As
  long as the split lands under `auth/sandbox/` and not in central `sandbox/`, it
  conforms. Confirmed target: surface-local, correct.

- **firestore engine split (firestore-entry-split, merged as #183; admin-firestore
  one-concept split, merged as #181).** The entry split (#183) already put the
  public firestore surface into per-family modules under `firestore/`, which
  conforms. The admin-firestore split (#181) made `sandbox/admin-firestore/`
  one-concept-per-file, which conforms on file shape but leaves the directory in
  central `sandbox/`, which does not conform on location. Those files are the
  ones the firestore behavior climb moves under 8.6 and the ruling in (A). So the
  file-level shape is already right; only the location is pending, and it moves
  with the next firestore climb, not as a separate project.
