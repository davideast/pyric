# 0012: One naming grammar for CLI commands and MCP tools

Status: Accepted

Date: 2026-09-02

## Context

Pyric exposes the same operations on two surfaces. The CLI speaks one
service-first grammar, `pyric <service> <artifact> <operation>`, and already
declares each command as one record under
`packages/cli/src/cli/service-command-records/`, where the filename is the path
joined with hyphens and a generated manifest computes the registry. The MCP
bridge exposes 29 tools whose names were chosen one family at a time, with no
grammar behind them:

- The Firestore data plane is verb-first (`firestore_get_document`,
  `firestore_query_where`) while the rules family is artifact-first in some
  names (`firestore_rules_stdlib_get`) and verb-first in others
  (`firestore_lint_rules`, `firestore_simulate_rules`).
- One simulator tool, `firestore_create_with_auto_id`, carries no family word
  at all although it belongs to the simulator family.
- Realtime Database tools say `rtdb` where the CLI says `database`.
- The shared rules standard library is exposed twice, once as
  `rules_stdlib_list` and `rules_stdlib_get` and again as the Firestore-only
  spellings `firestore_rules_stdlib_list` and `firestore_rules_stdlib_get`.
- `rtdb_simulate_access` and `firestore_simulate_rules` name the same operation
  as `pyric database rules simulate` and `pyric firestore rules simulate` yet
  share no words with those commands.
- The unregistered handlers that exist in source but are not on the bridge
  contract use a third vocabulary: `firebase_assurance_run`, `storage_get_status`,
  `pyric_verify_fixture`, and the Playground's verb-first names such as
  `inspect_auth_users` and `try_rules_edit`.

A name currently also encodes, by convention only, where a tool runs. The
contract file splits the list into "forwarded to the browser sandbox" and
"in-process in Node", and readers infer the transport from the family. Nothing
in the name says so, and the split is a property of how the bridge dispatches,
not of what the tool does.

The consequence is that an agent that knows the CLI cannot predict a tool name,
a tool name cannot be turned back into a command, and adding a tool means
choosing a name by analogy with whichever family the author last read. The
actuation harmony plan needs both surfaces to derive from one declaration so
that a record can be added once and appear on the CLI, the bridge, and the
Playground without three hand-maintained lists. That derivation needs a
grammar first.

## Decisions

1. **One grammar, service first.** Every operation has a path of words:
   a service word, an optional artifact word, and an operation word. The CLI
   spells the path with spaces, `pyric firestore rules lint`. The MCP bridge
   exposes one tool per service and artifact, named by joining those two words
   with an underscore, `firestore_rules`, or by the service word alone when
   there is no artifact, `sandbox`. The operation word is the value of a
   required `op` field on the call, `lint`. Hyphens inside a CLI word become
   underscores in the tool name or the op value, so `can-i-use` becomes the op
   `can_i_use` and a future `batch-write` becomes `batch_write`. The record
   stores the path as an array of words. Tool names and op values are derived
   from it and never parsed back, which is why a compound operation word such
   as `batch_write` is allowed: it is one word in the record even though it
   contains an underscore.

2. **The binary name is the service word for general commands.** Commands
   that are not service-first, `pyric verify`, `pyric verify cases`, and
   `pyric can-i-use`, take `pyric` as their service word on the bridge: the
   tool `pyric` with ops `verify`, `verify_cases`, and `can_i_use`. The `pyric`
   word is therefore reserved for operations about Pyric itself or that span
   more than one Firebase service. Nothing else may use it.

3. **The artifact word is omitted when the subject is the service itself.**
   The tool `sandbox` with op `inspect` inspects the sandbox; the tool `pyric`
   with op `verify` verifies a session. A tool named by a service word alone
   is the grammar applied to a whole service, not an exception to it.

4. **The service word set is closed and matches the CLI.** The service words
   are `firestore`, `database`, `storage`, `auth`, `rules`, `sandbox`, and
   `pyric`. `rtdb` and `firebase` are not service words. Realtime Database is
   `database` because the CLI, the `pyric/database` package subpath, and the
   `database` key in `firebase.json` already say so; `rtdb` survives only as a
   parameter value where a record needs to enumerate services. Adding a
   service word is a decision recorded here, not a local choice.

