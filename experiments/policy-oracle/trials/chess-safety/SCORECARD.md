# Cumulative chess oracle scorecard

Each score counts agreements with the independently frozen native answer. The safety column asks whether the moving king is safe. The board and write columns additionally cover move legality and the claimed successor.

Selected program `knight-endgame-paired-pawn-combined-bare-fixed-comma-packed-v5`.

| Primary batch | Native allow / deny | Standalone safety | Standalone board | Local linked write |
| --- | ---: | ---: | ---: | ---: |
| Existing file pins | 4 / 6 | 10/10 | 10/10 | 10/10 |
| Rank and diagonal pins | 13 / 6 | 19/19 | 19/19 | 19/19 |
| King destinations | 6 / 6 | 12/12 | 12/12 | 12/12 |
| Escapes from check | 4 / 4 | 8/8 | 8/8 | 8/8 |
| En passant | 3 / 2 | 5/5 | 5/5 | 5/5 |
| Castling | 8 / 12 | 20/20 | 20/20 | 20/20 |
| Composition and cost | 9 / 1 | 10/10 | 10/10 | 10/10 |
| Terminal claims | 5 / 5 | 10/10 | 10/10 | 10/10 |

## The same rook move on two boards

The white king is on e1 for the first pair and a4 for the rank cases. Each live column belongs to the exact source digest for that release. A dash means there is no completed signed observation. [File positions](../king-safety/reference/positions.json) · [Rank positions](batches/01-rank-diagonal/v1/positions.json)

| Move and board | Native | Local candidate | Prior stronger baseline, live | Candidate, live |
| --- | --- | --- | --- | --- |
| Re2–d2, black rook on f8 | ALLOW | ALLOW | ALLOW | ALLOW |
| Re2–d2, black rook on e8 | DENY | DENY | ALLOW | DENY |
| Rc4–c5, black rook on h5 | ALLOW | ALLOW | ALLOW | ALLOW |
| Rc4–c5, black rook on h4 | DENY | DENY | ALLOW | DENY |
| Rc4–c5, second blocker on e4 | ALLOW | ALLOW | ALLOW | ALLOW |
| Rc4–e4, staying on the pin line | ALLOW | ALLOW | ALLOW | ALLOW |
| Rc4xh4, capturing the attacker | ALLOW | ALLOW | ALLOW | ALLOW |

## Live observations by batch

Each cell gives native matches divided by distinct authenticated writes. A dash means that the release has no completed observation for that batch.

| Batch | Prior stronger baseline | Bare king | Three-piece status | Fixed-width policy |
| --- | ---: | ---: | ---: | ---: |
| Existing file pins | 6/10 | — | — | 10/10 |
| Rank and diagonal pins | 13/19 | — | — | 19/19 |
| King destinations | 6/12 | — | — | 12/12 |
| Escapes from check | 4/8 | — | — | 8/8 |
| En passant | 3/5 | — | — | 5/5 |
| Castling | 8/20 | — | — | 20/20 |
| Composition and cost | 9/10 | — | — | 10/10 |
| Terminal claims | 5/10 | — | — | 10/10 |
| Minimized cases | 4/5 | — | — | 5/5 |
| Corner rights | 4/4 | — | — | 4/4 |
| Promotion claims | 4/8 | — | — | 8/8 |
| Submitted rights | 4/4 | — | — | 4/4 |
| Ten moves × three result claims | 10/30 | 24/30 | 23/30 | 26/30 |
| Sole pawn reply or stalemate | 4/12 | 10/12 | — | 12/12 |
| Bare king and sole knight reply | 7/21 | — | — | 21/21 |
| Actual fourth ply and knight interposition | 2/4 | — | — | 3/4 |
| Mating promotion with or without a castling right | 2/2 | — | — | 1/2 |
| Sole rook interposition or mate | 2/6 | — | — | 4/6 |

| Batch | Packed v3 | Packed v4 | Pawn witness | Quick status |
| --- | ---: | ---: | ---: | ---: |
| Existing file pins | 10/10 | — | — | 10/10 |
| Rank and diagonal pins | 19/19 | — | — | 19/19 |
| King destinations | 12/12 | — | — | 12/12 |
| Escapes from check | 8/8 | — | — | 8/8 |
| En passant | 5/5 | — | — | 5/5 |
| Castling | 20/20 | — | — | 20/20 |
| Composition and cost | 10/10 | — | — | 10/10 |
| Terminal claims | 5/10 | — | — | 10/10 |
| Minimized cases | 4/5 | — | — | 5/5 |
| Corner rights | — | 2/4 | — | 2/4 |
| Promotion claims | — | — | — | 4/8 |
| Submitted rights | — | — | — | 4/4 |
| Ten moves × three result claims | — | — | — | 13/30 |
| Sole pawn reply or stalemate | — | — | 12/12 | — |

