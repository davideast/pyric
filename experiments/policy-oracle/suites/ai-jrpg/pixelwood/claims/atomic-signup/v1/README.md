# Atomic and sequential signup

The same authenticated caller submitted the same invite update and named profile creation to AI-JRPG’s pinned app rules in an isolated live Firestore database. Firestore received one SDK `writeBatch.commit()` first. The refusal left the original invite and profile path available for two separate SDK writes without reseeding. The caller was a non-admin and the reader was a separate signed identity. [App rules](../../world-role/v1/probes/app-and-mirror/v1/app.rules)

| SDK submission | Firestore | Invite after write | Profile after write |
|---|---|---|---|
| Batch containing invite update and profile create | DENY | Original version, `usedBy` and `usedAt` null | Absent |
| Separate invite update | ALLOW | `usedBy` is the caller, `usedAt` is a server timestamp | Absent |
| Separate named profile create | ALLOW | Same caller, timestamp, and document version | `name = "Oracle player"`, the same invite code, and a server-generated `createdAt` |

The profile rule reads `get(invite).data.usedBy`. At batch evaluation the committed invite is unused. During the separate profile write the invite already contains the caller’s UID. Each row retains the complete SDK readbacks and independent REST document versions for both paths before and after the submission. The packed rules replay supplies the same committed snapshot for both batch members, passes Pyric the projected batch state, and commits locally only when both writes pass. A control that splits the batch into two commits incorrectly allows the atomic case. [Scored live receipt](probes/commit-order/v1/evidence/61b9d5bd-1276-47b7-acbf-90166f033340.json)

## Release propagation and the first capture

The preliminary run submitted its batch about 22 seconds after rules activation. Firestore refused all three submissions, leaving the invite unused and the profile absent. Pyric matched one of those three verdicts. The cause of the first standalone refusal was not established. The scored capture used a protocol fixed before repeating the experiment: wait 100 seconds after the initial marker succeeds, then bracket every scored submission with a distinct successful write by the same caller and an independent signed read of that marker. Each scored write was submitted once. The first capture is retained as diagnostic evidence and fails the scored protocol’s admission checks. [Preliminary live receipt](diagnostics/initial-activation.json)

## Reproduce

From the experiment checkout, run the capture on the designated live oracle database with the external controller archive. Use the printed run UUID for the import.

```sh
oracle=experiments/policy-oracle
node "$oracle/arcade/live/controller/atomic-signup.mjs" "$archive"
bun "$oracle/adapters/atomic-signup/v1/import-reviewed.mjs" "$archive" "$run_id"
python3 "$oracle/core/oracle.py" --replay --trusted-captures "$archive"
python3 "$oracle/core/oracle.py" --candidate-package "$oracle/arcade/vendor/pyric-rules-0.1.0.tgz" --trusted-captures "$archive"
```

The additional SDK check calls Pyric’s public `writeBatch`, `updateDoc`, `setDoc`, and `getDoc` and compares the resulting documents with the live capture. Pass a project manifest from which `pyric` can be imported. Generated timestamp values use each runtime’s clock.

```sh
bun "$oracle/adapters/atomic-signup/v1/sandbox-replay.mjs" "$project/package.json" "$receipt"
```
