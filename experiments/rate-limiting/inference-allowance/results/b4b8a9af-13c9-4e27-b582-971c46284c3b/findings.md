# Inference allowance experiment b4b8a9af-13c9-4e27-b582-971c46284c3b

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../EVIDENCE.md).

9 cases; 65 requests; 102 checks.

Assessment: expected evidence observed. Expected negative controls remain failed invariants.

| Case | Check | Observed | Expected | Pass |
| --- | --- | --- | --- | --- |
| execution-admission-only | all scheduled requests observed | 6 | 6 | true |
| execution-admission-only | HTTP status matches outcome | [] | [] | true |
| execution-admission-only | no client transport errors | 0 | 0 | true |
| execution-admission-only | all work settles | 6 | 6 | true |
| execution-admission-only | execution capacity bound | false | true | false |
| execution-admission-only | reservations drain | 0 | 0 | true |
| execution-admission-only | provider operations settle | 6 | 6 | true |
| execution-admission-only | slots held until provider settles | 0 | 0 | true |
| execution-admission-only | rejected executions avoid database | 0 | 0 | true |
| execution-user-guard | all scheduled requests observed | 4 | 4 | true |
| execution-user-guard | HTTP status matches outcome | [] | [] | true |
| execution-user-guard | no client transport errors | 0 | 0 | true |
| execution-user-guard | all work settles | 4 | 4 | true |
| execution-user-guard | execution capacity bound | true | true | true |
| execution-user-guard | reservations drain | 0 | 0 | true |
| execution-user-guard | provider operations settle | 3 | 3 | true |
| execution-user-guard | slots held until provider settles | 0 | 0 | true |
| execution-user-guard | rejected executions avoid database | 0 | 0 | true |
| execution-user-guard | execution retry rejected | "execution_busy" | "execution_busy" | true |
| execution-user-guard | execution recovery succeeds | "completed" | "completed" | true |
| execution-instance-guard | all scheduled requests observed | 6 | 6 | true |
| execution-instance-guard | HTTP status matches outcome | [] | [] | true |
| execution-instance-guard | no client transport errors | 0 | 0 | true |
| execution-instance-guard | all work settles | 6 | 6 | true |
| execution-instance-guard | execution capacity bound | true | true | true |
| execution-instance-guard | reservations drain | 0 | 0 | true |
| execution-instance-guard | provider operations settle | 2 | 2 | true |
| execution-instance-guard | slots held until provider settles | 0 | 0 | true |
| execution-instance-guard | rejected executions avoid database | 0 | 0 | true |
| execution-instance-guard | execution instance saturation | {"completed":2,"rejected":4,"peak":2} | {"completed":2,"rejected":4,"peak":2} | true |
| execution-stream | all scheduled requests observed | 4 | 4 | true |
| execution-stream | HTTP status matches outcome | [] | [] | true |
| execution-stream | no client transport errors | 0 | 0 | true |
| execution-stream | all work settles | 4 | 4 | true |
| execution-stream | execution capacity bound | true | true | true |
| execution-stream | reservations drain | 0 | 0 | true |
| execution-stream | provider operations settle | 3 | 3 | true |
| execution-stream | slots held until provider settles | 0 | 0 | true |
| execution-stream | rejected executions avoid database | 0 | 0 | true |
| execution-stream | execution retry rejected | "execution_busy" | "execution_busy" | true |
| execution-stream | execution recovery succeeds | "completed" | "completed" | true |
| execution-stream | stream delivered before settlement | true | true | true |
| execution-timeout-ignored | all scheduled requests observed | 4 | 4 | true |
| execution-timeout-ignored | HTTP status matches outcome | [] | [] | true |
| execution-timeout-ignored | no client transport errors | 0 | 0 | true |
| execution-timeout-ignored | all work settles | 4 | 4 | true |
| execution-timeout-ignored | execution capacity bound | true | true | true |
| execution-timeout-ignored | reservations drain | 0 | 0 | true |
| execution-timeout-ignored | provider operations settle | 3 | 3 | true |
| execution-timeout-ignored | slots held until provider settles | 0 | 0 | true |
| execution-timeout-ignored | rejected executions avoid database | 0 | 0 | true |
| execution-timeout-ignored | inference deadline observed | "inference_timeout" | "inference_timeout" | true |
| execution-timeout-ignored | execution retry rejected | "execution_busy" | "execution_busy" | true |
| execution-timeout-ignored | execution recovery succeeds | "completed" | "completed" | true |
| execution-timeout-ignored | cancellation ignored | {"requested":1,"confirmed":0} | {"requested":1,"confirmed":0} | true |
| execution-disconnect-ignored | all scheduled requests observed | 4 | 4 | true |
| execution-disconnect-ignored | HTTP status matches outcome | [] | [] | true |
| execution-disconnect-ignored | no client transport errors | 0 | 0 | true |
| execution-disconnect-ignored | all work settles | 4 | 4 | true |
| execution-disconnect-ignored | execution capacity bound | true | true | true |
| execution-disconnect-ignored | reservations drain | 0 | 0 | true |
| execution-disconnect-ignored | provider operations settle | 3 | 3 | true |
| execution-disconnect-ignored | slots held until provider settles | 0 | 0 | true |
| execution-disconnect-ignored | rejected executions avoid database | 0 | 0 | true |
| execution-disconnect-ignored | execution retry rejected | "execution_busy" | "execution_busy" | true |
| execution-disconnect-ignored | execution recovery succeeds | "completed" | "completed" | true |
| execution-disconnect-ignored | stream delivered before settlement | true | true | true |
| execution-disconnect-ignored | cancellation ignored | {"requested":1,"confirmed":0} | {"requested":1,"confirmed":0} | true |
| execution-cancel-confirmed | all scheduled requests observed | 4 | 4 | true |
| execution-cancel-confirmed | HTTP status matches outcome | [] | [] | true |
| execution-cancel-confirmed | no client transport errors | 0 | 0 | true |
| execution-cancel-confirmed | all work settles | 4 | 4 | true |
| execution-cancel-confirmed | execution capacity bound | true | true | true |
| execution-cancel-confirmed | reservations drain | 0 | 0 | true |
| execution-cancel-confirmed | provider operations settle | 3 | 3 | true |
| execution-cancel-confirmed | slots held until provider settles | 0 | 0 | true |
| execution-cancel-confirmed | rejected executions avoid database | 0 | 0 | true |
| execution-cancel-confirmed | execution retry rejected | "execution_busy" | "execution_busy" | true |
| execution-cancel-confirmed | execution recovery succeeds | "completed" | "completed" | true |
| execution-cancel-confirmed | stream delivered before settlement | true | true | true |
| execution-cancel-confirmed | cancellation confirmed | 1 | 1 | true |
| execution-provider-error | all scheduled requests observed | 3 | 3 | true |
| execution-provider-error | HTTP status matches outcome | [] | [] | true |
| execution-provider-error | no client transport errors | 0 | 0 | true |
| execution-provider-error | all work settles | 3 | 3 | true |
| execution-provider-error | execution capacity bound | true | true | true |
| execution-provider-error | reservations drain | 0 | 0 | true |
| execution-provider-error | provider operations settle | 2 | 2 | true |
| execution-provider-error | slots held until provider settles | 0 | 0 | true |
| execution-provider-error | rejected executions avoid database | 0 | 0 | true |
| execution-provider-error | execution recovery succeeds | "completed" | "completed" | true |
| execution-provider-error | provider failure does not redispatch | {"dispatches":1,"failure":"outcome_unknown","repeat":"duplicate"} | {"dispatches":1,"failure":"outcome_unknown","repeat":"duplicate"} | true |
| execution-sustained | all scheduled requests observed | 30 | 30 | true |
| execution-sustained | HTTP status matches outcome | [] | [] | true |
| execution-sustained | no client transport errors | 0 | 0 | true |
| execution-sustained | all work settles | 30 | 30 | true |
| execution-sustained | execution capacity bound | true | true | true |
| execution-sustained | reservations drain | 0 | 0 | true |
| execution-sustained | provider operations settle | 10 | 10 | true |
| execution-sustained | slots held until provider settles | 0 | 0 | true |
| execution-sustained | rejected executions avoid database | 0 | 0 | true |
| execution-sustained | execution normal users complete | 6 | 6 | true |

- Elapsed time is local process time, not a production capacity estimate.
- Transaction reads/staged writes are SDK observations, not billing units.
- Fault delays are injected and named by scenario.
- Dispatch reservations are conservative: uncertain outcomes are not automatically redispatched or refunded.
