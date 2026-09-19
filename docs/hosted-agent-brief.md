# Brief for the implementing agent: hosted sandbox release

Read in this order: this brief, `docs/hosted-release-plan.md`, `docs/hosted-review-ledger.md`. The plan sets the phases and rules. The ledger holds the items. This brief tells you how a fix is done and how it is submitted. Nothing here overrides the plan; where they differ, the plan wins.

## What you are doing

Landing the `hosted-live-mode` branch on `main` as reviewed slices, in the order the plan sets, with every ledger item fixed in the slice that owns it. The branch is a reference. Slices are extracted from it by path onto branches cut from `main`.

You implement. A separate reviewer verifies. Your submission is accepted when the reviewer's own run of the acceptance command is green on your commit. Nothing else closes an item.

## Executable acceptance

`scripts/ledger-acceptance.json` maps ledger items to the tests that prove them. `bun scripts/verify-ledger.ts <item>` runs those tests and prints one line per item with the commit hash:

```
A1	PASS	5 pass, 0 fail	<commit>	packages/pyric/test/sandbox/firestore/ledger/a1-atomic-rule-method.test.ts
```

Phase 1 acceptance tests are already written and fail on the current tip. Your job for phase 1 is to make them pass without changing them. If you believe a phase 1 test asserts the wrong behavior, say so in the submission with the reason; do not edit the test.

For later phases, the first commit for each item adds its acceptance test and its map entry. The test must fail on the tip before your fix. Record that failing run in the commit message body. Then fix.

## How to work an item

1. Pick one item. Set its status to `fixing` in the ledger with your name and the branch.
2. Run `bun scripts/verify-ledger.ts <item>`. It must fail. If it passes before you touch product code, stop and report; the item is either already fixed or the test is wrong.
3. Fix the product code. Change only what the item needs. Do not refactor around it.
4. Run the item's acceptance again, then the package suites the fix touches (`bun test packages/pyric`, `bun test packages/cli/test/serve`, and so on), then the typecheck for the package.
5. Commit with the slice tag from the ledger entry: `fix(core): ...`, `fix(host): ...`, `fix(transport): ...`, `fix(evidence): ...`. One item per commit. The body records the failing run and the passing run.
6. Submit in the format below. Set the item to `verify` in the ledger.

## Submission format

Prose is not a submission. Each item comes back as this block, filled from real output:

```
Item: A1
Slice: core
Commit: <hash>
Before: <the FAIL line from verify-ledger on the tip before the fix>
After:  <the PASS line from verify-ledger on the fix commit>
Suites: <each suite command run, with its pass/fail counts>
Typecheck: <package, exit code>
Files: <changed files, one per line>
Notes: <only if a decision was made or a test is disputed>
```

The reviewer re-runs the After line on the commit. If it does not reproduce, the item goes back to `open`.

## Rules that are not negotiable

- **No verification markdown.** The runner output is the verification. Do not write a doc that says something passed.
- **No references to `ignored/`.** Evidence that is not committed does not exist.
- **Results JSON is read by a test or it is deleted** in the same commit that would have added it.
- **A contract change and the test that pins it land in the same commit.**
- **No new features on the branch.** Fixes and extractions only until the plan says otherwise.
- **No push without the owner's approval. Never merge a pull request.**
- **Do not call pyric's own surfaces "legacy"** in code, comments, or docs. Do not reference issue numbers or tools in code or docs.
- **Do not widen an assertion, skip a test, or mock the behavior under test** to make an item pass. The reviewer reads every test.
- **Report quota at each phase boundary**: agent runs, suite runs, and harness runs.

## What the reviewer will check beyond the runner

- The test itself: that it fails for the stated reason before the fix, asserts the behavior the ledger names, and does not mock it away.
- The diff: that it touches only what the item needs, in the slice it belongs to.
- The package suites and typecheck on the commit.
- Once per slice, a partitioned review of the whole slice before its pull request opens.

## If an item fails verification twice

The reviewer takes the item. You move to the next one. This is not a judgment; it caps the loop.

## Open decisions you must not make

The plan's section 4 lists owner decisions. Until the owner records a ruling there, do not act on either side of it. In particular: do not remove or extend the undo history and backups, do not add or remove the site-docs hosted pages, and do not touch the live entry.
