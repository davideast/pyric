# Lava Run ordered encounters

The two probes feed the standalone ordered-events policy the geometry and carry state for one 240 Hz substep. Headless runs used the stock Lava Run model and the exact commands from the archived browser recordings at satisfy.md `1924736b`. Before producing the normalized receipts, each run checked its full event payload and final player snapshot against the archived native tape. Gameplay output establishes the expected event order. [Source and compiler pins](sources.json)

| Probe | Seed and substep | Native events and outcome | Policy mutation |
| --- | --- | --- | --- |
| [Two stomps](probes/two-stomps/v1/evidence/fresh-native.json) | 3408597311 at 4440 | Pick up gem 19, contact foe 12, stomp for combo 7, contact foe 13, stomp for combo 8. The runner survives with a shield, one bounce and vertical speed 486. | Emit a stomp only for the first contact that bounces. The altered proposal leaves the second foe contact and every player field intact. |
| [Foe then lava](probes/foe-then-lava/v1/evidence/fresh-native.json) | 2926411498 at 4979 | Contact foe 15, break the shield, contact lava, die from lava. The foe sets recovery to 0.85 s and vertical speed to 285. | Append the lava events before the foe events. Both proposals use the same final player state, so this isolates the emitted order. |

The unmodified policy accepts the complete native proposals and refuses the altered event lists at `stompSequence`. Both mutations flip both verdicts in their own probe. The replay uses the existing offline Arcade runtime and compiles the unchanged satisfy.md policy with the pinned Pyric compiler at `d386b3596`. The historical satisfy.md run used `c25752aaf`.

The headless native check drives both routes from their seeds. Policy scoring covers only the two target substeps. Browser controls, live writes, gateway history and the rest of the Pyric route remain outside this check.

## Recapture

From this claim directory set `satisfy_repo` to a local satisfy.md clone containing the pinned revision. The source archive contains the model, its imports, the two native tapes and the report with the resolved commands.

```bash
native_export=$(mktemp -d)
native_revision=$(jq -r '.native.revision' sources.json)
git -C "$satisfy_repo" archive "$native_revision" $(jq -r '.native.files | keys[]' sources.json) |
  tar -x -C "$native_export"
bun capture-native.mjs "$native_export" probes/two-stomps/v1
bun capture-native.mjs "$native_export" probes/foe-then-lava/v1
```
