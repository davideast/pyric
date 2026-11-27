# Tally’s two-action turn

Starting at 90 exposes the effect of order. A strike at the cap has no effect. Erasing first creates room for the following strike. The proposed three-action turn ends at 90 whether the third strike executes or is skipped. Accepting its claim would violate the policy’s limit of two.

| Submitted turn at 90 | Claimed tally | Native Tally total | Standalone Pyric | Live Firestore |
| --- | ---: | ---: | --- | --- |
| Strike, erase | 89 | 89 | 89, match | Allow |
| Strike, erase | 90 | 89 | 89, mismatch | Deny |
| Erase, strike | 89 | 90 | 90, mismatch | Deny |
| Erase, strike | 90 | 90 | 90, match | Allow |
| Erase, strike, strike | 90 | 90 | Input length 3 exceeds bound 2 | Deny |

The native referee ran both the pinned satisfy.md turn parser and the slate model. Both accepted the third action and computed 90. The oracle records the native total and the two-action domain separately. The standalone scorer calls the installed package’s compiled function on the complete input, checks the returned integer, and recognizes the bound error. [Native capture](../../two-action-fold/v1/probes/turns/v1/evidence/native.json)

The Pyric source opts in to loops and declares a single local accumulator. The compiler uses the previous step’s result at each visited position and checks the input type and length. For this experiment it emits helpers for checked list parameters with a declared maximum of one or two, a single returned accumulator, and updates that provably read the prior value. The ordinary Firestore binding supplies the stored count and proposed moves and compares the derived value to the claimed integer. The live capture covers the five signed turn claims in the table. [Policy source](../../../../../../adapters/tally-fold/v1/tally.policy) · [Exact deployed Rules v2 source](../../../../../../adapters/tally-fold/v1/generated.rules)

Each update started from a separately seeded document with tally 90 and an empty move list. Firebase JS SDK 12.19.0 sent the update as its owner. A second authenticated client read the complete document before and after every attempt. Independent server reads supplied its creation and update times. Each accepted write stored the complete proposed turn and advanced the version. All three refusals preserved both fields and version. The controller restored the pinned closed release, observed a denied signed read and write, and removed the fixtures and temporary clients. [Retained production receipt](probes/turns/v1/evidence/6050e864-969c-4490-900b-dad59127ea5c.json)

The packed compiler matched 1,520 of 1,520 oracle cases. The ten new comparisons consist of five standalone results and five generated-rule verdicts. Re-executing the pinned native referee independently reproduced all five captured traces. The compiler reproduced the deployed rules byte for byte. [Scores and hashes](score.json)

## Replay

From the policy-oracle directory, pass a packed candidate, the independent controller archive, and the native source export at satisfy.md revision `f8c555be49482ebb10f9a6a438270c7e83fa8d1f` with its pinned Zod. The scorer compiles the candidate’s policy and evaluates its generated rules offline against the five recorded Firestore decisions. The report identifies whether the candidate emitted the exact bytes served in production.

```sh
python3 -B core/oracle.py --candidate-package "$rules_tarball" \
  --trusted-captures "$archive" --upstream-pyric ../.. > full-score.json
bun adapters/tally-fold/v1/report.mjs full-score.json "$native_tree"
```

To repeat the hosted capture, build the candidate package, reproduce the generated rules from `compileFunction(policy).firestoreModule()` and the versioned binding, and review their SHA-256. The controller checks the supplied hash before opening the isolated named database.

```sh
node adapters/tally-fold/v1/emit.mjs "$installed_rules_package/package.json" > /tmp/tally-generated.rules
cmp /tmp/tally-generated.rules adapters/tally-fold/v1/generated.rules
sha256sum /tmp/tally-generated.rules
node arcade/live/controller/tally-fold.mjs "$archive" "$reviewed_rules_sha256"
bun adapters/tally-fold/v1/import-reviewed.mjs "$archive" "$run_id"
```
