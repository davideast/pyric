# Agent tool inventory

This repo carries two MCP tool contracts, both sourced from
`packages/cli/src/bridge/server/mcp-contract.ts`.

1. **`pyric mcp`**: the **product surface**, ten service tools, one per
   Firebase capability, rendered from the method records under
   `packages/cli/src/bridge/surface/methods/`. Every call is
   `{ method, args }`, where `method` is the SDK's own method name where the
   SDK has one, and pyric's own name where it does not. `DEFAULT_MCP_TOOL_NAMES`
   is the exact list, and it is the ten tools this section documents. Ten is
   the ceiling `0014-service-tools-with-sdk-methods.md` sets. Which sandbox
   the server acts on depends on what is running: with a `pyric serve` or
   `pyric sandbox --bridge` up for the project it attaches to that process and
   relays to the sandbox it holds in the browser tab, which today advertises
   the transport surface below; otherwise it owns an in-process sandbox, a
   plain object inside the `pyric mcp` process with no browser involved,
   persisted to `.pyric/state/in-process.json`. `--attach` insists on the
   running one and fails when there is none; `--in-process` insists on owning
   one and never looks. The first line the server logs says which happened.
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

## The product surface: `pyric mcp`

Ten tools: `firestore`, `database`, `storage`, `auth`, `messaging`, `functions`,
`rules`, `sandbox`, `assurance`, `ai_logic`. Every one of them answers `describe` with `args: { method }`,
which returns that method's full argument schema, an example call, its
effect class (`read`, `write`, `destructive`, or `production`), and its
`status` on this server. A `destructive` call is refused unless
`args.confirm === true`.

A `production` method reaches Google infrastructure with real credentials. It is listed either way, under the heading `Production methods, disabled: start the server with --allow-production`, and `describe` reports it with `status: 'disabled'` and the sentence that enables it, so an agent reads what the surface can do and why this part of it will not run. What the opt-in gates is the call. Without `--allow-production` (or `PYRIC_ALLOW_PRODUCTION` set to `1` or `true`, with the flag winning) on the process that owns the sandbox, every call is refused with that same sentence, and the refusal carries the code `production_disabled` rather than `invalid_arguments`, because the arguments were fine. With the flag, the call still requires `confirm: true`. `pyric assurance testRulesHosted` refuses the same way and names the same flag. Credentials are looked for last, from `FIREBASE_SA_BASE64`, `GOOGLE_APPLICATION_CREDENTIALS`, or Application Default Credentials, and a run that finds none is refused naming all three, so a network client is never built without the flag, the confirmation, and credentials all present.

| Tool | Methods |
|---|---|
| `firestore` | `getDoc`, `getDocs`, `addDoc`, `setDoc`, `updateDoc`, `deleteDoc`, `writeBatch`, `getCountFromServer`, `getAggregateFromServer`, `discoverPaths`, `findCollectionGroup`, `extractIndexes`, `writeIndexes` (destructive; requires `confirm: true`) |
| `database` | `get`, `query`, `set`, `update`, `remove`, `push`, `crawl` (bounded structural view, no leaf values, depth 0 to 10, default 10) |
| `storage` | `getBytes`, `getDownloadURL`, `getMetadata`, `listAll`, `uploadBytes`, `updateMetadata`, `deleteObject`, `setCrossServiceIam`, `status` and `provision` (production; disabled unless the server was started with `--allow-production`, and then requires `confirm: true`) |
| `auth` | `getUser`, `getUserByEmail`, `listUsers`, `createUser`, `updateUser`, `deleteUser`, `setCustomUserClaims`, `importUsers`, `createCustomToken`, `signInWithEmailAndPassword`, `signInAnonymously`, `signInWithCustomToken`, `signInWithCredential`, `signOut`, `impersonate`, `actAsAdmin`, `actAsAnonymous`, `useAppSession`, `whoami`, `sessions` |
| `messaging` | `send`, `subscribeToTopic`, `unsubscribeFromTopic`, `tokens`, `deliveries` |
| `functions` | `listTriggers`, `fire`, `executions` |
| `ai_logic` | `script`, `clearScripts`, `scripts`, `status` |
| `rules` | `lint`, `simulate`, `explainDenial`, `set`, `listStdlib`, `getStdlib` |
| `sandbox` | `inspect`, `events`, `seed`, `seedFromFixture`, `exportFixture`, `reset` (destructive; requires `confirm: true`; `scope` narrows it to one service), `checkpoint`, `restore` (destructive; requires `confirm: true`), `listCheckpoints`, `deleteCheckpoint` (destructive; requires `confirm: true`), `fork`, `apply`, `diff`, `promote` (destructive; requires `confirm: true`), `discard`, `listBranches`, `setClock`, `advanceClock`, `resetClock` |
| `assurance` | `replaySession`, `verifyCases`, `canIUse`, `attach`, `start`, `map`, `define`, `propose`, `run`, `inspect`, `minimize`, `verify`, `export`, `testRulesHosted` (production; disabled unless the server was started with `--allow-production`, and then requires `confirm: true`) |

