# Sliding reply positions

Each board receives three writes with the identical piece move and successor board. Only the submitted result and its corresponding winner change. Arcade computes the expected result and complete legal reply list from the position. The independent referee verifies both, and records the board after each reply. The independent chess source SHA-256 is pinned in each cohort. [Rook](rook/independent.json) · [Bishop](bishop/independent.json) · [Queen](queen/independent.json)

| Cohort | Board pair | Sole reply on the first board | Change producing mate |
| --- | --- | --- | --- |
| Rook | Qg4–g8 | Rc5–c8 blocks the check | Move the black rook to h5 |
| Bishop | Qg4–g8 | Be5–b8 blocks the check | Add a black pawn on d6 |
| Bishop | Qg4–g8 | Bb6–d8 blocks the check | Add a black pawn on c7 |
| Bishop | Qg4–g8 | Bb7–c8 blocks the check | Add a white bishop on c6, pinning Bb7 to Ka8 |
| Queen | Qg4–g8 | Qc1–c8 blocks the rank | Add a black pawn on c4 |
| Queen | Qd7–h7 | Qa3–h3 blocks the file | Add a black pawn on d3 |
| Queen | Qe1–e4 | Qf7–d5 blocks the diagonal | Add a black pawn on e6 |
| Queen | Qg4–g8 | Qg2xg8 captures the checker | Add a black pawn on g3 |
| Queen | Ba2–d5 | Qf7xd5 captures the checker | Add a white rook on a1, creating discovered double check |

With the path check disabled, the faulty program first reports Be5–b8 through a pawn on d6. Skipping the king-safety check first permits a pinned bishop to move from b7 to c8. It also permits Qf7xd5 while the white rook on a1 still checks the black king. The controls compare both move lists and admission of each status claim. [Mutation results](mutations.json)

Run `python3 -B native/verify.py` from the sliding-replies trial directory to recompute Arcade's answers, the reference standalone answers and the mutation evidence. Add `--python-chess-archive /absolute/path/to/chess-1.11.2.tar.gz` to independently regenerate all 18 boards and 54 claims with python-chess. The six rook claims are already present in the previous 190-write trial.
