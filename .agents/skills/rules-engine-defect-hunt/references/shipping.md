# Shipping and follow-up

## Split the PRs by what a reviewer checks

A whole campaign in one PR is too large to review. Group by reviewer concern,
not by stream count. A split that worked:

1. **Evidence** — corpus, observations, registry rows, pins. No source changes.
   The score drops. Reviewers check the observations alone.
2. **Sandbox enforcement** — independent of the rest; small; security-relevant.
3. **Engine parity** — DSL, simulator, validator, lint, consolidation; stacked on
   the evidence PR.

Build each PR branch from the approved stream commits and prove the split is
exact: the trees of the PR branches together must equal the integrated tree that
passed the gates.

## Before opening

- Run the full gates on each branch tip after `bun run build` (see
  [pyric-gates.md](pyric-gates.md)). Record counts per branch.
- For any failing test, run the same test on a clean `origin/main` build in the
  same environment. Report failures that pre-exist as such, by name, in the PR
  body; never call a branch green while a failure is unexplained.
- Scan the diff and the PR text for anything that names the app or project that
  prompted the hunt, local paths, or conversation IDs.
- Write the body from `.github/pull_request_template.md`: one line, then runnable
  code with public `pyric/*` imports, then the before/after output. Produce that
  output by running the same script against an old build and the new build.
- A PR that moves a published number states the delta and its cause, and gets the
  [coverage-adversary](../../coverage-adversary/SKILL.md) audit.

## Merging a stack

- Update each PR with `main` and let CI re-run before merging, even when GitHub
  reports it clean: `main` moved under it.
- **Do not delete a branch another PR is based on.** Deleting the base closes the
  stacked PR instead of retargeting it. Retarget the stacked PR to `main` first
  (`gh pr edit <n> --base main`), then delete. If it already closed: push the old
  base back at the same commit, reopen, retarget, then delete.
- Merge with `--match-head-commit` so nothing lands that CI did not see.
- After the last merge, watch `main`'s own CI runs to completion.

## Packing for a downstream check

`npm pack` keeps `workspace:*` dependency specs, which do not install outside the
monorepo. Use `bun pm pack --destination <dir>` per package.

## Filing issues

For findings the campaign deferred:

1. Re-verify each against current `main` with the verdict rule; split sub-claims;
   cite evidence for every expected value. File only `OPEN` rows.
2. Check that each finding is reachable through a public entry point. A defect
   only an internal caller could trigger is a note inside a related issue, not an
   issue.
3. Group by root cause. Each issue: one-line summary, a runnable repro with public
   imports, observed vs expected, the evidence as repo file and line, and the
   affected source lines. "Surfaces disagree" findings say so and name the unknown
   production fact.
4. **Restart-safe filing.** Agents die on network errors mid-run. Write each body
   to a file first; before creating issue N, skip it if its URL file exists or a
   search finds it; write the URL to a file immediately after creating it.
5. Run every filed repro verbatim yourself afterwards. A repro that does not show
   the defect gets the issue edited, not left standing.
