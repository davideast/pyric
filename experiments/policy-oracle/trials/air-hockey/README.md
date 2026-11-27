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

## Match-level winning-goal check

The [placement](../../adapters/air-hockey-match-win/v1/fixture.mjs) binds Pyric’s [winning-score transition](../../adapters/air-hockey-match-win/v1/reaches-seven.policy) and the [existing frame policy](../../adapters/air-hockey/v1/frame.policy) to the old and merged match snapshots at `airhockey/$matchId/$host`. When either side reaches seven, the match validator requires the puck tick to advance and the winning goal and serve to satisfy the frame policy. Stock score and metadata rules still validate the increment, terminal status, and winner. The frame-local displacement check continues to run on ordinary frame writes.

The [four signed readbacks](../../suites/arcade/air-hockey/claims/match-level-winning-goal/v1/probes/host-writes/v1/evidence/1055a657-a9b4-4b90-9a6d-3c0b5fbc0ee5.json) start from identical 6–6 matches.

| Host write | Stock verdict and stored match | Match-level generated verdict and stored match |
|---|---|---|
| Full native win | Allow · 7–6, over, host wins, tick 3 | Allow · 7–6, over, host wins, tick 3 |
| Same win omitting the frame | Allow · 7–6, over, host wins, tick 0 | Deny · 6–6, playing, no winner, tick 0, same full match and ETag |

Run `node arcade/live/controller/air-hockey.mjs "$trusted_archive" match-win` from the oracle directory to capture a fresh secondary instance. Admit the resulting receipt with `node adapters/air-hockey-match-win/v1/import-reviewed.mjs "$trusted_archive" "$run_id"`. The offline scorer recompiles both predicates from the candidate package and records the generated rules digest.

## Guest winning goal from 6–6

The [native guest fixture](../../adapters/air-hockey-guest-win/v1/native.mjs) starts the puck at (38,121) moving toward the host’s end. On tick 3, Arcade awards the guest a goal and serves a stationary puck to the host at (48,96). The authenticated host submitted the resulting 6–7 match update, then tried the same closure without the frame from a fresh copy of the initial match.

| Host write | Stock verdict and stored match | Match-level generated verdict and stored match |
|---|---|---|
| Full guest win | Allow · 6–7, over, guest wins, tick 3 | Allow · 6–7, over, guest wins, tick 3 |
| Guest win omitting the frame | Allow · 6–7, over, guest wins, original puck at tick 0 | Deny · 6–6, playing, no winner, identical full match and ETag |

The [four signed readbacks](../../suites/arcade/air-hockey/claims/guest-winning-goal/v1/probes/host-writes/v1/evidence/9ead19fb-9893-4eaf-bf91-c7eab6064cc3.json) used the same stock and generated rules digests as the host-win capture. To repeat from the oracle directory, run `node arcade/live/controller/air-hockey.mjs "$trusted_archive" guest-win`, then `node adapters/air-hockey-guest-win/v1/import-reviewed.mjs "$trusted_archive" "$run_id"`.

## Serve side after a guest win

The [paired inputs](../../adapters/air-hockey-serve-side/v1/fixture.mjs) differ only in the final puck’s y-coordinate. Both are complete atomic guest wins from 6–6, with a stationary puck at x=48 on tick 3. Arcade serves to the host at y=96 after the guest scores.

| Submitted serve | Stock verdict and full match readback | Generated verdict and full match readback |
|---|---|---|
| (48,32), wrong side | Allow · 6–7, over, guest wins, puck at (48,32) on tick 3 | Deny · 6–6, playing, no winner, original puck at (38,121) on tick 0 and identical ETag |
| (48,96), native side | Allow · 6–7, over, guest wins, puck at (48,96) on tick 3 | Allow · identical final match |

The [production receipt](../../suites/arcade/air-hockey/claims/guest-winner-serve-side/v1/probes/host-writes/v1/evidence/5b23c313-a0f0-4ce9-a866-db874d0bbaf3.json) records the full readback for each signed host write. Both deployed rules digests match the earlier guest-winning-goal capture. Recapture from the oracle directory with `node arcade/live/controller/air-hockey.mjs "$trusted_archive" serve-side`, then import with `node adapters/air-hockey-serve-side/v1/import-reviewed.mjs "$trusted_archive" "$run_id"`.

## Serve side after a host win

The [paired inputs](../../adapters/air-hockey-host-serve-side/v1/fixture.mjs) use the native 7–6 host win from 6–6. Both writes submit a complete frame with the puck stationary at x=48 on tick 3. Only the y-coordinate changes. After a host goal, Arcade serves to the guest at y=32.

| Submitted serve | Stock verdict and readback | Generated verdict and readback |
|---|---|---|
| (48,96), wrong side | Allow · 7–6, over, host wins, puck at (48,96) on tick 3 | Deny · 6–6, playing, no winner, original puck at (38,7) on tick 0 and identical ETag |
| (48,32), native side | Allow · 7–6, over, host wins, puck at (48,32) on tick 3 | Allow · identical final match |

