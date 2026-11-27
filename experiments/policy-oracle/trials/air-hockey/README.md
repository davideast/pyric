# Air Hockey support assessment

Arcade revision `66e14d4f4b0aeab22c05db8d748704dde053d2e5` has three distinct referees. Firestore owns the lobby and final result. Realtime Database owns live writes. The client runs additional checks against data from both services. A policy can be correct for one referee while deliberately producing a different verdict from another.

| Behavior | Existing referee | Work for Pyric |
| --- | --- | --- |
| Create, join, cancel, resign, finish at seven, or record a forfeit | Firestore match document and imported lobby helpers | Bind the transition to the authenticated caller and old/new match, preserve unchanged fields, and compare stock and generated releases on the same signed writes. |
| Ordinary frame, guest mallet, presence, and score | RTDB per-path writer and shape rules | Preserve the separate write grant and validation predicates. Add RTDB expression generation for named child reads, arithmetic, ranges, and comparisons. The experimental RTDB emitter currently recognizes a guarded scalar increment. Arcade’s existing TypeScript constraint builders already generate its stock JSON. |
| Goal seven | RTDB atomic update of frame, score, meta status, and winner | Distinguish old state from the merged post-write view of siblings. Capture the real host write from 6–6 to 7–6 and a score-only update from the identical prior state. Verify signed readbacks of the whole live match. |
| Movement, goal plausibility, and final-result agreement | Standalone client observer | Use two observed frames and their tick difference. On a score change use the previous puck and the new serve. For the recorded result supply the Firestore document and RTDB state independently. A database rule in one service cannot read the other service. |
| Exact puck and mallet simulation | Native host running at 60 Hz | Capture the full-precision prior world and both mallet targets for every tick. Preserve collision order, clamping, vector normalization, friction, serve/reset, and terminal state. The network usually publishes every third tick, rounds positions to hundredths, and truncates velocity toward zero. Those samples alone omit inputs and precision needed to reproduce the exact simulation. Introduce and test numeric primitives for square root and rounding before promising an exact standalone port. |

## First capture

A three-tick ordinary frame permits a displacement of 22 pixels under Arcade’s client check, which uses `(180 + 240) / 60 × 3 + 1`. From (40,64) at tick zero, with legal mallets, no goal, and both reported puck velocities zero, submit (62,64) and (63,64) at tick three. The native check and the [standalone policy](plausible-move.policy) accept the first and flag the second. Pyric’s local simulation of the stock RTDB JSON allows both authenticated host writes. The accepted sample satisfies a displacement bound. Proving an exact successor also requires the intervening simulation inputs.

The live frame capture below records both stock decisions in isolated RTDB with full readbacks. A generated RTDB frame rule should enforce the displacement limit on ordinary updates, preserve initialization, and allow the legitimate serve reset on a goal. Score native, standalone, stock live RTDB, and generated live RTDB separately. The goal reset requires a trusted before/after score binding because applying the ordinary displacement limit to every frame would reject legitimate goals.

The [probe](assess.mjs) also compared every ordinary published frame under two seeded autopilot matches. Seed 3 had 1,711 such transitions and 10 goals. Seed 36 had 2,023 transitions and 11 goals. Both reached seven. All 3,734 ordinary transitions and all 21 goal transitions matched their respective native observers. The [goal policy](plausible-goal.policy) uses squared distance for the mouth check and requires the proper stationary serve. It also matched Arcade on a near-mouth goal, an attempted goal from mid-table, and a serve displaced by one pixel. Arcade’s separate physics/write tests passed 16/16. Air Hockey’s database decisions here were measured locally.

Reproduce with a built experimental rules package and a checkout of the pinned Arcade commit:

```sh
bun experiments/policy-oracle/trials/air-hockey/assess.mjs "$arcade_checkout"
(cd "$arcade_checkout" && bun test games/air-hockey/src/physics.test.ts)
```