## Signed releases

| Release and exact source review | Cases | False allows | False refusals | Same verdict in local evaluator | Signed readbacks |
| --- | ---: | ---: | ---: | ---: | --- |
| [Prior stronger baseline `523c4c137aa0`](live/reviews/523c4c137aa00c2c764264aa6c2cefeda7c692561544da45d4fcccf3a2056fda.json) | 190 | 93 | 0 | 190/190 | [Receipts](live/receipts/523c4c137aa00c2c764264aa6c2cefeda7c692561544da45d4fcccf3a2056fda/) |
| [Bare king `9b31d40d5a18`](live/reviews/9b31d40d5a1847c7ea8cfa9bb070b1b619919709c9bf4608c2ac977d4906f63f.json) | 42 | 8 | 0 | 42/42 | [Receipts](live/receipts/9b31d40d5a1847c7ea8cfa9bb070b1b619919709c9bf4608c2ac977d4906f63f/) |
| [Three-piece status `a53c2fedb742`](live/reviews/a53c2fedb742710fc3aa3db055741b82842382fed457c5ab781cbf7259cb851b.json) | 30 | 7 | 0 | 30/30 | [Receipts](live/receipts/a53c2fedb742710fc3aa3db055741b82842382fed457c5ab781cbf7259cb851b/) |
| [Fixed-width policy `5365dc5183a2`](live/reviews/5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380.json) | 190 | 7 | 1 | 190/190 | [Receipts](live/receipts/5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380/) |
| [Packed v3 `d0a6af913d73`](live/reviews/d0a6af913d73c2d4a870d0349135288c1ec719bdb129f8e8b7219712402e3da1.json) | 99 | 6 | 0 | 99/99 | [Receipts](live/receipts/d0a6af913d73c2d4a870d0349135288c1ec719bdb129f8e8b7219712402e3da1/) |
| [Packed v4 `911e4b24d6f7`](live/reviews/911e4b24d6f744f7995aab7bbb40ace8ce26b145a7f6fb1a51530faebe38636b.json) | 4 | 0 | 2 | 4/4 | [Receipts](live/receipts/911e4b24d6f744f7995aab7bbb40ace8ce26b145a7f6fb1a51530faebe38636b/) |
| [Pawn witness `fa5ed3178ac5`](live/reviews/fa5ed3178ac50a45f38f8a929bfd1908a0d4e617b7c1791cbd639fdf13aada34.json) | 12 | 0 | 0 | 12/12 | [Receipts](live/receipts/fa5ed3178ac50a45f38f8a929bfd1908a0d4e617b7c1791cbd639fdf13aada34/) |
| [Quick status `2d793f903e7d`](live/reviews/2d793f903e7d1b517ca34d92887a30a233e5246452228e35a136a730b4a10bf0.json) | 145 | 17 | 6 | 145/145 | [Receipts](live/receipts/2d793f903e7d1b517ca34d92887a30a233e5246452228e35a136a730b4a10bf0/) |

## Target compiler check

The emitted source has 42 direct unescaped ASCII `matches()` literals. The largest is 3902 characters. 0 exceed the observed 4,096-character limit. 0 exceed 100 regex groups. 4 other arguments are outside this source check. [Official diagnostic and measured samples](compiler-boundaries/regex-literal-v1/)

## The same checkmate under three claims

Black has a king on b3 and queen on d2. White has only its king on a1. After Qd2–b2, White has no legal reply and is in check. Each of these writes submits the same move and board. [Original native position and replies](exploration/hosted-holdout-v1/controls/native.json)

| Claimed result | Native | Prior stronger baseline | Bare king | Three-piece status | Fixed-width policy | Quick status |
| --- | --- | --- | --- | --- | --- | --- |
| playing | DENY | ALLOW | DENY | DENY | DENY | DENY |
| draw | DENY | ALLOW | DENY | DENY | DENY | DENY |
| won | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | DENY |

## Same move, different result claim or defender

The first two submissions use the genuine fourth-ply match snapshot after 1.f3 e5 2.g4. The last two both submit Ra8–h8 and claim a draw. Taking the white queen off b4 frees a black knight. [Complete inputs and independently frozen native replies](reachable/lifecycle-v1/named/v1/)

| Case | Native | Selected local | Prior stronger baseline | Fixed-width policy |
| --- | --- | --- | --- | --- |
| actual-fourth-ply-win | ALLOW | ALLOW | ALLOW | ALLOW |
| actual-fourth-ply-playing | DENY | ALLOW | ALLOW | ALLOW |
| knight-reply-477 | ALLOW | ALLOW | ALLOW | ALLOW |
| knight-reply-483 | DENY | DENY | ALLOW | DENY |

## A rook with one legal reply

White plays Qg4–g8 on both boards. A black rook on c5 can block with Rc8. A black rook on h5 has no legal reply. [Native successors and replies](exploration/rook-interposition-v1/controls/native.json)

