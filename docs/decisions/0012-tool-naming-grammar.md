# 0012: One naming grammar for CLI commands and MCP tools

Status: Proposed

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
   spells the path with spaces, `pyric firestore rules lint`. An MCP tool name
   is the same path joined with underscores, `firestore_rules_lint`. Hyphens
   inside a CLI word become underscores in the tool name, so `can-i-use`
   becomes `can_i_use` and a future `batch-write` becomes `batch_write`. The
   record stores the path as an array of words. The flat name is derived from
   it and never parsed back, which is why a compound operation word such as
   `batch_write` is allowed: it is one word in the record even though it
   contains an underscore.

2. **The binary name is the service word for general commands.** Commands
   that are not service-first, `pyric verify`, `pyric verify cases`, and
   `pyric can-i-use`, take `pyric` as their service word on the bridge:
   `pyric_verify`, `pyric_verify_cases`, `pyric_can_i_use`. The `pyric` word is
   therefore reserved for operations about Pyric itself or that span more than
   one Firebase service. Nothing else may use it.

3. **The artifact word is omitted when the subject is the service itself.**
   `sandbox_inspect` inspects the sandbox, `storage_provision` provisions
   Storage, `pyric_verify` verifies a session. A two-word name is the grammar
   applied to a whole service, not an exception to it.

4. **The service word set is closed and matches the CLI.** The service words
   are `firestore`, `database`, `storage`, `auth`, `rules`, `sandbox`, and
   `pyric`. `rtdb` and `firebase` are not service words. Realtime Database is
   `database` because the CLI, the `pyric/database` package subpath, and the
   `database` key in `firebase.json` already say so; `rtdb` survives only as a
   parameter value where a record needs to enumerate services. Adding a
   service word is a decision recorded here, not a local choice.

5. **Transport is a property of the record, never part of the name.** A
   record declares `transport: 'forwarded' | 'in-process'` alongside its path.
   The bridge reads the property to decide whether to relay the call to the
   browser peer or execute it in Node. Two records with the same operation on
   different backends share a name and differ in the handle they bind, which
   is the arrangement ADR-0011 already adopted for the worker transport. No
   name says `sandbox_` to mean "runs in the browser" and no name says
   `local_` to mean "runs in Node".

6. **Every tool is declared once as a record; both surfaces derive from it.**
   The CLI's `ServiceCommandPath` and file-per-record layout become the shape
   for tools as well: one file per record, the filename is the path joined
   with hyphens, and a generated manifest that names its generator computes the
   registry. The MCP tool list, the CLI dispatch table, and the Playground
   registry are three views of the same records. Which records a given surface
   exposes remains an exposure decision recorded in the tool-parity
   annotations; the grammar settles only what a record is called.

7. **This ADR moves words; it does not change them.** Operation words are
   kept wherever a current name already has one. `firestore_create_document`
   becomes `firestore_documents_create`, not `firestore_documents_set`, even
   though the operation mirrors `setDoc`. A new word is chosen only where a
   name had no artifact or the wrong one. Renaming an operation word is a
   change of meaning and belongs to a later decision with its own
   characterisation tests.

## Open questions

Each question below has one recommendation. The alternative is stated so the
maintainer can ratify either.

### 1. Does `rules` stand as a service?

**Recommendation: yes, for the shared standard library only.** `rules_stdlib_list`
and `rules_stdlib_get` stay. `firestore_rules_stdlib_list` and
`firestore_rules_stdlib_get` are deleted, because their behaviour is the
service-neutral tool with the `service` parameter fixed to `firestore`.

Rationale. The standard library is one catalogue with per-module service
compatibility. A service prefix would misdescribe it: there is no Firestore
standard library and a separate Storage one, there is one library and a
filter. Prefixing would also reintroduce the duplication the current inventory
carries, two records per module tool, one per service, which is exactly what
the alpha policy deletes. The `service` argument on the neutral tools is the
right place for the filter because it is optional on `list` and required on
`get`, and a name cannot express "optional".

Module resolution is different. `pyric firestore rules resolve` and
`pyric storage rules resolve` are two CLI records already, so the grammar gives
them two tool names: `firestore_rules_resolve` and `storage_rules_resolve`.
`rules_resolve_modules` splits into those two and its `service` parameter goes
away because the name carries it. `firestore_resolve_modules` becomes
`firestore_rules_resolve`. The `rules` service therefore holds only what has no
per-service CLI counterpart.

