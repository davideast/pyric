# Measure rules engine performance

The rules benchmark times each stage of the Security Rules pipeline on its own, for Firestore, Realtime Database and Storage. Run it before and after a change to the rules engine and compare the two runs against the committed baseline.

The harness lives in `packages/pyric/bench/rules/`. It loads the built package (`packages/pyric/dist`), the same code the test suite runs.

## Run the benchmark

Build the package, then run the harness from the repository root or from `packages/pyric`:

```sh
bun run build:pyric
bun run bench:rules
```

| Command | What it does |
| --- | --- |
| `bun run bench:rules` | One round over every fixture. Prints a table of medians and a table of every stage with median, p95 and p99. |
| `bun run bench:rules -- --check` | Three rounds, then compares each stage median to `baseline.json`. Exits non-zero when a stage regresses past the margin. |
| `bun run bench:rules -- --update` | Three rounds, then rewrites `baseline.json`. Refuses when a fixture check fails or the run is partial. |
| `bun run bench:rules -- --json` | Prints the report as JSON instead of tables. `--out <file>` also writes it to a file. |
| `bun run bench:rules -- --profile` | Runs the same fixtures under Bun's CPU profiler. See [Profile a run](#profile-a-run). |

Other flags:

- `--fixture <id>` runs one fixture: `chess`, `arcade-firestore`, `arcade-rtdb`, `arcade-storage` or `corpus`. Repeat it to run several.
- `--quick` takes fewer samples. Use it while iterating, never for `--check` or `--update`.
- `--rounds <n>`, `--warmup <n>`, `--iterations <n>` and `--cold-samples <n>` change the sampling. `--no-cold` skips the cold parse.
- `--margin <fraction>` and `--floor-us <n>` change the gate. See [How the gate decides](#how-the-gate-decides).

A full `--check` takes about three minutes on an Apple M3 Pro.

## Compare before and after an engine change

1. On the base commit, build and run `bun run bench:rules -- --check`. It passes when the machine matches the baseline.
2. Apply the engine change, rebuild with `bun run build:pyric`, and run `bun run bench:rules -- --check` again.
3. Put both outputs in the pull request. A stage the change speeds up prints as `faster:`.
4. When the change is an intended speedup, run `bun run bench:rules -- --update` and commit the new `baseline.json` with the change.

The harness warns when a source file is newer than `dist`, because the run then measures the previous build.

The benchmark is not part of CI. Shared CI runners vary too much from run to run for a 25 percent gate, so run it locally on a quiet machine.

## Stages

Each fixture reports these stages. A stage that does not apply to a service is left blank.

| Stage | What it times |
| --- | --- |
| `parse.cold` | A fresh `bun` process: loading the parser module, building the Ohm grammar, and the first parse. The median of 10 processes. |
| `parse.warm` | Source text to AST with the grammar already built. Firestore and Storage use the Firestore Rules grammar. Realtime Database parses the JSON and every `.read`, `.write` and `.validate` expression. |
| `resolve` | `rules_version = '2+modules'` import resolution and flattening. Only fixtures that use modules. |
| `compile` | What the engine builds before a request runs. Firestore: the authored source map (the simulator walks the AST directly). Realtime Database: `compileRtdbRules`, which parses, validates and lints every expression. Storage: `compileStorageRules` minus the parse, a derived value. |
| `evaluate` | One request against the compiled ruleset. |
| `evaluate.match` | Firestore only: resolving the request path to match blocks, timed on its own with the same inputs. |
| `evaluate.lookups` | Time inside the document lookup callback (`get()`, `exists()`, `firestore.get()`), with the count per request in the note. |
| `evaluate.expressions` | Firestore only, derived: `evaluate` minus lookups minus match. It includes expression evaluation, trace recording and context building. |
| `evaluate.input-validation` | Realtime Database only: the input schema check `evaluate` runs first. |
| `evaluate.first` | Realtime Database only: the first request on a fresh compile, when evaluation parses each rule it reaches once. |
| `expressions` | Firestore only: the expressions the request evaluated (`evaluatedExpressions`), in the unit of production's limit of 1000 per request. |
| `e2e` | A sandbox write from the SDK call to the verdict and commit: `setDoc` or a `writeBatch` commit through `pyric/firestore`, `set` through `pyric/database`, `uploadString` through `pyric/storage`. |

Every request is checked before it is timed. `evaluate` must return the verdict the fixture records, the `e2e` write must succeed, and the same write by another user must be denied, which shows the write path evaluated the rules. A failed check fails the run.

## Read the tables

- Values are microseconds (`us`) or milliseconds (`ms`). The medians table shows medians only; the second table adds p95, p99 and the sample count.
- A row named `fixture` holds the ruleset stages. A row named `fixture / request` holds one request's stages.
- A derived row is the difference of two timed medians. It carries the noise of both, so read it as an estimate.
- Slow stages take fewer samples to fit a time budget, never fewer than 30. The sample count is in the second table.
- With several rounds, each round runs in its own process and each stage keeps its fastest round. Other load on the machine only slows a round down, and a process's JIT and heap state can move a stage by a fifth, so the fastest of several processes is the most repeatable figure.

## How the gate decides

`--check` fails a timed stage when its median is more than 25 percent above the baseline median and more than 5 microseconds above it. An `expressions` count fails on any increase. Derived rows are never gated.

Before a stage fails, the harness runs that stage's fixture for three more rounds and keeps the fastest. A real regression stays slow; a busy moment does not.

Why 25 percent: on a laptop with other work running, single rounds of unchanged code moved some of the 80 timed stage medians by 25 to 45 percent. The Air Hockey `evaluate` stage alone ranged from 445 to 647 microseconds across four processes. With the fastest of three processes and the confirmation rounds, two `--check` runs of unchanged code passed. A tighter margin fails unchanged code on a working machine. A looser one misses a change that adds a quarter to a stage: a 100 microsecond delay injected into Firestore evaluation (about 40 percent of a chess move) failed every chess `evaluate` stage at this margin. The 5 microsecond floor keeps stages that take a few microseconds from failing on timer jitter.

## Fixtures

The fixtures are checked in under `packages/pyric/bench/rules/fixtures/`. Each `fixture.json` records its source. `bun run bench:rules:capture` rewrites them:

```sh
bun run bench:rules:capture chess
bun run bench:rules:capture corpus
bun run bench:rules:capture arcade --games <path to the arcade checkout>
```

| Fixture | Service | Source |
| --- | --- | --- |
| `chess` | Firestore | The chess showcase in `packages/site-docs/src/examples/chess`: `chess-v2.rules` resolved from `2+modules`, the move config document, and a normal move, a capture and a castle. |
| `arcade-firestore` | Firestore | The arcade's resolved `app/firestore.rules`, with a Reversi move and a Yacht score write built by each game's own write functions. |
| `arcade-rtdb` | Realtime Database | The arcade's `app/database.rules.json` with one Air Hockey frame. Each timed write carries a newer tick, as the game's frames do. |
| `arcade-storage` | Storage | The arcade's `app/storage.rules` with one Sokoban upload and the score document its rule reads. |
| `corpus` | All three | Ten scenarios from `packages/conformance/rules-corpus`, one request each, to represent ordinary apps. |

## Profile a run

```sh
bun run bench:rules -- --profile --fixture arcade-rtdb
```

The flag reruns the harness as `bun --cpu-prof --cpu-prof-dir=<dir> --cpu-prof-md bench/rules/run.ts --no-cold`, with your other flags. Profiles land in `packages/pyric/bench/rules/profiles/`, which git ignores. Open the `.cpuprofile` file in Chrome DevTools, or read the `.md` summary of hot functions.

A profile covers every stage in the run, so parse and compile time mixes with evaluation. To profile one stage, pass `--fixture` and read the functions under the stage you care about.

## Baseline

Recorded on an Apple M3 Pro with 18 GiB of memory and bun 1.3.9: three rounds, each in its own process, each stage's fastest round. The machine had a load average near 10 from other work, so a quiet machine measures some stages faster; `e2e` moved most. Medians:

| Fixture | parse.cold | parse.warm | resolve | compile | evaluate | e2e | expressions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| chess | 161.96 ms | 89.44 ms | 94.90 ms | 22.0 us | | | |
| chess / normal move (Nf3) | | | | | 253.5 us | 625.6 us | 928 |
| chess / capture (Qxf7#) | | | | | 275.6 us | 416.5 us | 978 |
| chess / castle (O-O) | | | | | 248.2 us | 461.7 us | 859 |
| arcade-firestore | 370.14 ms | 305.98 ms | | 72.9 us | | | |
| arcade-firestore / Reversi move | | | | | 241.5 us | 743.0 us | 516 |
| arcade-firestore / Yacht score (choice) | | | | | 97.9 us | 246.6 us | 372 |
| arcade-rtdb | 73.20 ms | 24.03 ms | | 78.64 ms | | | |
| arcade-rtdb / Air Hockey frame | | | | | 501.5 us | 502.6 us | |
| arcade-storage | 55.70 ms | 4.01 ms | | 0.0 us | | | |
| arcade-storage / Sokoban upload | | | | | 7.1 us | 38.8 us | |
| corpus / firestore/common-auth-membership-firestore | | 3.16 ms | | 0.2 us | 7.9 us | | 5 |
| corpus / firestore/required-fields-and-mapdiff | | 3.32 ms | | 0.1 us | 11.3 us | | 35 |
| corpus / firestore/hierarchical-match-cascade | | 242.3 us | | 0.0 us | 4.0 us | | 1 |
| corpus / firestore/list-and-string-methods | | 2.55 ms | | 0.1 us | 26.4 us | | 95 |
| corpus / storage/common-auth-membership | | 2.97 ms | | 0.0 us | 0.9 us | | |
| corpus / storage/metadata-access | | 515.6 us | | 0.0 us | 1.2 us | | |
| corpus / storage/upload-primitives-boundaries | | 4.12 ms | | 0.0 us | 0.9 us | | |
| corpus / rtdb/r2-own-uid | | 145.2 us | | 655.5 us | 12.9 us | | |
| corpus / rtdb/r4-validate-structure | | 307.9 us | | 1.19 ms | 30.5 us | | |
| corpus / rtdb/r14-root-lookup | | 557.5 us | | 2.05 ms | 25.5 us | | |

Air Hockey's `evaluate.first` is 7.33 ms: the first frame after a rules deploy parses every rule it reaches. Storage `compile` is derived from two millisecond medians, so it reads as 0.0 us whenever the conversion is smaller than the parse's run-to-run noise. `baseline.json` holds every stage with p95, p99 and sample counts.
