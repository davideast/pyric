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
| competing-reacquisition | exactly one winner and one epoch increment | PASS |
| competing-reacquisition | loser retries with current owner | PASS |
| ownership-during-draw | old drawing does not commit | PASS |
| ownership-during-draw | pixel unchanged after denied drawing | PASS |
| ownership-during-draw | retry observes new owner | PASS |
| delayed-release | delayed release denied | PASS |
| delayed-release | new ownership survives delayed release | PASS |
| multiple-colors | both transactions read vacant claims | PASS |
| multiple-colors | one user owns at most one color | EXPECTED FAILURE |
| concurrent-pixel | both contenders read the same pixel | PASS |
| concurrent-pixel | later committed color is saved | PASS |
| concurrent-pixel | both listeners converge to saved winner | PASS |
| paired-user-race | one user acquires only one color | PASS |
| paired-user-race | loser reads current member claim | PASS |
| paired-user-race | paired records agree | PASS |
| paired-color-race | one color has only one owner | PASS |
| paired-color-race | losing member remains unassigned | PASS |
| paired-rules | color-only acquisition denied | PASS |
| paired-rules | member-only acquisition denied | PASS |
| paired-rules | mismatched generation denied | PASS |
| paired-rules | forged owner denied | PASS |
| paired-rules | two colors in one batch denied | PASS |
| paired-rules | signed out denied | PASS |
| paired-rules | outsider denied | PASS |
| paired-rules | acquire and draw in same batch accepted | PASS |
| paired-rules | direct valid pair accepted | PASS |
| paired-rules | color-only release denied | PASS |
| paired-rules | member-only release denied | PASS |
| paired-rules | color deletion denied | PASS |
| paired-rules | member deletion denied | PASS |
| paired-rules | extra field denied | PASS |
| paired-rules | release and draw in same batch denied | PASS |
| paired-rules | denials preserve pair | PASS |
| paired-lifecycle | occupied switch refuses | PASS |
| paired-lifecycle | occupied switch preserves current color | PASS |
| paired-lifecycle | release clears both records | PASS |
| paired-lifecycle | switch updates all three records | PASS |
| paired-lifecycle | reacquisition increments generation | PASS |
| paired-lifecycle | fresh drawing accepted | PASS |
| paired-lifecycle | stale drawing denied | PASS |
| paired-lifecycle | stale transaction release refuses | PASS |
| paired-lifecycle | stale direct release denied | PASS |
| paired-lifecycle | stale operations preserve current pair | PASS |

Expected negative controls: stale-grid: distinct edits survive; claim-aba-control: old claim write rejected after reacquisition; multiple-colors: one user owns at most one color.

- No hosted latency, billing, quotas, offline delivery, TTL or load measured
- Two synthetic identities share an in-process backend, not independent network clients
- Claim ownership uses backend Rules; no local Kin policy gate
- Delayed payloads are scheduled by the harness, not a real offline queue; listener recovery uses unsubscribe/resubscribe
