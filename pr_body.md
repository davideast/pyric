```ts
$ pyric serve denials
The host keeps a bounded log: these counts start at 2026-10-13T00:00:00.000Z.
rtdb /rooms/$roomId: 1 denial on 1 page load
  first 2026-10-13T00:00:09.001Z, last 2026-10-13T00:00:09.001Z
  identities: anonymous-cf1eb84b
  rule: auth != null && data.child('members').child(auth.uid).exists()

Tip: After updating rules, run `pyric verify` to replay these captured sessions and confirm your fixes.

$ pyric database rules generate
pyric database rules generate: wrote /project/database.rules.json
  Test before deploy: pyric verify --service rtdb --rules rtdb=database.rules.json
```

## Verify hints in the development loop

`pyric verify` is now discoverable from the three places users reach when they are thinking about rules or production:
1. `pyric serve denials` appends a tip to replay captured sessions.
2. `pyric database rules generate` prints a tip to verify before deploying.
3. `pyric sandbox` prints a hint to verify past sessions when it hot-reloads rules, printed exactly once per session to avoid noise.

Docs are also updated with a "Before you ship" link in the quickstart, the agent baseline skill is updated to run verify before proposing rules, and the verification docs are updated to describe `--engine staging`.

## Risk

Very low. Only adds console hints and updates documentation.

<details>
<summary>Implementation notes</summary>

Verification:
- Added tests in `serve-denials.test.ts` and `database-rules-generate.test.ts`.
- Extended `test/apps/rtdb-verify-reads-and-denials` to assert the hints appear on the CLI and hot-reload. Against the base branch, it fails expecting the hints.
- Docs check passed.

</details>
