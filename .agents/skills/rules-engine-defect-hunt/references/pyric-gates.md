# Gates and repo conventions for an engine campaign

Run these at baseline, on every stream branch, at integration, and on every PR
branch tip. Record the exit code and the counts; a gate you did not run is not
green.

## Build first

Tests import `pyric/*` through package exports that resolve to `dist/`. A fresh
worktree fails hundreds of tests with "Cannot find module 'pyric/sandbox'" until
it is built.

```sh
bun install --frozen-lockfile
bun run build            # scripts/build.sh; or build:pyric for the engine alone
```

## The gates

| Gate | Command | Notes |
|---|---|---|
| Typecheck | `npx --prefix packages/pyric tsc -p packages/pyric/tsconfig.json --noEmit` | Also `packages/cli`, `packages/conformance` when touched |
| Library suite | `bun run test:ci:libraries` | Sum the pass/fail lines across packages |
| CLI suite | `bun run test:ci:cli` | Compare failures with a clean `origin/main` build before blaming the branch: some tests fail in some local environments |
| Conformance | `bun run compat:check` | Fails on stale *generated* projections (gitignored) after switching branches: run `bun run compat:conformance` and re-check before calling it a regression |
| Rules score | `bun run compat:rules-score` | Prints `RTDB Rules conformance: N/91`; scores, denominators and per-construct facts must match committed baselines |
| Coupling | `BASE_REF=origin/main bash scripts/ci/conformance-coupling-gate.sh` | Engine change without evidence change needs a `Conformance-Exempt: <reason>` commit trailer |
| One file, often | `bun test <path>` | e.g. `packages/pyric/test/rules/rtdb/rules-conformance.test.ts` |

## Where evidence and pins live

| What | Where |
|---|---|
| Corpus scenarios | `packages/conformance/rules-corpus/{rtdb,firestore,storage}/` |
| Production observations | `packages/conformance/observations/{rtdb-rules,firestore-rules,storage}/`, plus SDK-level ones under `rtdb-modular/`, `firestore/`, `rtdb/` |
| Registry rows | `packages/conformance/registry/rules.ts` and siblings |
| Node counts | `packages/conformance/assurance-node-counts/<service>/`; a registry row added or removed adds one `{ "delta": n }` file there, named for the change, in the same change (AGENTS.md boundary 6) |
| Scorecards / baselines | `packages/conformance/baselines/*-scorecard.json`, `coverage-baseline.json` |
| Score pins in tests | `packages/conformance/test/src/{conformance-model,generate-docs-scoreboard,rules-language-coverage,rules-scorecard-gate}.test.ts` |
| RTDB runtime pins | `KNOWN_DIVERGENCES` in `packages/pyric/test/rules/rtdb/rules-conformance.test.ts` |
| Static validator pins | `KNOWN_CORPUS_VALIDATOR_GAPS` in `packages/pyric/test/rules/rtdb/grammar/validator-types.test.ts` |
| Firestore replay gate | `packages/pyric/test/rules/oracle-conformance.test.ts` |
| Storage replay gate | `packages/pyric/test/storage/rules-oracle-conformance.test.ts` |
| Served-plane RTDB pins | `packages/cli/test/serve/rtdb-differential/known-divergences.ts` |

Shared generated files (scorecards, baselines, node counts, score pins) are where
parallel branches collide. Each stream keeps its changes to them in one commit,
and whichever PR merges second regenerates them with `compat:conformance` and
`compat:rules-score` on top of `main`
([fix-campaign.md](../../defect-hunt/references/fix-campaign.md#3-shared-score-pins)).
Never hand-merge them.

## Conventions a reviewer will hold you to

- `docs/code-conventions.md`: no nested or multi-line ternaries; 600 lines of
  source is the trigger to split a file.
- AGENTS.md boundaries: errors are first-class values that take part in `||` /
  `&&` absorption (2); a sandbox change is checked against the worker protocol in
  `packages/cli/src/serve/` (3); shared logic goes in `pyric/sandbox/internal`
  (4); node-count invariant (6); integration evidence through real entry points,
  named in the PR body (7).
- `.github/pull_request_template.md`: one line, then the code; deleting a test
  file needs a `Removes tests:` line.
- `.agents/skills/` is scanned by `packages/cli/test/tool-name-drift.test.ts`:
  a token shaped like `<service>_<word>` (service being rtdb, rules, auth,
  sandbox and so on) is read as an MCP tool name and must be registered. JWT
  claim names and generated namespaces have that shape too; write prose around
  them.
