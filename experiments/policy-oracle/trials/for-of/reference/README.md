# Frozen loop reference

The public fixture freeze is commit `6154c8f84`. It predates candidate execution. Four rook positions have matching answers from Arcade's pinned legal-move generator and its handwritten six-offset helper. The helper ran offline on a complete map of 64 string-valued squares. The hosted comparison has its own receipts. [Public cases](cases.json) · [Native observations and source digests](native.json)

Tally distinguishes a calculation from admitting a whole turn. Starting at 73, applying zero actions leaves the native model at 73. Its turn parser rejects an empty list. Starting at zero, 400 and 401 strikes both leave the single-action model at 90. The turn parser accepts 400 and rejects 401. The proposed bounded loop returns its initial value on an empty input and checks the declared limit before visiting any item. The early-return, missing-key and bound diagnostics in `cases.json` are proposed language answers. Neither native game defines those language semantics.

The capture reads pinned source directly. Prepare the clean satisfy.md export and pinned Zod package described in the [original Tally probe](../../../suites/satisfy/tally-slate/claims/ordered-fold/v1/probes/native-turns/v1/README.md). From this directory, reproduce the retained native observations with:

```sh
bun capture.mjs "$tally_export" | cmp - native.json
```

From the parent trial directory, run the independent verdict scorer on an implementation's observation file:

```sh
bun reference/score.mjs artefacts/results.json
```

Each row has its frozen ID, a value or symbolic error, and the original diagnostic for an error. The scorer requires complete ordered rows. It also checks that omitting the sixth square first changes the blocked a1-a8 decision and that reversing the actions first changes the strike-then-erase result at 90.

## Sealed authoring cases

The independent authoring corpus has a precommitted digest and uses a verifier-held random seed. Its sparse boards span all eight straight or diagonal directions, distances one through seven, off-path pieces, occupied destinations and interior blockers. With the white queen as the sole white attacker, Arcade's attack query answers whether each path is clear. The question stops at path clearance. [Seeded generator](holdout.mjs) · [Frozen commitment](holdout-lock.json)

After both source submissions lock, the verifier can replay a locked source through the chosen installed package's public entry point:

```sh
bun author-score.mjs "$private_corpus" "$source" "$source_sha256" "$package_dir" function
```

Use `module` and an optional export name for a bounded-module submission. The scorer recomputes the source digest, corpus digest and native results before scoring. It reports compilation failures, non-boolean answers and runtime failures separately from incorrect booleans.
