# Chess acceptance evidence by requirement

This audit indexes the 41 game requirements and four admission requirements in the placement registry. The **initial hosted cohort** consists of the registered stock (24 writes), compatibility (24) and stronger (30) releases. It excludes the repeated 18-write discovery capture. A positive write with a full readback establishes what happened on that input. A one-field negative control adds evidence that a particular condition mattered. The SDK reports a whole-write verdict. [Release registry](../../verify/releases) · [Placement registry](obligations.json)

In the hosted column, unqualified IDs appear in all three initial releases. **H** means a stronger-only case. **B** means the board/reference corpus, whose named positions check exact legal moves, resulting positions and outcomes. **M** means the matched metadata/admission run, which compared 3,473 successors and checked four admission decisions for each. **L** means the 150-case local rules replay. The supplement column gives case IDs from the later cohort, prefixed with `supplement-` in its receipts. Its separately retained local results cover 49 decisions, including seven sensitivity flips. The hosted supplement recorded 15 writes under stock rules, the same 15 under generated compatibility rules, and 19 under stronger rules. [Stock supplement](../../verify/releases/stock-supplement.json) · [Compatibility supplement](../../verify/releases/compatibility-supplement.json) · [Stronger supplement](../../verify/releases/stronger-supplement.json) [Board corpus](../../reference/public.json) · [Locked metadata score](../../reference/scores/97dda7add77cb18d132ba1c730bbef24a48870404198d6677cdf0f961a30d212-metadata.json) · [Local rules decisions](../local-results.json) · [Supplement cases and expected decisions](../supplement/fixtures.mjs)

## Match lifecycle and stored transition

| Requirement | Initial hosted evidence | Native or local evidence | Supplement or remaining limitation |
|---|---|---|---|
| signed-match-reads | Each independent signed readback and the signed-out read journal event | Hosted-operand replay checks the read rule | Directly observed for the match path. |
| opening-board-and-fields | `open-match`, `create`, `opening-counter` | B opening and independent full initial document verification | Only the initial counter receives a dedicated refusal. |
| open-seat-and-join | `join`, `join-rematch` | L `join`, `join-modifies-board` | Firestore refused `boundary-occupied-seat-join` and preserved the original seat. |
| cancel-waiting-match | `cancel-by-host`, `cancel-by-guest` | Both hosted operations replay from the waiting state | Different actor, same waiting match. |
| resignation-and-winning-seat | `resign-rematch`, guest resigns and host wins | L `resign`, `resign-modifies-board` | Firestore refused `boundary-wrong-resign-winner` and preserved the playing match. |
| finished-parent-rematch | `offer-rematch`, `duplicate-offer` | Whole prior match, pointer and new match read back | Firestore refused `boundary-unfinished-parent-rematch`. The parent stayed intact and both new documents stayed absent. |
| rematch-pointer-and-new-match-atomicity | `pointer-alone`, `offer-rematch`, `duplicate-offer` | Verifier mutation removes the pointer from an accepted readback | Both writes and the unchanged parent are observed. |
| playing-match | `terminal-move`; accepted `f2f3` | M tests a resigned prior state | Terminal write also includes fields from a previous transition. |
| authenticated-current-seat | `wrong-turn` versus `f2f3` | L `turn-owner`; M checks the opposing seat at every successor | Direct seat comparison. |
| turn-flip | Every stored move, e.g. `f2f3` | B `retain-turn` mutation; M | `retain-turn` |
| counter-increment | `wrong-counter` and `f2f3` | L `move-count`; the +2 rules mutant changes both hosted verdicts on replay | Direct one-field comparison. |
| last-move-encoding | `special-castle-black-queenside`, `special-en-passant`, `special-underpromotion-capture` | M verifies exact from, to, promotion and sorted extra list | `last-move-extra` |
| winner-and-status-shape | `f2f3`, `d8h4`, `special-stalemate` | M checks both status and assigned winner | `ongoing-winner` |
| previous-board-and-rights | Prior state is retained in every accepted move | L `previous-board`; M compares both prior rights fields | `previous-board`, `previous-rights`, `previous-ep` |
| protected-fields | Signed readbacks include players and createdAt | L `join-modifies-board`, `resign-modifies-board` | `protected-guest` |
| unchanged-unrelated-squares | Every full-board readback, e.g. `f2f3` | B exact successors and all 64 squares | `unrelated-square` |
| own-piece-and-target-owner | `special-underpromotion-capture` captures an opposing rook | B exact legal sets and moves in `kiwipete` | `wrong-color` covers the mover; a dedicated same-color destination refusal remains. |
| source-emptied | Every move readback | B exact board successors | `retained-source` |
| target-piece-and-promotion-choice | `special-underpromotion-capture` | B `promote-white-quiet-or-capture` and `promote-black-quiet-or-capture`; L all four choices | `wrong-destination` |
| king-capture-forbidden | No dedicated capture-king attempt | Ordinary reachable legal positions and terminal move lists contain no king capture | Stock has an explicit predicate. A legal reachable side-to-move position cannot isolate a geometrically legal capture of the opposing king. An offline predicate-isolation fixture can test this clause. |

## Movement, successor state and search

