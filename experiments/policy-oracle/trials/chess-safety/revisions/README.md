# Historical compiler results

Each saved input program is rebuilt from its recorded compiler package. The public API emits the helper, the pinned resolver assembles Arcade's entire ruleset, and the independent evaluator reruns all eight primary cohorts. An early revision originally scored on fewer cohorts still faces all 94 moves. Historical classifications, costs and linked bytes are compared with the saved scores. The first untiled index program is a compiler boundary with no emitted Rules. Its source limit is reproduced with the same public API. [Compiler limit probe](../terminal/table-v2/source-boundary.mjs)

Run `python3 revisions/verify.py` from the trial directory for the revision matrix. Package repacking with identical emitted bytes reuses an exact-digest hosted observation. Even a harmless emitted parameter rename gets a distinct digest and an unmeasured hosted result. [Package identity probe](package_identity.py)

The [first matrix](scores.json) is an immutable checkpoint. Each later archived program adds its [own result file](observations/) so independent revisions can land concurrently. Use `--only SCORE_FILENAME` to exercise one program.

On the selected fixed-width program, repacking the compiler package reproduced all 94 primary cases and the same two signed capture identities. Renaming an emitted parameter preserved the 94 local scores and produced a new digest with zero qualifying live observations. [Selected package identity control](selected-package-identity.json)