5. **Transport is a property of the operation, never part of the name.** Each
   op in a record declares `transport: 'forwarded' | 'in-process'`. The bridge
   reads the property to decide whether to relay the call to the browser peer
   or execute it in Node, so one tool may hold ops of both transports. Two ops
   with the same words on different backends share a name and differ in the
   handle they bind, which is the arrangement ADR-0011 already adopted for the
   worker transport. No name says `sandbox_` to mean "runs in the browser" and
   no name says `local_` to mean "runs in Node".

6. **Every tool is declared once as a record; both surfaces derive from it.**
   One file per tool, the filename is the tool name, and the record enumerates
   the tool's ops, each with its transport, its input schema, and the handler
   that implements it. A generated manifest that names its generator computes
   the registry. The MCP tool list, the CLI dispatch table, and the Playground
   registry are three views of the same records. Which records a given surface
   exposes remains an exposure decision recorded in the tool-parity
   annotations; the grammar settles only what a record is called.

7. **This ADR moves words; it changes one.** Operation words are kept wherever
   a current name already has one, so `firestore_get_document` becomes
   `firestore_data` with op `get`. The one exception is the set-document
   operation: `firestore_create_document` becomes op `set`, because the op
   mirrors `setDoc` and an op value inside one tool's enum can carry the
   operation's real meaning where a flat tool name could not. Every other new
   word is chosen only where a name had no artifact or the wrong one.
   Renaming any other operation word is a change of meaning and belongs to a
   later decision with its own characterisation tests.

## Resolutions

Each entry below records a ruling made against the open questions and the
further decisions the fold required to state precisely. The rejected
alternative is kept to one sentence.

### 1. The service word grammar is confirmed as closed

Every operation keeps the service, optional artifact, operation path from
Decision 1. The CLI spells it with spaces. The service word set is closed to
`firestore`, `database`, `storage`, `auth`, `rules`, `sandbox`, `pyric`;
`rtdb` and `firebase` remain excluded. This is Decision 4 restated because
every other ruling below builds its tool names from this set.

Alternative: leave the set open and let each new family add its own word;
rejected because an open set is exactly the drift the grammar exists to close.

### 2. MCP exposure folds operations into one tool per service and artifact

A tool is named `service_artifact`, for example `firestore_data`, or by the
service alone when there is no artifact, for example `sandbox`. The operation
becomes a required `op` field whose schema is an enum of the tool's
operations rather than a name segment. The tool description lists each op
with its fields. A call with an unknown op, or valid op with invalid fields,
returns an error naming the valid ops and the fields for the attempted op.

Records move from one file per operation to one file per tool, with the ops
enumerated inside; each op declares its own transport, forwarded to the
browser sandbox or in-process in Node, and the bridge routes each call by its
op. Per-op transport within one tool is therefore allowed and expected — a
folded tool is not required to run entirely on one side. The CLI is
unchanged: `pyric <service> <artifact> <op>` still resolves one command to
one operation; folding is an MCP exposure decision, not a grammar change.

Alternative: keep one MCP tool per operation, giving the bridge a literal
name for each of the twenty-eight-odd operations the unfolded proposal
produced; rejected because it leaves an agent scanning nearly thirty flat
names instead of twelve tools with self-describing schemas, and it does not
shrink the list as new operations are added.

### 3. `rules` stands as a service for the shared standard library only

Tool `rules_stdlib` with ops `list` and `get`. Its description opens with
"Firebase Security Rules standard library for Firestore and Cloud Storage" so
an agent scanning for a service finds it without already knowing it is
cross-service. The Firestore-only twins, `firestore_rules_stdlib_list` and
`firestore_rules_stdlib_get`, are deleted. Module resolution is per service
rather than shared: op `resolve` on `firestore_rules` and op `resolve` on
`storage_rules`, not a third cross-service tool.

Alternative: prefix every shared tool with a service, giving
`firestore_rules_stdlib_get` and a `storage_` twin; rejected because it
duplicates one catalogue as two tools per module, which is the duplication
the alpha policy removes elsewhere.

### 4. The Firestore data tool is `firestore_data`, and `set` replaces `create`

