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
| `pyric mcp` | Start the stdio MCP server. It attaches to `pyric sandbox --bridge` when available or hosts a headless sandbox. |
| `pyric call <tool> <op>` | Call one MCP tool operation from the terminal and print its result envelope as JSON. Fields come from `--args <json>` or `--stdin`. Attaches to `pyric sandbox --bridge` when available; without one, in-process operations run headless and sandbox operations exit 2. Accepts `--port` and `--json`. |
| `pyric firestore rules lint <path>` | Lint a Firestore rules file |
| `pyric firestore rules validate <path>` | Validate Firestore rules structure |
| `pyric firestore rules simulate` | Run the local Firestore rules simulator |
| `pyric firestore rules resolve <path>` | Resolve `2+modules` imports into a Firebase rules artifact |
| `pyric firestore indexes generate <path...>` | Derive composite-index definitions from application source |
| `pyric storage rules lint <path>` / `simulate` | Run local Storage rules lint or simulation |
| `pyric storage rules resolve <path> --out storage.rules` | Resolve `storage.modules.rules` into a deployable Storage rules artifact |
| `pyric database rules lint <path>` | Lint a Realtime Database rules JSON file |
| `pyric database rules validate <path>` | Validate Realtime Database rules expressions |
| `pyric database rules simulate` | Run the local Realtime Database rules simulator |
| `pyric database rules generate` | Compile a constraints module to local `database.rules.json` without contacting production |

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

Each tool is named for a service and, where one applies, an artifact, and
takes a required `op` field that selects the operation. A call with an unknown
`op`, or with fields the operation does not accept, returns a structured error
naming the valid operations and the fields of the attempted one.

Twelve tools carry 59 operations: 42 are forwarded to the connected browser
sandbox and 17 run in the bridge process.

**Sandbox-routed** — dispatched against the connected browser sandbox
(`createFirestoreDataTools`, `createFirestoreSimulatorTools`,
`createFirestoreInspectTools`, `createDatabaseDataTools`,
`createStorageDataTools`, `createAuthUserTools`, and the local RTDB inspection
and sandbox snapshot factories):

- `firestore_data`: `get`, `list`, `set`, `add`, `update`, `delete`,
  `batch_write`, `query`; one shared `as` field selects admin or a user
- `firestore_simulator`: `create`, `execute`, `read`, `batch`, `add`, `undo`,
  `redo`, `events`, `transaction`
- `sandbox`: `inspect` — single-call sandbox state/rules snapshot;
  `snapshot` — promote the live Firestore documents and Auth users to the
  document `pyric sandbox --seed` re-serves
- `database_data`: `crawl`, `get`, `set`, `update`, `remove`, `push`,
  `transaction`, `query`, `seed`; `crawl` returns a bounded structural view
  without leaf values, and the rest share the same `as` field as
  `firestore_data`
- `database_rules`: `simulate` — evaluates one operation against the data in
  the connected sandbox using its loaded rules or a supplied rules document
- `storage_data`: `upload`, `download`, `list`, `metadata`, `delete`; the same
  shared `as` field
- `auth_users`: `create`, `import`, `get`, `list`, `update`, `delete`,
  `set_claims`, `custom_token`

Assurance campaign tools remain available programmatically from
`@pyric/cli/assurance`, but are not registered on the default MCP bridge.

**In-process** — run on the bridge process itself. The bridge resolves project
credentials once at startup; when none resolve, `firestore_rules.test` and the
Rules Test API engine of `pyric.verify` stay listed and return their
credentials error on use:

- `firestore_rules`: `lint`, `simulate`, `resolve`, `validate`, `test`
- `firestore_indexes`: `generate`
- `rules_stdlib`: `list`, `get` (Firestore or Cloud Storage, by `service`)
- `storage_rules`: `resolve`, `lint`, `simulate`
- `database_rules`: `lint`, `validate`, `generate`
- `pyric`: `can_i_use`, `verify`, `verify_cases`

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
