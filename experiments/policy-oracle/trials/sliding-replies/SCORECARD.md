# Sliding reply scorecard for `all-paired-records-v16-dense3-lean`

Compiler package `98995632ebf810afa49c3e03ee7fc0bac31e3c8ff841327ffa8a3eddda2a9356`. Full Rules `a7f7200fffbb294ca859f3d279ae8cd33c6107d579e221dd9ad1aa9d28f225ca`.

Standalone Pyric returned an exact move list and outcome on 104 of 104 eligible distinct successors. 198 proposals led to those positions. Every proposal is scored on its complete write.

Live coverage is **measured** with 238 distinct observed proposals. The six rook claims also appear in the original 190. The overall row counts each proposal once.

## Complete writes

| Batch | Cases | Local matches | Local false approvals | Local false refusals | Local limit hits¹ | Live matches | Live measured | Live false approvals | Live false refusals |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| original-190 | 190 | 190 | 0 | 0 | 0 | 190 | 190 | 0 | 0 |
| rook | 6 | 6 | 0 | 0 | 0 | 6 | 6 | 0 | 0 |
| bishop | 18 | 18 | 0 | 0 | 0 | 18 | 18 | 0 | 0 |
| queen | 30 | 30 | 0 | 0 | 0 | 30 | 30 | 0 | 0 |
| overall | 238 | 238 | 0 | 0 | 0 | 238 | 238 | 0 | 0 |

¹ Limit hits can also count as false refusals. The SDK exposes an admission verdict. Expression costs come from the pinned local evaluator.

| Official source check | HTTP | Errors | Warnings | Game writes |
| --- | --- | --- | --- | --- |
| compiled | 200 | 0 | 4 | 0 |

## Every saved revision

