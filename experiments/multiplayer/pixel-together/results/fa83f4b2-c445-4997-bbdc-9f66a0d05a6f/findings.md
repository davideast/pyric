# Captured outcomes

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../EVIDENCE.md).

Evidence about this synthetic architecture, not the Kin UI or production.

| Case | Invariant | Outcome |
| --- | --- | --- |
| stale-grid | distinct edits survive | EXPECTED FAILURE |
| stale-grid | both listeners receive subsequent write | PASS |
| transaction-grid | distinct edits survive | PASS |
| transaction-grid | both listeners receive subsequent write | PASS |
| pixel-records | distinct edits survive | PASS |
| pixel-records | both listeners receive subsequent write | PASS |
| claims | exactly one claimant | PASS |
| claims | owner can draw | PASS |
| claims | other member cannot draw | PASS |
| claims | outsider cannot draw | PASS |
| claims | signed out cannot draw | PASS |
| claims | other member cannot release | PASS |
| claims | forged claimant rejected | PASS |
| claims | released color claimable | PASS |
| claims | former owner cannot draw | PASS |
| claims | new owner can draw | PASS |
| claim-aba-control | old claim write rejected after reacquisition | EXPECTED FAILURE |
| fenced-claims | fresh owner can draw | PASS |
| fenced-claims | released claim cannot draw | PASS |
| fenced-claims | epoch advances on reacquisition | PASS |
| fenced-claims | old claim write rejected after reacquisition | PASS |
| fenced-claims | stale release rejected | PASS |
| fenced-claims | rejected write leaves pixel unchanged | PASS |
| fenced-claims | claim cannot be deleted | PASS |
| fenced-claims | epoch cannot be reset | PASS |
| fenced-claims | other member cannot use current epoch | PASS |
| same-pixel | later serialized commit wins | PASS |
| same-pixel | other pixel unchanged | PASS |
| listener-resubscribe | resubscription observes missed write | PASS |

Expected negative controls: stale-grid: distinct edits survive; claim-aba-control: old claim write rejected after reacquisition.

- No hosted latency, billing, quotas, offline delivery, TTL or load measured
- Two synthetic identities share an in-process backend, not independent network clients
- Claim ownership uses backend Rules; no local Kin policy gate
- Delayed payloads are scheduled by the harness, not a real offline queue; listener recovery uses unsubscribe/resubscribe
