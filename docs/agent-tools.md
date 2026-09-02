# Agent tool inventory

Every agent-callable tool in this repo, **sourced**. Handlers are plain
`ToolHandler` objects produced by per-package factories — you compose them
into whatever runtime you use. They reach an agent two ways:

1. **`pyric sandbox --bridge`** (or `pyric bridge`) exposes the **default MCP
   surface**; the [Pyric agent plugin](../pyric-plugin/README.md) auto-wires
   it. Each MCP tool is one record under
   `packages/cli/src/bridge/tool-records/` and is pinned by
   `packages/cli/src/bridge/server/mcp-contract.ts` (**12** tools, **59**
   operations today: 42 forwarded to the connected sandbox, 17 in the MCP
   process).
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

The generated MCP tool reference (`packages/cli/scripts/generate-tool-reference.ts`
→ `packages/site-docs/src/content/reference/mcp-tools.md`, not committed —
built by the `packages/cli` prebuild) lists every tool, operation, transport,
and field; it cannot drift from `DEFAULT_MCP_TOOL_OPS`. `database_rules`
appears there with two transports because transport is a property of each
operation: `simulate` is forwarded to the sandbox, and `lint`, `validate`, and
`generate` run in the MCP process.

`firestore_data`, `database_data`, and `storage_data` share one `as` field
across their operations: omitted or `'admin'` bypasses rules for seeding;
`{ uid, claims? }` runs the operation as that user with rules enforced.

`rules_stdlib` takes `service` (`firestore` or `storage`) on both operations.
`firestore_rules.resolve` and `storage_rules.resolve` pin the service of the
neutral resolver, so the source must declare `service cloud.firestore` or
`service firebase.storage` respectively.

The bridge resolves project credentials once at startup
(`packages/cli/src/bridge/server/scope.ts`). When none resolve,
`firestore_rules.test` and the `rulesTestApi` engine of `pyric.verify` stay in
the manifest and return their credentials error on use, so the tool list is
the same with or without a project. `pyric verify --engine
rules-test-api|both` is the CLI route to the same hosted verification.

## Handlers behind the surface

Handler names are the factories' own and stay stable across the fold; the
records map each operation to one handler.

### Firestore data — `createFirestoreDataTools` / `createFirestoreInspectTools` (`pyric/firestore`)

`firestore_get_document` · `firestore_list_documents` ·
`firestore_create_document` · `firestore_add_document` ·
`firestore_update_document` · `firestore_delete_document` ·
`firestore_batch_write` · `firestore_query_where` · `sandbox_inspect`

### Sandbox snapshot — `createSandboxSnapshotTools` (`@pyric/cli`)

`sandbox_snapshot`

`sandbox.snapshot` promotes the connected sandbox's live Firestore documents
and Auth users to the document `pyric snapshot` writes and `pyric sandbox
--seed` re-serves. Passwords are redacted unless `includePasswords` is set.

### Security Rules — `createFirestoreRulesTools` (`pyric/rules/internal/node`)

`firestore_lint_rules` · `firestore_simulate_rules` ·
`firestore_validate_rules` · `rules_stdlib_list` · `rules_stdlib_get` ·
`rules_resolve_modules` (`2+modules` → plain v2) · `firestore_test_rules`
(live Rules Test API; returns the credentials error when the factory has no
`ProjectScope`, which the bridge supplies from its startup resolution)

`firestore_rules.validate` parses the source and runs the structural
validator, which reports security findings (open reads or writes, missing
auth checks) and semantic findings (undefined functions, wrong arity) with a
severity. `firestore_rules.lint` checks syntax, budgets, and smells.

The Firestore-only `firestore_rules_stdlib_list`, `firestore_rules_stdlib_get`,
and `firestore_resolve_modules` handlers remain in the factory for the
playground registry and are not mapped by any record.

### Firestore indexes — `createFirestoreIndexesTools` (`pyric/rules/internal/node`)

`firestore_extract_indexes`

`firestore_indexes.generate` statically extracts composite-index requirements
from query source, given inline `files` or on-disk `paths`, and returns a
`firestore.indexes.json`-shaped config; `out` also writes it to disk. The same
extraction backs `pyric firestore indexes generate`.

### Cloud Storage rules — `createStorageRulesTools` (`pyric/storage`)

`storage_lint_rules` · `storage_simulate_rules`

`storage_rules.lint` parses a Cloud Storage Security Rules source and reports
whether it compiles. `storage_rules.simulate` evaluates one request (`auth`,
`method`, `path`, and on writes `resource`) against a source and reports the
verdict and its reason. Both are pure-local: no bucket, project, or network.
`firestore.get()` and `firestore.exists()` lookups are unsupported in the
simulation and deny with a reason.

### Cloud Storage data — `createStorageDataTools` (`pyric/storage`)

`storage_upload_object` · `storage_download_object` · `storage_list_objects` ·
`storage_object_metadata` · `storage_delete_object`

Uploads are capped at 1 MiB decoded; downloads return a 64 KiB preview unless
`full` is set. `list` is non-recursive. `metadata` reads, or merges
client-settable fields when `set` is supplied.

### Realtime Database data — `createDatabaseDataTools` (`pyric/database`)

`database_get` · `database_set` · `database_update` · `database_remove` ·
`database_push` · `database_transaction` · `database_query` · `database_seed`

Write values pass through unchanged, so the `{ ".sv": "timestamp" }` and
`{ ".sv": { "increment": n } }` sentinels resolve at the sandbox write
boundary. `transaction` is a compare-and-set: with `expect` it writes only when
the current value matches, otherwise it reports `committed: false` with the
current value.

### Realtime Database sandbox inspection — `createRtdbInspectionTools` (`@pyric/cli`)

`rtdb_simulate_access` · `rtdb_crawl_structure`

Simulation reads the currently installed rules and data on every call, or
evaluates a supplied `rules` document against the same data; crawling returns
a bounded structural view without leaf values. Neither contacts a production
database or requires a rules-loading call first.

### Realtime Database rules source — `createRtdbRulesTools` (`@pyric/cli`)

`rtdb_lint_rules` · `rtdb_validate_rules` · `rtdb_generate_rules`

`database_rules.lint` and `database_rules.validate` compile every `.read`,
`.write`, and `.validate` expression of a rules document with the engine the
CLI commands use and report warnings or errors keyed by path and rule.
`database_rules.generate` compiles a local constraints module (a file that
calls `defineRtdbRules`) into `database.rules.json` data, the same output as
`pyric database rules generate`. None of the three fetches or deploys
production rules.

### Auth users — `createAuthUserTools` (`pyric/auth`)

`auth_create_user` · `auth_import_users` · `auth_get_user` · `auth_list_users`
· `auth_update_user` · `auth_delete_user` · `auth_set_claims` ·
`auth_custom_token`

Users land in the one user pool the application, Studio, and rules evaluation
share. Passwords are accepted on create, import, and update and never
returned. Claims are custom claims and reach rules as
`request.auth.token.<name>` on the next sign-in or token refresh.
`auth_users.custom_token` mints the token the sandbox's
`signInWithCustomToken` accepts. Sandbox auth failures return `ok: false` with
`data.code` set to the Firebase error code.

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

## Library-only tools

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

**Default MCP bridge: 12 tools, 59 operations** (see `DEFAULT_MCP_TOOL_OPS` in
`mcp-contract.ts`). Production shipping (rules, indexes, hosting, functions) is
owned by `firebase-tools` or the Firebase Console.
