# Inference allowance experiment 85a0edd1-b8a3-47f9-ad75-5aed664fba6b

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../EVIDENCE.md).

8 cases; 218 requests; 68 checks.

Assessment: expected evidence observed. Expected negative controls remain failed invariants.

| Case | Check | Observed | Expected | Pass |
| --- | --- | --- | --- | --- |
| http-normal | all scheduled requests observed | 6 | 6 | true |
| http-normal | HTTP status matches outcome | [] | [] | true |
| http-normal | no client transport errors | 0 | 0 | true |
| http-normal | normal users complete | 6 | 6 | true |
| http-normal | all work settles | 6 | 6 | true |
| http-unguarded | all scheduled requests observed | 56 | 56 | true |
| http-unguarded | HTTP status matches outcome | [] | [] | true |
| http-unguarded | no client transport errors | 0 | 0 | true |
| http-unguarded | normal users complete | 6 | 6 | true |
| http-unguarded | excess requests avoid database | 0 | 0 | true |
| http-unguarded | Alice peak matches guard | 50 | 50 | true |
| http-unguarded | all work settles | 56 | 56 | true |
| http-unguarded | burst rejection count | 0 | 0 | true |
| http-user-guard | all scheduled requests observed | 56 | 56 | true |
| http-user-guard | HTTP status matches outcome | [] | [] | true |
| http-user-guard | no client transport errors | 0 | 0 | true |
| http-user-guard | normal users complete | 6 | 6 | true |
| http-user-guard | excess requests avoid database | 0 | 0 | true |
| http-user-guard | Alice peak matches guard | 2 | 2 | true |
| http-user-guard | all work settles | 56 | 56 | true |
| http-user-guard | burst rejection count | 48 | 48 | true |
| http-combined-guard | all scheduled requests observed | 56 | 56 | true |
| http-combined-guard | HTTP status matches outcome | [] | [] | true |
| http-combined-guard | no client transport errors | 0 | 0 | true |
| http-combined-guard | normal users complete | 6 | 6 | true |
| http-combined-guard | excess requests avoid database | 0 | 0 | true |
| http-combined-guard | Alice peak matches guard | 2 | 2 | true |
| http-combined-guard | all work settles | 56 | 56 | true |
| http-combined-guard | burst rejection count | 48 | 48 | true |
| http-instance-guard | all scheduled requests observed | 20 | 20 | true |
| http-instance-guard | HTTP status matches outcome | [] | [] | true |
| http-instance-guard | no client transport errors | 0 | 0 | true |
| http-instance-guard | excess requests avoid database | 0 | 0 | true |
| http-instance-guard | all work settles | 20 | 20 | true |
| http-instance-guard | instance outcomes | {"completed":16,"rejected":4} | {"completed":16,"rejected":4} | true |
| http-instance-guard | instance peak matches guard | 16 | 16 | true |
| http-timeout-drain | all scheduled requests observed | 10 | 10 | true |
| http-timeout-drain | HTTP status matches outcome | [] | [] | true |
| http-timeout-drain | no client transport errors | 0 | 0 | true |
| http-timeout-drain | normal users complete | 6 | 6 | true |
| http-timeout-drain | excess requests avoid database | 0 | 0 | true |
| http-timeout-drain | all work settles | 10 | 10 | true |
| http-timeout-drain | retry blocked until settlement | {"status":"admission_busy","reason":"user_capacity"} | {"status":"admission_busy","reason":"user_capacity"} | true |
| http-timeout-drain | recovery succeeds | "completed" | "completed" | true |
| http-timeout-drain | expired admissions never dispatch | ["recovered"] | ["recovered"] | true |
| http-timeout-drain | timed out work settles after response | 2 | 2 | true |
| http-timeout-drain | disconnects observed | 0 | 0 | true |
| http-disconnect-drain | all scheduled requests observed | 10 | 10 | true |
| http-disconnect-drain | HTTP status matches outcome | [] | [] | true |
| http-disconnect-drain | no client transport errors | 0 | 0 | true |
| http-disconnect-drain | normal users complete | 6 | 6 | true |
| http-disconnect-drain | excess requests avoid database | 0 | 0 | true |
| http-disconnect-drain | all work settles | 10 | 10 | true |
| http-disconnect-drain | retry blocked until settlement | {"status":"admission_busy","reason":"user_capacity"} | {"status":"admission_busy","reason":"user_capacity"} | true |
| http-disconnect-drain | recovery succeeds | "completed" | "completed" | true |
| http-disconnect-drain | expired admissions never dispatch | ["recovered"] | ["recovered"] | true |
| http-disconnect-drain | timed out work settles after response | 2 | 2 | true |
| http-disconnect-drain | disconnects observed | 2 | 2 | true |
| http-instance-drain | all scheduled requests observed | 4 | 4 | true |
| http-instance-drain | HTTP status matches outcome | [] | [] | true |
| http-instance-drain | no client transport errors | 0 | 0 | true |
| http-instance-drain | excess requests avoid database | 0 | 0 | true |
| http-instance-drain | all work settles | 4 | 4 | true |
| http-instance-drain | retry blocked until settlement | {"status":"admission_busy","reason":"instance_capacity"} | {"status":"admission_busy","reason":"instance_capacity"} | true |
| http-instance-drain | recovery succeeds | "completed" | "completed" | true |
| http-instance-drain | expired admissions never dispatch | ["recovered"] | ["recovered"] | true |
| http-instance-drain | timed out work settles after response | 2 | 2 | true |
| http-instance-drain | disconnects observed | 2 | 2 | true |

- Elapsed time is local process time, not a production capacity estimate.
- Transaction reads/staged writes are SDK observations, not billing units.
- Fault delays are injected and named by scenario.
- Dispatch reservations are conservative: uncertain outcomes are not automatically redispatched or refunded.
