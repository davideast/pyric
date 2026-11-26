# Historical compiler results

Each saved input program is rebuilt from its recorded compiler package. The public API emits the helper, the pinned resolver assembles Arcade's entire ruleset, and the independent evaluator reruns all eight primary cohorts. An early revision originally scored on fewer cohorts still faces all 94 moves. Historical classifications, costs and linked bytes are compared with the saved scores. The first untiled index program is a compiler boundary with no emitted Rules. Its source limit is reproduced with the same public API. [Compiler limit probe](../terminal/table-v2/source-boundary.mjs)

Run `python3 revisions/verify.py` from the trial directory for the revision matrix. Package repacking with identical emitted bytes reuses an exact-digest hosted observation. Even a harmless emitted parameter rename gets a distinct digest and an unmeasured hosted result. [Package identity probe](package_identity.py)

The [first matrix](scores.json) is an immutable checkpoint. Each later archived program adds its [own result file](observations/) so independent revisions can land concurrently. Use `--only SCORE_FILENAME` to exercise one program.

On the selected fixed-width program, repacking the compiler package reproduced all 94 primary cases and the same two signed capture identities. Renaming an emitted parameter preserved the 94 local scores and produced a new digest with zero qualifying live observations. [Selected package identity control](selected-package-identity.json)

## Retrospective coverage

The [audit inventory](recovery-inventory-v1.json) fixes 51 historical programs. The original matrix covered 31. The audit found 12 additional programs with independent complete-write holdout summaries, four earlier king-mobility revisions with narrower recorded results, three saved and previously scored local prototypes, and one compiler-shape probe. One original program exceeded the compiler source limit before it emitted Rules. The remaining 50 each have a package hash, a complete Rules hash and 94 named primary inputs. One of those 50 received its first game score during the audit. A historical score and a retrospective replay are distinct observations.

The early `king-reply` family uses the archived pure-`replace` compiler. The combined families also require `split` and use their original combined compiler package. The scorer derives both tarballs from pinned inputs. Each recovery leaf links its original evidence to its exact complete Rules. A mobility-only leaf retains the original edge/interior scope and adds a fresh score on all seven batches and the ten legacy file-pin writes. The three local prototypes with earlier modeled game scores retain their original case IDs, outcomes and expression counts. The compiler-shape probe retains its original emitted digest and carries an explicit empty prior game-evidence list.

The historical replay checks all per-case scores on the moving-king prediction, the complete standalone board policy and the independently executed Rules for a modeled write. Earlier mobility predictors combined king safety with a check on the claimed result. On `one-king-reply-wrong-result`, they can correctly refuse the proposed outcome while differing from the narrower standalone moving-king question. Authenticated Firestore verdicts remain release-specific observations in the hosted receipt store.

To rerun the original local holdout cohorts as well as the primary cases, add `--replay-holdouts`. This command reproduces the edge-king cohort and the primary cases for the second mobility program.

```sh
python3 revisions/verify.py --only king-reply-v2-through-7.json --replay-holdouts
```
