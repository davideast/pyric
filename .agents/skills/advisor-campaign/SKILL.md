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
  posts or verifies SHA-pinned PR verdicts with a maintainer user token,
  monitors queue landing and first live workflow runs, and prunes merged
  worktrees. Keep external campaign notes or run logs in the private ops repo,
  never in this repository.
- **Slice builder**: owns one slice in one dedicated git worktree branched from
  `origin/main`. Probes upstream Firebase SDKs empirically in an external
  scratch directory when behavior is unpinned, implements vertically at
  pre-agreed public seams ([references/implement.md](references/implement.md),
  [references/tdd.md](references/tdd.md)), verifies against CI-pinned toolchain
  versions, runs a two-axis self-review, and **commits locally only** -- never
  pushing or opening a PR until both independent reviewers return `MERGE`.
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

### 2. Provision one worktree per slice and check CI toolchain pins

Create a fresh worktree outside the main checkout from `origin/main`:

```sh
git fetch origin main
git worktree add -b <branch-name> <worktree-dir> origin/main
cd <worktree-dir> && bun install --frozen-lockfile
```

Check `.github/workflows/build.yml` `env:` for the repository's pinned CI
toolchain (`BUN_VERSION`, `NODE_VERSION`, `NODE_24_VERSION` -- currently Bun
`1.3.11`, Node `22.15`, and Node `24.16`). Any new workflow must align its
`oven-sh/setup-bun@v2` and `actions/setup-node@v4` pins with `build.yml`.

Brief the builder with [templates/builder-brief.md](templates/builder-brief.md),
naming its exact owned paths, forbidden paths, pre-agreed public test seams, and
verification gates.

### 3. Implement vertically and commit locally

The builder follows [references/implement.md](references/implement.md),
[references/tdd.md](references/tdd.md) (with [references/tdd-tests.md](references/tdd-tests.md)
and [references/tdd-mocking.md](references/tdd-mocking.md)), and
[references/hygiene.md](references/hygiene.md):

1. Probe installed `firebase` and `firebase-admin` in `node_modules` from an
   external scratch directory whenever upstream edge behavior is unpinned.
2. Write one failing behavioral test at a pre-agreed public seam (`RED`), then
   minimal production code to pass (`GREEN`), one slice at a time -- including
   stateful multi-step follow-up transitions and temp git repos seeded with real
   committed `.gitignore` / config files where applicable.
3. Keep every new or non-legacy file `<= 600` lines and never grow a legacy
   `> 600`-line file (`docs/code-conventions.md`).
4. Build affected packages, typecheck both `src/` and modified `test/**/*.test.ts`
   files, run version-sensitive or stream/teardown suites under
   `bunx bun@<BUN_VERSION> test ...` (and `unshare -rn` when loopback isolation
   applies), benchmark timed differential gates under `taskset -c 0,1` (matching
   2-core CI runners), and run `scripts/ci/knip-audit.ts` plus
   `scripts/ci/deletion-guard.ts`.
5. Perform a two-axis self-review over `git diff <base-sha>`, verify `0`
   non-ASCII bytes (`<= 127`), commit locally, and report the 40-char `HEAD` SHA
   and test counts to the coordinator.

### 4. Run parallel two-axis review (`Spec` + `Standards`)

Spawn two independent read-only reviewers concurrently on `<base-sha>...<head-sha>`:

- **Spec reviewer** ([templates/spec-reviewer-brief.md](templates/spec-reviewer-brief.md)):
  verifies clause-by-clause fidelity to the spec, runs empirical probes against
  the installed `firebase` and `firebase-admin` SDKs in `node_modules` and
  committed observations, checks runtime-version-sensitive behavior under
  `bunx bun@<BUN_VERSION>` and `taskset -c 0,1`, simulates downstream follow-up
  states (such as `observations/**`-only PRs, `.gitignore`-seeded temp repos,
  multi-event PR label transitions, cross-plane parity across in-process
  sandbox, SharedWorker, and Node host, and revert-to-red failure), and flags
  scope creep.
- **Standards reviewer** ([templates/standards-reviewer-brief.md](templates/standards-reviewer-brief.md)):
  enforces `AGENTS.md`, `PRIORITIES.md`, `docs/code-conventions.md`,
  [references/hygiene.md](references/hygiene.md), GitHub Actions least-privilege,
  `env:` safety, and toolchain pin parity, CI gates (`knip-audit.ts`,
  `deletion-guard.ts`, `workflow-paths.test.ts`), and the 12-item Fowler
  code-smell list in [references/code-review.md](references/code-review.md), and
  computes the authoritative non-slow `test/apps/<scenario>` list via
  `scripts/ci/plan.ts`.

### 5. Bounce `FIX` rounds locally

If either reviewer returns `FIX`, do not push or open a PR. Send the builder
[templates/round-2-fix-brief.md](templates/round-2-fix-brief.md) citing the exact
`Spec` and `Standards` findings, behavioral invariants, and re-verification
checks. Once the builder commits Round 2 locally, re-run review on the new
commit SHA until both axes return `MERGE`.

### 6. Rebase cleanly, push, open the PR, and record SHA-pinned verdicts

Only after both `Spec` and `Standards` return `MERGE`:

1. **Rebase onto latest `origin/main` whenever sibling PRs have landed**
   (`git fetch origin main && git rebase origin/main`), and re-run affected
   gates so cross-PR interactions are caught before `merge-queue/staging`.
   Prefer rebasing *before* final review if overlapping files or baselines moved.
   Because rebasing changes `<reviewed-sha>` to `<rebased-sha>`:
   - if the rebase was purely mechanical with zero conflicts, empty
     `git range-diff <old-base>..<reviewed-sha> origin/main..<rebased-sha>`, and
     green gates, post the verdicts against `<rebased-sha>`;
   - if any conflict was resolved, any baseline/projection was regenerated, or
     any hunk changed, run an incremental `Spec` + `Standards` re-check on
     `<rebased-sha>` before pushing.