Ops: `get`, `list`, `set`, `add`, `update`, `delete`, `batch_write`, `query`,
with a common `as` field naming a user identity with claims, or admin. `set`
replaces the proposal's `create` because it has set-document semantics and an
op name is not a tool name, so Decision 7's "keep operation words" does not
bind it once the operation lives inside a tool's enum rather than as its own
name. The simulator keeps its own tool, `firestore_simulator`, with ops
`create`, `execute`, `read`, `batch`, `add`, `undo`, `redo`, `events`,
`transaction`.

Alternative: keep `create`, following Decision 7 literally; rejected because
that rule protects the tool and artifact words agents key off, not every
verb inside one tool's operation enum, and `set` names the operation's actual
semantics.

### 5. Realtime Database takes the CLI's word `database`

Tool `database_data` with ops `get`, `set`, `update`, `remove`, `push`,
`transaction`, `query`, `seed`, `crawl`, a common `as` field, and the
`serverTimestamp` and `increment` sentinels accepted by `set`, `update`, and
`push`. Tool `database_rules` with ops `lint`, `validate`, `simulate`,
`generate`. `simulate` is forwarded: with `rules` omitted it evaluates against
the connected sandbox's live rules; with `rules` supplied it evaluates that
document in the same sandbox, against the sandbox's data, so one op keeps one
transport and its input selects only which rules are read.

Alternative: keep `rtdb` as the tool prefix to match the current bridge
vocabulary; rejected because the CLI, the package subpath, and
`firebase.json` all already say `database`, and Decision 4 settled this.

### 6. `sandbox` and `pyric` keep their proposed homes

Tool `sandbox` with ops `inspect` and `snapshot`. `pyric` is reserved for
operations about Pyric itself or spanning services: tool `pyric` with ops
`can_i_use`, `verify`, `verify_cases`.

Alternative: fold the sandbox ops under `pyric`, giving `pyric_sandbox_*`;
rejected because the sandbox is a real family with its own backend, and
folding it into `pyric` would make that word grow with every sandbox
operation until it no longer means "about Pyric itself".

### 7. The remaining tool boundaries are fixed

`firestore_rules` with ops `lint`, `validate`, `simulate`, `resolve`, `test`
(`test` only when project credentials resolve). `firestore_indexes` with op
`generate`. `storage_rules` with ops `lint`, `simulate`, `resolve`.
`storage_data` with ops `upload`, `download`, `list`, `metadata`, `delete`.
`auth_users` with ops `create`, `import`, `get`, `list`, `update`, `delete`,
`set_claims`, `custom_token`.

Alternative: fold Storage and Auth into fewer, broader tools alongside
Firestore's; rejected because each service's operations share no schema, and
one tool per service and artifact keeps a tool's op enum a coherent family.

### 8. Old names are deleted in the same change that introduces the fold

Alpha policy applies: no aliases, no compatibility spellings. The bridge
contract becomes twelve tools.

Alternative: keep the unfolded names resolving alongside the folded ones for
one release; rejected under the standing alpha policy against deprecation
shims.

### 9. The contract test becomes a tool-to-ops map

The pinned contract test moves from a flat list of tool names to a
hand-written map of each tool name to its ops, and stays the deliberate gate
a new tool or op must edit. The drift test keys on tool names and, wherever a
document writes one, on `tool.op` references, rather than on flat operation
names.

Alternative: keep the flat pinned list and add a second list for ops;
rejected because two lists reintroduce the lockstep the fold is meant to
remove.

## Fold table

One row per operation. Transport is in-process or forwarded, or both where an
op's input selects it. Source is the current registered name the operation
replaces, `unregistered: <name>` for a handler that exists in source but was
never on the bridge contract, or `new` for capability being added.

