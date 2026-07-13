# Agent tool inventory

Every agent-callable tool in this repo, **sourced**. Tools are plain
`ToolHandler` objects produced by per-package factories — you compose them
into whatever runtime you use. They reach an agent two ways:

1. **`pyric dev --bridge`** (or `pyric bridge`) — exposes the registry over
   MCP; the [Claude Code plugin](../pyric-plugin/README.md) auto-wires it.
2. **Programmatic** — import a factory and register the handlers with any agent
   framework (the playground does this with `@inbrowser/agent`), or compose the
   prod registry via `composeMcpRegistry` (`pyric-tools/registry`).

Counts and names below are generated from the factory sources (grep
`name: '…'` under each file). If this table disagrees with the code, the code
wins — update this file.

## Firestore data — `createFirestoreDataTools` / `createFirestoreInspectTools` (`pyric/firestore`)

CRUD + queries against the sandbox or prod backend (whichever the handle
carries), plus sandbox inspection.

`firestore_get_document` · `firestore_list_documents` ·
`firestore_create_document` · `firestore_update_document` ·
`firestore_delete_document` · `firestore_query_where` ·
`sandbox_inspect`

## Firestore rules — `createFirestoreRulesTools` / `createFirestoreRulesStdlibTools` (`pyric/rules`, Node-only pieces under `pyric/rules/node`)

The differentiator surface: lint, simulate, and test rules **locally, as a
library** — no emulator, no deploy.

`firestore_lint_rules` · `firestore_simulate_rules` · `firestore_test_rules`
(live Rules Test API) · `firestore_resolve_modules` (`2+modules` →
plain v2) · `firestore_rules_stdlib_list` · `firestore_rules_stdlib_get`

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

## Index extraction — `pyric/rules/indexes`

`firestore_extract_indexes` — derive composite-index definitions from query
shapes.

## Realtime Database rule artifacts — `@pyric/cli`

Local compilation of a constraints module to `database.rules.json` data. It
does not fetch or deploy production rules.

`rtdb_generate_rules`

## Storage control plane — `createStorageAdminTools` (`pyric/storage`)

`storage_get_status` · `storage_provision`

## Deploy — `createFirestoreDeployTools` / `createRtdbDeployTools` / `createHostingDeployTools` / `createFunctionsDeployTools` (`pyric-tools/deploy`)

The Firebase control plane over REST — no `firebase-tools` CLI required.
Docs: [`packages/cli/docs/deploy/`](../packages/cli/docs/deploy/README.md).

`firestore_get_rules` · `firestore_deploy_rules` · `firestore_ensure_rules` ·
`firestore_provision_database` · `firestore_deploy_indexes` ·
`firestore_create_index` · `firestore_get_index_status` ·
`rtdb_get_rules` · `rtdb_deploy_rules` ·
`hosting_deploy` · `hosting_ensure_site` ·
`functions_deploy`

## Discovery — `createFirestoreDiscoverTools` (`pyric-tools/discover`)

`firestore_discover_paths` · `firestore_find_collection_group`

## Auth configuration — `createAuthAdminTools` (`pyric-tools/auth`)

Identity Toolkit project configuration.

`auth_get_config` · `auth_configure_provider` · `auth_manage_domains`

---

**Total: 51 unique tool names.** There are 53 factory entries when counting the
scope-based `createRtdbDeployTools` `rtdb_get_rules` / `rtdb_deploy_rules`
handlers separately from the host-backed RTDB rules factory. Removed since the
legacy project-level SDK:
`firebase_get_project`, `firebase_get_client_config` (died with that
package; project overview is now `sandbox_inspect` +
`firestore_discover_paths` + `auth_get_config` composed).
