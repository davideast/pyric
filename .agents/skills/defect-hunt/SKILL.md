---
name: defect-hunt
description: >-
  Plans, prioritizes, and runs multi-round defect hunts on pyric surfaces
  against a referee (production Firebase, a written contract such as an ADR, or
  sibling planes that must agree). Use when asked to plan when to do defect
  hunts, decide or rank which surfaces to hunt next from git history churn,
  coverage thinness, and criticality, hunt for bugs in a pyric engine, SDK
  surface or host, verify or re-verify a batch of findings, capture production
  to settle a disputed finding, or plan and land a fix campaign from confirmed
  findings. For pyric's rules engines, load rules-engine-defect-hunt as well.
  Not for auditing an app's own rules or code.
---

# Defect hunt

A green suite tests what the code does. Defects live where the code quietly
departs from what it promises. A defect hunt finds those departures, proves
each one against a referee, and lands the fixes without bending a test to fit.

It runs in rounds. One round on the RTDB rules engine (#1247) started from a
green suite (2,436 of 2,436) and a 91/91 score, used four hunters, five
verifiers and seven production captures, and confirmed 29 defects; 12 were
refuted (6 by production) and 3 waited on runtime evidence.

## When to hunt, and what goes first

Before starting a round, rank candidate surfaces across three axes
([references/triage.md](references/triage.md)):

1. **Criticality sets the floor.** Security Rules always go first: a simulator,
   list-query prover, deploy validator, sandbox enforcement path, live
   local-rules check, or assurance pass that says allow where production says
   deny ships a hole. Isolation and refusal boundaries (Swap-or-Stop, live
   write refusals, credential redaction) come next, then stateful SDK/Admin and
   host data planes, then CLI, MCP, and UI wrappers. Small unhunted changes on
   Security Rules outrank large changes on UI.
2. **Unhunted runtime churn.** Measure runtime `src` changes since the commit
   the surface was last hunted at (`<last-hunt-sha>..origin/main`), separated
   from test edits: commits, share of `src` files touched, lines added and
   deleted, new `src` files, `fix(...)` density (hand-found bugs cluster next
   to unfound siblings), and large fix waves landed *after* the last hunt.
3. **Coverage and referee thinness.** Check `test` to `src` line ratio, `src`
   files with no direct `.test` counterpart, `unverified` or `bug` registry
   rows, and referee strength. A surface backed only by a written contract or
   sibling planes hides shared-assumption bugs that a production oracle would
   catch.

**Trigger now** when Security Rules or an isolation guard changes behavior or
drops a safety layer, when a new surface lands with contract-only evidence,
when `fix(...)` commits cluster on one subsystem, or after a multi-hundred-line
fix wave lands. **Wait** when a surface still has unmerged `REAL` findings from
its last round: land that backlog first so hunters do not rediscover known
bugs, then hunt the post-fix delta.

## Where defects are

Look at boundaries, not at the core everyone already tests:

- **Accepted, then ignored.** A documented field or option that is parsed and
  dropped, merged or coerced.
- **Siblings that disagree.** The simulator vs the sandbox vs replay; the
  in-page sandbox vs the SharedWorker host vs the Node host; the CLI vs the
  library vs MCP.
- **Invalid input accepted.** What production refuses (at deploy, in the SDK)
  evaluated as if it were valid.
- **Host semantics borrowed.** JavaScript coercion, RegExp dialect, `null`
  indexing where production errors.
- **Lifecycle edges.** A drop, a restart, a revocation, a transaction commit:
  the paths a unit test fakes.

## Referees

Every surface gets one referee, chosen in this order: production observed,
then a documented contract, then sibling surfaces that must agree. Siblings
come last because two surfaces can agree on the wrong answer.

| Truth for the surface lives in | Referee | Runbook |
|---|---|---|
| RTDB rules verdicts and deploy checks | Deploy, observe, restore on the oracle instance | [references/oracle-rtdb.md](references/oracle-rtdb.md) |
| Firestore and Storage rules verdicts | Rules Test API, nothing deployed | [references/oracle-rules-test-api.md](references/oracle-rules-test-api.md) |
| SDK behavior: listeners, transactions, offline, error shapes | The real SDK against a real database with deployed rules | [references/oracle-sdk-runtime.md](references/oracle-sdk-runtime.md) |
| A written contract: an ADR, JSDoc, a docs page | The contract's text, clause by clause | [references/contract-adr.md](references/contract-adr.md) |
| Planes that must give the same result | The planes against each other | [references/differential-planes.md](references/differential-planes.md) |

A domain skill adds its surface map and gates on top of this method.
[rules-engine-defect-hunt](../rules-engine-defect-hunt/SKILL.md) is the one for
the rules engines.

## Verdicts

Every finding gets one verdict, from something that was run:

| Verdict | Means |
|---|---|
| `REAL` | A repro shows the defect, and the expected behavior is cited |
| `FALSE` | The claim does not hold, the cited evidence contradicts it, or it is already fixed (name the commit) |
| `NEEDS_RUNTIME` | The answer depends on production behavior no observation captures |

Every expected value cites one of: an observation file, its `behavior` field and
the probe line that produced it; an official Firebase docs URL with a quoted
sentence; or pyric's own contract (ADR clause, JSDoc, docs page). Without a
citation the verdict is `NEEDS_RUNTIME`, never `REAL`.

A repro asserts the correct behavior and prints `OPEN` or `FIXED`
([templates/recheck.mjs](templates/recheck.mjs)). A script that can only print
"bug" is not evidence. A uniform batch (9 of 9 `REAL`) means you re-check a
sample yourself before accepting it.

## Defect classes and standing checks

Every finding carries four classification tags from
[references/defect-classes.md](references/defect-classes.md):

- **Class:** one of the 7 primary classes (`SEMANTICS-DIVERGENCE`,
  `STATE-ROUNDTRIP`, `BACKEND-PARITY`, `ENTRYPOINT-PARITY`, `GUARD-BYPASS`,
  `FAIL-OPEN`, `REDACTION-LEAK`), a normalized `OTHER:*` class, or
  `NEW:<SHORT-NAME>` when a defect fits none of them.
- **Sub-Class:** required `SD:*` sub-class when `Class` is
  `SEMANTICS-DIVERGENCE`, else `n/a`.
- **Mechanism:** short `kebab-case` name of the exact failure mechanism.
- **Novelty:** `new-class`, `new-mechanism`, or `repeat-mechanism (<prior ID>)`.

**Escalation rule.** When a class (or `SD:*` sub-class) repeats across
consecutive rounds or reaches `>= 3` confirmed `REAL` findings in one round,
point fixes per repro are no longer enough: the fix campaign must add or extend
a class-level standing mechanical check (property roundtrip, cross-plane matrix,
differential oracle, or canary sweep) so sibling consumers fail CI immediately.

## A round

You are the coordinator. Workers hunt, verify and fix; you route work, keep
verdicts calibrated, spot-check, and run every capture yourself. Steps 4, 5
and 7 parallelize well: one agent per angle, verifier batch or fix stream, a
shared board, briefs from [templates/](templates/). Start a ledger from
[templates/ledger.md](templates/ledger.md) before step 1.

1. **Pick the referee.** Map each surface in scope to a row of the referee
   table. Done when every surface has a referee in the ledger, and any surface
   whose only referee is a sibling says so.
2. **Verify live access.** Run the runbook's readiness check and preview,
   then one credentialed control capture, then read the oracle's rules and data
   back and confirm they are at rest. Run it in a
   [scratch worktree](#captures-run-in-a-scratch-worktree) and copy nothing
   back if the control only confirms. Done when the control agrees with its
   committed observation. If access fails, resolve it before hunting, or record that
   this round runs on committed observations only.
3. **Baseline.** Record the target commit and run the domain's gates. Measure
   where evidence is thin: constructs with no observation, surviving mutants,
   documented options no test mentions. Done when the ledger has the counts.
4. **Hunt by angle.** One hunter per angle from
   [references/workstreams.md](references/workstreams.md): contract sweep,
   differential, metamorphic, fault injection. Brief each with
   [templates/hunter-brief.md](templates/hunter-brief.md). Every finding carries
   `Class`, `Sub-Class`, `Mechanism`, and `Novelty` from
   [references/defect-classes.md](references/defect-classes.md). Repros go in a
   scratch directory, never the repo. Done when every hunter has posted
   findings and clean results with counts.
5. **Verify independently.** Agents that did not hunt re-run every repro on a
   clean checkout ([templates/verifier-brief.md](templates/verifier-brief.md)),
   give each sub-claim a verdict, and audit its `Class`, `Sub-Class`,
   `Mechanism`, and `Novelty` tag. You spot-check the highest-severity findings
   and any whose expected value rests on production. Done when every finding has
   a verdict, verified class label, and a citation or `NEEDS_RUNTIME`.
6. **Settle disputes by capture.** For each `NEEDS_RUNTIME` that matters, and
   each finding a verifier disputes, author a scenario and capture production
   through the runbook. Production may refute a finding: record that as
   `FALSE`, prominently. Done when no disputed finding is left without a
   capture or a written reason it waits.
7. **Run the fix campaign.** Pins first, then red to green, disjoint ownership,
   two-axis review, one-at-a-time merges:
   [references/fix-campaign.md](references/fix-campaign.md), then
   [references/shipping.md](references/shipping.md) for PRs and issues. Attach
   or extend a class-level standing check for any repeat class (`>= 3` findings
   or consecutive-round repeat).
8. **Record the yield.** Add the round's row and `Yield by class` breakdown to
   the ledger: target commit, `src` paths hunted (so the next triage diffs
   `<last-hunt-sha>..origin/main` mechanically), reported, confirmed (`REAL`),
   false, new, new mechanisms, and repeat mechanisms. Score the round on new
   mechanisms uncovered and repeat-mechanism rate, not raw count alone. Run
   another round on an angle while it still yields new findings; if a round is
   dominated by repeats of one class, land that class's standing check before
   spending another hunter sweep on the same surface.

## Captures run in a scratch worktree

Every capture runs in a throwaway worktree outside the main checkout, so a
runner that rewrites more than you asked for never touches your tree:

```sh
git worktree add --detach <scratch> origin/main
cd <scratch> && bun install --frozen-lockfile
# run the capture here, credentials by env
```

Then copy back into your working branch only the observation files you
deliberately captured, and remove the scratch tree with
`git worktree remove --force <scratch>`. Your working tree never needs
anything discarded. Agents on this machine cannot discard working-tree changes
anyway: a safety hook blocks those git commands.

## Hard rules

- Never edit a test, observation or expectation to make a result come out. An
  unexpected green usually means already fixed: report it. Observations change
  only by re-capture.
- Captures are coordinator-only, one at a time, against the dedicated oracle
  only. Every capture names its scenario or probe: most runners capture
  everything and rewrite every observation file when given none.
- After every capture, read the oracle's rules and data back yourself and
  confirm they are at rest before the next. A capture that does not print its
  restore line makes this urgent, not optional.
- Credentials are passed by env for the one command that needs them. Never
  print them, never write them to `.env` or anywhere in the repo. The oracle
  rigs run keyless: with `PYRIC_ORACLE_SA_PATH` unset they use Application
  Default Credentials and `PYRIC_ORACLE_PROJECT_ID` names the project
  (`packages/conformance/docs/oracle-project-setup.md`). A key file, when one
  is used, stays outside the checkout.
- The final ledger lists `FALSE`, `NEEDS_RUNTIME` and unverified items next to
  the confirmed ones.
- Issues and PR text describe pyric, generically. They do not name the app or
  project that prompted the hunt.
