# Floor is Lava boost contact

At seed 7, step 304, the recorded player input lands on boost pad 2. The two runs use the same trusted contact and zero previous timer. Their proposed remaining times are 0.044 and 0.060 seconds.

`capture-contact.mjs` drives both the native game and its TypeScript replay from the hearth using the pinned input tape. The replay supplies the sweep, the generated roster and each stone's broken flag. The native game supplies the observed player and timer after the contact. The fixture retains all 16 candidates in their original order.

`generate.mjs` loads the published experimental Pyric API. It runs `floor-pick-landing.rules` over the complete roster, checks the winner against the game, and passes that winner to `floor-platform.policy`. Removing the winner from the input changes the standalone result. The policy derives 0.044 seconds. Its named `compressionTimer` requirement rejects 0.060 in standalone evaluation.

The Firestore placement uses the winner, previous timer, restart flag and step duration from the stored document. The writer can change only `remaining`. Firestore checks the generated timer expression and the handwritten ownership and field guards. The platform search, support and event verdicts run outside this placement. Whoever provisions the stored contact must run the standalone check against trusted physics inputs.

From this directory, after preparing the pinned Arcade runtime with `arcade/replay`, regenerate the artifacts in a new directory and compare them with the committed files.

```sh
node capture-contact.mjs /path/to/satisfy-at-59737d2f > /tmp/floor-contact-replay.json
cmp contact.json /tmp/floor-contact-replay.json
bun generate.mjs ../../../arcade/runtime/node_modules/@pyric/rules /tmp/floor-boost-generated
diff -r artifacts /tmp/floor-boost-generated
```

The capture uses the game's installed pinned esbuild dependency. The full cloud readbacks and release record are linked in the campaign report.
