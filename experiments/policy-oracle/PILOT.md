# Parallel oracle pilot results

Three authors worked from Pyric `22575fec0`, with the supervisor owning discovery, witness verification, and integration. The initial wave paired Tally Slate with Arcade Yacht and Firestore atomic writes. The authors also completed the Tally length and reset cases, Sokoban's score tiebreak and RTDB ancestor writes. The second wave added Checkers, both Lava Run event tapes and a Storage operation claim after the first merged replay passed. [Replay instructions](README.md) · [Initial baseline](baselines/pilot-v1.json) · [Follow-on baseline](baselines/follow-on-v1.json)

## Results by referee

| Claim | Independent answers matched | What the deliberately wrong implementation did |
|---|---:|---|
| Tally Slate ordered fold | 10/10 native-model proposal verdicts | Ignoring move order flipped four verdicts. At the cap, strike then erase ends at 89. Reversing them ends at 90. |
| Lava Run ordered events | 4/4 native-model proposal verdicts | Dropping the second stomp at step 4440 and reversing foe/lava events at step 4979 each flipped two verdicts. Both altered proposals preserved the final player fields. |
| Firestore atomic sibling merge | 3/3 archived production SDK verdicts | Dropping the stored sibling falsely denied the partial batch. The solo and full-batch controls stayed correct. |
| RTDB ancestor writes | 7/7 archived production verdicts | Giving the ancestor rule pre-write data for its proposed snapshot falsely denied the owner-create case. |
| Storage replacement upload | 5/5 archived production HTTP verdicts | Routing replacement byte uploads through metadata update flipped three outcomes. The new upload and metadata-only update controls stayed correct. |
| Arcade tic-tac-toe counter, two frozen claims | 21/21 archived production SDK verdicts | The constant-counter mutation produced four false allows and four false denials. |

The Firestore batch and RTDB imports establish the operation verdicts recorded upstream. Their receipts lack full post-write state. The Storage import covers the recorded HTTP operations. Its stored-object readbacks belong to different paths. The Lava Run headless model reproduced the two recorded target substeps. This run did not recapture browser play or gateway behavior. [Tally witnesses](suites/satisfy/tally-slate/claims/ordered-fold/v1/probes/native-turns/v1/README.md) · [Lava Run witnesses](suites/satisfy/lava-run/claims/ordered-events/v1/README.md) · [Storage scope](suites/pyric/storage/claims/overwrite-create-verb/v1/claim.json)

## Awaiting authenticated Firestore capture

| Claim | Local stock prediction | Local mutation |
|---|---|---|
| Yacht | 50 allowed, 49 denied for five equal dice | A fixed score of 49 reversed both outcomes. |
| Sokoban | From 40 moves and 10 pushes, 40/9 allowed and 40/10 denied | Allowing equal pushes admitted the unchanged score. |
| Checkers | On the same g3→e5 jump, naming f4 allowed and naming d4 denied | Removing the file-midpoint comparison admitted d4. Each proposal cleared its named square. |

These three claims retain six fixture cases in the inventory and contribute zero production decisions. Their next step is a supervised capture of the stock release on the isolated named database. The capture adapter takes authenticated SDK handles and the release owner's callbacks. Each attempt requires an isolated seed, full server snapshots, document version checks and the deployment/propagation record. The supervisor must independently retain the completed receipt outside the candidate worktree. No Firebase rules or data changed in this run. [Capture contract](adapters/arcade-sdk/v1/README.md)

## Parallel integration checks

The final author tips were `ec9c27bd5` (Tally and Lava Run), `96de5ff8f` (Arcade) and `315db3cad` (cloud observations). They share the same original base. The rehearsal applied the supervisor's files to that base, merged the three tips in all six orders with Git's merge machinery, and compared the resulting trees to the integrated source. It exported the forward and reverse trees into fresh directories, installed the frozen runtime offline in each, and compared the complete JSON reports byte for byte. All six orders produced the tree of integration commit `b1993c8f3`. Both clean reports had SHA-256 `2358f53e4b6955191ab78e818cfc440d82033dd346d9d71529a5b9b9f1de1abc`. The 25 oracle CLI tests, five capture adapter tests and nine archived receipt guards passed.

The experiment's acceptance suite also exercises duplicate IDs, stale pins, removed obligations, differing raw and normalized values, contradictory observations, surviving mutations, and independently retained controller evidence. A check with complete synthetic SDK rows left Yacht pending. Supplying a second copy from a sibling directory inside the same checkout also failed admission. A newly imported Pyric receipt must match its upstream Git object before its first release snapshot.
