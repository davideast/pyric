# Verifying the chess releases from controller evidence

The release registry binds each run to the exact linked rules file. Each gzip contains byte-for-byte the complete observed match documents after decompression. The verifier also requires the separately retained controller archive. Use Bun and the qualified Arcade campaign worktree.

```sh
archive="$HOME/.local/state/pyric/oracle/2026-11-25-89219c79/captures"
bun receipts.mjs "$archive"
```

A verified release has a controller lease on the pinned named database, signed propagation controls for its initial closed state, active release and restored closed state, matching identity and journal records, and a final completion record. The verifier compares every accepted match field independently to the native engine and protocol, including unchanged timestamps, prior positions, winners and multi-document effects. The signed-out read is archived with its original journal bytes. Every known before-state must equal its preceding after-state. Refusals must preserve all readbacks and versions. Signed-out read denial has its own journal event. The initial discovery capture records actor and case name. The later protocol captures also record the observer UID and exact write operations.

Each registered candidate specifies its own rules digest. Stock and generated compatibility can be compared after replacing run-specific identifiers and server timestamps. The verifier checks timestamps and server version transitions within each run before normalizing. Stronger deployment probes and referee mode have distinct requirements. A direct-player refusal under referee rules covers the database admission boundary. The equivalent Pyric chess verdict comes from the independent locked-engine comparison and the referee replay.

From this directory, `python3 retain.py ARCHIVE NAME RECEIPT RELATIVE-BUNDLE [RELATIVE-ENGINE]` verifies and registers a new capture. Keep the bundle and engine paths inside the integrated checkout for durable reproduction. An existing registration can only be written again with the same bytes. The registry is discovered by file name. Each new release adds separate files.

The in-memory sensitivity run changes one accepted move counter and removes the rematch pointer from an accepted batch, leaving the other returned documents intact. It checks that transition verification independently detects the first incorrect row. These are offline controls on the verifier. Each hosted client verdict is bound to an original, separately retained receipt.

## Score a new candidate offline

After the oracle's pinned offline rules runtime has been prepared with `python3 experiments/policy-oracle/core/oracle.py --all` from the checkout root, run `bun replay.mjs` here. The defaults select the campaign's two generated policy modules and four linked rules bundles. To score an alternate candidate pass its policy directory and rules directory, in that order. An optional third argument selects the private holdout corpus for locked submissions.

This loop reads the reviewed release registry and the compressed production receipts in the checkout. It checks their digests locally, replays every recorded SDK write under the candidate rules and compares the result with the recorded hosted verdict. It also reevaluates the independently signed before/after reads and the signed-out read. Batch replay evaluates every operation against the captured before-state and the entire proposed post-commit projection. The same command checks the candidate's board and metadata against the independent corpus. Judge admission of new hosted observations with the separate controller-backed verification command above.

The first referee run exposed a client replay defect. Its checkmate overlay marked legal moves illegal. On its archived first move, reversing only the board map's key insertion order changed Arcade's original replay decision. The qualifying browser check requires both clients to report an empty illegal-move list and correct replay at each of eight checkpoints. The frozen original-order result is retained alongside each corrected client result. [Diagnostic screenshot](diagnostics/first-checkmate.png) · [Diagnostic provenance](diagnostics/client-board-order.json)
