# Implementation workflow: vertical slices at pre-agreed seams

Use this workflow when building a campaign slice in its dedicated git worktree.

## 1. Confirm the contract and boundaries before editing

1. Read the originating issue, ADR, or spec alongside `AGENTS.md`, `PRIORITIES.md`,
   `docs/code-conventions.md`, and [hygiene.md](hygiene.md).
2. State the slice's title, behavioral contract, and owned file list before
   writing production code. If a requirement, public seam, or file boundary is
   ambiguous, ask the coordinator before editing outside your slice.
3. Check the seven integration boundaries in `AGENTS.md`:
   - full-lifecycle propagation across operations, handles, and Security Rules;
   - first-class error composition (`RuleError` absorption in rules evaluators);
   - dual-plane parity across in-process sandbox, SharedWorker (`packages/cli/src/serve/`),
     and Node host;
   - shared foundation reuse (`pyric/sandbox/internal`) rather than per-service copies;
   - cross-runtime fallback verification (explicitly exercising browser/worker
     branches when `bun test` defaults to Node/Bun globals);
   - conformance node-count invariants (`packages/conformance/assurance-node-counts/`);
   - real-entrypoint integration scenarios under `test/apps/` when user-reachable
     runtime behavior changes.

## 2. Build in vertical TDD slices

Follow [tdd.md](tdd.md), [tdd-tests.md](tdd-tests.md), and
[tdd-mocking.md](tdd-mocking.md) strictly at the public seams pre-agreed in your
builder brief:

1. Write one failing test at a public seam that captures one behavior or
   counterexample.
2. Run that single test file and confirm it fails for the expected reason (RED).
3. Write the minimal production change that makes the slice pass (GREEN), keeping
   every file `<= 600` lines and never growing a legacy `> 600`-line file
   (`docs/code-conventions.md` section 2).
4. Repeat one vertical tracer-bullet slice at a time. Never bulk-port all tests
   first or apply a multi-file patch horizontally without per-slice verification.

## 3. Continuous typechecking and gate verification

- Run package builds (`bun run build` or `bun run --cwd packages/<pkg> build`)
  whenever cross-package `dist/` contracts change.
- Run package `typecheck` frequently, and explicitly typecheck new or modified
  `test/**/*.test.ts` files (`tsconfig.json` in several packages excludes `test/`
  by default; validate with a temporary or inline `tsc --noEmit` invocation that
  sets `"exclude": []` or passes the test paths).
- Run single test files on each slice, then run the full affected package suites
  and repository gates at the end:
  - `bun test scripts/ci/` when CI scripts or workflows change;
  - `bun run compat:check` and `bun test --cwd packages/conformance` when
    conformance or engine behavior changes;
  - `bun scripts/ci/knip-audit.ts` (`0` PR findings);
  - `PR_BODY_FILE=/dev/null bun scripts/ci/deletion-guard.ts <base-sha> HEAD`.

## 4. Two-axis self-review and local commit

Once all slices are green, review `git diff <base-sha>` yourself along both
`Standards` and `Spec` axes ([code-review.md](code-review.md)). Apply cleanups
while keeping tests green, verify `0` non-ASCII bytes across changed files and
your commit message, and commit locally to your slice branch.

Do not push the branch or open a pull request until independent two-axis review
returns `MERGE` on both axes.
