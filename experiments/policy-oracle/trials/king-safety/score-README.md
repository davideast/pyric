# Scoring another compiler

From the trial directory, pass the path to a packed `@pyric/rules` package.

```sh
python3 score.py --candidate-package /path/to/candidate.tgz
```

The package uses the existing public `./experimental/policy` import and `compileFunction(source)` contract. The function runs standalone and exposes `.firestoreModule()` for target emission. Bindable output exports `fileSafe(board, file, color)` from a Rules module. The scorer uses the exact authored policy for both calls. Installation uses Pyric's existing Linux offline scoring runtime, frozen dependencies and disabled npm scripts.

The candidate receives the policy for emission in a private process. A second process invokes its standalone function on the board, source file and moving color. A separate offline install of the pinned evaluator links only the emitted Rules text into the full Arcade application and simulates the frozen SDK write proposals. Each row compares its absolute verdict with the native answer. The report labels local expression counts. Hosted observations belong to the separate live release receipts.

`passed` requires both the standalone and linked Rules decisions to match on all seven cases. Exit code zero means both passed. Exit code one directs the reader to the reported stage or first divergence. An installation error, missing emission, link failure or evaluation error carries a diagnostic. A well-formed decision contrary to the native answer counts as a false allow or false refusal. The cases are public and finite.

Use `--before-board` to run the same package with the deliberate stale-board mutation. Running `python3 score-controls.py` builds four disposable packages and checks that the scorer distinguishes the two wrong decisions, unsupported emission and a failed standalone invocation. [Matched candidate](score-evidence/qualified.json) · [Stale-board divergence](score-evidence/before-board.json) · [Control results](score-evidence/controls.json)