Alternative. Prefix every shared tool with a service, giving
`firestore_rules_stdlib_get` and `storage_rules_stdlib_get`. This keeps the
service word set to Firebase services plus `sandbox` and `pyric`, and an agent
choosing by name never has to know that `rules` is cross-service. The cost is
two records for one catalogue, a `storage_` twin for every future shared
rules tool, and a `rules` argument that still has to exist inside the record
for the shared implementation. The recommendation judges one cross-service
word cheaper than permanent duplication.

### 2. What artifact word do the Firestore data-plane tools take?

**Recommendation: `documents`.** The eight data-plane tools become
`firestore_documents_get`, `firestore_documents_list`,
`firestore_documents_create`, `firestore_documents_add`,
`firestore_documents_update`, `firestore_documents_delete`,
`firestore_documents_batch_write`, and `firestore_documents_query`. There is
no CLI counterpart today; when one is added it is
`pyric firestore documents <operation>` with `batch-write` as the hyphenated
form.

Rationale. The CLI's existing artifact words are collective nouns, `rules` and
`indexes`, and `documents` follows the pattern. It is Firestore's own word for
the thing every one of these tools reads or writes, and `list` and `query`
return many of them. `data` was considered and rejected for Firestore because
it does not distinguish documents from collections, though it is the right
word for Realtime Database, where the artifact is one JSON tree:
`rtdb_crawl_structure` becomes `database_data_crawl`.

Simulator family. `firestore_simulator_*` already conforms: `simulator` is the
artifact and each operation word stays. The one outlier,
`firestore_create_with_auto_id`, is the simulator's mirror of `addDoc` and
becomes `firestore_simulator_add`, parallel to `firestore_documents_add`. The
two families overlap in capability and a later decision may fold the
simulator's per-call `auth` context into the documents family's `as`
parameter; this ADR only gives each family a consistent name.

Alternative. `firestore_document_*` in the singular, matching the SDK's
`getDoc` and `setDoc`. It reads well for `get` and `delete` and poorly for
`list`, `query`, and `batch_write`, and it would be the only singular artifact
word beside `rules`, `indexes`, and `simulator`. A second alternative keeps the
verb-first names and treats the data plane as its own dialect; that is the
status quo and it leaves the grammar with a permanent exception in its most
used family.

### 3. Where do `sandbox_inspect` and `pyric_can_i_use` sit?

**Recommendation: `sandbox` is a service and `pyric` is the general-command
word.** `sandbox_inspect` stays and a future snapshot tool is
`sandbox_snapshot`. `pyric_can_i_use` stays. `pyric_verify_fixture` becomes
`pyric_verify` and `pyric_derive_rules_test_cases` becomes `pyric_verify_cases`,
because those are the CLI paths `pyric verify` and `pyric verify cases` joined
under Decision 2.

Rationale. The sandbox is the backend every forwarded tool runs against, so
tools whose subject is the sandbox as a whole, its rules, state, event log,
and snapshots, form a real family with a natural home, and `pyric sandbox`
already exists as the command that starts it. Treating `sandbox` as a service
also removes the temptation to prefix a tool with `sandbox_` to say where it
runs, which Decision 5 forbids. The `pyric` word is reserved for commands
about Pyric or spanning services; `can-i-use` asks about Pyric's own
conformance and `verify` replays a session across Firestore and Realtime
Database, so both belong there.

For `verify`, two other candidates were considered and this ADR recommends
neither. Keeping `pyric_verify_fixture` names the input rather than the
command and breaks the derivation rule for the one general command that has a
CLI path. A `session` artifact, `pyric_session_verify` and
`pyric_session_cases`, is the better description of what is verified, but it
only derives if the CLI also moves to `pyric session verify`, and that is a
CLI contract change outside this decision. If the CLI adopts `session` later,
both names re-derive under Decision 1 without a further naming decision.

Alternative. Fold the sandbox tools under `pyric`, giving `pyric_sandbox_inspect`,
on the ground that the sandbox is a Pyric concept, not a Firebase service.
That matches the CLI, where `sandbox` is a general command, and it keeps the
service word set to Firebase services plus `rules` and `pyric`. The cost is a
three-word name for every sandbox tool where two carry the meaning, and a
`pyric_` family that grows with every sandbox operation until it no longer
means "about Pyric itself". The recommendation prefers the shorter family.

