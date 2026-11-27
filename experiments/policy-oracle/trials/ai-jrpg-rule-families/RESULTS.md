# AI-JRPG rules conformance

The live captures use AI-JRPG revision `b3bed5e36acaa7bfc47a600e86e015fb84b1ac70` and Firebase SDK 12.19.0. Firestore claims carry the exact ruleset, caller roles, individual SDK outcomes, and versioned, independent REST readbacks. The Storage claim records the caller, release, object generations, metadata and content digests in a dedicated bucket. Each receipt is admitted by comparison with its independent capture-controller archive.

## Live coverage

Setup and transition writes that received SDK verdicts count as cases. Each invite race counts once and contains both clients’ outcomes. The five previously captured chat sends and the existing deletion cases are included in the full score.

| Family and live receipt | New cases | Pyric matches | What the cases exercise |
| --- | ---: | ---: | --- |
| [World allowlist](../../suites/ai-jrpg/pixelwood/claims/world-admin-lifecycle/v1/probes/app/v1/evidence/9d75c658-d645-41e5-a39b-b3f0b22ed896.json) | 9 | 9 | Protected write allowed in the open world, refused after bootstrap, allowed after addition and refused after removal. |
| [Concurrent invite claims](../../suites/ai-jrpg/pixelwood/claims/invite-contention/v1/probes/app/v1/evidence/9d75c658-d645-41e5-a39b-b3f0b22ed896.json) | 6 | 6 | Three fresh two-client races. Each produced one successful write and the stored UID of that winner. |
| [Invite and named profile](../../suites/ai-jrpg/pixelwood/claims/profile-lifecycle/v1/probes/app/v1/evidence/9d75c658-d645-41e5-a39b-b3f0b22ed896.json) | 6 | 6 | Named creation succeeded after claim. Only the owner could rename the profile. |
| [Combat-only creates, app](../../suites/ai-jrpg/pixelwood/claims/combat-profile-create/v1/probes/app/v1/evidence/9d75c658-d645-41e5-a39b-b3f0b22ed896.json) | 12 | 12 | Owner allowed in all three worlds. Peer allowed in the open world and when listed, refused when unlisted. |
| [Combat-only creates, deploy](../../suites/ai-jrpg/pixelwood/claims/combat-profile-create/v1/probes/deploy/v1/evidence/50d5529f-3674-4605-8781-a7e326637c12.json) | 12 | 12 | All six combat-only creates refused, including the listed caller creating for self. |
| [Trade receipts](../../suites/ai-jrpg/pixelwood/claims/trade-ledger/v1/probes/app/v1/evidence/9d75c658-d645-41e5-a39b-b3f0b22ed896.json) | 8 | 8 | Own UID and server timestamp accepted. Edits refused for owner and admin. Admin delete accepted. |
| [Chest claims](../../suites/ai-jrpg/pixelwood/claims/chest-claim/v1/probes/app/v1/evidence/9d75c658-d645-41e5-a39b-b3f0b22ed896.json) | 5 | 5 | First owner claim and fresh key accepted. Non-owner create, repeat and delete refused. |
| [House claims](../../suites/ai-jrpg/pixelwood/claims/house-claim/v1/probes/app/v1/evidence/9d75c658-d645-41e5-a39b-b3f0b22ed896.json) | 5 | 5 | First owner claim and fresh key accepted. Non-owner create, repeat and delete refused. |
| [Event ledger](../../suites/ai-jrpg/pixelwood/claims/event-ledger/v1/probes/app/v1/evidence/9d75c658-d645-41e5-a39b-b3f0b22ed896.json) | 9 | 9 | Self and delegated creates vary with role and config. Owner and admin edits refused. |
| [Conversations](../../suites/ai-jrpg/genkit/claims/conversation-membership/v1/probes/genkit/v1/evidence/087a7014-0258-4bd3-b03f-5014c2aa8321.json) | 30 | 30 | Membership changes, child reads, text and image sends, sender identity and typing ownership. |
| [Sessions](../../suites/ai-jrpg/blockingfun/claims/session-access/v1/probes/blocking/v1/evidence/2798509f-4d00-4eb2-a78d-ed5fa9710f11.json) | 9 | 7 | Own gets and filtered lists compared with other-user and unfiltered access. |
| [Lobbies](../../suites/ai-jrpg/blockingfun/claims/lobby-transitions/v1/probes/blocking/v1/evidence/2798509f-4d00-4eb2-a78d-ed5fa9710f11.json) | 18 | 18 | Separate cancel and play lifecycles including wrong actors, out-of-order transitions and extra fields. |
| [Storage clips](../../suites/ai-jrpg/storage/claims/clip-access/v1/probes/clip-objects/v1/evidence/031dfbf6-5494-4434-8eed-a483a875d775.json) | 11 | 11 | Signed WAV overwrite accepted. Uploads one byte below 2 MiB passed. Uploads at or above the limit were refused. |

