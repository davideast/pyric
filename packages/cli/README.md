# `@pyric/cli`

The Pyric CLI and programmatic helpers for local sandbox development,
verification, artifact generation, and agent bridges.

> **Alpha.** This package is an early alpha. Non-mirrored exports (e.g.
> `@pyric/cli/serve/worker`, `@pyric/cli/verify`, `@pyric/cli/credentials/node`)
> are experimental public-alpha surfaces that may change without notice. The
> MCP tool surface (tool names and shapes) will consolidate during early
> alpha — do not treat tool names as stable.

Production project administration (deploy, Identity Toolkit configuration,
hosted discovery) is **not** part of this package. Use
[`firebase-tools`](https://firebase.google.com/docs/cli) or the Firebase
Console to ship rules, indexes, hosting, and functions to a real project.

## CLI subcommands

| Command | What it does |
|---|---|
| `pyric init [dir]` | Scaffold a Pyric project. `--template web` (default) creates a Vite app, `--template static` creates a no-bundler app, and `--template node` creates a script project. Also supports `--name`, `--force`, and `--json`. |
| `pyric bridge` | Stand up an HTTP+WebSocket bridge an MCP client (Claude Code, Cursor) connects to (sandbox mode only) |
| `pyric sandbox [flags] [--] [command...]` | Start the local Firebase sandbox. It can serve a static app, run a child process, mount the MCP bridge, and serve Studio. See the [CLI reference](https://pyric.dev/docs/reference/cli/). |
| `pyric snapshot` | Promote saved sandbox state to a committable fixture. Load it with `pyric sandbox --seed <fixture>`. Supports `--out`, `--port`, `--force`, and `--json`. |
| `pyric verify` | Replay a captured sandbox session against candidate rules (`--engine sandbox\|rules-test-api\|both`). Hosted Rules Test API needs SA/ADC via `FIREBASE_SA_BASE64` / `GOOGLE_APPLICATION_CREDENTIALS` |
| `pyric can-i-use <feature>` | Query the canonical conformance model for availability, behaviour fidelity, assurance eligibility, caveats, and evidence. Only an exact canonical feature name exits 0; ambiguous names, spelling suggestions, and missing features exit 1. Accepts `--json`. |
| `pyric mcp` | Start the stdio MCP server. Headless (the default) it hosts an in-process sandbox and serves seven service tools, one per Firebase capability. `--allow-production` enables the `production` methods, which are listed but refused without it; `describe` reports them with `status: 'disabled'` and the sentence that enables it. |
| `pyric firestore rules validate <path>` | Validate Firestore rules structure |
| `pyric firestore rules resolve <path>` | Resolve `2+modules` imports into a Firebase rules artifact |
| `pyric firestore indexes generate <path...>` | Derive composite-index definitions from application source |
| `pyric storage rules resolve <path> --out storage.rules` | Resolve `storage.modules.rules` into a deployable Storage rules artifact |
| `pyric database rules validate <path>` | Validate Realtime Database rules expressions |
| `pyric database rules generate` | Compile a constraints module to local `database.rules.json` without contacting production |
| `pyric <tool> <method> [--<arg> <value>...]` | Call one method of the service surface (`firestore`, `database`, `storage`, `auth`, `rules`, `sandbox`, `assurance`) against this project's sandbox, with the SDK's own method and argument names, e.g. `pyric rules lint --service firestore` or `pyric firestore setDoc --path posts/p1 --data '{"a":1}'`. Any argument reads from a file as `--<arg>-file <path>`, as text for a string argument and parsed JSON for an object one: `pyric rules lint --service firestore --rules-file firestore.rules`. The same records serve `pyric mcp`. Firestore field values are written as JSON in `data`, at any depth: `{"$serverTimestamp": true}`, `{"$increment": <number>}`, `{"$arrayUnion": [...]}`, `{"$arrayRemove": [...]}`, and `{"$deleteField": true}` (accepted by `updateDoc` and a `writeBatch` update, refused elsewhere). The Realtime Database takes Firebase's own `{".sv": "timestamp"}`. |
| `pyric auth impersonate\|actAsAdmin\|actAsAnonymous\|useAppSession\|whoami\|sessions` | Set and read the identity your own calls run as, in this project's headless sandbox. `whoami` reports it beside the app session, the user the sandbox's SDK is signed in as, and says which one the next call runs as. |
| `pyric serve sessions` | List the clients connected to a running bridge, with the target id, platform, and current identity of each. Those ids are what `pyric auth reset --target <id>` takes. Requires a running bridge; `--json` prints the whole result. |
| `pyric auth signInWithEmailAndPassword\|signInAnonymously\|signInWithCustomToken\|signInWithCredential\|signOut` | Move the app session, the way the application's own SDK would. These change nothing about the identity your calls run as; `pyric auth useAppSession` adopts the app session for that. `pyric auth createCustomToken --uid alice` mints what `signInWithCustomToken` redeems. |
| `pyric firestore getCountFromServer\|getAggregateFromServer\|discoverPaths\|findCollectionGroup\|extractIndexes\|writeIndexes` | Firestore depth over the running sandbox. `getCountFromServer` and `getAggregateFromServer` compute count, sum, and average over a query without reading its documents. `discoverPaths` and `findCollectionGroup` walk the sandbox's own document index, exhaustively rather than sampled. `extractIndexes --queries '[...]'` finds the composite indexes a set of queries need, in `firestore.indexes.json` shape; `writeIndexes --indexes '[...]' --confirm` writes them, overwriting the file. |
| `pyric sandbox fork\|apply\|diff\|promote\|discard\|listBranches` | Work a change out on a branch before it reaches the live sandbox. A branch is a directory under `.pyric/state/branches/<branch>/`, so it survives a restart: `pyric sandbox fork --branch draft`, `pyric sandbox apply --branch draft --sessionPath .pyric/last-session.json`, `pyric sandbox diff --branch draft`, then `pyric sandbox promote --branch draft --confirm` or `pyric sandbox discard --branch draft`. |
| `pyric sandbox inspect\|events\|seed\|seedFromFixture\|exportFixture\|reset\|checkpoint\|restore\|listCheckpoints` | Read and manage the live sandbox state. A checkpoint is a named on-disk snapshot under `.pyric/state/checkpoints/`: `pyric sandbox checkpoint --name before-cleanup`, then `pyric sandbox restore --name before-cleanup --confirm`. `pyric sandbox events --kind denials` pages the operation log, `pyric sandbox exportFixture --path fixture.json` writes a fixture `seedFromFixture` loads back, carrying the seeded passwords unless `--excludePasswords` is passed; the file it writes is the seed shape `sandbox seed` accepts (`users` entries of `uid` plus optional `email`, `password`, `customClaims`, and `tenantId`), not the state file `pyric snapshot` writes, and `pyric sandbox reset --scope database --confirm` clears one service. A checkpoint carries the clock, so restoring one restores the instant it was taken under along with the data. |
| `pyric storage uploadBytes\|getDownloadURL\|updateMetadata\|setCrossServiceIam` | Work with sandbox Cloud Storage. An upload carries exactly one payload form, `--contentBase64` for bytes in hand or `--sourcePath` for a file inside the project directory, and the object path's extension supplies the content type the metadata does not name: `pyric storage uploadBytes --path exports/report.csv --sourcePath exports/report.csv`. `pyric storage getDownloadURL --path exports/report.csv` mints the sandbox's own URL, a `data:` URI carrying the object's bytes where production returns a token-signed HTTPS one. `pyric storage updateMetadata --path exports/report.csv --metadata '{"cacheControl":"max-age=600"}'` rewrites the client-settable fields and leaves the bytes alone. `pyric storage setCrossServiceIam --mode denied` puts the sandbox in the project state whose Storage service agent cannot read Firestore, so a rule calling `firestore.get` denies the way production would. |
| `pyric storage status\|provision` | Reach the project's real Storage service with your own credentials. Both are production methods: they run only with `--allow-production` (or `PYRIC_ALLOW_PRODUCTION` set to `1` or `true`) on the process, they require `--confirm`, and they are refused naming `FIREBASE_SA_BASE64`, `GOOGLE_APPLICATION_CREDENTIALS`, and Application Default Credentials when none is found. |
| `pyric sandbox setClock\|advanceClock\|resetClock` | Move the sandbox's one clock, which every `serverTimestamp()`, RTDB `now`, `request.time`, and minted token `iat` reads. `pyric sandbox setClock --isoTime 2026-06-01T00:00:00.000Z` pins the clock there and freezes it; `pyric sandbox advanceClock --ms 3600000` moves it forward an hour, staying frozen if the clock was pinned or flowing if it was not; `pyric sandbox resetClock` returns to the wall clock. `pyric sandbox inspect` reports the current mode and instant. |

Every command's full flags, defaults, exit codes, and environment variables are
in the **[CLI reference](https://pyric.dev/docs/reference/cli/)**.

### Persistence caveats (documented limits)

- **Anonymous users don't persist** (no round-trip key) — but their *documents
  do*. An app that calls `signInAnonymously` on load mints a new uid every
  reload under `--persist`, so docs owned by prior anonymous uids accumulate
  unreachably. Use the sign-in helper (or seeded users) for owner-based data
  you want durable.
- **The state file is not a point-in-time snapshot** — firestore and auth
  sections flush on independent debounces; a crash between them can persist
  docs whose owner user hasn't flushed yet (or vice versa).
- **One writer tab at a time (in-page fallback only)** — when several per-tab
  in-page sandboxes share one `.pyric/state` file, the first tab to flush holds
  the writer lock; others run read-only (console warning + `persistReadOnly`
  diagnostic) so they can't erase the writer's data. On the default SharedWorker
  path this can't happen — the single worker is the sole writer.
- **Loss window** — the final unsaved change can be lost if the tab CLOSES
  within the flush debounce while the state exceeds ~60KB (keepalive cap);
  smaller states flush on unload, and reloads are always safe. A reset (or
  any delete-all) that empties a non-empty state first preserves the prior
  file at `.pyric/state/state.json.bak`.

### Agent onboarding

Three parseable steps, no flags to discover:

```bash
pyric init myapp --json        # → {..., "nextSteps": [...]}
cd myapp && bun install
bun run dev:agent              # pyric sandbox --bridge --seed seed.json
```

Readiness probe: `GET <url>/__pyric/init.json` → 200 once serving (body
carries the live rules hash). MCP endpoint: `<url>/__pyric/mcp`. With
`pyric sandbox --json`, stdout's single line carries `{url, port, mcpUrl,
rulesHash}`.

## Programmatic subpaths

| Subpath | Surface |
|---|---|
| `@pyric/cli/credentials/node` | `fromServiceAccount`, `fromAdc` — build a `ProjectScope` for the Rules Test API (`pyric verify --engine rules-test-api\|both`) |
| `@pyric/cli/verify` | Captured-session replay for Firestore and RTDB rules |
| `@pyric/cli/conformance` | Node query surface: `canIUse` returns full claims and evidence; `canIUseImport` resolves a published import to its canonical compatibility page. |
| `@pyric/cli/conformance/browser` | Compact browser query surface: `canIUse` returns availability, fidelity, assurance, summary, caveats, and the evidence slug without the full claim graph. |
| `@pyric/cli/assurance` | Assurance campaign types and tools |
| `@pyric/cli/assurance/browser` | Browser attachment for assurance campaigns |
| `@pyric/cli/bridge` | `createBridge`, `startServer` (Node) / `connectBridge` (browser via conditional export). Vite integration is `pyric({ bridge })` in `@pyric/cli/vite`. |
| `@pyric/cli/bridge/client` | Browser bridge client helpers |
| `@pyric/cli/vite` | `pyric(opts)`, the dev-only firebase→sandbox swap plugin. Opts: `rules`, `persist`/`fresh`, `seed`, `capture`, `bridge` (MCP), `ui` (Pyric Studio at `/__pyric/ui/studio`, parity with `dev --ui`). |
| `@pyric/cli/discover` | Credential-free crawl helpers for sandbox discovery (`crawl`, `findCollectionGroup`, `createFirestoreDiscoverTools`). Not registered on the default MCP bridge. |
| `@pyric/cli/serve/worker` | SharedWorker serve runtime |
| `@pyric/cli/remote` | Remote / headless helpers |
| `@pyric/cli/register` | Registration helpers |

## MCP tool surface (`pyric bridge`)

The bridge composes its toolsets from the same factories used by its browser
dispatcher so advertised and executable tools cannot drift. The canonical,
always-current list is the
[agent tool inventory](../../docs/agent-tools.md).

**Sandbox-routed** — dispatched against the connected browser sandbox
(`createFirestoreDataTools` + `createFirestoreSimulatorTools` +
`createFirestoreInspectTools` + local RTDB inspection):

- data: `firestore_get_document` / `_list_documents` / `_create_document` / `_add_document` / `_update_document` / `_delete_document` / `_batch_write` / `_query_where` / `firestore_create_with_auto_id`
- stateful simulator session: `firestore_simulator_create` / `_execute` / `_read` / `_batch` / `_undo` / `_redo` / `_events` / `_transaction`
- diagnostics: `sandbox_inspect` — single-call sandbox state/rules snapshot
- RTDB authorization: `rtdb_simulate_access` — evaluates one operation against
  the rules and data currently installed in the connected sandbox
- RTDB structure: `rtdb_crawl_structure` — returns a bounded structural view of
  current sandbox data without leaf values

Assurance campaign tools remain available programmatically from
`@pyric/cli/assurance`, but are not registered on the default MCP bridge.

**In-process** — run on the bridge process itself (`createFirestoreRulesTools`
without a live `ProjectScope`, so no Rules Test API tool):

- `firestore_simulate_rules`
- `rules_stdlib_list` / `_get` (Firestore or Storage), with
  `firestore_rules_stdlib_list` / `_get` retained as compatibility aliases
- `rules_resolve_modules` (Firestore or Storage), with
  `firestore_resolve_modules` retained as a compatibility alias
- `firestore_lint_rules`
- `firestore_resolve_modules`

### Gaps from the playground tool surface

The `packages/playground/` app ships richer diagnostic tools that
the `pyric bridge` does NOT register out of the box today. They're
playground-specific orchestrators built on top of `useRuntimeStore`
and other browser-only state:

- `inspect_firestore_traffic` — structured dump of the sandbox traffic log
- `seed_firestore_data_as_admin` — admin-bypass bulk writes for fixture setup
- `generate_fixture_from_session` — snapshot `sandbox.history()` as a replay fixture
- `try_rules_edit` — replay events under a proposed rules edit
- `debug_firestore_rules` — orchestrator over simulate + lint + history + state

The underlying primitives (`sandbox.history()`, `pyric/sandbox/replay`, and the
rules simulator) remain available for custom compositions.
