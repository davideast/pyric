# Sliding reply scorecard for `all-mixed-replies-v20-dense3-lean`

Compiler package `98995632ebf810afa49c3e03ee7fc0bac31e3c8ff841327ffa8a3eddda2a9356`. Full Rules `f99158eb7764235e3984655fb2220e2821133a52370e875fba7fc9a8c5918f04`.

Standalone Pyric returned an exact move list and outcome on 115 of 115 eligible distinct successors. 233 proposals led to those positions. Every proposal is scored on its complete write.

Live coverage is **partial** with 15 distinct observed proposals. The six rook claims also appear in the original 190. The overall row counts each proposal once.

## Complete writes

| Batch | Cases | Local matches | Local false approvals | Local false refusals | Local limit hits¹ | Live matches | Live measured | Live false approvals | Live false refusals |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| original-190 | 190 | 190 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| rook | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| bishop | 18 | 18 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| queen | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| queen-bishop | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| two-knights | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| lone-pawn | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| mixed-slider | 15 | 15 | 0 | 0 | 0 | 15 | 15 | 0 | 0 |
| overall | 273 | 273 | 0 | 0 | 0 | 15 | 15 | 0 | 0 |

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
| qb-pawn-playing | b1b2, c3b2 | b1b2, c3b2 | ALLOW | ALLOW | unmeasured |
| qb-pawn-won | b1b2, c3b2 | b1b2, c3b2 | DENY | DENY | unmeasured |
| qb-no-pawn-playing | b1b2, c3b2 | b1b2, c3b2 | ALLOW | ALLOW | unmeasured |
| qb-no-pawn-won | b1b2, c3b2 | b1b2, c3b2 | DENY | DENY | unmeasured |

## Two defending knights

| Claim | Native replies | Pyric replies | Native | Local Rules | Live Firestore |
| --- | --- | --- | --- | --- | --- |
| knight-reply-121 (playing) | ∅ | ∅ | DENY | DENY | unmeasured |
| knight-reply-123 (draw) | ∅ | ∅ | DENY | DENY | unmeasured |
| knight-reply-122 (won) | ∅ | ∅ | ALLOW | ALLOW | unmeasured |
| knight-reply-475 (playing) | ∅ | ∅ | DENY | DENY | unmeasured |
| knight-reply-477 (draw) | ∅ | ∅ | ALLOW | ALLOW | unmeasured |
| knight-reply-476 (won) | ∅ | ∅ | DENY | DENY | unmeasured |
| knight-reply-481 (playing) | g4e3, g4e5, g4f2, g4f6, g4h2, g4h6 | g4e3, g4e5, g4f2, g4f6, g4h2, g4h6 | ALLOW | ALLOW | unmeasured |
| knight-reply-483 (draw) | g4e3, g4e5, g4f2, g4f6, g4h2, g4h6 | g4e3, g4e5, g4f2, g4f6, g4h2, g4h6 | DENY | DENY | unmeasured |
| knight-reply-482 (won) | g4e3, g4e5, g4f2, g4f6, g4h2, g4h6 | g4e3, g4e5, g4f2, g4f6, g4h2, g4h6 | DENY | DENY | unmeasured |

## One defending pawn

| Claim | Native replies | Pyric replies | Native | Local Rules | Live Firestore |
| --- | --- | --- | --- | --- | --- |
| lone-pawn-mate-playing (playing) | ∅ | ∅ | DENY | DENY | unmeasured |
| lone-pawn-mate-draw (draw) | ∅ | ∅ | DENY | DENY | unmeasured |
| lone-pawn-mate-won (won) | ∅ | ∅ | ALLOW | ALLOW | unmeasured |
| lone-pawn-blocked-playing (playing) | ∅ | ∅ | DENY | DENY | unmeasured |
| lone-pawn-blocked-draw (draw) | ∅ | ∅ | ALLOW | ALLOW | unmeasured |
| lone-pawn-blocked-won (won) | ∅ | ∅ | DENY | DENY | unmeasured |
| lone-pawn-mobile-playing (playing) | a4a3 | a4a3 | ALLOW | ALLOW | unmeasured |
| lone-pawn-mobile-draw (draw) | a4a3 | a4a3 | DENY | DENY | unmeasured |
| lone-pawn-mobile-won (won) | a4a3 | a4a3 | DENY | DENY | unmeasured |

## Missed sliding replies

