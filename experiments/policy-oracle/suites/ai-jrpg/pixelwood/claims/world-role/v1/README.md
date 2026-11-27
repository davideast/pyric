# AI-JRPG world roles

The app and deploy mirror at AI-JRPG revision `b3bed5e36acaa7bfc47a600e86e015fb84b1ac70` each contribute six authenticated writes. The entire source files are pinned as [app.rules](probes/app-and-mirror/v1/app.rules) and [mirror.rules](probes/app-and-mirror/v1/mirror.rules). The same signed actor deletes the same synthetic event or updates only the combat map of another signed player's profile. Each attempt starts from a newly seeded document. The before-state, proposal and caller are identical across source variants. When config exists it lists one UID, either the other player or the actor.

The controller leases the existing isolated, non-default oracle database. It checks for conflicting application collections, installs each complete ruleset, confirms propagation using SDK requests, cleans the fixture documents, and restores the original deny-all release between runs. Each scored SDK call runs once. A second signed user reads the full document from the server before and after; privileged Firestore reads record versions and independently confirm deletion. The controller captures the config state around each operation. Other fields on the profile establish that a successful update preserves unrelated data.

## Production observations

| Ruleset | Config | Event delete and server readback | Combat update and server readback |
|---|---|---|---|
| app | absent | ALLOW · document absent | ALLOW · `{"name":"Oracle target","rep":7,"combat":{"hp":9}}` |
| app | unlisted | DENY · `{"kind":"oracle-event","cycle":1}` | DENY · `{"name":"Oracle target","rep":7,"combat":{"hp":10}}` |
| app | listed | ALLOW · document absent | ALLOW · `{"name":"Oracle target","rep":7,"combat":{"hp":9}}` |
| mirror | absent | DENY · `{"kind":"oracle-event","cycle":1}` | DENY · `{"name":"Oracle target","rep":7,"combat":{"hp":10}}` |
| mirror | unlisted | DENY · `{"kind":"oracle-event","cycle":1}` | DENY · `{"name":"Oracle target","rep":7,"combat":{"hp":10}}` |
| mirror | listed | ALLOW · document absent | DENY · `{"name":"Oracle target","rep":7,"combat":{"hp":10}}` |

[Complete SDK readbacks, server versions, config snapshots and release proofs](probes/app-and-mirror/v1/evidence/757b7cb9-b02f-42b2-9c53-3c98af80a363.json)

## Reproduce

From the Pyric experiment checkout, with the existing private controller archive supplied as `archive`, run:

```sh
oracle=experiments/policy-oracle
node "$oracle/arcade/live/controller/world-role.mjs" "$archive"
```

Review the journal and its completed record. Import the verified receipt by run UUID and score the packed candidate against the retained live answers:

```sh
node "$oracle/adapters/world-role/v1/import-reviewed.mjs" "$archive" "$run_id"
python3 "$oracle/core/oracle.py" --replay --trusted-captures "$archive"
python3 "$oracle/core/oracle.py" --candidate-package "$oracle/arcade/vendor/pyric-rules-0.1.0.tgz" --trusted-captures "$archive"
```

Offline replay runs both source files through the candidate simulator with the specified config document and update semantics. Its mutation swaps the two rulesets. A receipt is admitted for scoring only when the verified copy matches the independently retained controller bytes.