## Rename table

Transport is recorded for context and takes no part in the name. "CLI path"
is the command whose words the tool name is derived from, or "none" when the
record has no CLI counterpart today.

### Registered on the bridge contract

| Current name | Proposed name | Transport | CLI path |
| --- | --- | --- | --- |
| `firestore_simulator_create` | `firestore_simulator_create` (unchanged) | forwarded | none |
| `firestore_simulator_execute` | `firestore_simulator_execute` (unchanged) | forwarded | none |
| `firestore_simulator_read` | `firestore_simulator_read` (unchanged) | forwarded | none |
| `firestore_simulator_batch` | `firestore_simulator_batch` (unchanged) | forwarded | none |
| `firestore_create_with_auto_id` | `firestore_simulator_add` | forwarded | none |
| `firestore_simulator_undo` | `firestore_simulator_undo` (unchanged) | forwarded | none |
| `firestore_simulator_redo` | `firestore_simulator_redo` (unchanged) | forwarded | none |
| `firestore_simulator_events` | `firestore_simulator_events` (unchanged) | forwarded | none |
| `firestore_simulator_transaction` | `firestore_simulator_transaction` (unchanged) | forwarded | none |
| `firestore_get_document` | `firestore_documents_get` | forwarded | none |
| `firestore_list_documents` | `firestore_documents_list` | forwarded | none |
| `firestore_create_document` | `firestore_documents_create` | forwarded | none |
| `firestore_add_document` | `firestore_documents_add` | forwarded | none |
| `firestore_update_document` | `firestore_documents_update` | forwarded | none |
| `firestore_delete_document` | `firestore_documents_delete` | forwarded | none |
| `firestore_batch_write` | `firestore_documents_batch_write` | forwarded | none |
| `firestore_query_where` | `firestore_documents_query` | forwarded | none |
| `sandbox_inspect` | `sandbox_inspect` (unchanged) | forwarded | none |
| `rtdb_simulate_access` | `database_rules_simulate` | forwarded | `database rules simulate` |
| `rtdb_crawl_structure` | `database_data_crawl` | forwarded | none |
| `firestore_simulate_rules` | `firestore_rules_simulate` | in-process | `firestore rules simulate` |
| `firestore_rules_stdlib_list` | deleted; `rules_stdlib_list` with `service: firestore` | in-process | none |
| `firestore_rules_stdlib_get` | deleted; `rules_stdlib_get` with `service: firestore` | in-process | none |
| `firestore_lint_rules` | `firestore_rules_lint` | in-process | `firestore rules lint` |
| `firestore_resolve_modules` | `firestore_rules_resolve` | in-process | `firestore rules resolve` |
| `rules_stdlib_list` | `rules_stdlib_list` (unchanged) | in-process | none |
| `rules_stdlib_get` | `rules_stdlib_get` (unchanged) | in-process | none |
| `rules_resolve_modules` | split: `firestore_rules_resolve` and `storage_rules_resolve` | in-process | `firestore rules resolve`, `storage rules resolve` |
| `pyric_can_i_use` | `pyric_can_i_use` (unchanged) | in-process | `can-i-use` |

Twenty-nine current names become twenty-eight: fifteen are renamed (one of
them by splitting into two records), twelve are unchanged, and two are
deleted because their target name already exists.

### Unregistered handlers

These exist in source but are not on the bridge contract. Transport is what
the handler would declare if registered.

| Current name | Proposed name | Transport | CLI path |
| --- | --- | --- | --- |
| `pyric_verify_fixture` | `pyric_verify` | in-process | `verify` |
| `pyric_derive_rules_test_cases` | `pyric_verify_cases` | in-process | `verify cases` |
| `rtdb_generate_rules` | `database_rules_generate` | in-process | `database rules generate` |
| `firestore_test_rules` | `firestore_rules_test` | in-process | none |
| `firestore_discover_paths` | `firestore_paths_discover` | in-process | none |
| `firestore_find_collection_group` | `firestore_paths_find` | in-process | none |
| `firestore_inspect_rules` | `firestore_rules_inspect` | in-process | none |
| `firestore_extract_indexes` | `firestore_indexes_generate` | in-process | `firestore indexes generate` |
| `storage_get_status` | `storage_status` | in-process | none |
| `storage_provision` | `storage_provision` (unchanged) | in-process | none |
| `firebase_assurance_attach` | `pyric_assurance_attach` | in-process | none |
| `firebase_assurance_start` | `pyric_assurance_start` | in-process | none |
| `firebase_assurance_map` | `pyric_assurance_map` | in-process | none |
| `firebase_assurance_define` | `pyric_assurance_define` | in-process | none |
| `firebase_assurance_propose` | `pyric_assurance_propose` | in-process | none |
| `firebase_assurance_run` | `pyric_assurance_run` | in-process | none |
| `firebase_assurance_inspect` | `pyric_assurance_inspect` | in-process | none |
| `firebase_assurance_minimize` | `pyric_assurance_minimize` | in-process | none |
| `firebase_assurance_verify` | `pyric_assurance_verify` | in-process | none |
| `firebase_assurance_export` | `pyric_assurance_export` | in-process | none |