| Claim | Native replies | Pyric replies | Native | Local Rules | Live Firestore |
| --- | --- | --- | --- | --- | --- |
| mixed-slider-mate-correct-1-1-6-playing (playing) | a4b2, b1b2, c3b2 | a4b2, b1b2, c3b2 | ALLOW | ALLOW | ALLOW |
| mixed-slider-mate-correct-1-1-6-draw (draw) | a4b2, b1b2, c3b2 | a4b2, b1b2, c3b2 | DENY | DENY | DENY |
| mixed-slider-mate-correct-1-1-6-won (won) | a4b2, b1b2, c3b2 | a4b2, b1b2, c3b2 | DENY | DENY | DENY |
| mixed-slider-stalemate-correct-0-1-6-playing (playing) | b5a4, b5a6, b5c4, b5c6, b5d3, b5d7, b5e2, b5e8, b5f1, e1a1, e1a5, e1b1, e1b4, e1c1, e1c3, e1d1, e1d2, e1e2, e1e3, e1e4, e1e5, e1f1, e1f2, e1g1, e1g3, e1h1, e1h4, f6d8, f6e5, f6e7, f6g5, f6g7, f6h8, f7c7, f7d7, f7e7, f7f8, f7g7, h2a2, h2b2, h2c2, h2d2, h2e2, h2e5, h2f2, h2f4, h2g1, h2g2, h2g3, h2h1, h2h3, h2h4, h2h5, h7b1, h7c2, h7d3, h7e4, h7f5, h7g6, h7g7, h7g8, h7h5, h7h6, h7h8 | b5a4, b5a6, b5c4, b5c6, b5d3, b5d7, b5e2, b5e8, b5f1, e1a1, e1a5, e1b1, e1b4, e1c1, e1c3, e1d1, e1d2, e1e2, e1e3, e1e4, e1e5, e1f1, e1f2, e1g1, e1g3, e1h1, e1h4, f6d8, f6e5, f6e7, f6g5, f6g7, f6h8, f7c7, f7d7, f7e7, f7f8, f7g7, h2a2, h2b2, h2c2, h2d2, h2e2, h2e5, h2f2, h2f4, h2g1, h2g2, h2g3, h2h1, h2h3, h2h4, h2h5, h7b1, h7c2, h7d3, h7e4, h7f5, h7g6, h7g7, h7g8, h7h5, h7h6, h7h8 | ALLOW | ALLOW | ALLOW |
| mixed-slider-stalemate-correct-0-1-6-draw (draw) | b5a4, b5a6, b5c4, b5c6, b5d3, b5d7, b5e2, b5e8, b5f1, e1a1, e1a5, e1b1, e1b4, e1c1, e1c3, e1d1, e1d2, e1e2, e1e3, e1e4, e1e5, e1f1, e1f2, e1g1, e1g3, e1h1, e1h4, f6d8, f6e5, f6e7, f6g5, f6g7, f6h8, f7c7, f7d7, f7e7, f7f8, f7g7, h2a2, h2b2, h2c2, h2d2, h2e2, h2e5, h2f2, h2f4, h2g1, h2g2, h2g3, h2h1, h2h3, h2h4, h2h5, h7b1, h7c2, h7d3, h7e4, h7f5, h7g6, h7g7, h7g8, h7h5, h7h6, h7h8 | b5a4, b5a6, b5c4, b5c6, b5d3, b5d7, b5e2, b5e8, b5f1, e1a1, e1a5, e1b1, e1b4, e1c1, e1c3, e1d1, e1d2, e1e2, e1e3, e1e4, e1e5, e1f1, e1f2, e1g1, e1g3, e1h1, e1h4, f6d8, f6e5, f6e7, f6g5, f6g7, f6h8, f7c7, f7d7, f7e7, f7f8, f7g7, h2a2, h2b2, h2c2, h2d2, h2e2, h2e5, h2f2, h2f4, h2g1, h2g2, h2g3, h2h1, h2h3, h2h4, h2h5, h7b1, h7c2, h7d3, h7e4, h7f5, h7g6, h7g7, h7g8, h7h5, h7h6, h7h8 | DENY | DENY | DENY |
| mixed-slider-stalemate-correct-0-1-6-won (won) | b5a4, b5a6, b5c4, b5c6, b5d3, b5d7, b5e2, b5e8, b5f1, e1a1, e1a5, e1b1, e1b4, e1c1, e1c3, e1d1, e1d2, e1e2, e1e3, e1e4, e1e5, e1f1, e1f2, e1g1, e1g3, e1h1, e1h4, f6d8, f6e5, f6e7, f6g5, f6g7, f6h8, f7c7, f7d7, f7e7, f7f8, f7g7, h2a2, h2b2, h2c2, h2d2, h2e2, h2e5, h2f2, h2f4, h2g1, h2g2, h2g3, h2h1, h2h3, h2h4, h2h5, h7b1, h7c2, h7d3, h7e4, h7f5, h7g6, h7g7, h7g8, h7h5, h7h6, h7h8 | b5a4, b5a6, b5c4, b5c6, b5d3, b5d7, b5e2, b5e8, b5f1, e1a1, e1a5, e1b1, e1b4, e1c1, e1c3, e1d1, e1d2, e1e2, e1e3, e1e4, e1e5, e1f1, e1f2, e1g1, e1g3, e1h1, e1h4, f6d8, f6e5, f6e7, f6g5, f6g7, f6h8, f7c7, f7d7, f7e7, f7f8, f7g7, h2a2, h2b2, h2c2, h2d2, h2e2, h2e5, h2f2, h2f4, h2g1, h2g2, h2g3, h2h1, h2h3, h2h4, h2h5, h7b1, h7c2, h7d3, h7e4, h7f5, h7g6, h7g7, h7g8, h7h5, h7h6, h7h8 | DENY | DENY | DENY |
| mixed-slider-one-rook-reply-wrong-result-0-1-5-playing (playing) | h7b7 | h7b7 | ALLOW | ALLOW | ALLOW |
| mixed-slider-one-rook-reply-wrong-result-0-1-5-draw (draw) | h7b7 | h7b7 | DENY | DENY | DENY |
| mixed-slider-one-rook-reply-wrong-result-0-1-5-won (won) | h7b7 | h7b7 | DENY | DENY | DENY |
| mixed-slider-interior-272-playing (playing) | c3e5 | c3e5 | ALLOW | ALLOW | ALLOW |
| mixed-slider-interior-272-draw (draw) | c3e5 | c3e5 | DENY | DENY | DENY |
| mixed-slider-interior-272-won (won) | c3e5 | c3e5 | DENY | DENY | DENY |
| mixed-slider-interior-314-playing (playing) | h6g7 | h6g7 | ALLOW | ALLOW | ALLOW |
| mixed-slider-interior-314-draw (draw) | h6g7 | h6g7 | DENY | DENY | DENY |
| mixed-slider-interior-314-won (won) | h6g7 | h6g7 | DENY | DENY | DENY |

