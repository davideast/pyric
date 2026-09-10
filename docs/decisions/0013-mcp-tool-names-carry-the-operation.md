# 0013: MCP tool names carry the operation word

Status: Superseded by ADR-0014

Date: 2026-09-07

## Context

ADR-0012 Decision 1 and Resolution 2 fold operations into one MCP tool per
service and artifact, and demote the operation word to a required `op` field
whose schema is an enum. The CLI keeps the operation as a word in its path.
The stated reason was surface size: twelve tools with self-describing schemas
rather than thirty flat names.

Two facts have emerged since.

An MCP client selects a tool by matching a request against tool names and
descriptions. A request is phrased in the words a person uses. "Impersonate
alice" and "change the authenticated user" both name an operation, and
neither phrase reaches a tool named `auth`. The operation word is the part of
the path a request actually matches, and the fold removes exactly that word
from the name.

`op` is also the bridge's own dispatch field. Exposing it requires a caller to
learn a routing convention before it can express an intent, and the field name
belongs to the router rather than to any service being modelled.

The fold was never implemented on `main`. The bridge there still exposes flat
names such as `firestore_get_document` and `pyric_can_i_use`. The
implementation lives on `actuation-harmony`, which did not land, so
Resolution 2 currently describes a state that does not exist in the shipped
product.

## Decisions

1. **The MCP tool name is the whole path, joined with underscores.** The
   record's path words produce `auth_impersonate` from `['auth',
   'impersonate']` and `firestore_rules_lint` from `['firestore', 'rules',
   'lint']`. The CLI joins the same words with spaces, as ADR-0012 already
   specifies. There is no `op` field on any tool.

2. **The path words themselves are unchanged.** Every ruling ADR-0012 made
   about which words a path contains still holds: the closed service word set,
   `database` rather than `rtdb`, `rules_stdlib` for the shared catalogue,
   `firestore_data` and `firestore_simulator` as distinct artifacts, and the
   omission of the artifact word when the subject is the service itself. Only
   the joining changes. `firestore_data` with op `get` becomes
   `firestore_data_get`.

3. **A record is one operation again.** ADR-0012 Decision 6 declared one
   record per tool with its ops enumerated inside, which existed to hold the
   op enum. With no enum to hold, a record returns to one file per operation,
   and the filename is the path joined with hyphens, matching the CLI's
   existing `service-command-records/` convention. Transport stays a property
   of the record.

4. **A rename justified only by the fold is withdrawn.** ADR-0012
   Resolution 4 replaced the operation word `create` with `set` on the
   Firestore data tool, reasoning that an op value inside an enum can carry
   meaning a flat tool name could not. That reasoning does not survive this
   amendment. Such a rename now needs its own case on the operation's
   semantics, or the existing word stands.

## Consequences

The surface is a name per operation. Adding the auth service described in
ADR-0012 takes the bridge from 29 tools to roughly 41. Tool count is managed
by deciding which families a given surface mounts, which the tool-parity
annotations already record, rather than by the shape of a name.

Some names on `main` become conforming without change, including
`rules_stdlib_list`, `rules_stdlib_get`, and `sandbox_inspect`. Others still
carry the wrong path words and are renamed when their family is next touched:
`firestore_get_document` becomes `firestore_data_get`, and `rtdb_*` becomes
`database_*`, as ADR-0012 already ruled.

An agent that knows a CLI command can predict the tool name and the reverse,
which was ADR-0012's original goal and is better served by a one-to-one
mapping of words than by a mapping that drops a word on one side.
