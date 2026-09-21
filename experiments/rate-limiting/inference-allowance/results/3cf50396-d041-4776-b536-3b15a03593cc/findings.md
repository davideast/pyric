# Inference allowance experiment 3cf50396-d041-4776-b536-3b15a03593cc

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../EVIDENCE.md).

17 cases; 386 requests; 69 checks.

Assessment: expected evidence observed. Expected negative controls remain failed invariants.

| Case | Check | Observed | Expected | Pass |
| --- | --- | --- | --- | --- |
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
| burst-50 | five admissions | 5 | 5 | true |
| burst-50 | remaining requests denied | 45 | 45 | true |
| burst-50 | saved balance zero | 0 | 0 | true |
| burst-50 | transaction retries observed | true | true | true |
| unsafe-burst | allowance respected | false | true | false |
| unsafe-burst | overspending reproduced | 50 | 50 | true |
| duplicates | one dispatch | 1 | 1 | true |
| duplicates | one charge | 240000 | 240000 | true |
| duplicates | changed payload rejected | "conflict" | "conflict" | true |
| duplicates | duplicate does not redispatch | 1 | 1 | true |
| authentication-timeout | auth deadline returned | "admission_timeout" | "admission_timeout" | true |
| authentication-timeout | no late transaction | false | false | true |
| authentication-timeout | no late inference | 0 | 0 | true |
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
| admission-timeout | timeout returned | "admission_timeout" | "admission_timeout" | true |
| admission-timeout | no late dispatch | 0 | 0 | true |
| admission-timeout | no late charge | null | null | true |
| admission-timeout | subsequent request succeeds | "completed" | "completed" | true |
| provider-failure | provider outcome uncertain | "outcome_unknown" | "outcome_unknown" | true |
| provider-failure | one attempted inference | 1 | 1 | true |
| provider-failure | no automatic refund | 240000 | 240000 | true |
| provider-failure | no duplicate inference | 1 | 1 | true |
| authorization | signed out rejected | "unauthenticated" | "unauthenticated" | true |
| authorization | forged UID rejected | "invalid_request" | "invalid_request" | true |
| authorization | unknown category rejected | "invalid_request" | "invalid_request" | true |
| authorization | unknown model rejected | "invalid_request" | "invalid_request" | true |
| authorization | client quota edits denied | true | true | true |
| authorization | no inference | 0 | 0 | true |
| malformed | negative balance denied | "backend_failure" | "backend_failure" | true |
| malformed | null bucket denied | "backend_failure" | "backend_failure" | true |
| malformed | missing buckets denied | "backend_failure" | "backend_failure" | true |
| malformed | policy mismatch denied | "backend_failure" | "backend_failure" | true |
| malformed | no inference | 0 | 0 | true |
| flood | normal users complete | ["completed","completed","completed","completed","completed"] | ["completed","completed","completed","completed","completed"] | true |
| flood | flood stays within allowance | true | true | true |
| flood | outstanding work drains | true | true | true |
| guarded-flood | normal users complete | ["completed","completed","completed","completed","completed"] | ["completed","completed","completed","completed","completed"] | true |
| guarded-flood | flood stays within allowance | true | true | true |
| guarded-flood | outstanding work drains | true | true | true |
| guarded-flood | guard sheds requests | true | true | true |
| multi-gateway | shared allowance respected | 5 | 5 | true |
| multi-gateway | both instances observed | 2 | 2 | true |
| multi-gateway | duplicate across instances charged once | 240000 | 240000 | true |
| retry-exhaustion | some native transactions fail | true | true | true |
| retry-exhaustion | allowance never exceeded | true | true | true |
| retry-exhaustion | inference requires admission | true | true | true |

- Elapsed time is local process time, not a production capacity estimate.
- Transaction reads/staged writes are SDK observations, not billing units.
- Fault delays are injected and named by scenario.
- Dispatch reservations are conservative: uncertain outcomes are not automatically redispatched or refunded.