The assurance family takes `pyric` because assurance is Pyric's own workflow
across services, not a Firebase service, and `firebase` is not a service word.
`firestore_extract_indexes` takes the CLI's operation word because
`pyric firestore indexes generate` runs the same extractor over the same
sources. `firestore_paths_discover` and `firestore_paths_find` share an
artifact because both return template paths; one walks the tree and the other
probes a collection group.

### Playground-only handlers

The Playground registers its own handlers today. Under Decision 6 they become
records like any other and take the grammar; the Playground exposes the
subset it needs. Where a Playground handler is the sandbox-bound twin of a
Node handler, it takes the same name and differs only in the handle it binds.

| Current name | Proposed name | CLI path |
| --- | --- | --- |
| `sandbox_discover_paths` | `firestore_paths_discover` (sandbox-bound record) | none |
| `firestore_extract_indexes` (wrapper) | `firestore_indexes_generate` | `firestore indexes generate` |
| `simulate_firestore_write` | `firestore_rules_evaluate` | none |
| `debug_firestore_rules` | `firestore_rules_debug` | none |
| `seed_firestore_data_as_admin` | `firestore_documents_seed` | none |
| `inspect_firestore_traffic` | `firestore_traffic_inspect` | none |
| `try_rules_edit` | `firestore_rules_try` | none |
| `generate_fixture_from_session` | `sandbox_session_export` | none |
| `inspect_auth_users` | `auth_users_inspect` | none |
| `seed_auth_users` | `auth_users_seed` | none |
| `inspect_denial` | `firestore_denials_inspect` | none |
| `build_game_rules` | `firestore_rules_build_game` | none |

`simulate_firestore_write` evaluates one request against the deployed ruleset
without a case list, so it does not take the `simulate` word that
`firestore_rules_simulate` owns; whether the two merge is a later decision.
`sandbox_discover_paths` stops carrying a transport in its name, which is the
first concrete application of Decision 5.

### Records the CLI has and the bridge does not

`firestore rules validate`, `storage rules lint`, `storage rules simulate`,
`database rules lint`, and `database rules validate` exist as CLI records with
no tool. Once they are shared records their tool names derive automatically
(`storage_rules_lint` and so on). Whether the bridge exposes them is an
exposure decision and is not made here.

## Consequences

- Old names are deleted, not aliased. The alpha policy admits no
  compatibility spellings, so `firestore_get_document` stops resolving on the
  day `firestore_documents_get` starts. A tool name is deleted in the same
  change that introduces its replacement.
- The name drift test pins every place a tool name is written outside the
  records: the plugin skills and agent, the agent tool inventory, the site's
  agent pages, the CLI README, and the release-contract fixture. Each of
  those is updated in the change that renames the tool, and the test fails
  the change if one is missed.
- The pinned contract list is edited once. The default contract in the bridge
  contract module and its ratifying test move to the proposed names in a
  single change, and the count drops from 29 to 28. No intermediate state
  carries both spellings.
- Transport moves from the shape of the contract list into a field on each
  record. The forwarded and in-process lists become two computed views of the
  records, and the fail-closed assertion checks the derived names rather than
  a hand-typed pair of arrays.
- The tool-parity annotations are re-keyed to the new names in the same
  change, since every record keeps its exposure decision.
- A future tool is named by writing its path. A name that cannot be written
  as `service`, optional `artifact`, `operation` with words from the closed
  service set is a signal that the tool's home has not been decided, and that
  decision precedes the record.
- The CLI contract does not change. No command is added, moved, or renamed by
  this decision; the CLI is the fixed side of the derivation.

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