| Case | Native | Prior stronger baseline | Fixed-width policy |
| --- | --- | --- | --- |
| rook-c5-after-queen-playing | ALLOW | ALLOW | ALLOW |
| rook-c5-after-queen-draw | DENY | ALLOW | DENY |
| rook-c5-after-queen-won | DENY | ALLOW | ALLOW |
| rook-h5-after-queen-playing | DENY | ALLOW | ALLOW |
| rook-h5-after-queen-draw | DENY | ALLOW | DENY |
| rook-h5-after-queen-won | ALLOW | ALLOW | ALLOW |

## A legal mating promotion with different prior rights

Black plays g2xh1=Q# on both boards. The only change is whether White still holds the kingside castling right before the capture. [Native successors and replies](exploration/held-rook-promotion-v1/controls/native.json)

| Case | Native | Prior stronger baseline | Fixed-width policy |
| --- | --- | --- | --- |
| promote-capturing-rook-right-held | ALLOW | ALLOW | DENY |
| promote-capturing-rook-right-expired | ALLOW | ALLOW | ALLOW |

## Sensitivity to faulty implementations

| Batch | Fault | First case | Native | Faulty |
| --- | --- | --- | --- | --- |
| Rank and diagonal pins | forbid-any-move-by-absolutely-pinned-piece | [rank-pinned-slide](batches/01-rank-diagonal/v1/mutations.json) | ALLOW | DENY |
| King destinations | use-legal-captures-to-detect-attacked-king-destination | [pinned-knight-defends](batches/02-king-destinations/v1/mutations.json) | DENY | ALLOW |
| Escapes from check | accept-eliminating-one-checker-in-double-check | [capture-one-of-two-checkers](batches/03-check-evasions/v1/mutations.json) | DENY | ALLOW |
| En passant | leave-captured-en-passant-pawn-on-board | [ep-two-pawns-leave-rank](batches/04-en-passant/v1/mutations.json) | DENY | ALLOW |
| Castling | test-only-final-king-square-when-castling | [white-short-start-attacked](batches/05-castling/v1/mutations.json) | DENY | ALLOW |
| Composition and cost | truncate-slider-attack-ray-before-seventh-square | [edge-ray-seventh-square](batches/06-composition/v1/mutations.json) | DENY | ALLOW |
| Terminal claims | accept-client-declared-result-for-legal-move | [mate-wrong-result](batches/07-terminal/v1/mutations.json) | DENY | ALLOW |
| Terminal claims | inspect-only-king-replies-for-terminal-position | [one-rook-reply-correct](batches/07-terminal/v1/mutations.json) | ALLOW | DENY |

Matching cloud and local decisions establishes agreement on the submitted writes. The local expression counts and local failure classifications describe the local evaluator. Firestore supplied the signed write decision, full stored match and server versions.

## Broader local evidence

| Cohort | Cases | Native matches | Other outcomes |
| --- | ---: | ---: | --- |
| v1 | 2481 | 2463 | 18 false-allow |
| replies-v1 | 378 | 328 | 50 false-allow |
| rights-v1 | 1736 | 1736 | — |
| promotions-v1 | 904 | 900 | 4 false-refusal/resource-limit |
| interior-v1 | 384 | 354 | 30 false-allow |
| rights-claims-v1 | 2048 | 2048 | — |
| self-check-v1 | 4440 | 4440 | — |
| king-last-v1 | 288 | 288 | — |
| successor-claims-v1 | 762 | 701 | 61 false-allow |
| bare-defender-v1 | 1992 | 1976 | 16 false-allow |
| knight-replies-v1 | 492 | 444 | 48 false-allow |
| Pinned knight and safe twin on every slider ray | 20608 | 20608 | — |
| Recorded traces, played | 1553 | 1553 | — |
| Recorded traces, legal | 47087 | 47087 | — |
| Consecutive saved match histories and refusal probes | 9587 | 9584 | 3 false-allow |
| En passant with actual previous double push | 524 | 524 | — |
| Private traces, each-legal-successor | 46385 | 46385 | — |
| Private traces, three-claims-per-board | 4563 | 4563 | — |

The cohort totals are independent measurements. Some corpora share positions or requests. [Native answers and mutation controls](batches/) · [Third-referee checks](exploration/independent-review/) · [Public package scoring](README.md)

## Exhaustive three-piece helper results

Each emitted helper was evaluated in isolation with the bare king to move against a king and one queen, rook, bishop or knight. Every position received three result claims under Arcade’s status convention. [Enumeration and native scope](terminal/emitted-bare-v1/README.md)

