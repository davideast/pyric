# Hosted rook path comparison

The controller submits the four [frozen rook moves](../reference/cases.json) through an authenticated Firebase SDK client. Each starts from its own seeded, complete Arcade match. The same move-update builder supplies both allowed proposals and the plausible successor for a move through a blocker. A separately authenticated observer reads the full match before and after the write. The controller checks both SDK reads against Firestore REST documents and server versions. Only a completed run on the named campaign database, including restoration of its original deny-all release, qualifies as hosted evidence.

The handwritten bundle is the previously qualified complete stronger Arcade ruleset. The generated bundle may replace its linked path helper. The controller checks the rest of the bundle against the handwritten bytes before any deployment. The original release, the open release, and the restored release each have independent signed propagation controls.

With the loop trial as the working directory, replay both captures offline:

```sh
bun live/replay.mjs "$generated_complete_rules" "$installed_reference_rules"
```

The scorer verifies the entire before-state, proposed write, after-state and each refused write's server version. It compares the two releases after normalising the temporary client identities and match paths. Each signed read, signed-out control and player write is replayed against the exact rules file named by its digest. The reported expression counts describe the local evaluator.

The optional third argument, an absolute private controller archive, reauthenticates both receipts from their original release and lease journals. The public gzip files retain complete observed match fields, server timestamps and receipt hashes. Anonymous account IDs and per-run match paths use stable aliases.

An operator can repeat the measurement with the existing locked live SDK dependencies installed under `experiments/policy-oracle/arcade/live`. Use each release's independently calculated SHA-256 and one active controller at a time:

```sh
node live/capture.mjs handwritten "$archive" ../chess/bundle/artifacts/stronger.rules "$handwritten_sha256"
node live/capture.mjs generated "$archive" "$generated_complete_rules" "$generated_sha256"
```

For each completed capture, `node live/retain.mjs "$archive" "$receipt_sha256" "$bundle"` verifies the original journal before writing the redacted receipt. An existing public receipt can only be written again with identical bytes. Fresh observations can be retained in a new version of this trial.
