# Atomic Hearthfest contribution and award

The depositor starts cycle 7 with two pumpkins, two iron and a stored 10-point ember award. Both authenticated SDK attempts target those same two existing documents. Each batch sets the pumpkin count to three, preserves both iron, and advances the award’s `ts` field by one. The proposed points are the only difference. Changing `ts` makes a partial award write observable even on the attempt that keeps the point total at 10.

The two item types still earn six variety points. The extra pumpkin raises the base from four to five and keeps the award at ember with six turnip seeds. The generated rule reads the contribution with `getAfter()` while evaluating the award update.

## Evidence and replay

The live controller rebuilds the cycle 7 rules and checks the bytes against the earlier generated release. It seeds both documents through the depositor’s SDK. It then submits the 10-point batch first, reads both documents, and checks their versions against the seed before submitting the 11-point batch. Each attempt calls `writeBatch().commit()` once. The readbacks contain the second account’s SDK data and the REST document fields, creation times and update times.

The receipt verifier checks both full documents and versions after a refusal. On acceptance it checks both new field sets, both preserved creation times and the shared commit version. The offline replay gives Pyric both proposed updates in one batch projection. Its mutation changes the award’s contribution lookup to `get()` to test whether the pair distinguishes the committed and proposed states.

From the oracle root, replay the generated rules and the mutation with `ORACLE_ROOT="$PWD" bun suites/ai-jrpg/pixelwood/claims/hearthfest-atomic-award/v1/probes/contribution-and-award/v1/replay.mjs`.

## Live readbacks

| Award in batch | Commit | Contribution after commit attempt | Award after commit attempt |
| --- | --- | --- | --- |
| 10 points | DENY | 2 pumpkins, 2 iron | 10 points, original timestamp |
| 11 points | ALLOW | 3 pumpkins, 2 iron | 11 points, advanced timestamp |

Both document versions matched their respective seed versions after the denied attempt. The accepted writes share the Firestore update time `2026-11-27T17:49:20.080505Z`. [Full SDK and REST readbacks](probes/contribution-and-award/v1/evidence/7cc3cc39-4919-4912-bec2-4a805b7d40c5.json)
