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

The npm package may still appear as `pyric-tools` in some install instructions;
prefer `@pyric/cli` for import paths.

## CLI subcommands

| Command | What it does |
|---|---|
| `pyric init [dir]` | Scaffold a pyric project — never prompts, idempotent, safe to rerun. `--template web` (default): a servable app with **canonical `firebase/*` imports** (owner-based rules, `seed.json`, `dev`/`dev:agent` scripts, real `firebase` dep) — `pyric dev` runs it on the sandbox; any standard bundler runs the same code on real Firebase. The swap is environmental, never a code edit. `--template node`: script-style scaffold whose backend is picked by `PYRIC_TARGET=sandbox\|firebase`. Also `--name`, `--force` (overwrite scaffold-owned files), `--json` (machine result on stdout: `{template, dir, created, merged, skipped, conflicts, nextSteps}`) |
| `pyric bridge` | Stand up an HTTP+WebSocket bridge an MCP client (Claude Code, Cursor) connects to (sandbox mode only) |
| `pyric dev` | Local dev server with the pyric sandbox standing in for Firebase: serves `hosting.public`, resolves unmodified `firebase/*` imports to a pyric sandbox via a served import map, deploys + hot-reloads `firestore.rules` (SSE), opens an emulator-style sign-in helper for `signInWithPopup`/`signInWithRedirect`. The sandbox runs in a **SharedWorker by default** — one backend shared by every tab of the origin (live cross-tab sync), kept in the browser's IndexedDB so **your sandbox data — Firestore docs, auth users, RTDB, storage objects, and the traffic history — survives a refresh/restart by default** (see the persistence guide's coverage matrix for the exact tiers); a per-tab in-page sandbox is the fallback when SharedWorker is unavailable. Flags + exit codes: [CLI reference](docs/reference/cli.md#pyric-dev); persistence, ephemeral runs, clearing data, and SharedWorker tips: [persistence & multi-tab](docs/how-to/serve-persistence-and-multi-tab.md) |
| `pyric snapshot` | Promote lived sandbox state (live `dev --persist`, else `.pyric/state/state.json`) to a committable fixture; `pyric dev --seed <fixture>` re-serves it (docs + users). `--out`, `--port`, `--force`, `--json` |
| `pyric verify` | Replay a captured sandbox session against candidate rules (`--engine sandbox\|rules-test-api\|both`). Hosted Rules Test API needs SA/ADC via `FIREBASE_SA_BASE64` / `GOOGLE_APPLICATION_CREDENTIALS` |
| `pyric rules:lint <path>` | Lint a Firestore rules file |
| `pyric rules:validate <path>` | Validate Firestore rules structure |
| `pyric rules:simulate` | Local rules simulator |
| `pyric database:rules:lint <path>` | Lint a Realtime Database rules JSON file |
| `pyric database:rules:validate <path>` | Validate Realtime Database rules expressions |
| `pyric database:rules:simulate` | Local Realtime Database rules simulator |
| `pyric database:rules:generate` | Compile a constraints module to local `database.rules.json` (no production contact) |
| `pyric firestore:indexes:generate` | Derive composite-index definitions from query shapes |
| `pyric storage:rules:lint` / `simulate` | Local Storage rules lint and simulation |

Every command's full flags, defaults, exit codes, and environment variables are
in the **[CLI reference](docs/reference/cli.md)**. Task guides and the rest of
the docs are indexed in **[docs/](docs/README.md)**.

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

### Agent onboarding (init → dev → MCP)

Three parseable steps, no flags to discover:

```bash
pyric init myapp --json        # → {..., "nextSteps": [...]}
cd myapp && bun install
bun run dev:agent              # pyric dev --bridge --seed seed.json
```

Readiness probe: `GET <url>/__pyric/init.json` → 200 once serving (body
carries the live rules hash). MCP endpoint: `<url>/__pyric/mcp`. With
`pyric dev --json`, stdout's single line carries `{url, port, mcpUrl,
rulesHash}`.

## Programmatic subpaths

| Subpath | Surface |
|---|---|
| `@pyric/cli/credentials/node` | `fromServiceAccount`, `fromAdc` — build a `ProjectScope` for the Rules Test API (`pyric verify --engine rules-test-api\|both`) |
| `@pyric/cli/verify` | Captured-session replay for Firestore and RTDB rules |
| `@pyric/cli/bridge` | `createBridge`, `startServer` (Node) / `connectBridge` (browser via conditional export). Vite integration is `pyricSandbox({ bridge })` in `@pyric/cli/vite`. |
| `@pyric/cli/vite` | `pyricSandbox(opts)`, the dev-only firebase→sandbox swap plugin. Opts: `rules`, `persist`/`fresh`, `seed`, `capture`, `bridge` (MCP), `ui` (Pyric Studio at `/__pyric/ui/`, parity with `dev --ui`). |
| `@pyric/cli/discover` | Library crawl helpers for sandbox / Rest discovery (`crawl`, `findCollectionGroup`, `createRestCrawlerFirestore`, `createFirestoreDiscoverTools`). Not registered on the default MCP bridge. |
| `@pyric/cli/serve/worker` | SharedWorker serve runtime |
| `@pyric/cli/assurance` | Assurance campaign tools (also registered on the default bridge) |
| `@pyric/cli/remote` | Remote / headless helpers |
| `@pyric/cli/register` | Registration helpers |

## MCP tool surface (`pyric bridge`)

The bridge composes its toolsets from the same factories used by its browser
dispatcher so advertised and executable tools cannot drift. The canonical,
always-current list is the
[agent tool inventory](../../docs/agent-tools.md).

**Sandbox-routed** — dispatched against the connected browser sandbox
(`createFirestoreDataTools` + `createFirestoreSimulatorTools` +
`createFirestoreInspectTools` + local RTDB inspection + assurance):

- data: `firestore_get_document` / `_list_documents` / `_create_document` / `_add_document` / `_update_document` / `_delete_document` / `_batch_write` / `_query_where` / `firestore_create_with_auto_id`
- stateful simulator session: `firestore_simulator_create` / `_execute` / `_read` / `_batch` / `_undo` / `_redo` / `_events` / `_transaction`
- diagnostics: `sandbox_inspect` — single-call sandbox state/rules snapshot
- RTDB authorization: `rtdb_simulate_access` — evaluates one operation against
  the rules and data currently installed in the connected sandbox
- RTDB structure: `rtdb_crawl_structure` — returns a bounded structural view of
  current sandbox data without leaf values
- assurance: `firebase_assurance_*` campaign tools

**In-process** — run on the bridge process itself (`createFirestoreRulesTools`
without a live `ProjectScope`, so no Rules Test API tool):

- `firestore_simulate_rules`
- `firestore_rules_stdlib_list` / `_get`
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

These are powerful and worth lifting into the library so any
`pyric bridge` user gets them. The blockers are: `inspect_traffic`
needs a generic traffic-log API on `Sandbox` (today the playground
maintains its own ring buffer); `try_rules_edit` + `debug_firestore_rules`
are orchestrators that depend on the replay engine being wired to a
generic "session" abstraction. Tracked as a follow-up — the underlying
primitives (`sandbox.history()`, `pyric/sandbox/replay`, the rules
simulator) all exist.