`checkpoint` writes the whole live sandbox under a name into
`.pyric/state/checkpoints/`: Firestore documents, the Realtime Database tree,
Storage objects with their bytes and metadata, auth accounts, and the three
rule sources. `restore` puts one back, `listCheckpoints` reports what is
stored, and `deleteCheckpoint` discards one and leaves the sandbox alone. A checkpoint is the only copy of the state it holds, so that call is destructive and takes `confirm: true`. `events` pages the operation log by cursor and filters
it to denials or writes; a cursor from a log a restore or a reset replaced is
refused rather than read as the start of the new log. `exportFixture` writes the live state as a fixture and
`seedFromFixture` loads one back. The fixture carries the sandbox's seeded
passwords, so a user it seeds back can sign in; `excludePasswords: true` leaves
them out. The file is the seed shape `sandbox.seed` accepts, not the state file
`pyric snapshot` writes.

The six branch methods work a change out on a copy before it reaches the live
sandbox. A branch carries every service the sandbox does, so an experiment can
upload an object or create an account and not just write a document.

`fork` copies the whole live sandbox into a named branch under
`.pyric/state/branches/<branch>/`. `candidateRules` runs the branch under rules
the live sandbox never sees: a string is the Firestore ruleset, and an object
naming `firestore`, `database`, and `storage` sets each service's rules
independently. `apply` re-issues sandbox events onto the branch, either from an
`events` list or from a recorded session file named by `sessionPath` relative
to the project directory; a call that names neither is refused. `diff` reports
what the branch and its reference disagree on, against `live` by default or
against a checkpoint by name; every divergence names the service it concerns
and the result carries a count per service. `promote` lands the branch on live
across every service and deletes it, and it is atomic: any write the live
sandbox refuses puts live back to what it held and leaves the branch to promote
again. What lands is the delta between the state the branch forked from and the
state it holds now, so state live gained after the fork survives the promotion.
`discard` deletes the branch and leaves live alone. `listBranches` reports every
branch with when it was forked, how many events it carries, and how far it has
drifted from live per service. A branch is a directory in the project, so it
outlives the server that forked it.

Two identities live in one sandbox and the `auth` tool keeps them apart. The
agent identity is what your own calls run under. It starts in the `default`
mode, the sandbox default, which bypasses rules the way admin does, and
`impersonate`, `actAsAdmin`, `actAsAnonymous`, and `useAppSession` move it. The app
session is the user the sandbox's own SDK is signed in as, which is what an
application built on it sees from `onAuthStateChanged`. The five sign-in
methods move the app session and nothing else, so a `signInWithEmailAndPassword`
followed by a `firestore.getDoc` still reads as whatever the agent identity was.
`whoami` reports both, under `agent` and `appSession`, and says which one the
next call runs as; `sessions` lists them; `useAppSession` is the one method that
adopts the app session's uid, tenant, and claims as the agent identity, after
which Security Rules evaluate your calls exactly as they evaluate the
application's. That adoption is a snapshot: a later sign-in moves the app
session and leaves the agent identity where `useAppSession` put it. A sign-in resolves the credential in the tenant the stored record
already belongs to, so a tenant identity keeps its tenant across a sign-in and
`request.auth.token.firebase.tenant` is set for it.

