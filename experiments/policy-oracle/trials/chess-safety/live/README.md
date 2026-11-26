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

After a completed or restored earlier upload, the operator can append `--reuse-run PREVIOUS_PRIVATE_RUN_ID` to `measure`. The controller derives the immutable Google Ruleset name from that prior lease's activation record. Before switching, it fetches the entire Google resource, requires the intended project, database attachment and Firestore service, and compares the only named source file byte-for-byte with the reviewed local bundle and its SHA-256. The usual actual activation, signed phase controls, authenticated writes, original release restoration and per-write digest checks still apply.

If a new upload succeeded and its activation failed temporarily, the bounded retry automatically selects that prior upload's run. The next lease verifies its complete remote bytes and attachment before activation.

### Signed two-player opening

`node opening.mjs measure PLAN PRIVATE_ARCHIVE PRIOR_RUN` exercises the ordinary opening on a single newly created match. The host creates the match, the guest joins, White plays g2–g4, and Black plays a7–a6. Every move claims `playing`. The plan identifies the already reviewed complete ruleset and the prior run supplies its verified Google Ruleset identifier. An independent signed client and the versioned service snapshot establish continuity across all four writes.

Use `node opening.mjs replay PLAN` to check the public receipt or add `PRIVATE_ARCHIVE` to verify the original release, complete journal and signed closure controls. Opening receipts are separate from the fresh-position score because all four writes depend on the same stored match.

The chess safety capture records its local proof times using elapsed monotonic time anchored once to UTC at process startup. Firestore supplies all document and release versions. A prior 115-write run encountered three backward jumps in the host clock. Its immutable transcript and authenticated restoration are listed under `unqualified/`. It contributes zero decisions. Archive-backed replay reproduces the three time inversions and confirms the release closure independently.
