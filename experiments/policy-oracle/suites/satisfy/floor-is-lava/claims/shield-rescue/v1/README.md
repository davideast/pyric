# Floor is Lava heat-shield rescue

On seed 20261113 the stock game picks up gem 4 at step 592, carries the shield and spends it at the first lava contact, step 798. The probe starts at step 1 with an empty inventory and scores all 798 consecutive 240 Hz steps. The [TypeScript replay receipt](probes/pickup-through-lava/v1/evidence/replay.json) records incoming shield, pickup IDs, outgoing shield, hazard outcome and resulting vx and vy. The capture cross-checks the replay's events, inventory and velocities against the stock game's public state and events on each step.

| Step | Stock replay and Pyric | Game with gem 4 pickup disabled |
| --- | --- | --- |
| 1–591 | Empty inventory | Agrees throughout |
| 592 | Picks up gem 4 and arms the shield | Empty pickup list and shield stays off. Velocities still match. First refusal at `rescuePickup`. |
| 593–797 | Carries the shield without collecting the same gem again | Remains unshielded. |
| 798 | Spends the shield, survives and rebounds at vy 768 px/s | Goes to defeat at vy 0. Both outgoing shields are false. The named refusal is `lavaOutcome`. |

The [policy](probes/pickup-through-lava/v1/floor-heat-shield.policy) derives pickup overlap, shield state, contact outcome and rescue velocity. The TypeScript adapter supplies pre-hazard movement, clock-dependent gem centers, platform geometry, steering and lava height. The runner feeds only Pyric's own shield and collected IDs into the next step. The score compares each derived state to the independent TypeScript answers and tests whether the judge accepts the [omitted-pickup game's report](probes/pickup-through-lava/v1/omitted.jsonl).

The altered native game skips collection of gem 4 wherever its pickup zone overlaps the player. All other native code and control inputs are identical. The policy mutation independently skips ID 4 in its pickup fold. This distinguishes dropping the pickup from dropping a notification while still awarding the shield. The claim ends on the first lava contact. Its authority is the native replay, and it exercises the standalone Pyric policy.

## Replay and recapture

From the Pyric experiment checkout, run the integrated replay or score another packed compiler.

```sh
python3 experiments/policy-oracle/core/oracle.py --all
python3 experiments/policy-oracle/core/oracle.py --candidate-package /path/to/rules.tgz
```

To reproduce the native inputs and answers, use a clean satisfy.md checkout at `8d86ed4660d1179d4d559cc01b86505e1b014ffb` with its esbuild dependency installed. From this claim directory run:

```sh
probe=probes/pickup-through-lava/v1
fresh=$(mktemp -d)
node "$probe/capture.mjs" /path/to/pinned/satisfy.md "$fresh"
cmp "$probe/geometry.json.gz" "$fresh/geometry.json.gz"
cmp "$probe/omitted.jsonl" "$fresh/omitted.jsonl"
cmp "$probe/evidence/replay.json" "$fresh/evidence/replay.json"
```

The compressed file contains one ordered JSON array of pre-hazard geometry samples. The runner's JSON diagnostics include the first omitted-pickup refusal and the lava-contact comparison.