`createCustomToken` mints what `signInWithCustomToken` redeems, and stores
nothing, so it is a read. `importUsers` takes the same user entry
`sandbox.seed` does: `uid`, and optionally `email`, `password`, `customClaims`,
and `tenantId`. The `password` is what the identity can then sign in with, and
is derived from the uid when omitted. `getUser`, `getUserByEmail`,
and `listUsers` all report `tenantId`.

The sandbox carries one clock, which every `serverTimestamp()`, Realtime
Database `now`, `request.time`, and minted auth token `iat` reads instead of
`Date.now()`. `setClock(isoTime)` pins the clock to that instant and freezes it
there; a value that does not parse as a date is refused, naming the value and
the ISO 8601 form it expects. `advanceClock(ms)` moves the clock forward by
that many milliseconds: a pinned clock stays frozen at the new instant, and a
flowing clock keeps flowing from the new offset. `resetClock()` returns to the
wall clock. `inspect` reports the clock's mode and current instant alongside
its other counts, and how far an offset clock is shifted. A checkpoint or a
branch fork carries the clock's state, so restoring or applying one moves the
clock along with the data. `promote` does not: the clock is an experiment
control rather than data, so landing a branch that ran under a pinned instant
leaves live on the clock it already had. `diff` ignores the clock for the same
reason, so a branch that only moved its clock has no divergences.
`rules.simulate` takes an optional `requestTime` (ISO 8601); when a call omits
it, `request.time` (Firestore, Storage) and `now` (database) evaluate at the
sandbox clock's current instant, so a rule with no explicit time still moves
when the clock does. Naming `requestTime` evaluates the rule at that instant
without moving the sandbox clock.

A Firestore field value is a function call in the SDK, and a tool call is
JSON, so each one has a JSON spelling that `setDoc`, `updateDoc`, `addDoc`,
and `writeBatch` decode in `data`, at any depth:
`{"$serverTimestamp": true}`, `{"$increment": <number>}`,
`{"$arrayUnion": [...]}`, `{"$arrayRemove": [...]}`, and
`{"$deleteField": true}`. `$deleteField` removes a key from a document that
already exists, so it is accepted by `updateDoc` and by a `writeBatch` entry
of type `update`, and refused elsewhere naming the method. Any other `$` key,
or one of these with a value of the wrong shape, is refused naming the field
path and the form it accepts, rather than stored as a literal. A server
timestamp written this way reads the sandbox clock, so pinning the clock and
writing two documents gives them the same instant. The Realtime Database
takes Firebase's own wire form instead, `{".sv": "timestamp"}`, which
`database.set` and `database.update` accept verbatim and resolve against the
same clock.

`storage.uploadBytes` carries its payload one of two ways, and exactly one per
call: `contentBase64` for bytes the call already holds, or `sourcePath` for a
file inside the project directory, which is read from disk and never leaves it.
A path that escapes the project directory is refused naming the value. The
object path's extension supplies the content type when the metadata does not
name one, so an upload of `exports/report.csv` reads back as `text/csv` rather
than as an octet stream. `storage.getDownloadURL` returns the URL the sandbox
mints, which is a `data:` URI carrying the object's own bytes and therefore
resolves only against this sandbox; production returns a token-signed HTTPS URL
instead. `storage.updateMetadata` replaces the client-settable metadata fields
and leaves the object's bytes alone, and its `updated` stamp follows the
sandbox clock like every other server-set time.

