# <Engine> rules engine defect hunt: ledger

**Target:** `origin/main` @ `<sha>`. Suite before the hunt: <pass>/<total>.
**Team:** <hunters>, <verifiers>; coordinator: <who>.
**Production oracle:** <instance / Rules Test API project, or "none: observations only">.

## Baseline measurements

| Measure | Value |
|---|---|
| Grammar features with 0 production observations | <n> of <total> |
| Mutation score (`<paths>`) | <killed>/<mutants> |
| Rules score | <n>/<denominator> |

## Outcome

| | Count |
|---|---|
| Findings reported | |
| REAL (whole or part) | |
| NEEDS_RUNTIME_MRE | |
| FALSE | |
| ALREADY_FIXED | |
| Spot-checked by coordinator | <IDs and result> |

## Findings

| ID | Severity | Defect | Verdict | Evidence for expected | Repro | Status |
|---|---|---|---|---|---|---|
| | | | | | | open / pinned / fixed in <sha> / filed #<n> / refuted |

## Clean results

What was run and found nothing, with counts.

## Production captures

| Scenario | Cases | Agree / disagree | Refuted findings |
|---|---|---|---|

## Refuted, unverified and deferred

Every `FALSE`, `NEEDS_RUNTIME_MRE` and deferred item, with the reason. Never
omit this section.