The packed candidate matched **138 of 140 new cases**. Each of the 13 probes distinguished its mutation. Across all sources, it matched **1491 of 1493**. See the session results below for every difference.

## Session query divergence

Two owners created one session each. For each caller, Firestore accepted an equality query on `_savedBy.email` using the email from that caller’s ID token and returned exactly the caller’s document. The packaged Pyric candidate refused both. It agreed with Firestore on the direct own-document get, the refused other-user get, the refused other-user filter, and the refused unfiltered query across both owners. [Live query results and IDs](../../suites/ai-jrpg/blockingfun/claims/session-access/v1/probes/blocking/v1/evidence/2798509f-4d00-4eb2-a78d-ed5fa9710f11.json)

Pyric’s list-query proof returned `UNPROVABLE` with reason `unsupported-predicate` for `request.auth.token.email == resource.data._savedBy.email`. The public Pyric sandbox SDK reproduced the two permission denials on `getDocs()` with `pyric@0.1.0-alpha.36` and `@pyric/rules@0.1.0`. A future repair can score these two positives alongside the other-user and unfiltered negatives. [SDK reproduction](../../adapters/ai-jrpg-campaign/v1/session-sdk.mjs)

## Session query repair

Against the same live receipts, the repaired package matched **1,493/1,493**. Comparing every case with the original run found exactly two changed answers. Both changed from denial to the recorded owner-only result. The packed Pyric SDK (`0.1.0-alpha.36`) returned these document IDs from `getDocs()` on the replay fixture.

| Caller and filter | SDK result |
| --- | --- |
| A, own email | `offline-run-a` only |
| B, own email | `offline-run-b` only |
| A, B’s email | `permission-denied` |
| A, no filter | `permission-denied` |

The list proof now follows static field segments and substitutes the query’s value for the constrained leaf. The ordinary rules evaluator compares that value with the authenticated email. The packed-app regression checks both directions of cross-user access, unfiltered reads by both users, and a single literal key containing a dot. It failed on the original main package and passed on the fix. [SDK regression](../../../../test/apps/firestore-query-owner-email/owner-query.mjs)

The full replay used the experimental compiler source at `d386b3596a6cc0288dfdd14f18996059d6bce60d` with this branch’s `packages/rules/src/simulator/query-proof.ts` and `query-proof-scope.ts`. Build and pack that rules package and pass its tarball to the candidate command below. The scored candidate SHA-256 was `dc9c7b69d0790612795ac1889fa091539782c1244d70609c0f5f8651c8775995`. Both runs used evidence digest `a67cfc9ad0ed9afc4725f198c6227ab0e5816ee50d7c78e55f03dede5259b5d1`.

## Existing evidence reused

The existing chat claim scores the ledger and message independently within each send. A mechanics-only profile allowed the ledger write and refused the message. The immediate repeat refused the ledger and skipped the message. The later ledger advanced by 1,716 ms and the message succeeded. The fixed-clock SDK replay denied 1,499 and 1,500 ms and accepted 1,501 ms. The exact 1,500 ms verdict has standalone evidence only. Existing app and deploy event-deletion observations are also part of the full replay. [Chat readbacks and timing](../../suites/ai-jrpg/pixelwood/claims/chat-send/v1/README.md) · [World-role comparison](../../suites/ai-jrpg/pixelwood/claims/world-role/v1/README.md)

## Reproduce the score

Run these commands from `experiments/policy-oracle` in the experiment worktree. Set `archive` to the separately retained capture-controller directory. The packed command exits with status 1 while a candidate has scored differences. The JSON report identifies each differing case.

```sh
python3 core/oracle.py --replay --trusted-captures "$archive" --upstream-pyric ../.. > replay.json
python3 core/oracle.py --candidate-package arcade/vendor/pyric-rules-0.1.0.tgz --trusted-captures "$archive" --upstream-pyric ../.. > packed.json
jq '.summary' packed.json
jq '.cases[] | select(.outcome != "match") | {claim,case,expected,candidate,outcome}' packed.json
```

To recapture a Firestore family, run `node arcade/live/controller/ai-jrpg-campaign.mjs "$archive" VARIANT [FAMILY ...]` and import the completed run with `bun adapters/ai-jrpg-campaign/v1/import-reviewed.mjs "$archive" RUN_ID`. The variants are `app`, `deploy`, `genkit` and `blocking`. Each deployment takes the isolated database lease and restores its closed release. [Storage capture and cleanup](../../suites/ai-jrpg/storage/claims/clip-access/v1/README.md)
