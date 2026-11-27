# AI-JRPG invite and profile lifecycle

Five sequential authenticated SDK writes use the same invite in an isolated live Firestore database. The deployed rules are AI-JRPG’s `app/firestore.rules` at revision `b3bed5e36acaa7bfc47a600e86e015fb84b1ac70`. Each writer owns their profile path. A fourth account reads the documents and is the sole listed world admin. [Pinned app rules](../../world-role/v1/probes/app-and-mirror/v1/app.rules)

## Live readbacks

| Write | Firestore | Invite after write | Claimant profile | Other caller profile | Guest profile |
|---|---|---|---|---|---|
| Claim unused invite | ALLOW | Claimed | Absent | Absent | Absent |
| Same claimant repeats claim | DENY | Claimed | Absent | Absent | Absent |
| Claimant creates named profile | ALLOW | Claimed | Named | Absent | Absent |
| Other caller creates own named profile using the same invite | DENY | Claimed | Named | Absent | Absent |
| Guest creates own mechanics-only profile | ALLOW | Claimed | Named | Absent | Mechanics |

The initial invite had `createdBy` set to the reader, `createdAt` set to 2026-01-01 UTC, and both claim fields null. The first write set `usedBy` to the claimant UID and `usedAt` to 2026-11-27T15:42:55.845Z. Every later read returned that same invite and document version. The named profile contained `name = "Oracle player"`, the claimed invite code, and `createdAt = 2026-11-27T15:43:08.546Z`. The guest profile contained `skills.lockpicking = 1`, `rep = 0`, and `updatedAt = 2026-11-27T15:43:21.208Z`.

Every attempt has a server SDK read and a versioned REST read for the invite and all three profile paths before and after the write. Both refusals preserved every document and version. The controller restored the deny-all release, checked propagation, and removed its fixtures. [Full capture](probes/signup/v1/evidence/cfa484a1-4d0f-445e-acbb-c12dcca7f5d1.json)

## Replay and recapture

From the experiment checkout, supply the independent controller archive as `archive`. Replay scores the ordered operations against the retained Firestore decisions. A control that serves the original, unclaimed invite during the profile lookup must miss `claimant-profile`.

```sh
oracle=experiments/policy-oracle
python3 "$oracle/core/oracle.py" --replay --trusted-captures "$archive"
python3 "$oracle/core/oracle.py" --candidate-package "$oracle/arcade/vendor/pyric-rules-0.1.0.tgz" --trusted-captures "$archive"
```

For a new capture on the designated live oracle database, run the controller, review the completed journal, then import its printed run UUID.

```sh
node "$oracle/arcade/live/controller/invite-profile.mjs" "$archive"
node "$oracle/adapters/invite-profile/v1/import-reviewed.mjs" "$archive" "$run_id"
```
