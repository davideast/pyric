# Agent tool inventory

Every agent-callable tool in this repo, **sourced**. Handlers are plain
`ToolHandler` objects produced by per-package factories — you compose them
into whatever runtime you use. They reach an agent two ways:

1. **`pyric sandbox --bridge`** (or `pyric bridge`) exposes the **default MCP
   surface**; the [Pyric agent plugin](../pyric-plugin/README.md) auto-wires
   it. Each MCP tool is one record under
   `packages/cli/src/bridge/tool-records/` and is pinned by
   `packages/cli/src/bridge/server/mcp-contract.ts` (**9** tools, **30**
   operations today).
2. **Programmatic** — import a factory and register the handlers with any agent
   framework (the playground does this with `@inbrowser/agent`).

## The MCP surface

A tool is named for a service and, where one applies, an artifact. Its input
schema carries a required `op` field whose enum lists the tool's operations;
the remaining properties are the union of the operations' fields, and the tool
description lists every operation with its fields. The bridge validates each
call against the schema of the operation it names. A call with an unknown
`op`, or with fields the operation does not accept, returns a structured error
naming the valid operations and the fields of the attempted one.

| Tool | Operations | Runs | Handlers |
|---|---|---|---|
| `firestore_simulator` | `create`, `execute`, `read`, `batch`, `add`, `undo`, `redo`, `events`, `transaction` | in the connected sandbox | `createFirestoreSimulatorTools` (`pyric/rules`) |
| `firestore_data` | `get`, `list`, `set`, `add`, `update`, `delete`, `batch_write`, `query` | in the connected sandbox | `createFirestoreDataTools` (`pyric/firestore`) |
| `sandbox` | `inspect` | in the connected sandbox | `createFirestoreInspectTools` (`pyric/firestore`) |
| `database_data` | `crawl` | in the connected sandbox | `createRtdbInspectionTools` (`@pyric/cli`) |
| `database_rules` | `simulate` | in the connected sandbox | `createRtdbInspectionTools` (`@pyric/cli`) |
| `firestore_rules` | `lint`, `simulate`, `resolve`, `test` | in the MCP process | `createFirestoreRulesTools` (`pyric/rules/internal/node`) |
| `rules_stdlib` | `list`, `get` | in the MCP process | `createFirestoreRulesStdlibTools` (`pyric/rules`) |
| `storage_rules` | `resolve` | in the MCP process | `createFirestoreRulesStdlibTools` (`pyric/rules`) |
| `pyric` | `can_i_use`, `verify`, `verify_cases` | in the MCP process | `createConformanceTools` (`@pyric/cli`), `createVerifyTools` (`@pyric/cli`) |

`firestore_data` shares one `as` field across its operations: omitted or
`'admin'` bypasses rules for seeding; `{ uid, claims? }` runs the operation as
that user with rules enforced.

`rules_stdlib` takes `service` (`firestore` or `storage`) on both operations.
`firestore_rules.resolve` and `storage_rules.resolve` pin the service of the
neutral resolver, so the source must declare `service cloud.firestore` or
`service firebase.storage` respectively.

The default bridge registers the local rules operations **without** the hosted
Rules Test API (no `ProjectScope`). Prefer `pyric verify --engine
rules-test-api|both` for hosted verification.

## Handlers behind the surface

Handler names are the factories' own and stay stable across the fold; the
records map each operation to one handler.

### Firestore data — `createFirestoreDataTools` / `createFirestoreInspectTools` (`pyric/firestore`)

`firestore_get_document` · `firestore_list_documents` ·
`firestore_create_document` · `firestore_add_document` ·
`firestore_update_document` · `firestore_delete_document` ·
`firestore_batch_write` · `firestore_query_where` · `sandbox_inspect`

### Security Rules — `createFirestoreRulesTools` / `createFirestoreRulesStdlibTools` (`pyric/rules`, Node-only pieces under `pyric/rules/internal/node`)

`firestore_lint_rules` · `firestore_simulate_rules` · `rules_stdlib_list` ·
`rules_stdlib_get` · `rules_resolve_modules` (`2+modules` → plain v2) ·
`firestore_test_rules` (live Rules Test API — only when a `ProjectScope` is
supplied; build one with `@pyric/cli/credentials/node`)

The Firestore-only `firestore_rules_stdlib_list`, `firestore_rules_stdlib_get`,
and `firestore_resolve_modules` handlers remain in the factory for the
playground registry and are not mapped by any record.

### Session verification — `createVerifyTools` (`@pyric/cli`)

`pyric_verify_fixture` · `pyric_derive_rules_test_cases`

`pyric.verify` replays a captured sandbox session against candidate Firestore
or RTDB rules. It uses local sandbox replay by default; the Firestore-only
`rulesTestApi` engine requires a resolved `ProjectScope`. `pyric.verify_cases`
derives Rules Test API cases from that same session; it is inspection-only
and never calls Firebase.

### Firestore simulator session — `createFirestoreSimulatorTools` (`pyric/rules`)

`firestore_simulator_create` · `firestore_simulator_execute` ·
`firestore_simulator_read` · `firestore_simulator_batch` ·
`firestore_simulator_transaction` · `firestore_simulator_undo` ·
`firestore_simulator_redo` · `firestore_simulator_events` ·
`firestore_create_with_auto_id`

### Realtime Database sandbox inspection — `createRtdbInspectionTools` (`@pyric/cli`)

`rtdb_simulate_access` · `rtdb_crawl_structure`

Simulation reads the currently installed rules and data on every call;
crawling returns a bounded structural view without leaf values. Neither
contacts a production database or requires a rules-loading call first.

## Library-only tools

### Index extraction — `pyric/rules/indexes`

`firestore_extract_indexes` — derive composite-index definitions from query
shapes. Available as a library and via `pyric firestore indexes generate`;
**not** registered on the default MCP bridge.

### Realtime Database rule artifacts — `@pyric/cli`

Local compilation of a constraints module to `database.rules.json` data. It
does not fetch or deploy production rules.

`rtdb_generate_rules` — library / CLI (`pyric database rules generate`);
**not** on the default MCP bridge.

### Storage control plane — `createStorageAdminTools` (`pyric/storage`)

`storage_get_status` · `storage_provision`

Library surface for provisioning / status. **Not** on the default MCP bridge.
Ship Storage rules and buckets with `firebase-tools` / Console for production.

### Discovery — `createFirestoreDiscoverTools` (`@pyric/cli/discover`)

Credential-free crawl helpers for agents that compose their own registry and
provide the data source:

`firestore_discover_paths` · `firestore_find_collection_group`

These exist in `@pyric/cli/discover` but are **not** registered on the default
`pyric bridge` / `pyric sandbox --bridge` surface.

### Assurance — `createAssuranceTools` (`@pyric/cli/assurance`)

Available for applications that compose their own tool registry, but **not**
registered on the default `pyric bridge` / `pyric sandbox --bridge` surface:

`firebase_assurance_attach` · `firebase_assurance_start` ·
`firebase_assurance_map` · `firebase_assurance_define` ·
`firebase_assurance_propose` · `firebase_assurance_run` ·
`firebase_assurance_inspect` · `firebase_assurance_minimize` ·
`firebase_assurance_verify` · `firebase_assurance_export`

---

**Default MCP bridge: 9 tools, 30 operations** (see `DEFAULT_MCP_TOOL_OPS` in
`mcp-contract.ts`). Production shipping (rules, indexes, hosting, functions) is
owned by `firebase-tools` or the Firebase Console.