| Emitted source | Positions | Claims | Disagreements | Runtime errors |
| --- | ---: | ---: | ---: | ---: |
| [`5365dc51`](terminal/emitted-bare-v1/5365dc51/summary.json) | 1,791,552 | 5,374,656 | 0 | 0 |
| [`d582f74a`](terminal/emitted-bare-v1/d582f74a/summary.json) | 1,791,552 | 5,374,656 | 0 | 0 |

## Remaining obligations on the broader local corpus

227 distinct writes disagreed with native. The second replay independently reproduced every original decision and expression-count digest.

| Obligation | Distinct writes |
| --- | ---: |
| evaluation-budget | 4 |
| refute-draw-with-legal-reply | 9 |
| refute-won-with-legal-reply | 100 |
| reject-playing-after-checkmate | 76 |
| reject-playing-after-stalemate | 38 |

## Authenticated opening under 523c4c137aa0

create ALLOW (ply 0) | join ALLOW (ply 0) | g2g4 ALLOW (ply 1) | a7a6 ALLOW (ply 2)

Final stored status was **playing**. [Full signed readbacks](live/openings/523c4c137aa00c2c764264aa6c2cefeda7c692561544da45d4fcccf3a2056fda/baseline-sole-pawn.json.gz)

## Authenticated opening under 5365dc5183a2

create ALLOW (ply 0) | join ALLOW (ply 0) | g2g4 ALLOW (ply 1) | a7a6 ALLOW (ply 2)

Final stored status was **playing**. [Full signed readbacks](live/openings/5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380/comma-chess-safety-full.json.gz)

## Official source compilation

Each static test submitted source to Google’s Rules service. A successful static result qualifies that compiler observation; the signed-write table reports live match decisions.

| Source or control | Static result | First diagnostic |
| --- | --- | --- |
| [comma-chess-safety-full](live/diagnostics/5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380.json) | compiled | — |
| [fallback-paired-pawn](live/diagnostics/12c714bb2c32abc6ec3ffc41e15227370829c5313458d4638ab130d764ce475f.json) | compile-error | Regular expression too long. Maximum allowed length: 4096 |
| [final-chess-safety-full](live/diagnostics/a5a549b9bf2b0c1bd4835bbd9742a63629268df6f640bdb7dc8d0966fde5ef12.json) | compile-error | Regular expression too long. Maximum allowed length: 4096 |
| [fixed-chess-safety-full](live/diagnostics/28a1783008b1d212be7a386e3db2aced79adb0a4f4b185a0b47d61a9afc673fa.json) | compiled | — |
| [groups-100](live/diagnostics/140151b16596ac56b5329f737868261d9eaa85bd8173f196fe8b473c9fe18339.json) | compiled | — |
| [groups-101](live/diagnostics/2bf55568240a66af082b8b9b8a5a802dac63b95171b362c299d6a6525419e474.json) | compile-error | Regular expression too many groupings. Maximum allowed groupings: 100 |
| [literal-4096](live/diagnostics/4b4eaf4564fdac2a6348bb5e61fa8f7c213129c6a4f9febec19b8d74f2e7bbbd.json) | compiled | — |
| [literal-4097](live/diagnostics/1e232698bc7837ac3599d222a8abb59d9c380d4b722908398b27cc42912af80a.json) | compile-error | Regular expression too long. Maximum allowed length: 4096 |
| [pawn-sole-pawn](live/diagnostics/fa5ed3178ac50a45f38f8a929bfd1908a0d4e617b7c1791cbd639fdf13aada34.json) | compiled | — |
| [preliminary-pins](live/diagnostics/3d8c9d8dc097accaaedada29421787c7b15aee4f55965fcb1aa269512cf06696.json) | compiled | — |
| [projection-chess-safety-full](live/diagnostics/ef1a9a20902c228227567277e8acc8cb38936a8c64789ca16d993da2de1e5343.json) | compiled | — |
| [split-chess-safety-full](live/diagnostics/ac1cbff2f3a8db47adf2869dcd7569e4e7d15dd46565d988569c122e199b1b75.json) | compile-error | Regular expression too many groupings. Maximum allowed groupings: 100 |

Google returned HTTP 400 on publication of the intended `final-chess-safety-full` release and received 0 case writes. [Management journal summary](live/failures/696a7898aee71c9f6e8275cb4251d60931b713c85a32fdb0b28f17a2b23324e1.json)

## Unscored live attempts

12 management failures produced no qualifying case observations. 2 capture attempts failed the evidence checks. [Management journal summaries](live/failures/) · [Excluded receipts](live/unqualified/)

The interrupted `combined-fast-full` capture has 85 fully journaled transitions and 0 scored cases. Whether another in-flight write reached Firestore is unknown. The original closed release was restored at 2026-11-26T17:58:22.307898Z. Both signed read/write/read control rounds returned DENY. [Recovery and released lease](live/unqualified/bd46c53fe0db4a0718fa512463a6d0ad438c079901a6bce317c6a3f3890cff3a.json)
