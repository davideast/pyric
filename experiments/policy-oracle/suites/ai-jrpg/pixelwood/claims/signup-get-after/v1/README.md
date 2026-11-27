# Invite ownership with get() and getAfter()

The paired probe holds the authenticated caller, reader, invite code, profile path, rules revision and signup payloads constant. The only source edit changes the profile-create ownership lookup from `get(invite).data.usedBy` to `getAfter(invite).data.usedBy`. Both rulesets require the invite to exist before signup. [Exact source edit and digests](../../../../../../adapters/signup-get-after/v1/sources.mjs)

Each ruleset starts with the same unused invite data and an absent profile. The client submits an atomic batch, then the invite update and profile creation as two separate commits. If the batch succeeds, the controller records both readbacks before restoring the unused invite and removing the profile for the sequential control. The receipt includes signed reader snapshots and independent versioned REST documents before and after every submission.

Both releases run on the isolated named database. The controller checks propagation, waits another 100 seconds, and brackets each submission with a signed marker write and independent read. It cleans the fixtures and restores deny-all between rulesets and after the final capture.

## Live readbacks

| Ruleset | Submission | Firestore | Invite | Profile |
|---|---|---|---|---|
| Stock | Batch | DENY | Unused, original version | Absent |
| Stock | Sequential claim | ALLOW | Claimed by caller | Absent |
| Stock | Sequential profile | ALLOW | Same claim and version | Named profile with invite code |
| getAfter | Batch | ALLOW | Claimed by caller | Named profile with invite code |
| getAfter | Sequential claim | ALLOW | Claimed by caller | Absent |
| getAfter | Sequential profile | ALLOW | Same claim and version | Named profile with invite code |

In the accepted batch, Firestore set both the invite’s `usedAt` and the profile’s `createdAt` to `2026-11-27T16:11:35.548Z`. Both documents have update time `2026-11-27T16:11:35.562772Z`. On the standalone profile writes, the invite was already claimed. Both lookups saw the caller as its owner. [Full readbacks, marker writes and release proofs](probes/paired-signup/v1/evidence/98238e4a-6545-4d55-ab81-0124d2488add.json)

## Reproduce

From the experiment worktree, supply the private controller archive and use the run UUID printed at completion.

```sh
oracle=experiments/policy-oracle
node "$oracle/arcade/live/controller/signup-get-after.mjs" "$archive"
bun "$oracle/adapters/signup-get-after/v1/import-reviewed.mjs" "$archive" "$run_id"
python3 "$oracle/core/oracle.py" --candidate-package "$oracle/arcade/vendor/pyric-rules-0.1.0.tgz" --trusted-captures "$archive" --upstream-pyric .
```

The packed rules engine scores each commit against the recorded SDK verdict. Its negative control removes the batch’s projected document state from rules evaluation. The Pyric SDK replay also compares the invite and profile field by field using a fixed local clock for server timestamps. Supply a manifest from which `pyric` is importable and the live receipt path.

```sh
for ruleset in stock get-after; do
  bun "$oracle/adapters/atomic-signup/v1/sandbox-replay.mjs" "$project/package.json" "$receipt" "$ruleset"
done
```
