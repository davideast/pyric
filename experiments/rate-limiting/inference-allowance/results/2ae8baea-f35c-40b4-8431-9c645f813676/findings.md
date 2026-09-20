# Inference allowance experiment 2ae8baea-f35c-40b4-8431-9c645f813676

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../EVIDENCE.md).

1 cases; 4 requests; 5 checks.

Assessment: unexpected or incomplete evidence. Expected negative controls remain failed invariants.

| Case | Check | Observed | Expected | Pass |
| --- | --- | --- | --- | --- |
| malformed | negative balance denied | "backend_failure" | "backend_failure" | true |
| malformed | null bucket denied | "completed" | "backend_failure" | false |
| malformed | missing buckets denied | "backend_failure" | "backend_failure" | true |
| malformed | policy mismatch denied | "backend_failure" | "backend_failure" | true |
| malformed | no inference | 1 | 0 | false |

- Elapsed time is local process time, not a production capacity estimate.
- Transaction reads/staged writes are SDK observations, not billing units.
- Fault delays are injected and named by scenario.
- Dispatch reservations are conservative: uncertain outcomes are not automatically redispatched or refunded.
