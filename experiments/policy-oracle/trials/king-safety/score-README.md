# Scoring another compiler

From the trial directory, pass the path to a packed `@pyric/rules` package.

```sh
python3 score.py --candidate-package /path/to/candidate.tgz
```

The package uses the existing public `./experimental/policy` import and `compileFunction(source)` contract. Bun resolves that import from the installed package using its active export conditions. The function runs standalone and exposes `.firestoreModule()` for target emission. The default v2 profile compiles `fileSafe(board, file, color)` and `horizontalPathClear(board, rank, x, toX)` from the authored sources. Selecting `--variant v1` binds the same king safety helper alongside the earlier path geometry. Installation uses Pyric's existing Linux offline scoring runtime, frozen dependencies and disabled npm scripts.

The candidate receives the policy for emission in a private process. A second process invokes its standalone function on the board, source file and moving color. A separate offline install of the pinned evaluator links only the emitted Rules text into the full Arcade application and simulates the frozen SDK write proposals. Each row compares its absolute verdict with the native answer. The report labels local expression counts. Hosted observations belong to the separate live release receipts.

`passed` requires both planes to agree with their native reference across three separately frozen cohorts. The seven primary moves test leaving the king exposed. A subsequent legal long slide tests the full request budget. Two additional moves blocked by intervening pieces test horizontal geometry. Both leave the king safe, so standalone `fileSafe` should return true and the complete write should be refused. Exit code one directs the reader to a divergence or diagnostic. A native-legal write refused on the expression budget counts as a false refusal with its limit and evaluated expression count. A refusal caused by an evaluation error on a native-illegal move is scored as an error. The cases are public and finite.

Use `--before-board` to run the same package with the deliberate stale-board mutation. Running `python3 score-controls.py` builds disposable packages and checks both wrong decisions, unsupported emission, and failures in standalone or linked evaluation. [Matched v2 candidate](score-evidence/qualified.json) · [v1 cost refusal](score-evidence/v1.json) · [Stale-board divergence](score-evidence/before-board.json) · [Control results](score-evidence/controls.json)
