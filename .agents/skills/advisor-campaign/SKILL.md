---
name: advisor-campaign
description: >-
  Plans, dispatches, reviews, and lands multi-slice engineering campaigns on
  pyric with isolated worktree builders, parallel two-axis read-only review
  (Spec and Standards), SHA-pinned pull request verdict comments, and automated
  merge-queue handoff. Use when coordinating or executing multi-PR feature,
  conformance, or fix campaigns, briefing builders or Spec/Standards reviewers,
  bouncing Round-2 fix briefs, or posting campaign verdicts on pull requests.
  For discovering and verifying new divergences before fixing them, load
  defect-hunt first.
---

# Advisor campaign

Large changes land reliably when builders cannot step on each other's files,
reviewers never share context with the author, and nothing reaches a pull
request or the merge queue without empirical proof on the exact commit SHA.

This skill packages that loop so any contributor or agent session can run it end
to end from this repository.

## Roles and workspace isolation

- **Coordinator (Advisor)**: decomposes the goal into collision-free slices,
  assigns explicit file ownership, provisions isolated worktrees, dispatches
  builders and parallel read-only reviewers, spot-checks high-risk claims,
  posts or verifies SHA-pinned PR verdicts, monitors queue landing, and prunes
  merged worktrees. Keep external campaign notes or run logs in the private ops
  repo, never in this repository.
- **Slice builder**: owns one slice in one dedicated git worktree branched from
  `origin/main`. Implements vertically at pre-agreed public seams
  ([references/implement.md](references/implement.md),
  [references/tdd.md](references/tdd.md)), runs a two-axis self-review, and
  **commits locally only** -- never pushing or opening a PR until both
  independent reviewers return `MERGE`.
- **Spec reviewer** and **Standards reviewer**: two parallel read-only reviewers
  that did not write the code ([references/code-review.md](references/code-review.md)).
  Neither edits or leaves untracked files in the worktree or main checkout; any
  temporary upstream-SDK probe runs in an external scratch directory and is
  deleted before reporting.

## The loop

### 1. Split into collision-free slices

Map call sites and shared contracts on `origin/main` before briefing anyone, and
write a slice ownership table:

| Slice | Scope / Issue | Owns (may edit) | Must not edit | Depends on |
|---|---|---|---|---|
| S1 ... | `#...` | disjoint source + mirrored `test/` files | sibling slices, shared workflows | none |
| S2 ... | `#...` | disjoint surface / CI files | S1 files | S1 (if hard interface dep) |

- **Disjoint file ownership.** Two active slices never edit the same file. If a
  builder discovers it needs a one-line export in an unowned file, it asks the
  coordinator first; exceptions are recorded explicitly.
- **Shared baselines and generated projections.** Scorecards and baselines
  collide when edited in parallel. Keep baseline/projection regeneration in a
  separate commit on a slice so whichever PR lands second can drop that commit,
  rebase onto `origin/main`, regenerate cleanly, and re-commit. Assurance node
  counts use per-PR delta files (`packages/conformance/assurance-node-counts/<service>/<pr>.json`,
  `AGENTS.md` boundary 6) so concurrent PRs merge without conflict.
- **DAG scheduling.** Run independent slices in parallel (for example, up to 4
  concurrent builders) and hold a downstream slice only on genuine interface or
  file-overlap dependencies.

### 2. Provision one worktree per slice and brief the builder

Create a fresh worktree outside the main checkout from `origin/main`:

```sh
git fetch origin main
git worktree add -b <branch-name> <worktree-dir> origin/main
cd <worktree-dir> && bun install --frozen-lockfile
```

Brief the builder with [templates/builder-brief.md](templates/builder-brief.md),
naming its exact owned paths, forbidden paths, pre-agreed public test seams, and
verification gates.

### 3. Implement vertically and commit locally

The builder follows [references/implement.md](references/implement.md),
[references/tdd.md](references/tdd.md) (with [references/tdd-tests.md](references/tdd-tests.md)
and [references/tdd-mocking.md](references/tdd-mocking.md)), and
[references/hygiene.md](references/hygiene.md):

1. Write one failing behavioral test at a pre-agreed public seam (`RED`), then
   minimal production code to pass (`GREEN`), one slice at a time.
2. Keep every new or non-legacy file `<= 600` lines and never grow a legacy
   `> 600`-line file (`docs/code-conventions.md`).
3. Build affected packages, typecheck both `src/` and modified `test/**/*.test.ts`
   files, and run affected suites plus `scripts/ci/knip-audit.ts` and
   `scripts/ci/deletion-guard.ts`.
4. Perform a two-axis self-review over `git diff <base-sha>`, verify `0`
   non-ASCII bytes (`<= 127`), commit locally, and report the 40-char `HEAD` SHA
   and test counts to the coordinator.

### 4. Run parallel two-axis review (`Spec` + `Standards`)

Spawn two independent read-only reviewers concurrently on `<base-sha>...<head-sha>`:

- **Spec reviewer** ([templates/spec-reviewer-brief.md](templates/spec-reviewer-brief.md)):
  verifies clause-by-clause fidelity to the spec, runs empirical probes against
  the installed `firebase` and `firebase-admin` SDKs in `node_modules` and
  committed observations, simulates downstream follow-up states (such as
  staged observations on an `observations/**`-only PR, rebase behavior, cross-plane
  parity across in-process sandbox, SharedWorker, and Node host, and
  revert-to-red test failure), and flags scope creep.
- **Standards reviewer** ([templates/standards-reviewer-brief.md](templates/standards-reviewer-brief.md)):
  enforces `AGENTS.md`, `PRIORITIES.md`, `docs/code-conventions.md`,
  [references/hygiene.md](references/hygiene.md), GitHub Actions least-privilege
  and `env:` safety, CI gates (`knip-audit.ts`, `deletion-guard.ts`,
  `workflow-paths.test.ts`), and the 12-item Fowler code-smell list in
  [references/code-review.md](references/code-review.md), and computes the
  authoritative non-slow `test/apps/<scenario>` list via `scripts/ci/plan.ts`.

### 5. Bounce `FIX` rounds locally

If either reviewer returns `FIX`, do not push or open a PR. Send the builder
[templates/round-2-fix-brief.md](templates/round-2-fix-brief.md) citing the exact
`Spec` and `Standards` findings, behavioral invariants, and re-verification
checks. Once the builder commits Round 2 locally, re-run review on the new
commit SHA until both axes return `MERGE`.

### 6. Push, open the PR, and record SHA-pinned verdicts

Only after both `Spec` and `Standards` return `MERGE`:

1. Rebase onto `origin/main` and re-verify if `main` moved across overlapping
   files or shared baselines.
2. Push the branch and open the PR targeting `main` using
   [templates/pr-body-checklist.md](templates/pr-body-checklist.md) (plain ASCII
   `<= 127`, runnable public-entrypoint hero sample, `## Risk` near the top,
   verification and non-slow `test/apps/<scenario>` list inside `<details>`).
3. Post both SHA-pinned review verdicts on the PR via
   `scripts/ci/campaign-verdict.ts`:

   ```sh
   bun scripts/ci/campaign-verdict.ts \
     --pr <pr-number> --repo <owner/repo> \
     --axis spec --verdict MERGE --sha <40-char-head-sha> \
     --summary "<concise plain-ASCII Spec verification summary>"

   bun scripts/ci/campaign-verdict.ts \
     --pr <pr-number> --repo <owner/repo> \
     --axis standards --verdict MERGE --sha <40-char-head-sha> \
     --summary "<concise plain-ASCII Standards verification summary>"
   ```

   Each comment carries a standalone hidden marker line:

   `<!-- campaign-verdict axis=spec|standards verdict=MERGE|FIX sha=<40-char head sha> -->`

### 7. Enqueue through `merge-queue`

- **Automated path (`.github/workflows/campaign-verdicts.yml`):** triggered on
  `issue_comment` and `pull_request` (`synchronize`, `ready_for_review`,
  `reopened`). `scripts/ci/campaign-verdicts.ts` adds the `merge-queue` label
  only when the PR targets `main`, is open and not a draft, originates from the
  base repository, has trusted (`OWNER`, `MEMBER`, or `COLLABORATOR`) `MERGE`
  verdicts on both `spec` and `standards` matching the current 40-char `head.sha`,
  and has no subsequent trusted `FIX` verdict for that SHA. Pushing a new commit
  changes `head.sha` and invalidates prior verdicts automatically.
  `.github/workflows/merge-queue.yml` then waits for `CI / required` on the PR
  head before staging and landing the batch onto `main`.
- **Manual fallback:** once PR `CI / required` is green and both axes are
  `MERGE`, add `merge-queue` via REST (`gh api -X POST 'repos/{owner}/{repo}/issues/<pr>/labels' -f 'labels[]=merge-queue'`).
  Note that PRs modifying `.github/workflows/*.yml` may be refused on staging
  push when using a token without `workflows` scope and must then be merged by a
  maintainer after green `CI / required`.

### 8. Watch `main` and prune the worktree

After `merge-queue.yml` lands the PR onto `main`, confirm `main` stays green,
then remove the slice's worktree and local branch:

```sh
git worktree remove <worktree-dir>
git branch -d <branch-name>
git worktree prune
```

## Hard rules

- **Local commits until dual `MERGE`.** Builders never push or open PRs prior to
  independent `Spec` and `Standards` sign-off.
- **Read-only reviewers leave zero trace.** Reviewers never modify tracked files
  or leave untracked files in any repository worktree.
- **SHA-pinned verdicts only.** Every verdict names the full 40-char commit SHA
  that was reviewed; any rebase or fix commit requires fresh verdicts on the new
  SHA.
- **Never weaken a gate or pin.** Fix the root cause instead of loosening a
  test, scorecard baseline, or CI check.
- **Strict ASCII and zero leakage.** Enforce [references/hygiene.md](references/hygiene.md)
  everywhere (`<= 127` ASCII, synthetic domain nouns, public imports in samples,
  generic "the private ops repo" wording, and zero machine paths, session IDs,
  hunt IDs, cloud project/service-account details, spend figures, or model names).
