# Shipping and follow-up

## Split the PRs by what a reviewer checks

A whole campaign in one PR is too large to review. Group by reviewer concern:

1. **Evidence.** Scenarios, observations, registry rows, pins. No source
   changes. The score drops. Reviewers check the observations alone.
2. **One PR per fix stream**, stacked on the evidence PR, each removing its own
   pins. A security-relevant stream (sandbox enforcement, listener revocation)
   stays small and separate.

Every PR opens as a draft and stays one until it is approved.

## Before opening

- Run the full gates on each branch tip after `bun run build`. Record counts
  per branch.
- For any failing test, run the same test on a clean `origin/main` build in the
  same environment. Name pre-existing failures in the PR body, and file or fix
  each one; never call a branch green while a failure is unexplained.
- Scan the diff and the PR text for anything that names the app or project that
  prompted the hunt, local paths, or conversation IDs.
- Write the body from `.github/pull_request_template.md`: one line, then
  runnable code with public `pyric/*` imports, then the before and after output,
  produced by running the same script against the old and new builds. Name the
  integration test (AGENTS.md boundary 7).
- A PR that moves a published number states the delta and its cause, and gets
  the [coverage-adversary](../../coverage-adversary/SKILL.md) audit.

## Merging a stack

- Update each PR with `main` and let CI re-run before merging, even when GitHub
  reports it clean: `main` moved under it.
- Do not delete a branch another PR is based on. Deleting the base closes the
  stacked PR instead of retargeting it. Retarget the stacked PR to `main` first,
  then delete. If it already closed: push the old base back at the same commit,
  reopen, retarget, then delete.
- Merge with `--match-head-commit` so nothing lands that CI did not see.
- After the last merge, watch `main`'s own CI runs to completion.

## Packing for a downstream check

`npm pack` keeps `workspace:*` dependency specs, which do not install outside
the monorepo. Use `bun pm pack --destination <dir>` per package.

## Filing issues

For findings the campaign deferred, or that it found outside its streams:

1. Re-verify each against current `main` with the verdict rule; split
   sub-claims; cite evidence for every expected value. File only `REAL` rows.
2. Check that each is reachable through a public entry point. A defect only an
   internal caller could trigger is a note inside a related issue.
3. Group by root cause. Each issue: one-line summary, a runnable repro with
   public imports, observed vs expected, the evidence as repo file and line,
   and the affected source lines. "Surfaces disagree" findings say so and name
   the unknown production fact.
4. Restart-safe filing. Write each body to a uniquely named file first; before
   creating issue N, skip it if its URL file exists or a search finds it; write
   the URL to a file right after creating it.
5. Run every filed repro verbatim yourself afterwards. A repro that does not
   show the defect gets the issue edited, not left standing.