| Policy | Local compile | Google source test | Original | Rook | Bishop | Queen | False approvals | False refusals | Evaluation errors | Limit hits¹ | Verified witness boards | Live measured |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| prior | emitted | unmeasured | 182/190 | 4/6 | 12/18 | 21/30 | 22 | 1 | 0 | 1 | 0 | 190 |
| rook-rays-v1 | emitted | compiled | 181/190 | 4/6 | 12/18 | 21/30 | 20 | 4 | 0 | 4 | 2 | 0 |
| rook-cross-v2 | emitted | compiled | 182/190 | 6/6 | 12/18 | 21/30 | 20 | 3 | 0 | 3 | 2 | 0 |
| bishop-cross-v3 | emitted | unmeasured | 174/190 | 6/6 | 16/18 | 21/30 | 13 | 14 | 0 | 14 | 8 | 0 |
| queen-cross-v4 | emitted | compiled, service-error | 173/190 | 6/6 | 15/18 | 22/30 | 4 | 23 | 1 | 24 | 18 | 0 |
| all-packed-path-v5 | emitted | service-error | 176/190 | 6/6 | 18/18 | 29/30 | 4 | 11 | 0 | 11 | 18 | 0 |
| all-tabled-path-v6 | emitted | service-error | 176/190 | 6/6 | 18/18 | 30/30 | 4 | 10 | 0 | 10 | 18 | 0 |
| all-rights-king-v7 | emitted | service-error | 186/190 | 6/6 | 18/18 | 30/30 | 4 | 0 | 0 | 0 | 18 | 0 |
| all-rights-king-v7-dense3 | emitted | unmeasured | 187/190 | 6/6 | 18/18 | 30/30 | 3 | 0 | 0 | 0 | 18 | 0 |
| all-two-defenders-v8 | emitted | service-error | 186/190 | 6/6 | 18/18 | 30/30 | 2 | 2 | 0 | 2 | 18 | 0 |
| all-minors-v9 | emitted | service-error | 189/190 | 6/6 | 18/18 | 30/30 | 1 | 0 | 0 | 0 | 18 | 0 |
| all-minors-v9-dense3 | emitted | unmeasured | 190/190 | 6/6 | 18/18 | 30/30 | 0 | 0 | 0 | 0 | 18 | 0 |
| all-shared-rays-v10 | emitted | service-error | 189/190 | 6/6 | 18/18 | 30/30 | 1 | 0 | 0 | 0 | 18 | 0 |
| all-shared-rays-v10-dense3 | emitted | service-error | 190/190 | 6/6 | 18/18 | 30/30 | 0 | 0 | 0 | 0 | 18 | 0 |
| all-projected-king-v11 | emitted | service-error | 189/190 | 6/6 | 18/18 | 30/30 | 1 | 0 | 0 | 0 | 18 | 0 |
| all-projected-king-v11-dense3-once | emitted | service-error | 186/190 | 6/6 | 18/18 | 29/30 | 0 | 5 | 0 | 5 | 18 | 0 |
| all-projected-king-v11-mask-dense3-lean | emitted | unmeasured | 181/190 | 4/6 | 12/18 | 10/30 | 0 | 23 | 12 | 35 | 18 | 0 |
| all-projected-king-v11-targets-dense3-lean | emitted | unmeasured | 176/190 | 2/6 | 6/18 | 10/30 | 0 | 23 | 23 | 0 | 0 | 0 |
| all-projected-king-v11-dense3 | emitted | service-error | 190/190 | 6/6 | 18/18 | 30/30 | 0 | 0 | 0 | 0 | 18 | 0 |
| all-unified-rays-v12 | emitted | compiled | 181/190 | 4/6 | 12/18 | 12/30 | 1 | 23 | 9 | 32 | 18 | 0 |
| all-unified-rays-v12-dense3-lean | emitted | service-error | 182/190 | 4/6 | 12/18 | 10/30 | 0 | 23 | 11 | 34 | 18 | 0 |
| all-shared-axes-v13 | emitted | service-error | 188/190 | 6/6 | 18/18 | 28/30 | 1 | 3 | 0 | 3 | 18 | 0 |
| all-shared-axes-v13-dense3 | emitted | unmeasured | 189/190 | 6/6 | 18/18 | 26/30 | 0 | 5 | 0 | 5 | 18 | 0 |
| all-mode-table-v14 | emitted | compiled | 185/190 | 6/6 | 16/18 | 20/30 | 1 | 15 | 1 | 16 | 18 | 0 |
| all-marked-records-v15 | emitted | compiled | 188/190 | 6/6 | 18/18 | 30/30 | 1 | 1 | 0 | 1 | 18 | 0 |
| all-marked-records-v15-boxed-lean | emitted | unmeasured | 189/190 | 6/6 | 18/18 | 30/30 | 0 | 1 | 0 | 1 | 18 | 0 |
| all-marked-records-v15-dense3-filecut-lean | emitted | service-error | 190/190 | 6/6 | 18/18 | 30/30 | 0 | 0 | 0 | 0 | 18 | 0 |
| all-marked-records-v15-dense3-lean | emitted | compiled | 189/190 | 6/6 | 18/18 | 30/30 | 0 | 1 | 0 | 1 | 18 | 0 |
| all-paired-records-v16 | emitted | unmeasured | 189/190 | 6/6 | 18/18 | 30/30 | 1 | 0 | 0 | 0 | 18 | 0 |
| all-paired-records-v16-dense3-lean | emitted | compiled | 190/190 | 6/6 | 18/18 | 30/30 | 0 | 0 | 0 | 0 | 18 | 238 |

## Same move and successor under three claims