| Tool | Op | Transport | Source |
| --- | --- | --- | --- |
| `firestore_data` | `get` | forwarded | `firestore_get_document` |
| `firestore_data` | `list` | forwarded | `firestore_list_documents` |
| `firestore_data` | `set` | forwarded | `firestore_create_document` |
| `firestore_data` | `add` | forwarded | `firestore_add_document` |
| `firestore_data` | `update` | forwarded | `firestore_update_document` |
| `firestore_data` | `delete` | forwarded | `firestore_delete_document` |
| `firestore_data` | `batch_write` | forwarded | `firestore_batch_write` |
| `firestore_data` | `query` | forwarded | `firestore_query_where` |
| `firestore_simulator` | `create` | forwarded | `firestore_simulator_create` |
| `firestore_simulator` | `execute` | forwarded | `firestore_simulator_execute` |
| `firestore_simulator` | `read` | forwarded | `firestore_simulator_read` |
| `firestore_simulator` | `batch` | forwarded | `firestore_simulator_batch` |
| `firestore_simulator` | `add` | forwarded | `firestore_create_with_auto_id` |
| `firestore_simulator` | `undo` | forwarded | `firestore_simulator_undo` |
| `firestore_simulator` | `redo` | forwarded | `firestore_simulator_redo` |
| `firestore_simulator` | `events` | forwarded | `firestore_simulator_events` |
| `firestore_simulator` | `transaction` | forwarded | `firestore_simulator_transaction` |
| `firestore_rules` | `lint` | in-process | `firestore_lint_rules` |
| `firestore_rules` | `simulate` | in-process | `firestore_simulate_rules` |
| `firestore_rules` | `resolve` | in-process | `firestore_resolve_modules`; the Firestore half of `rules_resolve_modules` |
| `firestore_rules` | `validate` | in-process | new (CLI has it) |
| `firestore_rules` | `test` | in-process | unregistered: `firestore_test_rules` |
| `firestore_indexes` | `generate` | in-process | unregistered: `firestore_extract_indexes` (CLI `firestore indexes generate`) |
| `rules_stdlib` | `list` | in-process | `rules_stdlib_list` (`firestore_rules_stdlib_list` deleted) |
| `rules_stdlib` | `get` | in-process | `rules_stdlib_get` (`firestore_rules_stdlib_get` deleted) |
| `database_data` | `crawl` | forwarded | `rtdb_crawl_structure` |
| `database_data` | `get` | forwarded | new |
| `database_data` | `set` | forwarded | new |
| `database_data` | `update` | forwarded | new |
| `database_data` | `remove` | forwarded | new |
| `database_data` | `push` | forwarded | new |
| `database_data` | `transaction` | forwarded | new |
| `database_data` | `query` | forwarded | new |
| `database_data` | `seed` | forwarded | new |
| `database_rules` | `simulate` | forwarded; evaluates the sandbox's live rules, or a supplied `rules` document, in the sandbox | `rtdb_simulate_access` (omitted); new (supplied) |
| `database_rules` | `lint` | in-process | new |
| `database_rules` | `validate` | in-process | new |
| `database_rules` | `generate` | in-process | unregistered: `rtdb_generate_rules` |
| `storage_rules` | `lint` | in-process | new |
| `storage_rules` | `simulate` | in-process | new |
| `storage_rules` | `resolve` | in-process | the Storage half of `rules_resolve_modules` |
| `storage_data` | `upload` | forwarded | new |
| `storage_data` | `download` | forwarded | new |
| `storage_data` | `list` | forwarded | new |
| `storage_data` | `metadata` | forwarded | new |
| `storage_data` | `delete` | forwarded | new |
| `auth_users` | `create` | forwarded | new |
| `auth_users` | `import` | forwarded | new |
| `auth_users` | `get` | forwarded | new |
| `auth_users` | `list` | forwarded | new |
| `auth_users` | `update` | forwarded | new |
| `auth_users` | `delete` | forwarded | new |
| `auth_users` | `set_claims` | forwarded | new |
| `auth_users` | `custom_token` | forwarded | new |
| `sandbox` | `inspect` | forwarded | `sandbox_inspect` |
| `sandbox` | `snapshot` | forwarded | new |
| `pyric` | `can_i_use` | in-process | `pyric_can_i_use` |
| `pyric` | `verify` | in-process | unregistered: `pyric_verify_fixture` |
| `pyric` | `verify_cases` | in-process | unregistered: `pyric_derive_rules_test_cases` |