`storage.setCrossServiceIam` decides whether storage rules may read Firestore
through `firestore.get` and `firestore.exists`. `granted` serves those lookups
from the sandbox's own Firestore store, which is the common configured-project
state; `denied` is the project whose Storage service agent lacks
`roles/firebaserules.firestoreServiceAgent`, where every executed lookup fails
and its rule denies while a short-circuited lookup is never executed and is
unaffected. `rules.simulate` for storage evaluates a cross-service rule under
whichever posture the sandbox is in, so a simulation predicts the operation
rather than a neighbouring one.

`storage.status` and `storage.provision` are the control plane, and they reach
the project's real Storage service with the caller's own credentials, so both
are production methods. `status` reads the service state, the default resource
location, and the linked buckets. `provision` enables
`firebasestorage.googleapis.com`, finalizes the default resource location,
which is set once and cannot be changed, and creates and links the bucket;
enabling the service needs `roles/serviceusage.serviceUsageAdmin` or
`roles/owner`, which the default Firebase Admin SDK service account does not
carry. Both are refused without `--allow-production`, refused again without
`confirm: true`, and refused a third time when no credentials are found, naming
the same three sources the hosted rules test reads.

`messaging.send` carries its payload under `message`, exactly one of
`token`, `topic`, or `condition` naming the recipient, the way the admin
SDK's own `Message` union does; naming none or more than one is refused
naming all three. A send to a token the sandbox does not recognize, minted
here or not, is refused pointing at `messaging.tokens` to see what is
registered. `messaging.subscribeToTopic` and `messaging.unsubscribeFromTopic`
manage topic membership for a batch of tokens and report per-token success
and failure counts, never all-or-nothing. `messaging.tokens` and
`messaging.deliveries` are pyric's own reads: the first lists every
registered device token, its state, and the topics it is subscribed to; the
second lists what the sandbox delivered, foreground or background, handled
or not, optionally since a clock timestamp cursor. Both change no state.

`functions` covers the Cloud Functions RTDB trigger runtime and nothing
else: callable functions are a deferred mirror by design, so there is no
`call` method. `functions.listTriggers` discovers the handlers a project's
Functions source defines, their reference patterns, and any exports whose
trigger kind the runtime does not support yet, with the reason; a project
with no Functions source answers with an empty list and names where it
looked. `functions.fire` runs one discovered handler on a synthetic event
built from `path` and `value`, matching `path` against the handler's own
reference pattern to capture its wildcard params; it never writes `value` at
`path`, and naming a trigger `listTriggers` did not discover is refused
pointing at `listTriggers`. `functions.executions` lists the runs `fire`
caused, with cause, duration, and result or error, optionally since a clock
timestamp cursor.

`ai_logic` is a local mirror control, not a way to send a prompt: no method
here ever calls an upstream model. `ai_logic.script` registers one
deterministic response on the local scripted answer engine, matched by
prompt substring, by the model a call names, by both, or by neither
(unconditional). `response.payload` must agree with `response.type`: a
string for `text`, a plain object for `json`, `{ code, message }` for
`error`; a mismatched call is refused naming the accepted form.
`ai_logic.clearScripts` empties the queue, and `ai_logic.scripts` lists what
is queued, each entry beside whether it has already answered a call. All
three reach only the scripted engine, and are refused when the project's
resolved AI Logic engine is something else. `ai_logic.status` reports the
resolved engine (`scripted`, `openai` for a local loopback upstream, or
`gemini` for production pass-through to Google AI or Vertex AI), its model
and upstream when it has one, and whether a key is configured; it never
returns the key value, a prefix of it, or its length, only the boolean
`keyPresent`. When the resolved engine is `gemini`, `status` says so, and
`script` still only ever affects the local scripted engine.

The CLI derives `pyric <tool> <method> [--<arg> <value>...]` from the same
method records the MCP tool calls, so `pyric firestore setDoc --path
posts/p1 --data '{"a":1}'` and an MCP call with `{ method: "setDoc", args:
{ path: "posts/p1", data: { a: 1 } } }` run the identical handler against the
identical sandbox state. See `docs/decisions/0014-service-tools-with-sdk-methods.md`
for the design rationale.

