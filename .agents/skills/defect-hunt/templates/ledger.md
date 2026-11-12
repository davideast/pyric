# <Surface> defect hunt: ledger

**Target:** `origin/main` @ `<sha>`. Suite before the hunt: <pass>/<total>.
**Scope:** `<packages/.../src/... paths hunted>`.
**Team:** <hunters>, <verifiers>; coordinator: <who>.
**Referees:** <surface -> production oracle (instance or project) | contract
(ADR) | planes>. Live access verified: <control capture and result, or "none:
committed observations only">.

## Baseline measurements

| Measure | Value |
|---|---|
| Constructs with 0 production observations | <n> of <total> |
| Mutation score (`<paths>`) | <killed>/<mutants> |
| Published score | <n>/<denominator> |

## Yield by round

| Round | Date | Angles | Reported | Confirmed (`REAL`) | False | New | New Mechanisms | Repeat Mechanisms |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |

New means confirmed and not found in an earlier round, an open issue, or the
pins. Track **New Mechanisms** vs **Repeat Mechanisms** (`references/defect-classes.md`)
to detect when a class needs a standing mechanical check rather than another
hunter sweep. An angle with no new findings in a round is done for this surface.

## Yield by class

| Class | Sub-Class | Confirmed (`REAL`) | `Sev-1` | Repeat Mechanisms | Standing Check Action |
|---|---|---|---|---|---|
| | | | | | none / extend existing / build new (`>= 3` or repeat) |

## Findings

| ID | Round | Severity | Class (Sub-Class) | Mechanism | Novelty | Defect | Verdict | Evidence for expected | Repro | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | open / pinned / fixed in <sha> / filed #<n> / refuted |

## Clean results

What was run and found nothing, with counts.

## Captures

| Scenario or probe | Cases | Agree / disagree | Rules and data at rest | Refuted findings |
|---|---|---|---|---|

## Refuted, unverified and deferred

Every `FALSE`, `NEEDS_RUNTIME` and deferred item, with the reason. Never omit
this section.
