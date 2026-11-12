# spaces legacy vs compiled RTDB rules

Copied unmodified from google-labs-code/spaces at commit
`964224af24a040d8924b521837eeda38555ca3e8` (worktree `rtdb-rules-typescript`):

| fixture | source |
| --- | --- |
| `legacy-main.rules.json` | `firebase/legacy/database-main.rules.json` (hand-written, JSONC) |
| `legacy-shard.rules.json` | `firebase/legacy/database-shard.rules.json` (hand-written, JSONC) |
| `compiled-main.rules.json` | `firebase/database-main.rules.json` (compiled by the constraints DSL) |
| `compiled-shard.rules.json` | `firebase/database-shard.rules.json` (compiled by the constraints DSL) |

`test/rules/rtdb/rules-diff.test.ts` uses them as the acceptance input for
`diffRtdbRules(legacy, compiled, { ignoreEquivalent: true })`.