| Piece | Board | Move | Native legal replies | Standalone Pyric sliders | Emitted helper (local trace) | Native P/D/W | Local P/D/W | Live P/D/W |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rook | rook-c5-after-queen | g4g8 | c5c8 | c5c8 | c5c8 | A / D / D | A / D / D | A / D / D |
| rook | rook-h5-after-queen | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | D / D / A |
| bishop | bishop-e5-clear | g4g8 | e5b8 | e5b8 | e5b8 | A / D / D | A / D / D | A / D / D |
| bishop | bishop-e5-d6-blocker | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | D / D / A |
| bishop | bishop-b6-clear | g4g8 | b6d8 | b6d8 | b6d8 | A / D / D | A / D / D | A / D / D |
| bishop | bishop-b6-c7-blocker | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | D / D / A |
| bishop | bishop-b7-free | g4g8 | b7c8 | b7c8 | b7c8 | A / D / D | A / D / D | A / D / D |
| bishop | bishop-b7-pinned | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | D / D / A |
| queen | queen-rank-clear | g4g8 | c1c8 | c1c8 | c1c8 | A / D / D | A / D / D | A / D / D |
| queen | queen-rank-c4-blocker | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | D / D / A |
| queen | queen-file-clear | d7h7 | a3h3 | a3h3 | a3h3 | A / D / D | A / D / D | A / D / D |
| queen | queen-file-d3-blocker | d7h7 | ∅ | ∅ | ∅ | D / D / A | D / D / A | D / D / A |
| queen | queen-diagonal-clear | e1e4 | f7d5 | f7d5 | f7d5 | A / D / D | A / D / D | A / D / D |
| queen | queen-diagonal-e6-blocker | e1e4 | ∅ | ∅ | ∅ | D / D / A | D / D / A | D / D / A |
| queen | queen-capture-clear | g4g8 | g2g8 | g2g8 | g2g8 | A / D / D | A / D / D | A / D / D |
| queen | queen-capture-g3-blocker | g4g8 | ∅ | ∅ | ∅ | D / D / A | D / D / A | D / D / A |
| queen | queen-captures-only-checker | a2d5 | f7d5 | f7d5 | f7d5 | A / D / D | A / D / D | A / D / D |
| queen | queen-capture-leaves-rook-check | a2d5 | ∅ | ∅ | ∅ | D / D / A | D / D / A | D / D / A |

Claims are ordered playing, draw, won. A means allow, D means deny, and — means unmeasured.

## Changes from the historical release on the original 190

| Case | Native | Prior live | Current local | Local diagnostic | Current live |
| --- | --- | --- | --- | --- | --- |
| actual-fourth-ply-playing | DENY | ALLOW | DENY |  | DENY |
| holdout-interior-v1-b-mate-playing | DENY | ALLOW | DENY |  | DENY |
| holdout-interior-v1-w-nonking-checked-won | DENY | ALLOW | DENY |  | DENY |
| holdout-replies-v1-only-b-move-in-check-won | DENY | ALLOW | DENY |  | DENY |
| holdout-replies-v1-stalemate-pinned-defender-playing | DENY | ALLOW | DENY |  | DENY |
| promote-capturing-rook-right-held | ALLOW | DENY | ALLOW |  | ALLOW |
| rook-c5-after-queen-won | DENY | ALLOW | DENY |  | DENY |
| rook-h5-after-queen-playing | DENY | ALLOW | DENY |  | DENY |

## Firestore readbacks

Among the 238 measured proposals in this score, Firestore admitted 108 and refused 130. A qualified capture checks every admitted document against the full submitted successor and every refused document against its complete starting snapshot. Server versions changed on 108 admitted writes and 0 refusals.

Closed capture `sliding-part-1` measured 120 proposals. Private receipt `d3ef593d5a4023e0bf7400342b058199344b3047458a51a0f6e1b86ae4e30560`. Journal `6fadb633cbd622c6fbeeff8a675e5d4def1fb36013236aac710f798d2bb86d16`. Authenticated read and write after restoration returned DENY and DENY.

Closed capture `sliding-part-2` measured 118 proposals. Private receipt `0bdea0418a964fadf1387eb91054e84e78a4e9927840258e5b9cd8e8075c5ed9`. Journal `d4244c50e39bb5833625c129b8c901803890f25c066e27c4e1003c8e5fb8906c`. Authenticated read and write after restoration returned DENY and DENY.
