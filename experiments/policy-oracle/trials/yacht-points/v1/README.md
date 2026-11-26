# One Yacht points function in standalone Pyric and Arcade

Arcade awards points in twelve categories for a five-die roll. This trial authors the calculation once, as a pure Rules function. In standalone mode the caller supplies a category and five dice. The experimental Pyric compiler also exports the function as an importable `2+modules` module. The Arcade linker places that helper at the existing score action. Arcade supplies the selected category and the stored dice and enforces turn ownership, scorecard updates, totals and end-of-game conditions.

```js
const scoreRoll = compileFunction(source);
Number(scoreRoll('fullHouse', [2, 2, 3, 3, 3])); // 13
Number(scoreRoll('fullHouse', [4, 4, 4, 4, 4])); // 0
Number(scoreRoll('yacht', [4, 4, 4, 4, 4]));     // 50
const moduleText = scoreRoll.firestoreModule();
```

The local compiler branch is `experiment/yacht-pure-function-modules`, commit `d41b2b55b`. The change supports indexed reads and the pure methods `size()`, `removeAll(list)` and `toSet()` inside a parameterized function. The emitter uses the parsed function body and returns standard Rules module text. The previous experimental tarball reported the scoring expression as unsupported. [Function source](yacht-points.rules) · [Generated module](artifacts/points-module.rules) · [Previous package result](previous-package.json)

## What the evidence covers

| Evidence | Result |
|---|---|
| Standalone Pyric against Arcade's native TypeScript scoring function | All 7,776 ordered rolls in each of 12 categories agreed, 93,312 point values. |
| Complete linked ruleset in the pinned reference simulator | All 93,312 correct scores were allowed, and all 93,312 proposals one point higher were refused. Each proposal also changed the total by its claimed points. |
| Stock and generated releases on isolated live Firestore | Both allowed a Yacht worth 50 for five fours and denied 49 for that hand. |
| Offline scoring-error control | Changing a little straight from 30 to 31 preserved both frozen Yacht verdicts. The complete replay caught 120 false allows and 120 false denials, one of each per ordering of 1–5. |
| Prior compiler checks on the same tarball | 56/56 broad cases, 2/2 public Sokoban cases and 19/19 sealed Sokoban cases passed. The emitted Sokoban bundle remained byte-identical. |

The native reference is the pinned Arcade file `games/yacht/src/scoring.ts` at commit `66e14d4f4b0aeab22c05db8d748704dde053d2e5`. The candidate runs in an offline, isolated install. A second install uses the fixed reference package and Arcade resolver to link and simulate only the candidate's emitted text. Linking the unmodified modules must first reproduce the archived stock rules byte for byte. The package and Sokoban scores cover separate paths and are reported separately. [Package score](score.json) · [Coverage control](sensitivity.json) · [Regression checks](regressions.json)

For production, both cases started from the same stock fixture on separate documents with totals `[12, 4]` and an unused Yacht square. The accepted transaction stored 50 in that square and advanced totals to `[62, 4]`. The refused transaction left the square at −1, totals at `[12, 4]`, and the server version unchanged. A separately authenticated client read the full document after each write. The controller checked those reads against the REST documents and verified deny-all restoration before releasing its lease. Production evidence for this release covers those two writes. [Complete readbacks](firestore-receipt.json) · [Deployment pins](release-evidence.json)

## Reproduce offline

From the oracle worktree root, the shared controller archive admits the stock observations. The first command installs the candidate tarball offline, replays both execution paths and exits nonzero on a mismatch. The second verifies the cloud records and restoration journal without contacting Firebase.

```sh
state="$HOME/.local/state/pyric/oracle/2026-11-25-89219c79"
trial=experiments/policy-oracle/trials/yacht-points/v1
package="$state/packages/yacht-3a79e94878d551a292757774f3e39cd2f3d57b15ffec93200807922ae3120fa6.tgz"
python3 "$trial/score.py" --candidate-package "$package" --trusted-captures "$state/captures"
node experiments/policy-oracle/trials/verify-live.mjs "$state/captures"
```

The separate coverage-control command `python3 "$trial/sensitivity.py"` uses the prepared pinned Arcade runtime. The control runs entirely offline. The complete production bundle is retained in [artifacts/complete.rules](artifacts/complete.rules).