The [production receipt](../../suites/arcade/air-hockey/claims/host-winner-serve-side/v1/probes/host-writes/v1/evidence/57d0febe-8cd2-4fc3-981a-555171ee7edc.json) retains all four complete match readbacks. Stock and generated rules digests match the guest serve-side capture. Recapture from the oracle directory with `node arcade/live/controller/air-hockey.mjs "$trusted_archive" host-serve-side`, then import with `node adapters/air-hockey-host-serve-side/v1/import-reviewed.mjs "$trusted_archive" "$run_id"`.

## Moving serve after either winning goal

The [paired inputs](../../adapters/air-hockey-moving-serve/v1/fixture.mjs) take each winner’s native atomic update from a 6–6 match. The puck starts the serve at (48,32) for a host win and (48,96) for a guest win. The moving variant changes only `vx` from 0 to 1. Both variants have `vy=0` on tick 3.

| Winner and serve | Stock live readback | Generated live readback |
|---|---|---|
| Host, vx=0 | Allow · 7–6, host wins, vx=0 | Allow · same final match |
| Host, vx=1 | Allow · 7–6, host wins, vx=1 | Deny · 6–6, playing, no winner, original puck at (38,7) on tick 0 |
| Guest, vx=0 | Allow · 6–7, guest wins, vx=0 | Allow · same final match |
| Guest, vx=1 | Allow · 6–7, guest wins, vx=1 | Deny · 6–6, playing, no winner, original puck at (38,121) on tick 0 |

The [live receipt](../../suites/arcade/air-hockey/claims/winning-serve-velocity/v1/probes/host-writes/v1/evidence/a603d34f-7d78-456e-a1cc-3bbb4ab41fdc.json) retains all eight authenticated writes and full readbacks. Each denied write preserved the entire match and ETag. Recapture from the oracle directory with `node arcade/live/controller/air-hockey.mjs "$trusted_archive" moving-serve`, then import with `node adapters/air-hockey-moving-serve/v1/import-reviewed.mjs "$trusted_archive" "$run_id"`.

## Vertical velocity after either winning goal

The [paired inputs](../../adapters/air-hockey-vertical-serve/v1/fixture.mjs) start from 6–6 and differ only in the final puck’s vertical velocity. Both submit a complete tick-3 winning frame with `vx=0`. The host’s serve is at (48,32) and the guest’s is at (48,96).

| Winning serve | Stock readback | Generated readback |
|---|---|---|
| Host, vy=0 | Allow · 7–6, host wins, vy=0 | Allow · identical final match |
| Host, vy=1 | Allow · 7–6, host wins, vy=1 | Deny · 6–6, playing, no winner, original puck at (38,7) on tick 0 |
| Guest, vy=0 | Allow · 6–7, guest wins, vy=0 | Allow · identical final match |
| Guest, vy=1 | Allow · 6–7, guest wins, vy=1 | Deny · 6–6, playing, no winner, original puck at (38,121) on tick 0 |

The [live receipt](../../suites/arcade/air-hockey/claims/winning-serve-vertical-velocity/v1/probes/host-writes/v1/evidence/58aa2b17-5532-4dac-a8ca-6f09c1e81995.json) retains all eight signed writes and complete match readbacks. The entire match and its ETag stayed unchanged after both denials. The stock and generated rules digests match the horizontal velocity capture. Recapture with `node arcade/live/controller/air-hockey.mjs "$trusted_archive" vertical-serve` from the oracle directory and import with `node adapters/air-hockey-vertical-serve/v1/import-reviewed.mjs "$trusted_archive" "$run_id"`.

## Off-center serve after either winning goal

The [paired inputs](../../adapters/air-hockey-off-center-serve/v1/fixture.mjs) use each winner’s native 6–6 transition. Only the final puck x changes, from 48 to 49. Both velocities are zero on tick 3. The serve y is 32 for a host win and 96 for a guest win.

| Winning serve | Stock readback | Generated readback |
|---|---|---|
| Host, (48,32) | Allow · 7–6, host wins, puck at (48,32) | Allow · identical final match |
| Host, (49,32) | Allow · 7–6, host wins, puck at (49,32) | Deny · 6–6, playing, no winner, puck at (38,7) on tick 0 |
| Guest, (48,96) | Allow · 6–7, guest wins, puck at (48,96) | Allow · identical final match |
| Guest, (49,96) | Allow · 6–7, guest wins, puck at (49,96) | Deny · 6–6, playing, no winner, puck at (38,121) on tick 0 |

The [live receipt](../../suites/arcade/air-hockey/claims/winning-serve-center-x/v1/probes/host-writes/v1/evidence/4a26135a-0521-48c7-b4d6-d567d4429d9d.json) retains all eight signed writes and full match readbacks. Both refusals preserved the entire match and ETag. Recapture with `node arcade/live/controller/air-hockey.mjs "$trusted_archive" off-center-serve` from the oracle directory and import with `node adapters/air-hockey-off-center-serve/v1/import-reviewed.mjs "$trusted_archive" "$run_id"`.