## Special pawn replies

| Starting FEN | Move | Only legal reply |
| --- | --- | --- |
| 8/8/k7/7r/K7/4r3/3P4/8 b - - | h5h4 | d2d4 |
| 8/3p4/4R3/k7/7R/K7/8/8 w - - | h4h5 | d7d5 |
| 2b5/5p2/3k4/6P1/4K3/2b3q1/8/8 b - - | f7f5 | g5f6 |
| 8/8/2B3Q1/4k3/6p1/3K4/5P2/2B5 w - - | f2f4 | g4f3 |

Local full writes matched native chess on 12 of 12 claims.

## Original mixed-material failures

| Frozen case | Native | Local Rules | Local expressions |
| --- | --- | --- | --- |
| mate-correct-1-1-6 | DENY | DENY | 744 |
| stalemate-correct-0-1-6 | DENY | DENY | 709 |
| one-rook-reply-wrong-result-0-1-5 | DENY | DENY | 736 |
| one-rook-reply-wrong-result-1-0-3 | DENY | DENY | 747 |
| one-rook-reply-wrong-result-1-1-2 | DENY | DENY | 744 |
| black-mate-correct-1-1-3 | DENY | DENY | 736 |
| interior-212 | DENY | DENY | 977 |
| interior-228 | DENY | DENY | 960 |
| interior-248 | DENY | DENY | 749 |
| interior-272 | DENY | DENY | 997 |
| interior-304 | DENY | DENY | 988 |
| interior-314 | DENY | DENY | 708 |
| interior-340 | DENY | DENY | 760 |

The mirrored bishop-pin controls matched on 8 of 8 terminal claims.

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

Among the 15 measured proposals in this score, Firestore admitted 5 and refused 10. A qualified capture checks every admitted document against the full submitted successor and every refused document against its complete starting snapshot. Server versions changed on 5 admitted writes and 0 refusals.

Closed capture `mixed-slider` measured 15 proposals. Private receipt `75e923581f25c075f558e23037d8ed000fa277e0875c2bd00e42024078bb27e5`. Journal `8edcb29c50f759e9d4b343b38e32ad8423dd3d5016e5b65a363c8aa1dc74a694`. Authenticated read and write after restoration returned DENY and DENY.
