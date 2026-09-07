# Agent tool inventory

Every agent-callable tool in this repo, **sourced**. Tools are plain
`ToolHandler` objects produced by per-package factories — you compose them
into whatever runtime you use. They reach an agent two ways:

1. **`pyric sandbox --bridge`** (or `pyric bridge`) exposes the **default sandbox
   registry** over MCP; the [Pyric agent plugin](../pyric-plugin/README.md)
   auto-wires it. Forwarded + in-process names are authored per family in
   `packages/cli/src/bridge/tool-family-records/` and pinned by
   `packages/cli/src/bridge/server/mcp-contract.ts` (**41** tools today).
2. **Programmatic** — import a factory and register the handlers with any agent
   framework (the playground does this with `@inbrowser/agent`).

Counts and names below are generated from the factory sources (grep
`name: '…'` under each file). If this table disagrees with the code, the code
wins — update this file.

## Firestore data — `createFirestoreDataTools` / `createFirestoreInspectTools` (`pyric/firestore`)

CRUD + queries against the sandbox (or whichever backend the handle carries),
plus sandbox inspection.

`firestore_get_document` · `firestore_list_documents` ·
`firestore_create_document` · `firestore_add_document` ·
`firestore_update_document` · `firestore_delete_document` ·
`firestore_batch_write` · `firestore_query_where` ·
`sandbox_inspect`

## Security Rules — `createFirestoreRulesTools` / `createFirestoreRulesStdlibTools` (`pyric/rules`, Node-only pieces under `pyric/rules/internal/node`)

The service-neutral catalog and resolver cover Firestore and Storage. Existing
Firestore-prefixed names remain compatibility aliases. Firestore lint,
simulation, and optional hosted testing remain service-specific.

`rules_stdlib_list` · `rules_stdlib_get` ·
`rules_resolve_modules` (`2+modules` → plain v2) ·
`firestore_rules_stdlib_list` · `firestore_rules_stdlib_get` ·
`firestore_resolve_modules` · `firestore_lint_rules` ·
`firestore_simulate_rules` ·
`firestore_test_rules` (live Rules Test API — only when a `ProjectScope` is
supplied; build one with `@pyric/cli/credentials/node`)

The default MCP bridge registers the local rules tools **without**
`firestore_test_rules` (no scope). Prefer `pyric verify --engine
rules-test-api|both` for hosted verification.

## Firestore simulator session — `createFirestoreSimulatorTools` (`pyric/rules`)

A stateful sandbox-backed Firestore session for agents: seed, execute,
read, batch, transact, undo/redo, inspect the event log.

`firestore_simulator_create` · `firestore_simulator_execute` ·
`firestore_simulator_read` · `firestore_simulator_batch` ·
`firestore_simulator_transaction` · `firestore_simulator_undo` ·
`firestore_simulator_redo` · `firestore_simulator_events` ·
`firestore_create_with_auto_id`

## Realtime Database sandbox inspection — `@pyric/cli` bridge

Local inspection of the RTDB state owned by the connected sandbox. Simulation
reads the currently installed rules and data on every call; crawling returns a
bounded structural view without leaf values. Neither tool contacts a production
database or requires a rules-loading tool call first.

`rtdb_simulate_access` · `rtdb_crawl_structure`

## Sandbox auth users — `createAuthUsersTools` (`@pyric/cli` bridge)

`auth_create_user` · `auth_import_users` · `auth_get_user` ·
`auth_list_users` · `auth_update_user` · `auth_delete_user` ·
`auth_set_claims` · `auth_custom_token`

These administer the one user pool the application, Studio, and rules
evaluation share, calling the same `pyric/auth` sandbox driver the served
worker's admin ops call. Creating a user does not sign anyone in, and a
password is never returned. A user created under a dotted provider id
(`google.com`, `oidc.acme`) with no password is assigned a generated
`photoUrl`; `password`, `phone`, and anonymous users keep `photoUrl` null.

## Auth identity — `createAuthIdentityTools` (`@pyric/cli` bridge)

`auth_impersonate` · `auth_reset` · `auth_whoami` · `auth_sessions`

`auth_impersonate` takes exactly one of `uid` (with optional `tenant` and
`claims`), `admin: true`, or `anonymous: true`. `auth_reset` returns to the
application session. Both take an optional `target`; `auth_sessions` reports
the target id, platform, and current identity of every client connected to the
bridge, and `auth_whoami` reports the identity the bridge holds for you.

With a `target`, the bridge stores the identity on that client's registry entry
and pushes it as an event, and that client's SDK stamps it on the operations it
then issues. With no `target`, the bridge records the identity for you.

With no `target`, the recorded identity governs the tool calls you then
forward: the bridge puts it on the `tool-call` frame and the page dispatcher
binds the Firestore data tools to it, so `firestore_get_document` and the rest
of that family run with Security Rules enforced as that user. `admin` bypasses
rules. A call that passes its own `as` argument uses that instead, and leaves
the recorded identity in place. `sandbox_inspect`, the rules simulator, the
Realtime Database inspectors, and the auth user-administration tools take no
identity and keep bypassing rules.

**A `target` still changes nothing about your own calls.** It retargets the
named client and nothing else. Both the tool descriptions and the results say
so.

The same operations are on the CLI as `pyric auth impersonate`,
`pyric auth reset`, `pyric auth whoami`, and `pyric auth sessions`.

## Index extraction — `pyric/rules/indexes`

`firestore_extract_indexes` — derive composite-index definitions from query
shapes. Available as a library and via `pyric firestore indexes generate`;
**not** registered on the default MCP bridge.

## Realtime Database rule artifacts — `@pyric/cli`

Local compilation of a constraints module to `database.rules.json` data. It
does not fetch or deploy production rules.

`rtdb_generate_rules` — library / CLI (`pyric database rules generate`);
**not** on the default MCP bridge.

## Storage control plane — `createStorageAdminTools` (`pyric/storage`)

`storage_get_status` · `storage_provision`

Library surface for provisioning / status. **Not** on the default MCP bridge.
Ship Storage rules and buckets with `firebase-tools` / Console for production.

## Discovery — `createFirestoreDiscoverTools` (`@pyric/cli/discover`)

Credential-free crawl helpers for agents that compose their own registry and
provide the data source:

`firestore_discover_paths` · `firestore_find_collection_group`

These exist in `@pyric/cli/discover` but are **not** registered on the default
`pyric bridge` / `pyric sandbox --bridge` surface.

## Assurance — `createAssuranceTools` (`@pyric/cli/assurance`)

Available for applications that compose their own tool registry, but **not**
registered on the default `pyric bridge` / `pyric sandbox --bridge` surface:

`firebase_assurance_attach` · `firebase_assurance_start` ·
`firebase_assurance_map` · `firebase_assurance_define` ·
`firebase_assurance_propose` · `firebase_assurance_run` ·
`firebase_assurance_inspect` · `firebase_assurance_minimize` ·
`firebase_assurance_verify` · `firebase_assurance_export`

---

**Default MCP bridge: 41 unique tool names** (see `DEFAULT_MCP_TOOL_NAMES` in
`mcp-contract.ts`). Production shipping (rules, indexes, hosting, functions) is
owned by `firebase-tools` or the Firebase Console.
