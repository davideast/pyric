# Hosted observations for the chess safety queue

The live controller deploys an exact, reviewed complete Arcade ruleset to the campaign's pinned database. Each proposal starts from a fresh complete match. The signed player submits the update. A second signed client reads the whole match before and after, and the controller compares both reads with the service's REST document and timestamps. A refusal must preserve all fields, the creation time and the update time. An accepted write must store the precise submitted successor and advance the update time.

The release reviews identify exact bytes. Each capture plan separately pins its input-only position files, including any explicit terminal status and winner claimed by the submitting player. Neither native verdicts nor local predictions enter the capture. Each run takes the existing exclusive database lease, verifies signed controls after activation, restores the original deny-all rules, verifies signed read and write refusal, then releases the lease. The public evidence retains the proposed fields, complete before and after states, service versions, independent controller receipt and rules digest. Test identities and run-specific document names use stable aliases.

From the parent trial directory, run:

```sh
bun live/run.mjs replay
bun live/run.mjs lookup RULES_SHA256
```

Each returns hosted data only. An unknown digest returns `unmeasured`. Hosted management failures are a separate field; they carry no case verdict. For failure before Rules accepted upload, the public entry distinguishes the planned digest from a digest actually bound by the private activation journal. Repeating a measurement requires identical normalized inputs. Each digest records its own outcomes. A local package score cannot substitute for a production decision. Add `--archive ABSOLUTE_PRIVATE_CAPTURE_DIRECTORY` to authenticate the raw journal, signed controls and individual write proofs again.

The operator installs the SDK from Arcade's locked `live/package-lock.json`. A plan can be captured, retained and privately replayed in one operation with `node live/run.mjs measure PLAN ARCHIVE`. Alternatively, a plan can be run with `node live/run.mjs capture PLAN ARCHIVE`. The subsequent `node live/run.mjs retain PLAN ARCHIVE PRIVATE_RECEIPT_SHA256` verifies the original release, active deployment, every update, signed readbacks and closure before recording a public receipt. Replaying measurements is offline.

The combined operator command retries a temporary management error up to twice. It first checks the immutable journal for zero case writes, initial closure, restoration after any attempted switch, the correct database and original release, and successful lease release. An ambiguous restoration or any scored writes leave that failed run for inspection. No failed run contributes a verdict.
