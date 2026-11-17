# Implementation workflow: vertical slices at pre-agreed seams

Use this workflow when building a campaign slice in its dedicated git worktree.

## 1. Confirm the contract, upstream behavior, and boundaries before editing

1. Read the originating issue, ADR, or spec alongside `AGENTS.md`, `PRIORITIES.md`,
   `docs/code-conventions.md`, and [hygiene.md](hygiene.md).
2. State the slice's title, behavioral contract, and owned file list before
   writing production code. If a requirement, public seam, or file boundary is
   ambiguous, ask the coordinator before editing outside your slice.
3. **Probe upstream Firebase SDKs empirically.** Whenever an error code, check
   order, synchronous throw vs rejected promise, or stream lifecycle is not
   already pinned by a committed observation in `packages/conformance/observations/`,
   run a small read-only probe from an external scratch directory against the
   workspace's installed `firebase` and `firebase-admin` packages in
   `node_modules` (and clean up the scratch file afterwards). Never guess
   upstream behavior.
4. Check the seven integration boundaries in `AGENTS.md`:
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

## 2. Build in vertical TDD slices, including stateful follow-up transitions

Follow [tdd.md](tdd.md), [tdd-tests.md](tdd-tests.md), and
[tdd-mocking.md](tdd-mocking.md) strictly at the public seams pre-agreed in your
builder brief:

1. Write one failing test at a public seam that captures one behavior or
   counterexample, run that single test file to witness RED, and write the
   minimal production code to reach GREEN, keeping every file `<= 600` lines and
   never growing a legacy `> 600`-line file (`docs/code-conventions.md` section 2).
2. **Test stateful follow-up states and real repo config.** When a feature spans
   multiple steps or pull requests (for example: staging an uncaptured probe in
   PR #1 followed by an `observations/**`-only capture PR #2 before PR #3 links
   `rowIds`, or adding a PR label followed by an unreviewed push or `FIX`
   comment), write unit tests exercising every state transition. When testing git
   or filesystem guards in a temporary repository, copy in the real committed
   `.gitignore` and config files so ignore-rule interactions cannot hide bypasses.
3. Repeat one vertical tracer-bullet slice at a time; never bulk-port all tests
   or hunks horizontally without per-slice verification.

## 3. Continuous typechecking, CI-pinned runtimes, and gate verification

- Check `.github/workflows/build.yml` `env:` for the pinned CI toolchain
  (`BUN_VERSION`, `NODE_VERSION`, `NODE_24_VERSION` -- for example Bun `1.3.11`,
  Node `22.15`, Node `24.16`).
- Run version-sensitive, stream, or async-teardown suites under the exact CI Bun
  pin (`bunx bun@<BUN_VERSION> test ...`, and under `unshare -rn` when loopback
  isolation applies), looping 5-10 times when verifying async cleanup.
- Measure timed differential gates under a 2-core CPU cap (`taskset -c 0,1`) so
  local timings match 2-core GitHub Actions runners.
- Run package builds (`bun run build` or `bun run --cwd packages/<pkg> build`)
  whenever cross-package `dist/` contracts change, and typecheck both `src/` and
  modified `test/**/*.test.ts` files (`tsconfig.json` often excludes `test/` by
  default; pass `"exclude": []` or explicit test paths to `tsc --noEmit`).
- Run the full affected package suites and repository gates at the end:
  - `bun test scripts/ci/` when CI scripts or workflows change;
  - `bun run compat:check` and `bun test --cwd packages/conformance` when
    conformance or engine behavior changes;
  - `CI_BASE_SHA=<base-sha> CI_HEAD_SHA=HEAD bun scripts/ci/knip-audit.ts` (`0` PR findings);
  - `PR_BODY_FILE=/dev/null bun scripts/ci/deletion-guard.ts <base-sha> HEAD`.

## 4. Two-axis self-review and local commit

Once all slices are green, review `git diff <base-sha>` yourself along both
`Standards` and `Spec` axes ([code-review.md](code-review.md)). Apply cleanups
while keeping tests green, verify `0` non-ASCII bytes across changed files and
your commit message, and commit locally to your slice branch.

Do not push the branch or open a pull request until independent two-axis review
returns `MERGE` on both axes.