Twelve tools carry fifty-nine operations. The Playground's own handlers take
the same grammar as these records once it registers them under the fold; they
are not counted here because the Playground's exposure of a record remains
its own decision under Decision 6. The assurance family also maps under
`pyric` once it is registered — a single `pyric_assurance` tool with ops
`attach`, `start`, `map`, `define`, `propose`, `run`, `inspect`, `minimize`,
`verify`, `export` — and is likewise left out of this table until that
registration happens.

## Consequences

- The bridge contract's target is twelve tools in place of the original
  twenty-nine, folding fifty-nine operations behind them. Phase 1b landed
  nine of those tools, carrying thirty operations; `firestore_indexes`,
  `storage_data`, `auth_users`, and `pyric_assurance` remain to land in later
  lanes. Old names are deleted, not aliased: the alpha policy admits no
  compatibility spellings, so a flat name such as `firestore_get_document`
  stops resolving on the day `firestore_data` with `op: 'get'` starts, in the
  same change.
- The pinned contract test moves from a flat list of names to a hand-written
  map of each tool to its ops. It stays the deliberate gate: a new tool or a
  new op on an existing tool edits this map, and the test fails the change if
  it does not.
- The name drift test keys on tool names and, wherever a document writes one,
  on `tool.op` references, rather than on twenty-nine independent flat names.
  The plugin skills and agent, the agent tool inventory, the site's agent
  pages, the CLI README, and the release-contract fixture are each updated in
  the change that folds a family, and the test fails the change if one is
  missed.
- Transport is a property of each op rather than of the tool or the name. A
  single folded tool may carry ops with different transports — `database_rules`
  forwards `simulate` and runs `lint`, `validate`, and `generate` in-process —
  and the bridge routes each call by reading the op's declared transport, not
  by which tool the call arrived on.
- Records move from one file per operation to one file per tool, with the
  ops enumerated inside; the MCP tool list, the CLI dispatch table, and the
  Playground registry stay three views of the same records, now folded on
  the MCP side.
- A future tool is named by writing its service and, where the subject is
  not the whole service, its artifact; a new operation is added to that
  tool's op enum rather than becoming a new tool name. A name that cannot be
  written as `service` or `service_artifact` from the closed service set is a
  signal that the tool's home has not been decided, and that decision
  precedes the record.
- The CLI contract does not change. No command is added, moved, or renamed by
  this decision; `pyric <service> <artifact> <op>` remains the fixed side of
  the derivation, and folding is an MCP exposure decision layered on top of
  it.

## Credential resolution at bridge startup

Recorded as context for a later lane, not as part of this decision. The
bridge will need to hand a `ProjectScope` to in-process tools that call
Google's Rules Test API, and a scout of the CLI found the entry point already
shaped for it.

`resolveScope(options)` in `packages/cli/src/cli/scope.ts` returns
`{ scope: ProjectScope, source }` and is the single entry point. It resolves,
in order: `FIREBASE_SA_BASE64`; then `GOOGLE_APPLICATION_CREDENTIALS` read
from disk; then Application Default Credentials from the gcloud configuration
directory, attempted only when a project id is present from `--project` or
`PYRIC_PROJECT`; otherwise it throws. `--project` and `PYRIC_PROJECT` override
the project id found in a service account. There is no metadata-server
fallback and no interactive login anywhere in the chain.

It is startup-safe. Resolution reads and parses JSON and performs no network
call; the first token exchange happens on the first `scope.resolveToken()`
and is memoised with a per-attempt timeout and early refresh. Credential
validity is not checked at resolve time, so an invalid key fails on first use,
not at startup.

It throws rather than returning `undefined` when no source resolves, when the
credentials file is missing, when the service account JSON lacks a required
field, or when the base64 value is malformed. The bridge should therefore call
it once at startup inside a guard, treat failure as "scope unavailable" and
leave the verify tools' `scope` undefined, and let those tools surface their
existing "requires a ProjectScope" error on use. `createVerifyTools({ scope? })`
in `packages/cli/src/verify/tools.ts` is already shaped for this and no
non-test caller wires a scope today. `pyric verify` uses the same function
only when the Rules Test API engine is selected, catches the error, and exits
with code 2. The CLI usage text is the only documentation of the chain and
matches the code.