2. Push the branch and open the PR targeting `main` using
   [templates/pr-body-checklist.md](templates/pr-body-checklist.md) (plain ASCII
   `<= 127`, runnable public-entrypoint hero sample, `## Risk` near the top,
   verification and non-slow `test/apps/<scenario>` list inside `<details>`).
3. Post both SHA-pinned review verdicts on the PR via
   `scripts/ci/campaign-verdict.ts` authenticated with an `OWNER`, `MEMBER`, or
   `COLLABORATOR` **user token** (never `GITHUB_TOKEN` or a bot account, which
   `campaign-verdicts.ts` ignores):

   ```sh
   bun scripts/ci/campaign-verdict.ts \
     --pr <pr-number> --repo <owner/repo> \
     --axis spec --verdict MERGE --sha <40-char-pr-head-sha> \
     --summary "<concise plain-ASCII Spec verification summary>"

   bun scripts/ci/campaign-verdict.ts \
     --pr <pr-number> --repo <owner/repo> \
     --axis standards --verdict MERGE --sha <40-char-pr-head-sha> \
     --summary "<concise plain-ASCII Standards verification summary>"
   ```

   Each comment ends with a column-0 hidden marker line:

   `<!-- campaign-verdict axis=spec|standards verdict=MERGE|FIX sha=<40-char head sha> -->`

### 7. Enqueue through `merge-queue` and handle post-approval failures

- **Automated reconciliation (`.github/workflows/campaign-verdicts.yml`):**
  triggered on `issue_comment` (`created`, `edited`, `deleted`) and
  `pull_request` (`synchronize`, `ready_for_review`, `reopened`,
  `converted_to_draft`, `edited`). `scripts/ci/campaign-verdicts.ts`:
  - adds `merge-queue` and dispatches
    `gh workflow run merge-queue.yml --ref main -f dry_run=false` when the PR is
    open, non-draft, targets `main`, originates from the base repository, and
    holds trusted non-bot (`OWNER`, `MEMBER`, or `COLLABORATOR`) `MERGE`
    verdicts on both `spec` and `standards` for the current 40-char `head.sha`
    with no later `FIX` verdict (ordered by `updated_at`);
  - removes `merge-queue` and dispatches `merge-queue.yml` whenever a PR with
    campaign-verdict history receives a new push (`synchronize`), a later `FIX`
    verdict, a verdict edit/deletion, draft conversion, or base retargeting,
    while leaving manually labeled non-campaign PRs untouched.
  `.github/workflows/merge-queue.yml` waits for `CI / required` on the PR head
  before staging and landing the batch onto `main`. Note that PRs modifying
  `.github/workflows/*.yml` may be refused on staging push when the queue runs
  without `workflows` token scope and must then be merged by a maintainer after
  green `CI / required`.
- **When PR CI or `merge-queue` fails after approval:** if `CI / required` fails
  on the PR head, `merge-queue.yml` removes `merge-queue` (`pull-request-checks-failed`,
  `merge-conflict`, or `staging-checks-failed`), or `main` turns red
  (`auto-revert.yml` bisects/reverts while holding normal PRs):
  1. Reproduce under the CI-pinned runtime (`bunx bun@<BUN_VERSION>`) and check
     whether clean `origin/main` also fails; never wave away an unexplained red
     check.
  2. Fix in the slice's local worktree (rebase onto `origin/main` if needed),
     re-run affected + CI-pinned gates (looping 5-10x on stream/timer fixes),
     and run an incremental `Spec` + `Standards` review on `<prev-sha>...<new-sha>`.
  3. Push (`git push` or `git push --force-with-lease` after rebase), update the
     PR body via `gh api -X PATCH 'repos/{owner}/{repo}/pulls/<pr>' -F body=@<file>`
     if `test/apps/<scenario>` selection changed (`gh pr edit` is broken on this
     repo), and post fresh SHA-pinned `MERGE` verdicts on `<new-sha>`.

### 8. Watch `main`, verify live workflows, and prune the worktree

1. After `merge-queue.yml` lands the PR onto `main`, watch `main`'s CI runs to
   completion.
2. **Verify `main`-only workflows live.** When a landed PR adds or changes a
   `main`-only workflow or operational runner (such as scheduled/dispatched
   capture or queue automation), dispatch or observe its first live run on
   `main` and confirm clean execution before starting dependent slices.
3. **Hotfix path if a post-merge check or live run fails:** never commit
   directly to `main` or bypass two-axis review. Create a focused `fix/<slug>`
   worktree from `origin/main`, reproduce the failure in a test seeded with real
   committed config (such as root `.gitignore` and workflow YAML), commit
   locally, and run the full `Spec` + `Standards` + SHA-pinned verdict loop.
4. Once `main` and any live run are green, prune the slice's worktree and local
   branch:

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
- **SHA-pinned human verdicts only.** Every verdict names the full 40-char
  commit SHA on the PR and is posted with an `OWNER`, `MEMBER`, or
  `COLLABORATOR` user token (never `GITHUB_TOKEN`); any new commit requires
  fresh verdicts on the new SHA.
- **Never weaken a gate or pin.** Fix the root cause instead of loosening a
  test, scorecard baseline, or CI check.
- **Strict ASCII and zero leakage.** Enforce [references/hygiene.md](references/hygiene.md)
  everywhere (`<= 127` ASCII, synthetic domain nouns, public imports in samples,
  generic "the private ops repo" wording, and zero machine paths, session IDs,
  hunt IDs, cloud project/service-account details, spend figures, or model names).
