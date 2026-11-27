# Two strikes from 89

The first strike brings the count to 90. A second strike at the cap also leaves 90. Both actions must still be valid. The validator checks each action in order and returns false at the first invalid strike. The update rule calls both generated functions, `validStrikes` and `tally`, on the proposed moves. The fold starts at the stored count.

| Strengths | Claim | Native parser and model | Standalone Pyric | Live Firestore |
| --- | ---: | --- | --- | --- |
| 0.5, 0.5 | 90 | Accept turn, derive 90 | Accept | Allow |
| 1.5, 0.5 | 90 | Reject moves.0.strength | Reject strike validation | Deny |
| 0.5, 1.5 | 90 | Reject moves.1.strength | Reject strike validation | Deny |
| 0.5, 0.5 | 89 | Accept turn, derive 90 | Reject claimed total | Deny |

The capture checks the two-strike subset of the native turn format. For invalid moves the native parser produces an issue and the model never runs. A standalone caller gets the boolean validator result. A Firestore writer gets the service verdict. The receipt identifies each attempted write, the release digest, and the independent reader’s full snapshots and server versions. The three refused writes preserved the seed and version. The owner’s signed control read and write were denied after restoration. [Policy](../../../../../../adapters/tally-strikes/v1/valid-strikes.policy) · [Generated Rules v2](../../../../../../adapters/tally-strikes/v1/generated.rules) · [Live receipt](probes/turns/v1/evidence/3788c461-7757-44ce-a080-6d5d5600d523.json) · [Separate scores](score.json)

Native replay reproduced four of four traces. Standalone evaluation matched all four native outcomes, and the candidate reproduced the live release byte for byte and matched all four live decisions. All 1,520 earlier case IDs retained their authorities, expected answers, and candidate outcomes. The resulting oracle score was 1,528/1,528.

From the policy-oracle directory, use the installed experimental rules tarball, the independent capture-controller archive, and a satisfy.md export at the revision in the [native capture](../../two-strike-validation/v1/probes/turns/v1/evidence/native.json).

```sh
node adapters/tally-strikes/v1/emit.mjs "$installed_rules_package/package.json" | cmp - adapters/tally-strikes/v1/generated.rules
python3 -B core/oracle.py --candidate-package "$rules_tarball" --trusted-captures "$archive" --upstream-pyric ../.. > full-score.json
bun adapters/tally-strikes/v1/report.mjs full-score.json "$native_tree"
```

A future candidate can agree on all four outcomes with different output bytes. The report gives the exact-byte comparison separately. To recapture in the isolated database, pass the independently reviewed digest to `node arcade/live/controller/tally-fold.mjs "$archive" "$reviewed_digest" tally-strikes`, then import the completed run with `bun adapters/tally-strikes/v1/import-reviewed.mjs "$archive" "$run_id"`.
