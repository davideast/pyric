# Hosted comparison for ordered guards

Each chess release receives the five moves in the [native reference](../reference/cases.json). A signed observer reads the entire match before and after each authenticated player update. The controller checks those SDK reads against server fields and update versions. Paired releases receive the same complete documents and proposals after replacing temporary player IDs and collection paths with stable aliases. A refused write must preserve every field and its original version.

The supplemental release binds the emitted two-guard helper to an owner-only update in a separate collection on the same isolated database. Its five cases vary the stored cells. The signed owner always submits the same update to mark the document checked. Firestore reports the allow or deny decision for the whole write. The standalone evaluator reports the missing-field error for a reached read.

The [release manifest](releases.json) pins the full deployed rules. The supplement's checked binding, helper and hash of the remaining executable source restrict its changes to this additional control. The controller uses an exclusive lease. It checks the original deny-all release before activation and confirms authenticated reads and writes are denied again before releasing the lease.

## Replay

From this trial directory, replay the three retained live captures with an installed copy of the pinned reference evaluator. A dash selects the public receipts.

```sh
bun live/replay.mjs "$generated_rules" "$reference_package" - "$ordered_error_rules"
```

Substitute the absolute path to the private controller archive for the dash to authenticate every original journal, release, per-write proof and restoration receipt. The output records live verdicts and version changes. Expression counts come from the local reference evaluator running those exact requests through the released rules.

## Highest sampled expression cost

The [separately frozen position](../reference/budget-case.json) is a black rook capture from a8 to a1. It came from replaying the candidate against the older full Arcade suite. Both releases receive the same normalized, complete match and the same legal move. The signed player occupies the guest seat with Black to move. The normal capture profile still requires each frozen verdict. This additional measurement admits either observed Firestore decision and checks the complete stored state appropriate to that decision. The public score reports native legality, local verdict, local cost and observed Firestore decision separately.

```sh
bun live/budget/run.mjs replay "$generated_rules" "$reference_package" -
```
