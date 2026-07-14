# 0003: Keep corpus migrations and mechanical Messaging history out of the app-registry change

Status: Accepted follow-ups for the app-registry/SharedWorker PR

Date: 2026-07-14

## Findings

The final focused reviews identified three non-correctness debts:

1. Observation JSON repeats its filename key in a `name` property, while the
   ratified data-record convention says the filename is the only join key.
   This is corpus-wide: current capture writers, validators, readers, and the
   committed observation corpus all use the property.
2. The coverage ratchet prevents regressions in the published totals, but it
   does not independently prove that every removed denominator entry was a
   legitimate surface reclassification.
3. The Messaging public implementation moved from `messaging/index.ts` to
   `messaging/client.ts` in the same working change that added app-scoped
   subscription teardown. The resulting source follows the public-barrel and
   one-family-per-file rules, but the move and behavior should remain distinct
   review units in the eventual commit history.

## Decision for this PR

Do not partially remove `name` from only the nine new app observations. That
would create two observation schemas and make captured evidence depend on its
surface. Keep the existing validated schema until one mechanical migration can
update every writer, validator, reader, fixture, and observation together.

Do not change coverage math or the Messaging source shape merely to hide these
review findings. The coverage-adversary review confirmed that this PR's
Messaging denominator reduction is a legitimate public-surface
reclassification and that the overall score fell rather than being inflated.
The Messaging source now has a re-export-only public barrel and a single client
API family file; app-owned listener teardown is required behavior.

## Follow-up boundaries

Before changing the observation schema:

1. Characterize all writers, validators, readers, fixtures, and generated-doc
   inputs that consume observation `name`.
2. Remove the duplicate key from the complete corpus in one mechanical change.
3. Derive the key from the filename at every read boundary and rerun every
   conformance and generated-document gate.

Before the next change that reclassifies or removes coverage denominator rows:

1. Add a ratchet that reports removed row identities and requires an explicit
   classification reason.
2. Prove the old and new inventories against the installed public package
   surface, not only aggregate counts.

When assembling this PR's commit history, keep the mechanical
`messaging/index.ts` to `messaging/client.ts` extraction separate from the
app-lifecycle behavior commit. No correctness, isolation, lifecycle, evidence,
or score-inflation defect is waived by this decision.
