# Conversation membership queries

Two rooms were created in the isolated named Firestore database using authenticated Firebase SDK 12.19.0 clients. Room X was `b581fa86-47dc-45eb-89da-73633d841e6c-x`, and room Y was `b581fa86-47dc-45eb-89da-73633d841e6c-y`. A created X with members A and B. B created Y with B and C. A then replaced B with C in X. D was an unused filter value distinct from all three callers. Each query below ran against the server in both states. [SDK responses, returned IDs, and independent document reads](probes/genkit/v1/evidence/b581fa86-47dc-45eb-89da-73633d841e6c.json)

| Query on `memberIds` | Live before | Live after | Packed Pyric |
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

## Reproduce

The verified candidate matched 15 of 17 new cases (12 of 14 queries and all three writes). The full score was **1,508/1,510** with two false denials, zero false allows and zero regressions. All 1,493 historical case records were identical to the previous run. The evidence digest was `5dda65b3361128ff67a09bf887f8383ebe1d4d9f4f7e41385a8e39aed7a674ce`.

From `experiments/policy-oracle`, use the reviewed controller archive with the same rules candidate that passed the 1,493-case baseline (SHA-256 `dc9c7b69d0790612795ac1889fa091539782c1244d70609c0f5f8651c8775995`). The public SDK reproduction used `pyric@0.1.0-alpha.36` with that rules package installed. Both scoring commands exit 1 when a difference is observed.

```sh
python3 -B core/oracle.py --candidate-package "$rules_tarball" --trusted-captures "$archive" --upstream-pyric ../.. > packed.json
jq .summary packed.json
bun adapters/conversation-queries/v1/sdk-replay.mjs "$sdk_project/package.json" \
  suites/ai-jrpg/genkit/claims/conversation-queries/v1/probes/genkit/v1/evidence/b581fa86-47dc-45eb-89da-73633d841e6c.json
```

To capture fresh production evidence, run `node arcade/live/controller/conversation-queries.mjs "$archive"`. After the controller confirms restoration and prints the run ID, import with `bun adapters/conversation-queries/v1/import-reviewed.mjs "$archive" "$run_id"`.
