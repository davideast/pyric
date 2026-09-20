# Inference allowance experiment bfa3a4ff-1365-4ad1-8db7-305dd95a3095

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../EVIDENCE.md).

10 cases; 46 requests; 160 checks.

Assessment: expected evidence observed. Expected negative controls remain failed invariants.

| Case | Check | Observed | Expected | Pass |
| --- | --- | --- | --- | --- |
| lifecycle-normal-stream | all scheduled requests observed | 5 | 5 | true |
| lifecycle-normal-stream | HTTP status matches outcome | [] | [] | true |
| lifecycle-normal-stream | no client transport errors | 0 | 0 | true |
| lifecycle-normal-stream | all work settles | 5 | 5 | true |
| lifecycle-normal-stream | lifecycle responses | {"replies":{"retry":"execution_busy","other":"completed","held":"completed","repeat":"duplicate","recovered":"completed"},"disconnected":[]} | {"replies":{"held":"completed","retry":"execution_busy","other":"completed","repeat":"duplicate","recovered":"completed"},"disconnected":[]} | true |
| lifecycle-normal-stream | one dispatch per request | 3 | 3 | true |
| lifecycle-normal-stream | capacity retained until termination | true | true | true |
| lifecycle-normal-stream | execution capacity respected | true | true | true |
| lifecycle-normal-stream | remote work respects capacity | true | true | true |
| lifecycle-normal-stream | unknown outcomes retain capacity | {"unknown":[],"quarantined":[],"finalReserved":0} | {"unknown":[],"quarantined":[],"finalReserved":0} | true |
| lifecycle-normal-stream | cancellation evidence | {"requested":0,"confirmed":0} | {"requested":0,"confirmed":0} | true |
| lifecycle-normal-stream | pre-dispatch stops | 0 | 0 | true |
| lifecycle-normal-stream | stream evidence | {"chunks":[0,1,2],"firstChunkObserved":true} | {"chunks":[0,1,2],"firstChunkObserved":true} | true |
| lifecycle-normal-stream | busy requests avoid database | 0 | 0 | true |
| lifecycle-normal-stream | saved debits are not refunded | true | true | true |
| lifecycle-normal-stream | complete lifecycle evidence | true | true | true |
| lifecycle-owner-cancel | all scheduled requests observed | 9 | 9 | true |
| lifecycle-owner-cancel | HTTP status matches outcome | [] | [] | true |
| lifecycle-owner-cancel | no client transport errors | 0 | 0 | true |
| lifecycle-owner-cancel | all work settles | 4 | 4 | true |
| lifecycle-owner-cancel | lifecycle responses | {"replies":{"foreign":"not_found","signed-out":"unauthenticated","forged":"invalid_request","cancel":"cancellation_requested","held":"cancellation_requested","cancel-again":"cancellation_requested","retry":"execution_busy","repeat":"duplicate","recovered":"completed"},"disconnected":[]} | {"replies":{"foreign":"not_found","signed-out":"unauthenticated","forged":"invalid_request","cancel":"cancellation_requested","cancel-again":"cancellation_requested","held":"cancellation_requested","retry":"execution_busy","repeat":"duplicate","recovered":"completed"},"disconnected":[]} | true |
| lifecycle-owner-cancel | one dispatch per request | 2 | 2 | true |
| lifecycle-owner-cancel | capacity retained until termination | true | true | true |
| lifecycle-owner-cancel | execution capacity respected | true | true | true |
| lifecycle-owner-cancel | remote work respects capacity | true | true | true |
| lifecycle-owner-cancel | unknown outcomes retain capacity | {"unknown":[],"quarantined":[],"finalReserved":0} | {"unknown":[],"quarantined":[],"finalReserved":0} | true |
| lifecycle-owner-cancel | cancellation evidence | {"requested":1,"confirmed":1} | {"requested":1,"confirmed":1} | true |
| lifecycle-owner-cancel | pre-dispatch stops | 0 | 0 | true |
| lifecycle-owner-cancel | stream evidence | {"chunks":[],"firstChunkObserved":true} | {"chunks":[],"firstChunkObserved":true} | true |
| lifecycle-owner-cancel | busy requests avoid database | 0 | 0 | true |
| lifecycle-owner-cancel | saved debits are not refunded | true | true | true |
| lifecycle-owner-cancel | complete lifecycle evidence | true | true | true |
| lifecycle-cancel-ignored | all scheduled requests observed | 6 | 6 | true |
| lifecycle-cancel-ignored | HTTP status matches outcome | [] | [] | true |
| lifecycle-cancel-ignored | no client transport errors | 0 | 0 | true |
| lifecycle-cancel-ignored | all work settles | 5 | 5 | true |
| lifecycle-cancel-ignored | lifecycle responses | {"replies":{"cancel":"cancellation_requested","held":"cancellation_requested","retry":"execution_busy","other":"completed","repeat":"duplicate","recovered":"completed"},"disconnected":[]} | {"replies":{"held":"cancellation_requested","cancel":"cancellation_requested","retry":"execution_busy","other":"completed","repeat":"duplicate","recovered":"completed"},"disconnected":[]} | true |
| lifecycle-cancel-ignored | one dispatch per request | 3 | 3 | true |
| lifecycle-cancel-ignored | capacity retained until termination | true | true | true |
| lifecycle-cancel-ignored | execution capacity respected | true | true | true |
| lifecycle-cancel-ignored | remote work respects capacity | true | true | true |
| lifecycle-cancel-ignored | unknown outcomes retain capacity | {"unknown":[],"quarantined":[],"finalReserved":0} | {"unknown":[],"quarantined":[],"finalReserved":0} | true |
| lifecycle-cancel-ignored | cancellation evidence | {"requested":1,"confirmed":0} | {"requested":1,"confirmed":0} | true |
| lifecycle-cancel-ignored | pre-dispatch stops | 0 | 0 | true |
| lifecycle-cancel-ignored | stream evidence | {"chunks":[],"firstChunkObserved":true} | {"chunks":[],"firstChunkObserved":true} | true |
| lifecycle-cancel-ignored | busy requests avoid database | 0 | 0 | true |
| lifecycle-cancel-ignored | saved debits are not refunded | true | true | true |
| lifecycle-cancel-ignored | complete lifecycle evidence | true | true | true |
| lifecycle-deadline | all scheduled requests observed | 5 | 5 | true |
| lifecycle-deadline | HTTP status matches outcome | [] | [] | true |
| lifecycle-deadline | no client transport errors | 0 | 0 | true |
| lifecycle-deadline | all work settles | 5 | 5 | true |
| lifecycle-deadline | lifecycle responses | {"replies":{"held":"inference_timeout","retry":"execution_busy","other":"completed","repeat":"duplicate","recovered":"completed"},"disconnected":[]} | {"replies":{"held":"inference_timeout","retry":"execution_busy","other":"completed","repeat":"duplicate","recovered":"completed"},"disconnected":[]} | true |
| lifecycle-deadline | one dispatch per request | 3 | 3 | true |
| lifecycle-deadline | capacity retained until termination | true | true | true |
| lifecycle-deadline | execution capacity respected | true | true | true |
| lifecycle-deadline | remote work respects capacity | true | true | true |
| lifecycle-deadline | unknown outcomes retain capacity | {"unknown":[],"quarantined":[],"finalReserved":0} | {"unknown":[],"quarantined":[],"finalReserved":0} | true |
| lifecycle-deadline | cancellation evidence | {"requested":1,"confirmed":0} | {"requested":1,"confirmed":0} | true |
| lifecycle-deadline | pre-dispatch stops | 0 | 0 | true |
| lifecycle-deadline | stream evidence | {"chunks":[],"firstChunkObserved":true} | {"chunks":[],"firstChunkObserved":true} | true |
| lifecycle-deadline | busy requests avoid database | 0 | 0 | true |
| lifecycle-deadline | saved debits are not refunded | true | true | true |
| lifecycle-deadline | complete lifecycle evidence | true | true | true |
| lifecycle-disconnect | all scheduled requests observed | 5 | 5 | true |
| lifecycle-disconnect | HTTP status matches outcome | [] | [] | true |
| lifecycle-disconnect | no client transport errors | 0 | 0 | true |
| lifecycle-disconnect | all work settles | 5 | 5 | true |
| lifecycle-disconnect | lifecycle responses | {"replies":{"retry":"execution_busy","other":"completed","repeat":"duplicate","recovered":"completed"},"disconnected":["held"]} | {"replies":{"retry":"execution_busy","other":"completed","repeat":"duplicate","recovered":"completed"},"disconnected":["held"]} | true |
| lifecycle-disconnect | one dispatch per request | 3 | 3 | true |
| lifecycle-disconnect | capacity retained until termination | true | true | true |
| lifecycle-disconnect | execution capacity respected | true | true | true |
| lifecycle-disconnect | remote work respects capacity | true | true | true |
| lifecycle-disconnect | unknown outcomes retain capacity | {"unknown":[],"quarantined":[],"finalReserved":0} | {"unknown":[],"quarantined":[],"finalReserved":0} | true |
| lifecycle-disconnect | cancellation evidence | {"requested":1,"confirmed":0} | {"requested":1,"confirmed":0} | true |
| lifecycle-disconnect | pre-dispatch stops | 0 | 0 | true |
| lifecycle-disconnect | stream evidence | {"chunks":[0],"firstChunkObserved":true} | {"chunks":[0],"firstChunkObserved":true} | true |
| lifecycle-disconnect | busy requests avoid database | 0 | 0 | true |
| lifecycle-disconnect | saved debits are not refunded | true | true | true |
| lifecycle-disconnect | complete lifecycle evidence | true | true | true |
| lifecycle-completion-race | all scheduled requests observed | 7 | 7 | true |
| lifecycle-completion-race | HTTP status matches outcome | [] | [] | true |
| lifecycle-completion-race | no client transport errors | 0 | 0 | true |
| lifecycle-completion-race | all work settles | 5 | 5 | true |
| lifecycle-completion-race | lifecycle responses | {"replies":{"cancel":"cancellation_requested","held":"cancellation_requested","retry":"execution_busy","other":"completed","late-cancel":"not_found","repeat":"duplicate","recovered":"completed"},"disconnected":[]} | {"replies":{"held":"cancellation_requested","cancel":"cancellation_requested","late-cancel":"not_found","retry":"execution_busy","other":"completed","repeat":"duplicate","recovered":"completed"},"disconnected":[]} | true |
| lifecycle-completion-race | one dispatch per request | 3 | 3 | true |
| lifecycle-completion-race | capacity retained until termination | true | true | true |
| lifecycle-completion-race | execution capacity respected | true | true | true |
| lifecycle-completion-race | remote work respects capacity | true | true | true |
| lifecycle-completion-race | unknown outcomes retain capacity | {"unknown":[],"quarantined":[],"finalReserved":0} | {"unknown":[],"quarantined":[],"finalReserved":0} | true |
| lifecycle-completion-race | cancellation evidence | {"requested":1,"confirmed":0} | {"requested":1,"confirmed":0} | true |
| lifecycle-completion-race | pre-dispatch stops | 0 | 0 | true |
| lifecycle-completion-race | stream evidence | {"chunks":[],"firstChunkObserved":true} | {"chunks":[],"firstChunkObserved":true} | true |
| lifecycle-completion-race | busy requests avoid database | 0 | 0 | true |
| lifecycle-completion-race | saved debits are not refunded | true | true | true |
| lifecycle-completion-race | complete lifecycle evidence | true | true | true |
| lifecycle-before-dispatch | all scheduled requests observed | 5 | 5 | true |
| lifecycle-before-dispatch | HTTP status matches outcome | [] | [] | true |
| lifecycle-before-dispatch | no client transport errors | 0 | 0 | true |
| lifecycle-before-dispatch | all work settles | 4 | 4 | true |
| lifecycle-before-dispatch | lifecycle responses | {"replies":{"cancel":"cancellation_requested","held":"cancellation_requested","retry":"execution_busy","other":"completed","recovered":"completed"},"disconnected":[]} | {"replies":{"held":"cancellation_requested","cancel":"cancellation_requested","retry":"execution_busy","other":"completed","recovered":"completed"},"disconnected":[]} | true |
| lifecycle-before-dispatch | one dispatch per request | 2 | 2 | true |
| lifecycle-before-dispatch | capacity retained until termination | true | true | true |
| lifecycle-before-dispatch | execution capacity respected | true | true | true |
| lifecycle-before-dispatch | remote work respects capacity | true | true | true |
| lifecycle-before-dispatch | unknown outcomes retain capacity | {"unknown":[],"quarantined":[],"finalReserved":0} | {"unknown":[],"quarantined":[],"finalReserved":0} | true |
| lifecycle-before-dispatch | cancellation evidence | {"requested":0,"confirmed":0} | {"requested":0,"confirmed":0} | true |
| lifecycle-before-dispatch | pre-dispatch stops | 0 | 0 | true |
| lifecycle-before-dispatch | stream evidence | {"chunks":[],"firstChunkObserved":true} | {"chunks":[],"firstChunkObserved":true} | true |
| lifecycle-before-dispatch | busy requests avoid database | 0 | 0 | true |
| lifecycle-before-dispatch | saved debits are not refunded | true | true | true |
| lifecycle-before-dispatch | complete lifecycle evidence | true | true | true |
| lifecycle-unknown | all scheduled requests observed | 4 | 4 | true |
| lifecycle-unknown | HTTP status matches outcome | [] | [] | true |
| lifecycle-unknown | no client transport errors | 0 | 0 | true |
| lifecycle-unknown | all work settles | 4 | 4 | true |
| lifecycle-unknown | lifecycle responses | {"replies":{"held":"outcome_unknown","retry":"execution_busy","other":"completed","later":"execution_busy"},"disconnected":[]} | {"replies":{"held":"outcome_unknown","retry":"execution_busy","other":"completed","later":"execution_busy"},"disconnected":[]} | true |
| lifecycle-unknown | one dispatch per request | 2 | 2 | true |
| lifecycle-unknown | capacity retained until termination | true | true | true |
| lifecycle-unknown | execution capacity respected | true | true | true |
| lifecycle-unknown | remote work respects capacity | true | true | true |
| lifecycle-unknown | unknown outcomes retain capacity | {"unknown":["held"],"quarantined":["held"],"finalReserved":1} | {"unknown":["held"],"quarantined":["held"],"finalReserved":1} | true |
| lifecycle-unknown | cancellation evidence | {"requested":0,"confirmed":0} | {"requested":0,"confirmed":0} | true |
| lifecycle-unknown | pre-dispatch stops | 0 | 0 | true |
| lifecycle-unknown | stream evidence | {"chunks":[],"firstChunkObserved":true} | {"chunks":[],"firstChunkObserved":true} | true |
| lifecycle-unknown | busy requests avoid database | 0 | 0 | true |
| lifecycle-unknown | saved debits are not refunded | true | true | true |
| lifecycle-unknown | complete lifecycle evidence | true | true | true |
| lifecycle-truncated-stream | all scheduled requests observed | 5 | 5 | true |
| lifecycle-truncated-stream | HTTP status matches outcome | [] | [] | true |
| lifecycle-truncated-stream | no client transport errors | 0 | 0 | true |
| lifecycle-truncated-stream | all work settles | 5 | 5 | true |
| lifecycle-truncated-stream | lifecycle responses | {"replies":{"held":"outcome_unknown","retry":"execution_busy","other":"completed","repeat":"execution_busy","recovered":"execution_busy"},"disconnected":[]} | {"replies":{"held":"outcome_unknown","retry":"execution_busy","other":"completed","repeat":"execution_busy","recovered":"execution_busy"},"disconnected":[]} | true |
| lifecycle-truncated-stream | one dispatch per request | 2 | 2 | true |
| lifecycle-truncated-stream | capacity retained until termination | true | true | true |
| lifecycle-truncated-stream | execution capacity respected | true | true | true |
| lifecycle-truncated-stream | remote work respects capacity | true | true | true |
| lifecycle-truncated-stream | unknown outcomes retain capacity | {"unknown":["held"],"quarantined":["held"],"finalReserved":1} | {"unknown":["held"],"quarantined":["held"],"finalReserved":1} | true |
| lifecycle-truncated-stream | cancellation evidence | {"requested":0,"confirmed":0} | {"requested":0,"confirmed":0} | true |
| lifecycle-truncated-stream | pre-dispatch stops | 0 | 0 | true |
| lifecycle-truncated-stream | stream evidence | {"chunks":[0],"firstChunkObserved":true} | {"chunks":[0],"firstChunkObserved":true} | true |
| lifecycle-truncated-stream | busy requests avoid database | 0 | 0 | true |
| lifecycle-truncated-stream | saved debits are not refunded | true | true | true |
| lifecycle-truncated-stream | complete lifecycle evidence | true | true | true |
| lifecycle-transport-control | all scheduled requests observed | 4 | 4 | true |
| lifecycle-transport-control | HTTP status matches outcome | [] | [] | true |
| lifecycle-transport-control | no client transport errors | 0 | 0 | true |
| lifecycle-transport-control | all work settles | 4 | 4 | true |
| lifecycle-transport-control | lifecycle responses | {"replies":{"held":"outcome_unknown","retry":"completed","other":"completed","recovered":"completed"},"disconnected":[]} | {"replies":{"held":"outcome_unknown","retry":"completed","other":"completed","recovered":"completed"},"disconnected":[]} | true |
| lifecycle-transport-control | one dispatch per request | 4 | 4 | true |
| lifecycle-transport-control | capacity retained until termination | false | true | false |
| lifecycle-transport-control | execution capacity respected | true | true | true |
| lifecycle-transport-control | remote work respects capacity | false | true | false |
| lifecycle-transport-control | unknown outcomes retain capacity | {"unknown":[],"quarantined":[],"finalReserved":0} | {"unknown":[],"quarantined":[],"finalReserved":0} | true |
| lifecycle-transport-control | cancellation evidence | {"requested":0,"confirmed":0} | {"requested":0,"confirmed":0} | true |
| lifecycle-transport-control | pre-dispatch stops | 0 | 0 | true |
| lifecycle-transport-control | stream evidence | {"chunks":[],"firstChunkObserved":true} | {"chunks":[],"firstChunkObserved":true} | true |
| lifecycle-transport-control | busy requests avoid database | 0 | 0 | true |
| lifecycle-transport-control | saved debits are not refunded | true | true | true |
| lifecycle-transport-control | complete lifecycle evidence | true | true | true |

- Elapsed time is local process time, not a production capacity estimate.
- Transaction reads/staged writes are SDK observations, not billing units.
- Fault delays are injected and named by scenario.
- Dispatch reservations are conservative: uncertain outcomes are not automatically redispatched or refunded.
