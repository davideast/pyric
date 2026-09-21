# Inference allowance experiment f9053384-2444-4253-ae9f-0604f0a3ebb0

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../EVIDENCE.md).

9 cases; 102 requests; 43 checks.

Assessment: unexpected or incomplete evidence. Expected negative controls remain failed invariants.

| Case | Check | Observed | Expected | Pass |
| --- | --- | --- | --- | --- |
| portable-burst | allowance conserved for both users | true | true | true |
| portable-burst | dispatches do not exceed charges | true | true | true |
| portable-burst | dispatches unique per user request | 0 | 0 | true |
| portable-burst | all responses classified | true | true | true |
| portable-burst | contending user makes progress | false | true | false |
| portable-burst | other user makes progress | false | true | false |
| refill | initial capacity | ["completed","completed","completed","completed","completed"] | ["completed","completed","completed","completed","completed"] | true |
| refill | exhausted | "quota_exhausted" | "quota_exhausted" | true |
| refill | half token denied | ["quota_exhausted",3000] | ["quota_exhausted",3000] | true |
| refill | exact refill boundary | "completed" | "completed" | true |
| refill | long idle capped | ["completed","completed","completed","completed","completed","quota_exhausted"] | ["completed","completed","completed","completed","completed","quota_exhausted"] | true |
| refill | backwards clock gives no credit | "quota_exhausted" | "quota_exhausted" | true |
| isolation | chat exhausted | "quota_exhausted" | "quota_exhausted" | true |
| isolation | agent independent | "completed" | "completed" | true |
| isolation | other user independent | "completed" | "completed" | true |
| isolation | saved balances isolated | [0,60000,240000] | [0,60000,240000] | true |
| duplicates | one dispatch | 1 | 1 | true |
| duplicates | one charge | 240000 | 240000 | true |
| duplicates | changed payload rejected | "conflict" | "conflict" | true |
| duplicates | duplicate does not redispatch | 1 | 1 | true |
| before-commit-failure | failure returned | "backend_failure" | "backend_failure" | true |
| before-commit-failure | no dispatch | 0 | 0 | true |
| before-commit-failure | no charge | null | null | true |
| before-commit-failure | retry succeeds | "completed" | "completed" | true |
| commit-ack-lost | uncertain outcome | "outcome_unknown" | "outcome_unknown" | true |
| commit-ack-lost | no premature dispatch | 0 | 0 | true |
| commit-ack-lost | retry resumes admission | "completed" | "completed" | true |
| commit-ack-lost | charged once | 240000 | 240000 | true |
| commit-ack-lost | dispatched once | 1 | 1 | true |
| dispatch-ack-lost | uncertain claim | "outcome_unknown" | "outcome_unknown" | true |
| dispatch-ack-lost | no premature inference | 0 | 0 | true |
| dispatch-ack-lost | retry does not reclaim dispatch | "duplicate" | "duplicate" | true |
| dispatch-ack-lost | no dispatch after retry | 0 | 0 | true |
| dispatch-ack-lost | allowance retained | 240000 | 240000 | true |
| provider-failure | provider outcome uncertain | "outcome_unknown" | "outcome_unknown" | true |
| provider-failure | one attempted inference | 1 | 1 | true |
| provider-failure | no automatic refund | 240000 | 240000 | true |
| provider-failure | no duplicate inference | 1 | 1 | true |
| malformed | negative balance denied | "backend_failure" | "backend_failure" | true |
| malformed | null bucket denied | "backend_failure" | "backend_failure" | true |
| malformed | missing buckets denied | "backend_failure" | "backend_failure" | true |
| malformed | policy mismatch denied | "backend_failure" | "backend_failure" | true |
| malformed | no inference | 0 | 0 | true |

- Elapsed time is local process time, not a production capacity estimate.
- Transaction reads/staged writes are SDK observations, not billing units.
- Fault delays are injected and named by scenario.
- Dispatch reservations are conservative: uncertain outcomes are not automatically redispatched or refunded.
