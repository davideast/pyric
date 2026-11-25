# Sokoban compiler repair trial

Arcade stores a player's best solve for a level. Fewer moves wins, even when the new solution uses more pushes. At equal moves, fewer pushes wins. `best-score.policy` expresses that order. The unchanged Arcade guards still enforce the writer, document shape, allowed changes, score bounds, object name and server timestamp.

The supervisor supplied a compiler with a deliberately overrestrictive integer comparison. At 40 moves an improvement from 10 to 9 pushes failed. This was an experiment on a seeded defect in an offline candidate. The reference vendor package already implemented the comparison correctly. The author could edit compiler source and tests and could run the two public cases. An independent verifier froze 19 other cases before the author received the brief. Both agents shared a filesystem and followed separate briefs.

| Check | Starting package | First locked edit |
|---|---:|---:|
| Broad package corpus against its admitted evidence | 56/56 | 56/56 |
| Generated Sokoban bundle against stock Firebase receipts | 1/2 | 2/2 |
| Generated Sokoban bundle against sealed cases | 18/19 | 19/19 |

The broad corpus exercises the Sokoban simulator on the stock handwritten rules. Testing whether the compiler emits the same ordering requires passing its emitted helper through the complete Arcade linker and evaluating the resulting text independently. The held-out failure was a one-move improvement from 51 moves and 8 pushes to 50 moves and 14 pushes. All 24 witness routes solved their corresponding levels. The author locked their first revision after 79 seconds. It preserved the 18 existing held-out passes.

## Replay a package

From the worktree root, use the private controller archive retained from the live stock run. The broad command returns a breakdown by authority and execution path. The trial command installs the candidate offline, obtains its helper, and hands only the emitted Rules text to the independent pinned linker and scorer. It fails on a missing production witness, an unsupported case, a wrong verdict or a bundle mismatch when the optional comparison is requested.

```sh
oracle=experiments/policy-oracle
trial=$oracle/trials/sokoban-repair/v1
python3 "$oracle/core/oracle.py" --candidate-package "$package" --trusted-captures "$captures"
python3 "$trial/score.py" --candidate-package "$package" --trusted-captures "$captures" --compare-rules "$trial/repaired.rules"
```

Use `--compare-rules` when replaying the locked artifact. For a new candidate, omit it to score equivalent implementations. Replaying `sealed/verify-solves.mjs` with Bun takes the pinned Arcade `games/sokoban/src` directory as its positional argument. The original seal and both submitted score reports remain alongside this file. After release these cases serve as regression tests. A new blind trial requires fresh held-outs.

[Policy](best-score.policy) · [Generated module](repaired-helper.rules) · [Case-by-case held-out report](held-out-report.json) · [Starting score](starting-score.json) · [Locked score](locked-score.json)
