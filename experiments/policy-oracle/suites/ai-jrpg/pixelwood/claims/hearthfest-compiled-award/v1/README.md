# Compiled Hearthfest award writes

This experiment binds the standalone Hearthfest award policy to cycle 7. The fixed call asks for four pumpkins, two iron, two corn seeds and two pumpkin seeds. The compiler reads the two folds and the award expressions from the pinned Pyric policy. It emits one line-fold step per call line and a bounded search for any positive contribution. The submitted award provides no counts, totals, tier selector or benefit menu to this calculation.

The rule reads `hearthfest/{cycle}/contributions/{pid}` with `getAfter()` using the award document’s path. It checks sign-in, recipient, cycle, integer points, tier and benefit. The catalog fixes the requested quantities and available benefits. Attendance, grant delivery and the grant lifecycle remain outside the compiled scoring check. Other cycles require their own catalog binding.

## Reproduce

From the oracle root, run `bun adapters/hearthfest-compiled/v1/check-native.mjs`. It recompiles the original policy, checks the deployed file byte for byte, and tries the native score and a one-point increase on all 16 cycle 7 fixtures in the simulator. It represents an absent contribution map as an empty map in an existing contribution document. The neighboring `hearthfest-score` claim owns the original native answers.

The `award-lifecycle/v1` probe compares an installed candidate’s newly generated rules against the live write receipts. It compares the release digest before and after the attempts and verifies both full document readbacks. The `hearthfest-award-write` claim preserves the independent stock capture. The candidate replay uses stock as a mutation control. Its predictions for additional attempts are local simulations.

## Live results

The unchanged contribution held two pumpkins and two iron. Attempts ran in the following order through Firebase SDK 12.19.0. The signed writer and the award recipient used different accounts.

| Attempt | Generated release | Stored award after the attempt |
| --- | --- | --- |
| Signed-out create at 10 | DENY | Absent |
| Signed-in create at 11 | DENY | Absent |
| Signed-in create at 10 | ALLOW | 10, ember, six turnip seeds |
| Update to 11 | DENY | Original award and document version |
| Update tier to hearthfriend | DENY | Original award and document version |
| Update benefit to null | DENY | Original award and document version |
| Update at 10 and set granted to true | ALLOW | 10, ember, six turnip seeds, granted |
| Delete | DENY | Granted award and document version |

The separate stock receipt accepted the create at 10 and the update to 11. Only the generated release ran the additional create-at-11, tier, benefit and valid-update controls.
