# Sliding reply scorecard for `all-mixed-sliders-v17-dense3-lean`

Compiler package `98995632ebf810afa49c3e03ee7fc0bac31e3c8ff841327ffa8a3eddda2a9356`. Full Rules `833a0fe29435df2456f0a3636aeea03dc33405f1193f22c424428efe469fdae8`.

Standalone Pyric returned an exact move list and outcome on 106 of 106 eligible distinct successors. 202 proposals led to those positions. Every proposal is scored on its complete write.

Live coverage is **partial** with 4 distinct observed proposals. The six rook claims also appear in the original 190. The overall row counts each proposal once.

## Complete writes

| Batch | Cases | Local matches | Local false approvals | Local false refusals | Local limit hits¹ | Live matches | Live measured | Live false approvals | Live false refusals |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| original-190 | 190 | 190 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| rook | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| bishop | 18 | 18 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| queen | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| queen-bishop | 4 | 4 | 0 | 0 | 0 | 4 | 4 | 0 | 0 |
| overall | 242 | 242 | 0 | 0 | 0 | 4 | 4 | 0 | 0 |

¹ Limit hits can also count as false refusals. The SDK exposes an admission verdict. Expression costs come from the pinned local evaluator.

## Same move and successor under three claims

| Piece | Board | Move | Native legal replies | Standalone Pyric sliders | Emitted helper (local trace) | Native P/D/W | Local P/D/W | Live P/D/W |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rook | rook-c5-after-queen | g4g8 | c5c8 | c5c8 | c5c8 | A / D / D | A / D / D | — / — / — |
| rook | rook-h5-after-queen | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | — / — / — |
| bishop | bishop-e5-clear | g4g8 | e5b8 | e5b8 | e5b8 | A / D / D | A / D / D | — / — / — |
| bishop | bishop-e5-d6-blocker | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | — / — / — |
| bishop | bishop-b6-clear | g4g8 | b6d8 | b6d8 | b6d8 | A / D / D | A / D / D | — / — / — |
| bishop | bishop-b6-c7-blocker | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | — / — / — |
| bishop | bishop-b7-free | g4g8 | b7c8 | b7c8 | b7c8 | A / D / D | A / D / D | — / — / — |
| bishop | bishop-b7-pinned | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | — / — / — |
| queen | queen-rank-clear | g4g8 | c1c8 | c1c8 | c1c8 | A / D / D | A / D / D | — / — / — |
| queen | queen-rank-c4-blocker | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | — / — / — |
| queen | queen-file-clear | d7h7 | a3h3 | a3h3 | a3h3 | A / D / D | A / D / D | — / — / — |
| queen | queen-file-d3-blocker | d7h7 | ∅ | ∅ | ∅ | D / D / A | D / D / A | — / — / — |
| queen | queen-diagonal-clear | e1e4 | f7d5 | f7d5 | f7d5 | A / D / D | A / D / D | — / — / — |
| queen | queen-diagonal-e6-blocker | e1e4 | ∅ | ∅ | ∅ | D / D / A | D / D / A | — / — / — |
| queen | queen-capture-clear | g4g8 | g2g8 | g2g8 | g2g8 | A / D / D | A / D / D | — / — / — |
| queen | queen-capture-g3-blocker | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | — / — / — |
| queen | queen-captures-only-checker | a2d5 | f7d5 | f7d5 | f7d5 | A / D / D | A / D / D | — / — / — |
| queen | queen-capture-leaves-rook-check | a2d5 | ∅ | ∅ | ∅ | D / D / A | D / D / A | — / — / — |

Claims are ordered playing, draw, won. A means allow, D means deny, and — means unmeasured.

## Qd2–b2 with and without the b6 pawn

| Claim | Native replies | Pyric replies | Native | Local Rules | Live Firestore |
| --- | --- | --- | --- | --- | --- |
| qb-pawn-playing | b1b2, c3b2 | b1b2, c3b2 | ALLOW | ALLOW | ALLOW |
| qb-pawn-won | b1b2, c3b2 | b1b2, c3b2 | DENY | DENY | DENY |
| qb-no-pawn-playing | b1b2, c3b2 | b1b2, c3b2 | ALLOW | ALLOW | ALLOW |
| qb-no-pawn-won | b1b2, c3b2 | b1b2, c3b2 | DENY | DENY | DENY |

## Changes from the historical release on the original 190

| Case | Native | Prior live | Current local | Local diagnostic | Current live |
| --- | --- | --- | --- | --- | --- |
| actual-fourth-ply-playing | DENY | ALLOW | DENY |  | — |
| holdout-interior-v1-b-mate-playing | DENY | ALLOW | DENY |  | — |
| holdout-interior-v1-w-nonking-checked-won | DENY | ALLOW | DENY |  | — |
| holdout-replies-v1-only-b-move-in-check-won | DENY | ALLOW | DENY |  | — |
| holdout-replies-v1-stalemate-pinned-defender-playing | DENY | ALLOW | DENY |  | — |
| promote-capturing-rook-right-held | ALLOW | DENY | ALLOW |  | — |
| rook-c5-after-queen-won | DENY | ALLOW | DENY |  | — |
| rook-h5-after-queen-playing | DENY | ALLOW | DENY |  | — |

## Firestore readbacks

Among the 4 measured proposals in this score, Firestore admitted 2 and refused 2. A qualified capture checks every admitted document against the full submitted successor and every refused document against its complete starting snapshot. Server versions changed on 2 admitted writes and 0 refusals.

Closed capture `sliding-queen-bishop` measured 4 proposals. Private receipt `96278f2750d4cbf077433f80b25a02313ccaa390616a593d3ca28d043367efa0`. Journal `92dff44ba44c34f555615dd5cc5072ae9a72ec5d4d00cac19f8548fb5471737d`. Authenticated read and write after restoration returned DENY and DENY.
