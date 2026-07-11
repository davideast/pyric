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

The exemplars in the tree are the compat registry (`scripts/compat/registry/*.ts`, one record file per service), the oracle observations (`scripts/oracle/observations/*.json`, one observation per file, filename is the key, directory is the index), and the generated `COMPAT.md` documents. Source code now inherits the same discipline.

## 1. Directory shape for a mirrored surface

A mirrored surface is one Firebase capability the project reproduces: firestore, auth, database, storage, rules. Every surface has four parts. The rule fixes where each part lives.

Rule. For a surface named `X` in `packages/pyric/src`:

- The public entry is `X/index.ts`. It is a re-export barrel and nothing else. It is the package export contract.
- The public API implementation is one file per API family under `X/`. Families are `refs`, `reads`, `writes`, `query`, `aggregation`, `listeners`, `field-values`, `transactions`, and the surface's own additions. No family file exceeds the size limit in section 2.
- The sandbox implementation is under `X/sandbox/` or under `sandbox/X/`, one concept per file. It never lives in the public entry.
- The types are `X/types.ts` for a small surface, or `X/types/` (one file per subsystem, computed barrel) for a large one.
- The tests mirror the source path under `test/`, one test file per source concept.

The class of defect this fixes. Today the firestore public entry is `src/firestore/index.ts` and holds the client implementation inline, while the sandbox implementation lives in `src/sandbox/firestore/` and the admin adapter lives in a third place. The public entry and its implementation must live in one directory. A reader who opens the surface directory sees the whole surface.

Reference to align to. `sandbox/firestore/admin-compat/` already follows the one-concept-per-file rule: `batch.ts`, `doc-ref.ts`, `query.ts`, `snapshots.ts`, `transaction.ts`, `paths.ts`, `value-order.ts`, and a barrel. Match that shape. The database surface partly follows it too: `database/sandbox/` already separates `query.ts`, `data-tree.ts`, `normalize.ts`, `rules-eval.ts`.

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

Rule: append-friendly structures are per-record, not per-list. A shared list, registry, or switch that every feature must edit is a conflict generator. Replace it with one record per file and a computed aggregation. This is the data-record convention applied to code. The compat registry and the oracle observations already work this way and never conflict on additions.

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
