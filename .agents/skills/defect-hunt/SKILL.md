---
name: defect-hunt
description: Defect hunt on a pyric surface, in rounds, against a referee (production Firebase, a written contract such as an ADR, or sibling planes that must agree). Use when asked to hunt for bugs in a pyric engine, SDK surface or host, run another hunt round, verify or re-verify a batch of findings, capture production to settle a disputed finding, or plan and land a fix campaign from confirmed findings. For pyric's rules engines, load rules-engine-defect-hunt as well. Not for auditing an app's own rules or code.
---

# Defect hunt

A green suite tests what the code does. Defects live where the code quietly
departs from what it promises. A defect hunt finds those departures, proves
each one against a referee, and lands the fixes without bending a test to fit.

It runs in rounds. One round on the RTDB rules engine (#1247) started from a
green suite (2,436 of 2,436) and a 91/91 score, used four hunters, five
verifiers and seven production captures, and confirmed 29 defects; 12 were
refuted (6 by production) and 3 waited on runtime evidence.

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
   [templates/hunter-brief.md](templates/hunter-brief.md). Repros go in a
   scratch directory, never the repo. Done when every hunter has posted
   findings and clean results with counts.
5. **Verify independently.** Agents that did not hunt re-run every repro on a
   clean checkout ([templates/verifier-brief.md](templates/verifier-brief.md))
   and give each sub-claim a verdict. You spot-check the highest-severity
   findings and any whose expected value rests on production. Done when every
   finding has a verdict and a citation or `NEEDS_RUNTIME`.
6. **Settle disputes by capture.** For each `NEEDS_RUNTIME` that matters, and
   each finding a verifier disputes, author a scenario and capture production
   through the runbook. Production may refute a finding: record that as
   `FALSE`, prominently. Done when no disputed finding is left without a
   capture or a written reason it waits.
7. **Run the fix campaign.** Pins first, then red to green, disjoint ownership,
   two-axis review, one-at-a-time merges:
   [references/fix-campaign.md](references/fix-campaign.md), then
   [references/shipping.md](references/shipping.md) for PRs and issues.
8. **Record the yield.** Add the round's row to the ledger: reported, confirmed
   (`REAL`), false, and new (confirmed and not in an earlier round, an open
   issue or the pins). Run another round on an angle while it still yields new
   findings; an angle whose round yields none is done for that surface.

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
