# Tally Slate ordered fold

Each case proposes a final tally. The stock model receipt records the moves through their pinned fixture, intermediate counts, final count, and whether each proposal matches. The stock turn parser and its `tallyNext` entry point reproduce the same ten comparisons. Both paths use the stock tally model. The arithmetic check below is independent of that implementation.

| Initial tally | Moves in order | Tally after each move | Unordered mutant |
| --- | --- | --- | --- |
| 90 | Strike, erase | 90, 89 | 90 |
| 90 | Erase, strike | 89, 90 | 90 |
| 73 | Erase all, strike | 0, 1 | 0 |
| 73 | Strike, erase all | 74, 0 | 0 |
| 0 | 400 strikes | 1 through 90, then 90 for 310 moves | 90 |

At 90 a strike leaves the count unchanged, so erasing next subtracts one from 90. Erasing first makes space for the next strike. Erase-all clears the count when it occurs, so only a later strike can leave a mark. The mutant adds the net delta once before clamping. Any erase-all in its input resets the whole aggregate to zero. It yields two false accepts and two false refusals across the paired proposals.

The 400-strike control is a native result and a valid experimental transition. The separate 401-strike control ends at 90 when calling the unrestricted model one move at a time. The stock agent-turn parser rejects the same 401 strikes with its own 400-move constraint, and the experimental standalone judge rejects the proposal at `tallyMatches` because the fold exceeds its declared limit. The 401-move control stays outside the native-model score. [Raw model](evidence/stock-model.json) · [Stock agent-turn parser](evidence/stock-turn-parser.json) · [Experimental boundary](evidence/experimental-boundary.json)

## Replay and recapture

Run `bun replay.mjs` from this directory once the offline Arcade runtime dependencies are installed by the common runner. `bun replay.mjs --policy-boundary` prints the standalone judge's 400/401 decisions. The replay compiles the unchanged `strike-turn.policy` at satisfy.md revision `10ee7ffe` with the expression budget from its `strike-policy.ts` configuration. The packed Pyric compiler comes from the shared archive at `d386b3596`. [Source and runtime pins](recipe.json) · [Source revisions](fixtures/sources.json)

For a fresh native capture, export only the pinned source closure from a local satisfy.md clone. With `satisfy_repo` set to that clone and the working directory set to this probe, run:

```bash
native_export=$(mktemp -d)
native_revision=$(jq -r '.native.revision' fixtures/sources.json)
git -C "$satisfy_repo" archive "$native_revision" $(jq -r '.native.files | keys[]' fixtures/sources.json) |
  tar -x -C "$native_export"
bun capture-native.mjs "$native_export"
```

For the separate parser run, extract the lock-pinned Zod 4.6.7 archive into `$native_export/node_modules/zod` and run `bun capture-native.mjs "$native_export" --parser`. The recorded run used the local npm cache and verified the tarball's SHA-512 against the exported package lock. The capture script checks each exported source file's SHA-256 before invoking either stock entry point.
