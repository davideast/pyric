# Score a packed rules engine

From this experiment directory, run the scorer against the file that would ship. The JSON goes to standard output.

```sh
python3 core/oracle.py --candidate-package /path/to/pyric-rules.tgz
python3 core/oracle.py --candidate-package arcade/vendor/pyric-rules-0.1.0.tgz
python3 -B core/test_candidate.py
```

Use the same reviewed checkout, baselines and capture-controller directory for both comparisons. The existing `--trusted-captures` and `--upstream-pyric` flags control evidence admission. A probe with a missing eligible receipt stays pending even when both packages produce a decision. The command reads the admitted answers before either install. It checks the evidence again after both runs.

## Read the score

`candidateSha256` and `referenceSha256` identify the exact compressed package bytes. `evidenceSha256` hashes the canonical JSON object containing the verified inventory under `snapshot`, the archived Arcade ledger digest under `frozenArcadeLedger` and the admitted observation names by probe under `admittedObservations`. The inventory includes observation hashes that bind the raw evidence.

Each row under `cases` names the claim, probe, case, authority and execution path. An evidenced row carries its oracle answer, the pinned package's decision and the submitted package's decision. A false allow includes a boolean `true` for a native proposal the source model rejected. A false denial includes a boolean `false` for an accepted proposal. A regression is a scored mismatch on a case the reference package answered correctly. The summary gives counts and the first named regression, false allow and false denial in frozen manifest order followed by discovered probe and recipe order.

An install incompatibility or a probe that fails to return its declared decisions gives `unsupported` rows for affected evidenced cases. A leaf that throws partway through its run loses the whole probe's predictions. `pending` and `disputed` rows are excluded from the scored count. A mismatch, unsupported evidenced case or dispute exits 1. The first diagnostic on standard error identifies an infrastructure or evidence validation failure. A completed comparison prints its report even when the submitted package regresses.

## What executes

Each package gets its own `npm ci --offline --ignore-scripts` install. The runner substitutes only the rules tarball in a private copy of the lockfile, checks the installed dependencies with `npm ls` and adds the independently hashed Arcade bundler. The checked-in packages, original lockfile, prepared runtime and capture-controller archive remain outside writable storage. Packages requiring additional runtime dependencies need a separately reviewed version of the runtime.

For the frozen Arcade archive, the stock replay checks the original 21 writes, both controls and its historical mutation counts. The submitted package compiles each Policy source, emits its Firestore module, bundles it with the pinned resolver and simulates every operation on the resolved rules. The report lists emitted module and bundled rules hashes for both claims. A change in emitted bytes can coexist with 21 matching decisions. The submitted archive leg measures the generated rules' decisions. The separate native-model leaves exercise the Policy judge.

Each discovered leaf runs its existing pinned recipe against the corresponding installation. For example, the original Arcade game leaves simulate the stock Firestore rules, while the Firestore batch leaf calls the internal simulator and shared post-write projection. A leaf only covers the package entry points its runner calls.

The worker requires Linux unprivileged user and network namespaces, bubblewrap with `--disable-userns`, a Debian-style `/usr` layout, Python 3, npm, Node 22+ and Bun. It starts a fresh network namespace, clears inherited environment variables, and gives each probe a private process namespace and writable tmpfs. The package and inputs are mounted read-only during probe execution. The kernel, local tools, reviewed checkout and replay programs are trusted. The fixtures and probe code are visible to the candidate. A package can recognize cases or interfere with its in-process JavaScript harness, so a score measures behavior on those inputs. Keeping holdouts private and verifying their provenance is a separate controller responsibility.

## Reproduced package comparison

The acceptance test packed a second distribution that reverses the public Firestore simulator's reported decisions. Against the pilot and follow-on inventories at `f22a2ed7b`, both runs had evidence digest `e7af1783d493badb0b64defc8dda33f65471d6608fa1910ff45ff7197d109824`. Six cases awaited independent Arcade receipts.

| Compressed package SHA-256 | Matches / scored | False allows | False denials | Regressions |
|---|---:|---:|---:|---:|
| Released `67087040f9e1206c54660563a27329d4b5db22102229af8f11b8ccb68ea87743` | 50 / 50 | 0 | 0 | 0 |
| Altered `8451ab44306404c5a8825ad3e7501b0091369e5f06793959286e4ab8ce963c34` | 29 / 50 | 14 | 7 | 21 |

The first regression was a false denial on `arcade/tictactoe/relative-plus-one/v1`, case `zero/stock/normal`. The first false allow was `zero/stock/skipped`. Both emitted modules and both resolved rules files still matched their original bytes. Every archived write reached the altered simulator.
