# Floor is Lava boost sequence

Seed 7 lands on pad 2 at step 304. This standalone claim scores each of the 13 consecutive steps through 316 as one exact state comparison. The TypeScript input replay supplies seven reference fields (x, y, vx, vy, support, remaining compression in seconds, and boost flight). The stock model independently matches those fields and supplies the boost event. Each recorded state and event can be inspected in the [reference trace](probes/seed-seven/v1/evidence/typescript-replay.json).

| Step | Recorded behavior |
| --- | --- |
| 304 | The 16-platform landing search selects pad 2. Compression starts at 44 ms with a boost-compress event. |
| 305–314 | The supported player carries horizontally as the timer counts down. On step 314, 2.333333 ms remain. |
| 315 | The timer expires, support clears, boost flight starts and the boost-launch event fires at vy 802 px/s. |
| 316 | Gravity changes vy to 795.033333 px/s and y rises to 136.312639 px. |

The [runner](probes/seed-seven/v1/replay.mjs) receives only the pre-contact player state, swept geometry, platform roster, rails, clock and controls. It runs the landing search and carries the boost policy's own typed output into each subsequent step. The oracle compares full-precision predictions with the independent trace outside the runner. Changing only the policy's launch speed to 800 produces the first mismatch on step 315 and changes both y and vy on step 316.

From the Pyric experiment checkout, run the registered oracle with its pinned runtime or supply another packed compiler.

```sh
python3 experiments/policy-oracle/core/oracle.py --all
python3 experiments/policy-oracle/core/oracle.py --candidate-package /path/to/rules.tgz
```

To recapture, use a clean satisfy.md checkout at `59737d2f544e213cecaebf8e9677cf95f39eaa60` with its esbuild dependency installed. From this claim directory, the following reruns the stock game and TypeScript replay from recorded controls, checks the original upstream trace and compares the fresh files.

```sh
probe=probes/seed-seven/v1
fresh=$(mktemp -d)
node "$probe/capture.mjs" /path/to/pinned/satisfy.md "$fresh"
cmp "$fresh/inputs.json" "$probe/inputs.json"
cmp "$fresh/evidence/typescript-replay.json" "$probe/evidence/typescript-replay.json"
```

The [production timer trial](../../../../../../trials/floor-boost/v1/README.md) has its own Firestore receipts for 44 ms accepted and 60 ms refused on the same trusted contact. Its two writes are scored separately from this native sequence.
