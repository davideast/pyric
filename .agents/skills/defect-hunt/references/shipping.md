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

## Merging through the queue (and stacks)

- Enqueue approved, ready pull requests that target `main` by adding the
  `merge-queue` label via the REST API (`gh pr edit` is broken on this repo):
  `gh api -X POST 'repos/{owner}/{repo}/issues/<n>/labels' -f 'labels[]=merge-queue'`.
  `.github/workflows/merge-queue.yml` stages every ready pull request together
  (up to 8, in label order) onto `merge-queue/staging` over current
  `origin/main`, runs the full `main` `Build & Test` suite (`packaging=true`,
  `rtdb-differential=true`, every non-slow app scenario, base quarantine),
  reruns a single-attempt flake once, and lands the batch by pushing the staged
  commit to `main` without force, so `main` is the commit that was tested.
- A landed pull request shows as merged and gets a comment naming the landed
  commit and the staging run. A batch of two or more lands as one commit whose
  first parent is the previous `main`; each pull request keeps its own merge
  commit under it, which `git revert -m 1` undoes alone.
- A batch that fails twice is split to find the culprit, in at most 6 more runs
  for a batch of 8. Only the pull request a twice-failed run singles out loses
  the label; the others land without being re-labeled. A pull request that
  conflicts while the batch is built loses the label with a comment.
- Revert pull requests (title starting `revert:`, or branch `auto-revert/*`) go
  first, in a batch of their own. While `Build & Test` or `Slow app scenarios`
  is red on the head of `main`, the queue lands reverts only; land a forward
  fix by hand, or wait for the revert. A revert batch that fails on a red
  `main` stays staged and nobody loses the label; remove the label from a
  revert that should not be queued, or add the missing one.
- If `main` goes red after a batch landed, `auto-revert.yml` bisects the batch
  with runs on `merge-queue/bisect/*` branches and opens a revert for the one
  pull request it finds, not for the batch.
- If GitHub refuses the queue's push because a pull request changes
  `.github/workflows/` (the default workflow token may not push workflow
  changes), that pull request loses the label with the refusal in a comment.
  Merge it by hand.
- If a pull request is part of an explicit stack, do not delete a branch another
  PR is based on. Deleting the base closes the stacked PR instead of retargeting
  it. Retarget the stacked PR to `main` first, then delete:
  `gh api -X PATCH 'repos/{owner}/{repo}/pulls/<n>' -f base=main`. If it already
  closed: push the old base back at the same commit, reopen, retarget, then
  delete.
- If merging by hand when the queue is not used, update the PR with `main`, let
  CI re-run, and pass `--match-head-commit` so nothing lands that CI did not see.
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