| Requirement | Initial hosted evidence | Native or local evidence | Supplement or remaining limitation |
|---|---|---|---|
| pawn-geometry | `f2f3`, `e7e5`, `special-en-passant` | L `backward-pawn`, `pawn-distance`; B `opening` | Forward, double and diagonal moves sampled. |
| knight-geometry | Initial special case promotes to a knight; no ordinary knight move | B `opening`; L `knight`, `knight-shape` | `knight`, H `knight-shape` |
| bishop-geometry | No ordinary bishop move | B `kiwipete`; sensitivity mutation `truncate-bishop-rays` | `bishop`, H `bishop-shape` |
| rook-geometry | `special-capture-corner-rights` | B `rook-endgame`; L `capture-corner-rook` | `rook`, H `rook-shape` |
| queen-geometry | `special-long-clear-ray` and `d8h4` | L `long-line`, `long-diagonal`; B `kiwipete` | Two legal lines and a blocked line. An isolated wrong queen displacement remains unmeasured live. |
| king-geometry | `special-castle-black-queenside`; no ordinary one-square king step | B `king-adjacency`; L `native-1-e1d1` | `king`, H `king-shape` |
| sliding-path-clearance | `special-long-clear-ray`, H `special-long-blocked-ray` | L `slider-blocked`, `long-line` | Direct open versus blocked file. |
| double-pawn-push | `e7e5` and `g2g4` | B `opening`; L `opening-pawn`, `ep-successor` | A same-file occupied intermediate square on the double push is a useful separate refusal. |
| mandatory-final-rank-promotion | `special-underpromotion-capture`, H `special-promotion-required` | L `missing-promotion` and four choices; both colors in B | Accepted and refused examples have different destinations. |
| castling-rights-and-rook-path | `special-castle-black-queenside` | B `no-rights`, `blocked-castling`, both colors and sides; L `empty-castle-rights` | Add held-versus-absent rights on the same castle. |
| castling-rook-transition | `special-castle-black-queenside`, H `special-castle-rook-arrival` | L `castle-rook-successor` | Same castle with one wrong board cell. |
| corner-rook-capture-rights | `special-capture-corner-rights`, H `special-capture-retains-rights` | B `home-rook-captured`, `rooks-return-rights-expire` | Same move and initially held rights. |
| en-passant-target-and-expiry | `e7e5`, `special-en-passant`, H `special-en-passant-expires` | B `en-passant-expires`; L `ep-successor` | A held-target expiry and creation are sampled separately. |
| en-passant-captured-pawn | `special-en-passant`, H `special-en-passant-captured-pawn` | B `ordinary-en-passant`; L `ep-captured-pawn-successor` | Same move with a retained captured pawn. |
| complete-successor-board | All accepted moves use 64-square readbacks | B exact successor comparisons; M move metadata | `unrelated-square` covers an unrelated value change. Dropping a previously empty key has no dedicated hosted case. |
| king-safety-and-pins | Initial DB releases have no authority for self-check | B `absolute-pin`, `discovered-check`, `double-check`; pin mutation caught | Referee qualification separately tests the pinned rook. |
| castling-attacked-squares | Initial DB releases have no authority for attacked transit | B `attacked-transit`; L `castle-attacked-transit` | The referee committed `boundary-castle-clear` and refused `boundary-castle-through-check` with `legalMove`. |
| en-passant-exposing-king | Initial DB releases have no authority for self-check | B `en-passant-opens-rook-line` checks the exact legal list | The referee committed `boundary-ep-clear` and refused `boundary-ep-exposes-king` with `legalMove`. |
| has-legal-reply | Accepted `d8h4` and `special-stalemate` record supplied results | B `one-escape`, `mate`, `stalemate` | Complete reply generation runs standalone. |
| checkmate-and-winning-seat | `d8h4` stored a win for guest | B `fools-mate`; M winning-seat projection; `report-mate-as-stalemate` mutation | Initial hosted receipts establish the stored result. Referee qualification derives the result before commit. |
| stalemate-and-draw | `special-stalemate` stored a draw | B `deliver-stalemate`, `one-escape`; M | Same distinction between storage and adjudication. |

## Authoritative admission

The qualified referee release recorded the browser moves, race and referee decisions, followed by the restored deny-all controls. Firestore returns a write verdict. The referee also records the named admission requirement and stored document version. [Browser and concurrency receipt](../../verify/releases/referee.json) [Referee evidence verifier](../../verify/browser-proof.mjs) · [Version-conditioned write](../../live/referee.mjs)

| Requirement | Native or local evidence | Referee-specific evidence | Additional observation |
|---|---|---|---|
| reject-direct-player-move | L `opening-pawn` allows in stronger and refuses in referee | `direct-player-move` signed player SDK refusal and unchanged match | Same legal move through admission succeeds. |
| authenticate-before-admission | Local match policy consumes an independently determined UID | Valid browser participants' requests and stored actor IDs | The referee returned HTTP 401 and `identity` on `boundary-signed-out`. The document and version stayed unchanged. |
| expected-match-ply | M exercises a stale expected ply at each successor | `concurrent-admission` checks two submissions sharing the same initial version | The current player supplied an old ply in `boundary-stale-ply` and received `matchVersion` before commit. |
| compare-and-commit-stored-version | Placement gate binds the persistence adapter | Both contestants in `concurrent-admission` read one version. One committed and the other received `matchVersion`. | The losing request's readback identified the winning successor. |

## Live admission and lifecycle checks

The final ten cases cover seven requests to the referee and three direct client writes to Firestore. Two legal moves committed. The eight refused attempts preserved every observed document and server version, including the absent rematch documents. The referee distinguished identity, wrong turn, stale ply and move legality. Firestore returned a write refusal on each invalid lifecycle action. [Boundary receipt](../../verify/releases/referee-boundary.json)