[Host physics and observer checks](https://github.com/davideast/arcade/blob/66e14d4f4b0aeab22c05db8d748704dde053d2e5/games/air-hockey/src/physics.ts) · [Wire format and result comparison](https://github.com/davideast/arcade/blob/66e14d4f4b0aeab22c05db8d748704dde053d2e5/games/air-hockey/src/logic.ts) · [RTDB writer and validation rules](https://github.com/davideast/arcade/blob/66e14d4f4b0aeab22c05db8d748704dde053d2e5/games/air-hockey/src/rtdb-rules.ts) · [Firestore match rules](https://github.com/davideast/arcade/blob/66e14d4f4b0aeab22c05db8d748704dde053d2e5/games/air-hockey/airhockey.rules)

## Live frame capture

The [oracle receipt](../../suites/arcade/air-hockey/claims/frame-plausibility/v1/probes/host-writes/v1/evidence/a30bafc5-2b09-4285-a0a9-c61dc826aa67.json) records six host writes and their full signed match readbacks. From (40,64) at tick 0, stock accepted both x=62 and x=63 at tick 3. The generated rule accepted x=62 and refused x=63. Both accepted Arcade's atomic goal from (38,7) to a stationary serve at (48,32), with the score changing from 0–0 to 1–0. Each write had its own match. The temporary secondary instance was closed and deleted.

[The policy](../../adapters/air-hockey/v1/frame.policy) uses the before and after puck plus both score snapshots. The experimental numeric RTDB emitter inlines local bindings and guards each bound leaf with `isNumber()`. Arithmetic uses RTDB numbers. The [placement](../../adapters/air-hockey/v1/fixture.mjs) adds the predicate to stock frame validation and preserves first-frame initialization. A score-only write does not evaluate the frame validator. The capture covers a host goal below match point and the ordinary displacement boundary.

To regenerate inputs, run `bun experiments/policy-oracle/adapters/air-hockey/v1/native.mjs "$arcade_checkout"` and compare stdout with `frames.json`. The controller uses the stock and generated JSON files beside the policy. To recapture in a fresh instance and admit its receipt, run from the oracle directory:

```sh
node arcade/live/controller/air-hockey.mjs "$trusted_archive"
node adapters/air-hockey/v1/import-reviewed.mjs "$trusted_archive" "$run_id"
```

## Winning goal from 6–6

The [winning-goal receipt](../../suites/arcade/air-hockey/claims/winning-goal/v1/probes/host-writes/v1/evidence/0dfd9ead-080c-445f-97ca-8ac503286296.json) records four signed host writes. Each began with the same full match. The [fixture generator](../../adapters/air-hockey-winning/v1/native.mjs) ran three physics ticks and took the winning patch directly from Arcade’s `frameOp`. The control sent only the score entry of that patch to the same match-relative location.

| Match-root PATCH | Stock RTDB | Generated RTDB | Full match readback under both releases |
|---|---|---|---|
| Frame, score, `meta/status`, `meta/winner` | Allow | Allow | 7–6, over, host wins. Stationary puck at (48,32), tick 3. Guest identity, both mallets and presence preserved. |
| Score only | Deny | Deny | Identical 6–6 playing match and ETag. Puck at (38,7), tick 0, no winner. |

The generated release retains Arcade’s score validator, which requires the merged match status to be `over` when a side reaches seven. The generated frame predicate participates when the frame is written. These two writes establish that the real winning patch works and that a score alone cannot close the match. The missing-frame capture below tests whether match closure requires a fresh frame.

Recapture with `node arcade/live/controller/air-hockey.mjs "$trusted_archive" winning-goal` from the oracle directory, then admit the completed run with `node adapters/air-hockey-winning/v1/import-reviewed.mjs "$trusted_archive" "$run_id"`.


## Winning goal with the frame omitted

The [live receipt](../../suites/arcade/air-hockey/claims/winning-goal-missing-frame/v1/probes/host-writes/v1/evidence/55edaa28-8c46-4682-9ad5-877a7833941a.json) records the stock and generated results from identical 6–6 matches. Each host submitted the score, status and winner from the native winning patch. Both releases returned HTTP 200. Each full match readback showed 7–6, status `over`, and winner `host`. The stored frame still held the puck at (38,7) with velocity (0,−170) on tick 0. Both mallets, both presence fields and the guest identity also matched the initial match.

Together the three write shapes distinguish the terminal score check from the frame check. A score alone was denied. The full native write closed the match and stored the tick-3 serve. Omitting only the frame closed the match with the tick-0 puck still stored. Pyric places its generated predicate on the frame, so it runs when that branch is written.

Recapture from the oracle directory with `node arcade/live/controller/air-hockey.mjs "$trusted_archive" missing-frame`, then import the completed run with `node adapters/air-hockey-missing-frame/v1/import-reviewed.mjs "$trusted_archive" "$run_id"`.