A derived command acts on the in-process sandbox in
`.pyric/state/in-process.json`, and its first line says so. It cannot reach a
sandbox that a running `pyric serve` holds in the browser, so when one is
running for the project the command refuses rather than answer about a
different sandbox, naming `--in-process`, which overrides the refusal, and
`pyric mcp`, which reaches the running one.

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

`auth_reset` is also on the CLI, as `pyric auth reset`, calling this same
bridge tool because retargeting a connected client is a concept only a running
bridge has. `pyric auth impersonate`, `pyric auth whoami`, and
`pyric auth sessions` are different commands now: the derived service-tool
commands `auth.impersonate`, `auth.whoami`, and `auth.sessions` (product
surface, above), which act on this project's local `.pyric/state` and need no
running bridge. `auth.sessions` reports the sessions the project's in-process
sandbox itself holds, the agent identity and the app session; `auth_sessions`
on a bridge reports the clients connected to it, and `pyric serve sessions` is
the command that prints those rows, with the target ids `--target` takes.

## Index extraction — `pyric/rules/indexes`

`firestore_extract_indexes` — derive composite-index definitions from query
shapes found by static analysis of application source. Available as a library
and via `pyric firestore indexes generate`; **not** registered on the default
MCP bridge.

The product surface's `firestore.extractIndexes` and `firestore.writeIndexes`
(above) are a different capability: they take queries directly rather than
parsing source, and run against the sandbox rather than a source tree.

## Realtime Database rule artifacts — `@pyric/cli`

Local compilation of a constraints module to `database.rules.json` data. It
does not fetch or deploy production rules.

`rtdb_generate_rules` — library / CLI (`pyric database rules generate`);
**not** on the default MCP bridge.

## Storage control plane — `createStorageAdminTools` (`pyric/storage`)

`storage_get_status` · `storage_provision`

Library surface for provisioning / status, and the client the service surface's
`storage.status` and `storage.provision` reach through. **Not** on the default
`pyric bridge` surface; on `pyric mcp` it is the two production methods above,
which no server runs without `--allow-production`.

## Discovery — `createFirestoreDiscoverTools` (`@pyric/cli/discover`)

Credential-free crawl helpers for agents that compose their own registry and
provide the data source:

`firestore_discover_paths` · `firestore_find_collection_group`

These exist in `@pyric/cli/discover` but are **not** registered on the default
`pyric bridge` / `pyric sandbox --bridge` surface. The product surface's
`firestore.discoverPaths` and `firestore.findCollectionGroup` (above) are a
separate, exhaustive implementation over the sandbox's own document index
rather than a sampled crawl, and are registered on `pyric mcp`.

## Assurance — `createAssuranceTools` (`@pyric/cli/assurance`)

Available for applications that compose their own tool registry, but **not**
registered on the default `pyric bridge` / `pyric sandbox --bridge` surface:

`firebase_assurance_attach` · `firebase_assurance_start` ·
`firebase_assurance_map` · `firebase_assurance_define` ·
`firebase_assurance_propose` · `firebase_assurance_run` ·
`firebase_assurance_inspect` · `firebase_assurance_minimize` ·
`firebase_assurance_verify` · `firebase_assurance_export`

The `assurance` service tool on the product surface reaches these same ten
operations, one method each, against the sandbox the in-process server owns.
The two are the same library under two transports and neither is derived from
the other, so a change to an operation's schema or its classification has to
land in `createAssuranceTools` and is picked up by both.

---

**Transport surface: 41 unique tool names** (see `BRIDGE_TOOL_NAMES` in
`mcp-contract.ts`). The product surface `pyric mcp` serves by default is the
seven service tools documented above (`DEFAULT_MCP_TOOL_NAMES` in the same
file). Production shipping (rules, indexes, hosting, functions) is owned by
`firebase-tools` or the Firebase Console.
