# Agent tool inventory

This repo carries two MCP tool contracts, both sourced from
`packages/cli/src/bridge/server/mcp-contract.ts`.

1. **`pyric mcp`** (headless, the default): the **product surface**, six
   service tools, one per Firebase capability, rendered from the method
   records under `packages/cli/src/bridge/surface/methods/`. Every call is
   `{ method, args }`, where `method` is the SDK's own method name where the
   SDK has one, and pyric's own name where it does not. `DEFAULT_MCP_TOOL_NAMES`
   is the exact list, and it is the six tools this section documents.
2. **`pyric sandbox --bridge`** (or `pyric bridge`): the **transport
   surface** a browser sandbox peer executes, plus the rules and conformance
   tools that run in the bridge process. Its names are authored per family in
   `packages/cli/src/bridge/tool-family-records/` and pinned as
   `BRIDGE_TOOL_NAMES` (41 tools today, unchanged flat names such as
   `firestore_get_document` and `sandbox_inspect`). The
   [Pyric agent plugin](../pyric-plugin/README.md) auto-wires an agent to
   this surface when it drives `pyric sandbox --bridge` against a served
   application page.

Programmatic use (importing a factory and registering its handlers with any
agent framework, the way the playground does with `@inbrowser/agent`) reaches
the same underlying tool-family factories the transport surface composes.

## The product surface: `pyric mcp` (headless, default)

Six tools: `firestore`, `database`, `storage`, `auth`, `rules`, `sandbox`.
Every one of them answers `describe` with `args: { method }`, which returns
that method's full argument schema, an example call, and its effect class
(`read`, `write`, `destructive`, or `production`). A `destructive` call is
refused unless `args.confirm === true`. No `production` method exists yet;
when one ships, it is not mounted unless the server is started with
`--allow-production`.

| Tool | Methods |
|---|---|
| `firestore` | `getDoc`, `getDocs`, `addDoc`, `setDoc`, `updateDoc`, `deleteDoc`, `writeBatch` |
| `database` | `get`, `query`, `set`, `update`, `remove` |
| `storage` | `getBytes`, `getMetadata`, `listAll`, `uploadBytes`, `deleteObject` |
| `auth` | `getUser`, `listUsers`, `createUser`, `updateUser`, `deleteUser`, `setCustomUserClaims`, `impersonate`, `actAsAdmin`, `actAsAnonymous`, `useAppSession`, `whoami` |
| `rules` | `lint`, `simulate`, `explainDenial`, `set`, `listStdlib`, `getStdlib` |
| `sandbox` | `inspect`, `events`, `seed`, `seedFromFixture`, `exportFixture`, `reset` (destructive; requires `confirm: true`; `scope` narrows it to one service), `checkpoint`, `restore` (destructive; requires `confirm: true`), `listCheckpoints`, `fork`, `apply`, `diff`, `promote` (destructive; requires `confirm: true`), `discard`, `listBranches` |

`checkpoint` writes a named on-disk snapshot of the live sandbox under
`.pyric/state/checkpoints/`, `restore` puts one back, and `listCheckpoints`
reports what is stored. `events` pages the operation log by cursor and filters
it to denials or writes. `exportFixture` writes the live state as a fixture and
`seedFromFixture` loads one back.

The six branch methods work a Firestore change out on a copy before it reaches
the live sandbox. A branch holds Firestore documents: `fork` copies the live
Firestore documents, and the Realtime Database tree, into a named branch under
`.pyric/state/branches/<branch>/`, and Storage objects, auth users, and the
rules the live sandbox runs under are not branched. `candidateRules` gives the
branch its own rules, as Firestore rules source or a Realtime Database
`rules.json` body; they decide the verdicts of writes made on the branch and
nothing else. `apply` re-issues sandbox events onto the branch's Firestore
documents, from an `events` list or from a recorded session file named by
`sessionPath` relative to the project directory; a call that names neither, or
both, is refused. `diff` compares Firestore documents alone, against `live` by
default or against a checkpoint by name. `promote` lands the branch's Firestore
documents on live and deletes the branch; it installs no rules, so the live
sandbox keeps the rules it was running. `discard` deletes the branch and leaves
live alone. `listBranches` reports every branch with when it was forked, how
many events it carries, and how far its documents have drifted from live. A
branch is a directory in the project, so it outlives the server that forked it.

Extending branches past Firestore, so a fork carries Storage objects, auth
users, and rules, is open work.

The CLI derives `pyric <tool> <method> [--<arg> <value>...]` from the same
method records the MCP tool calls, so `pyric firestore setDoc --path
posts/p1 --data '{"a":1}'` and an MCP call with `{ method: "setDoc", args:
{ path: "posts/p1", data: { a: 1 } } }` run the identical handler against the
identical sandbox state. See `docs/decisions/0014-service-tools-with-sdk-methods.md`
for the design rationale.

Any argument may be read from a file instead of the command line, as
`--<arg>-file <path>`, and the file is read as that argument's own kind: text
for a string argument, parsed JSON for an object or array one. A relative path
resolves against the working directory.

```
pyric rules lint --service firestore --rules-file firestore.rules
pyric firestore setDoc --path posts/p1 --data-file post.json
```

The file form is derived from the argument names a record declares rather than
declared on the record, so every method has it and no method mentions it. An
argument passed both inline and from a file is refused.

## The transport surface: `pyric sandbox --bridge` / `pyric bridge`

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

`auth_reset` and `auth_sessions` are also on the CLI, as `pyric auth reset`
and `pyric auth sessions`, calling this same bridge tool because "connected
clients" is a concept only a running bridge has. `pyric auth impersonate` and
`pyric auth whoami` are a different command now: the derived service-tool
commands `auth.impersonate` and `auth.whoami` (product surface, above), which
act on this project's local `.pyric/state` and need no running bridge.

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

**Transport surface: 41 unique tool names** (see `BRIDGE_TOOL_NAMES` in
`mcp-contract.ts`). The product surface `pyric mcp` serves by default is the
six service tools documented above (`DEFAULT_MCP_TOOL_NAMES` in the same
file). Production shipping (rules, indexes, hosting, functions) is owned by
`firebase-tools` or the Firebase Console.
