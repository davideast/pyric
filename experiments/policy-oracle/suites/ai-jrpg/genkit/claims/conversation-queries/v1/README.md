# Conversation membership queries

Two rooms were created in the isolated named Firestore database using authenticated Firebase SDK 12.19.0 clients. Room X was `b581fa86-47dc-45eb-89da-73633d841e6c-x`, and room Y was `b581fa86-47dc-45eb-89da-73633d841e6c-y`. A created X with members A and B. B created Y with B and C. A then replaced B with C in X. D was an unused filter value distinct from all three callers. Each query below ran against the server in both states. [SDK responses, returned IDs, and independent document reads](probes/genkit/v1/evidence/b581fa86-47dc-45eb-89da-73633d841e6c.json)

| Query on `memberIds` | Live before | Live after | Pyric at initial capture |
| --- | --- | --- | --- |
| A, `array-contains A` | X | X | Both matched |
| B, `array-contains B` | X, Y | Y | Both matched |
| C, `array-contains C` | Y | X, Y | Both matched |
| A, `array-contains B` | Denied | Denied | Both matched |
| A, unfiltered | Denied | Denied | Both matched |
| A, `array-contains-any [A]` | X | X | Both denied |
| A, `array-contains-any [A, D]` | Denied | Denied | Both matched |

Membership in Y stayed fixed. Independent REST reads verified room contents and versions on both sides of every attempt. The controller removed the fixtures and temporary clients, restored the closed release, and recorded the lease release. The pinned stock rules came from AI-JRPG commit `b3bed5e36acaa7bfc47a600e86e015fb84b1ac70`.

The packed rules scorer evaluates authorization before the fixture enumerates the matching rooms. The separate public SDK check executes `getDocs()` with the original UIDs and room IDs and compares its snapshots with the live SDK responses. Both identified the same two singleton-query false denials. D belonged to neither room, so the singleton and mixed filters selected the same stored rows in this fixture. Firestore nevertheless denied the mixed query. [Public SDK check](../../../../../../adapters/conversation-queries/v1/sdk-replay.mjs)

## Repair and replay

The initial candidate matched 15 of 17 new cases (12 of 14 queries and all three writes). Its full score was **1,508/1,510**. The repaired SDK passes every comparison, including the exact X document ID before and after the replacement. Both mixed queries return `permission-denied`. The SDK carries all comparison values into the proof, and the rules evaluator checks that every alternative guarantees the required member.

The repaired rules package matched **1,510/1,510**. Only `before-any-a` and `after-any-a` changed. Both runs used the same evidence digest, `5dda65b3361128ff67a09bf887f8383ebe1d4d9f4f7e41385a8e39aed7a674ce`. The installed app regression also exercises the singleton and mixed queries before and after a member replacement. [App regression](../../../../../../../../test/apps/firestore-query-array-membership/membership.mjs)

## Reproduce

From `experiments/policy-oracle`, use the reviewed controller archive. The initial rules archive had SHA-256 `dc9c7b69d0790612795ac1889fa091539782c1244d70609c0f5f8651c8775995`. The repaired rules archive had SHA-256 `89c8a578fc15fc6341ebd38144272d8ca300648526a13019f38ce036d6a965ac` and used the same experimental compiler source with the updated query proof. The repaired `pyric@0.1.0-alpha.36` SDK archive had SHA-256 `1c7744b15f9c07677b8046925334afcc0b521819336fc42843dbf6b591a7c88f`. Install both repaired packages to reproduce the SDK results. Both scoring commands exit 1 when a difference is observed.

```sh
python3 -B core/oracle.py --candidate-package "$rules_tarball" --trusted-captures "$archive" --upstream-pyric ../.. > packed.json
jq .summary packed.json
bun adapters/conversation-queries/v1/sdk-replay.mjs "$sdk_project/package.json" \
  suites/ai-jrpg/genkit/claims/conversation-queries/v1/probes/genkit/v1/evidence/b581fa86-47dc-45eb-89da-73633d841e6c.json
```

To capture fresh production evidence, run `node arcade/live/controller/conversation-queries.mjs "$archive"`. After the controller confirms restoration and prints the run ID, import with `bun adapters/conversation-queries/v1/import-reviewed.mjs "$archive" "$run_id"`.
