# Floor is Lava moving platform

On seed 1901463376 the pilot hops first to stone 1 and then to shuttle 2. This standalone probe scores 312 consecutive physics steps, including the accepted 156-step prefix and the entire second turn. The reference is the pinned TypeScript course replay. We also fly both hops in the native game and record the shuttle center at every substep and the detector operands at landing. The shifted build translates the shuttle base, body and rails together by 12 px immediately after the first turn. Its existing detector reads the translated body.

| Step | TypeScript replay x (px) | Shifted game x (px) | Observation |
| --- | ---: | ---: | --- |
| 1–156 | | | Stock and shifted centers agree on the full first turn. |
| 157 | 155.59066987602432 | 167.59066987602432 | First refusal at `stoneAtCoursePosition`. |
| 311 | 188.9289732683725 | 200.9289732683725 | Both land on stone 2. Each detector uses its own platform's center and accepts the crossing within its 42.25 px radius. |

The [Pyric policy](probes/two-hop-shuttle/v1/shuttle.policy) starts with the authored phase. On each tick it advances its previous phase by frequency × duration and computes x from the base, swing amplitude and sine of the new phase. The packed rules runtime has no sine intrinsic. This policy uses a degree-17 sine polynomial after reducing the phase around one turn. Its supported interval is explicitly guarded (reduced phase within ±1 radian). The score allows 1e-12 px absolute error against the TypeScript replay; the largest measured error on this recording was 2.85e-14 px or less.

Each step scores three results: the numeric prediction against the independent replay, the policy verdict on the stock body, and its verdict on the shifted body. Only the numeric scorer sees the replay x. The policy takes authored oscillator parameters and a clock for derivation, then sees the submitted body x for its verdict. Every step starts from Pyric's own preceding phase. The mutation control widens the positive tolerance to just over 12 px; it misses all 156 displaced samples.

Run the registered suite from the experiment checkout with `python3 experiments/policy-oracle/core/oracle.py --all`, or score a packed compiler with `--candidate-package /path/to/rules.tgz`. The probe output includes the maximum numeric error and first refused position under `diagnostics`. The [samples](probes/two-hop-shuttle/v1/samples.json) are indexed from step 1. The [native receipt](probes/two-hop-shuttle/v1/evidence/native.json) includes the actual landing operands, verdicts and sample digest.

To reproduce the capture, use a clean satisfy.md checkout at `59737d2f544e213cecaebf8e9677cf95f39eaa60` with esbuild installed. From this claim directory run:

```sh
probe=probes/two-hop-shuttle/v1
fresh=$(mktemp -d)
node "$probe/capture.mjs" /path/to/pinned/satisfy.md "$fresh"
cmp "$probe/inputs.json" "$fresh/inputs.json"
cmp "$probe/samples.json" "$fresh/samples.json"
cmp "$probe/evidence/native.json" "$fresh/evidence/native.json"
```

This claim records standalone geometry and the headless native landing. Firestore timer writes and gateway persistence have separate evidence.
