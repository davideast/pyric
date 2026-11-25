# Arcade move-counter policy oracle

Two claims are registered in [the frozen v1 manifest](v1/manifest.json). For an ordinary nonwinning host move, the generated helper must require the proposed move counter to equal the stored counter plus the policy's increment, either one or two. Arcade's surrounding grant enforces the actor's turn. The corpus covers one zero-count and one four-count board. [Scored decisions and counterexamples](FINDINGS.md)

## Replay from a clean checkout

Run from the root of this experimental branch on Linux with Node 24, npm, GNU tar, sha256sum and flock.

```sh
experiments/policy-oracle/arcade/replay
```

The command installs the pinned packages from the local tarballs using npm's offline mode, emits both modules through `@pyric/rules/experimental/policy`, and links them into Arcade's complete module tree with Arcade's own pinned resolver. It compares the complete bundle bytes to the deployed hashes. The public `@pyric/rules` simulator then replays each request against the candidate and independent controls. The source policy is also judged independently of the turn guard. An out-of-turn player with the correct number can satisfy that one requirement and still receive a database refusal.

Add `--json` for machine-readable scores, including full inputs for the first false allow and first false denial. To score a different emitter, supply `--modules /absolute/path` containing its `generated-module.rules` (+1) and `plus2-module.rules` (+2). The candidate is linked and scored against the same live observations. A changed candidate receives an offline comparison; new production evidence would require a new capture with its bundle digest. An incomplete receipt, unsupported evaluator decision or failed conformance claim produces a nonzero exit.

## Capture the twelve count-four writes

```sh
experiments/policy-oracle/arcade/capture
```

The command requires an authenticated gcloud CLI with access to the named trial database, Firebase Rules and the project's existing Firebase web app. It installs the locked Firebase SDK. The named database UID and original deny-all ruleset must match the frozen target. A create-only Firestore lock prevents overlapping captures. An interrupted process leaves a private journal and may leave the lock. Inspect the named release and the lock's owning run before recovering an interrupted capture.

The setup uses privileged requests for fixture creation, rules releases, a corroborating document read and the lock. The host and guest sign in through Firebase Auth. Scored writes use the client SDK and each complete post-state is fetched from the server by the guest. Allowed writes must advance the server version. Refused writes must preserve it and every field. Every case uses a new document. After a release changes, two consecutive zero-count control pairs must distinguish +1 from +2 before any four-count submission. Control writes and their readbacks are recorded separately from scored cases. Cleanup restores the original deny-all release, checks a signed-in read is refused, and deletes the temporary Auth users. Synthetic documents remain in the closed trial database.

The command prints the path of its private journal. Compare a fresh completed capture with the frozen baseline using `replay --receipt /absolute/path/to/production.json`. The default replay uses the two committed normalized receipts. They preserve full documents, timestamp values, update times, identities as consistent role aliases and raw receipt hashes. The original SDK receipts stay under the ignored `records/` directory.

## Evidence and scoring

The manifest was committed before the new writes. It pins the case recipes, expected answers, dependency versions, rules hashes and target bindings. The independent +2 control was handwritten directly in stock tic-tac-toe's move grant. The other games retain the stock helper. The count-four board was independently reproduced through Arcade's stock transitions with zero-based moves 0, 4, 5 and 1; move 6 is legal and leaves the match playing.

The immutable [observation index](v1/ledger.json) binds the zero-count and four-count raw receipts and their portable copies. To audit normalization with the original bytes, run `node normalize.mjs zero /path/to/zero.json` or `node normalize.mjs four /path/to/production.json` from this directory. Compare stdout byte-for-byte with the corresponding file under `v1/observations/`. After one replay, `node runtime/guards.test.mjs` exercises the evidence rejection cases.

Evidence coverage counts claims with their required production observations and independent controls. Implementation conformance counts evidenced claims for which all rows match the source contract, control and candidate behavior. Duplicate cases cannot inflate either score. The intentional mutant removes the prior counter from the policy source, then follows the same emission, linking and evaluation path. Access to Firestore is confined to the capture command.
