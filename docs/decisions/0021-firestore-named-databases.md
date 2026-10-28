# 0021: Firestore named databases

Status: Proposed

Date: 2026-10-27

Decides how pyric gives each Firestore database its own data, rules and SDK
selection on every plane. Builds on ADR-0011 (the worker protocol) and follows
the shape pyric already uses for Realtime Database instances.

## Context

A Firebase project can hold up to 100 Firestore databases. The first is
`(default)`; any other is a named database. Production keeps them apart in
three ways:

- **Data.** "To create a client connected to a named database, set the
  database ID when you instantiate a client"
  ([Manage databases](https://firebase.google.com/docs/firestore/manage-databases)).
  Each database has its own documents.
- **Rules.** "Cloud Firestore Security Rules are applied separately for each
  named database in your project", and "if you create multiple databases, you
  must manage and deploy rules for each one individually"
  ([Structuring security rules](https://firebase.google.com/docs/firestore/security/rules-structure)).
  The `{database}` wildcard in `match /databases/{database}/documents` captures
  the database the request addresses.
- **SDK selection.** `getFirestore(app, databaseId)` and `getFirestore(databaseId)`
  in the client SDK and in the Admin SDK.

Pyric models one database per app. The four `Named databases` rows in
`packages/conformance/registry/firestore.ts` pin the gap as
`diverged-documented`:

| Row | Surface | Today |
| --- | --- | --- |
| MD1 | sandbox `getFirestore(app, databaseId)` | every id returns the `(default)` handle |
| MD2 | the served `firebase/firestore` entry | the worker protocol carries no database id |
| MD3 | `pyric-admin` `getFirestore` | takes no database id |
| MD4 | rules `match /databases/{database}/documents` | `database` is always `(default)` |

A project that uses a named database loses its isolation in pyric: every id
reads and writes `(default)`, and `(default)`'s rules govern it.

Realtime Database instances already have the full shape: `firebase.json`
declares them, each gets its own data and rules, client and admin handles
select by URL, every plane agrees, and the tools take an instance. This record
copies that shape wherever Firestore allows it, and names the places it can't.

### What reading the sources found

Three facts differ from what the plan for #1314 assumed. Each one changes a
decision below.

1. **The SDKs do not validate a database id.** In `firebase` 12.13.0
   (`@firebase/firestore` 4.14.1, `dist/common-7a7519be.esm.js`),
   `getFirestore(e, n)` takes a string first argument as the id and otherwise
   uses `n || "(default)"`. The component factory builds
   `new DatabaseId(app.options.projectId, id)` after one check: it throws
   `FirestoreError('invalid-argument', '"projectId" not provided in firebase.initializeApp.')`
   when the app has no `projectId`. `initializeFirestore(app, settings, id)`
   applies the same `(default)` fallback. In the Admin SDK, `firebase-admin`
   13.10.0 `lib/firestore/index.js` does the same fallback and
   `@google-cloud/firestore` 7.11.6 checks only that `databaseId` is a string
   (`validateString('settings.databaseId', ...)`). There is no format check to
   port. The SDK checks that do exist are about mixing databases (decision 1).
2. **The oracle project already has a named database.** The observation
   `packages/conformance/observations/storage-rules/stdlib-realstorage-p3-named-database.json`
   (captured 2026-07-21) read an existing named database `probes`, and the rig
   `packages/conformance/rigs/storage-stdlib-real.ts` lists "the existing
   `probes` named database" as a project feature. A capture does not need a new
   database. It does need to deploy rules to `probes`, which changes production
   state (see "Captures this record needs").
3. **Storage rules cannot read a named database.** In the same observation, a
   Storage rule `firestore.get(/databases/probes/documents/...).data.allow == true`
   was denied both when the `probes` document held `true` and when it held
   `false` (registry row `storage-rules#131`). Pyric's refusal in
   `packages/pyric/src/storage/sandbox/rules-firestore-lookup.ts` ("Storage
   rules may access only the default Firestore database") matches it and stays.

A fourth fact comes from capture C3, run for this record on 2026-10-28
(observation `firestore-named-database-absent`, under "Captures"):

4. **Production has no "database not found" verdict for the client, and no
   special error for a malformed id.** A read from a database the project
   lacks gets `NOT_FOUND: The database <id> does not exist for project <p> ...`
   from the backend. The Admin SDK rejects with that message. The client SDK
   treats it as a connection failure: it logs the `NOT_FOUND`, goes offline,
   and `getDoc` rejects with `unavailable`, `Failed to get document because the
   client is offline.` An id outside the naming rules (`Bad_Id`) and the keyword
   `default` get the same answer as a valid id that doesn't exist.

A fifth comes from capture C1, also run on 2026-10-28 (observation
`firestore-named-database-rules-api`):

5. **Rules bind `database` to the database the request addresses.** For a
   request under `/databases/probes/documents/`, the Rules Test API binds the
   `{database}` wildcard to `probes`, puts `probes` in `request.path[1]`, and
   matches a literal `match /databases/probes/documents` block but not a
   literal `(default)` one. A request under `(default)` gets the reverse.

C2, which deploys rules to `probes`, has not run. It is the only capture that
can show whether a deployed rule in one database reads another database's
documents, so that question stays open (decision 3).

## Decisions

### 1. Identity: the id as the SDK takes it, owned by one module

The database id is a string. `undefined`, an empty string, and the string
`(default)` all name the default database, as `n || "(default)"` does in the
SDK. Any other string names a named database and is used exactly as given:
no lowercasing and no trimming, because the SDK does neither.

`getFirestore` accepts every form the SDK accepts:

```ts
getFirestore(app, 'reports');    // client and Admin SDK
getFirestore('reports');         // default app, client and Admin SDK
initializeFirestore(app, {}, 'reports');
```

The sandbox's own forms take the id as an optional second argument, as
`getDatabase(sandbox, url)` does for RTDB:

```ts
getFirestore(sandbox, 'reports');
getFirestore(sandbox.withAuth({ uid: 'alice' }), 'reports');
```

Pyric does not reject an id at `getFirestore`, because the SDK does not. An id
that production could not have created (the
[naming rules](https://firebase.google.com/docs/firestore/manage-databases):
4 to 63 characters, lowercase letters, numbers and hyphens, starting with a
letter, ending with a letter or number, not shaped like a UUID) is a database
that does not exist. C3 confirms production answers `Bad_Id` exactly as it
answers a valid id it lacks, and answers `default` the same way, so `default`
is a named database. Decision 3 covers what using one does.

The checks the SDK does make are ported, with their messages:

- No `projectId`: `'"projectId" not provided in firebase.initializeApp.'`
  (`invalid-argument`). Pyric resolves a project id for every sandbox app, so
  this applies only where pyric's app has none.
- A `DocumentReference` stored as a field value must belong to the writing
  database: `Document reference is for database <project>/<db> but should be
  for database <project>/<db>` (`invalid-argument`, from the user data
  writer).
- A batch or transaction given a reference from another `Firestore` instance:
  `Provided document reference is from a different Firestore instance.`
  (`invalid-argument`, `__PRIVATE_validateReference` in `dist/index.esm.js`).
  Two databases are two instances, so this check isolates writes for free.
- `refEqual` and `queryEqual` compare `firestore` identity, so references to
  the same path in two databases are not equal.

One new module, `packages/pyric/src/sandbox/internal/firestore-databases.ts`,
owns the id. It exports `DEFAULT_FIRESTORE_DATABASE = '(default)'`, the
function that normalizes an argument to an id, the naming-rule predicate used
for `firebase.json` (decision 6), the persistence namespace for an id
(decision 5), and the registry key. Every plane imports it (AGENTS.md item 4).

The keyed, lazily created map that `instances.ts` builds for RTDB
(`createDatabaseInstanceRegistry`) moves to a service-neutral
`resource-registry.ts` beside it. RTDB keeps its `keyOf`, which knows about
project-derived default names. Firestore needs no such mapping: its default
key is always `(default)`.

Rejected:

- **Port a format check into `getFirestore`.** The SDK has none, so throwing
  for `getFirestore(app, 'Reports')` would fail a call production accepts.
- **Reuse `instances.ts` for Firestore ids.** RTDB names are hostnames parsed
  from URLs, lowercased, and default to `<project>-default-rtdb`. None of that
  applies, and sharing the module would invite one service's rules into the
  other's.
- **Normalize `'default'` to `(default)`**, as RTDB accepts the keyword
  `default`. The Firestore SDK treats `'default'` as a named database, so pyric
  does too.

### 2. The sandbox core: one environment per database

The sandbox holds a map from database id to `LocalEnvironment`, created on
first use. The `(default)` entry is the environment `_env` holds today, so
every existing caller of `getInternalEnv(sandbox)` (about 50 sites) keeps
reading `(default)` unchanged. A new `getInternalEnvFor(sandbox, databaseId)`
returns the others.

What each option does to the parts that matter:

| Concern | (a) one environment per id | (b) a database dimension in one environment |
| --- | --- | --- |
| Store | each env has its own `DocStore`; isolation is structural | every key gains a database prefix; isolation depends on every read site adding it |
| Rules | each env already holds one `RulesState` and simulator | one env holds many rulesets and picks per request |
| Listeners | each env's `ListenerDispatch` sees only its writes | every dispatch filters by database |
| Transactions | a transaction runs in one env, as production binds it to one `Firestore` | the transaction engine must reject cross-database keys itself |
| Activity events | the sandbox subscribes to each env and stamps `database` on its events, as RTDB backends stamp `instance` | each event site adds the field |
| Undo, redo and the agent event log | per database, owned by each env | one log interleaving databases |
| `snapshot()` / `loadSnapshot()` | iterate the map | one map with compound keys |
| `reset()` | dispose every env, keep the `(default)` one fresh | clear every database inside one env |

Recommended: (a). Each environment already owns its store, rules, listeners,
transactions and history, so a second database is a second environment. The
work is in `SandboxImpl`: it wires each new env's events (`envUnsubs`)
with the database stamped on, calls `reevaluateLiveListeners` on every env when
the user changes, and, on `reset()`, disposes all of them and recreates only
`(default)`. Named environments come back on next use, with the rules
decision 6 resolves for them. The clock is shared, so a pinned instant holds
across databases.

`SandboxSnapshot` keeps `firestore` as the `(default)` documents and gains
`firestoreDatabases?: Record<string, Record<string, DocumentData>>` for the
others, omitted when empty. That is RTDB's layout (the default instance at the
top level, named instances under `instances`), and it means every snapshot
written before this change loads as `(default)` only.

`appRuntime.service('firestore/default', ...)` in
`packages/pyric/src/firestore/instances.ts` becomes `firestore/<id>`, so
`getFirestore(app, 'reports')` returns one handle per app and id, as the SDK's
provider does.

Rejected: (b). It touches every engine under `packages/pyric/src/firestore/sandbox/`
and makes isolation a property every future read site must remember, which is
the failure this record exists to remove.

### 3. Rules: one ruleset per database, and `database` binds the handle's id

Each environment holds its own ruleset. A request through a `reports` handle
evaluates `reports`' rules with `database == 'reports'`, `request.path` and
`resource.__name__` under `/databases/reports/documents/`.

The places that hard-code `(default)` today, each of which takes the
evaluating database's id:

- `packages/pyric/src/rules/simulator/handler.ts`:
  - line 337, the full path built for `request.path`;
  - line 452, `database: '(default)'` in the evaluation context;
  - lines 561 to 575, the root wildcard bindings (every root wildcard, whatever
    its name, binds the id).
- `packages/pyric/src/rules/simulator/document-lookups.ts`:
  - `normalizeDocumentPath` replaces `$(database)` with `(default)` and strips
    only the `/databases/(default)/documents` prefix;
  - `makeGetResource` builds `__name__` under `(default)`.
- `packages/pyric/src/rules/simulator/evaluation-builtins.ts`: `afterLookupPath`
  (for `getAfter` and `existsAfter`) goes through `normalizeDocumentPath`.
- `packages/pyric/src/rules/simulator/wrappers/reference.ts`:
  `referenceToResourceName` defaults `databaseId` to `(default)`; its callers
  pass the stored reference's database.
- `packages/pyric/src/storage/sandbox/rules-firestore-lookup.ts`: refuses any
  database but `(default)`. This one stays, on the evidence of
  `storage-rules#131` (Context, finding 3).

C1 confirms the binding: the Rules Test API binds `database`, `request.path`
and literal database matches to the addressed database.

**`get()`, `exists()`, `getAfter()` and `existsAfter()` across databases.**
Firebase's docs do not say whether a rule in one database may read a document
in another. C1 shows the language accepts such a path: a `get()` of the other
database's path, answered by a function mock, evaluated in both directions. A
mock answers whatever path it names, so this says nothing about a real read.
This record does not know production's answer. Until C2 settles it, a lookup whose path names a different database is an evaluation
error, so it denies. That keeps pyric from allowing what production might deny;
if production allows the read, pyric denies a request production allows, and
MD6 (decision 9) documents that until it's fixed.

Today a path such as `/databases/reports/documents/c/d` is not stripped, so it
normalizes to the odd-length `databases/reports/documents/c/d` and errors. The
result already denies. The new error names the database instead of the
segment count.

**An unconfigured database.** Production creates a database in "production
mode", which "denies all reads and writes from mobile and web clients", or in
"test mode", which allows them
([Manage databases](https://firebase.google.com/docs/firestore/manage-databases)).
A named database that `firebase.json` deploys no rules to starts locked, unless
the runtime runs in permissive mode, which opens it as it opens `(default)`.
Pyric logs this once per database, as `undeployedInstanceNotice` does for RTDB.

**A database that does not exist.** Pyric cannot see the console, so a
database exists in pyric when something declares it:

- a `firestore` entry in `firebase.json` names it, by `database` or by a
  `target` that `.firebaserc` resolves to it (decision 6);
- a seed, a restored snapshot or a host store holds documents for it;
- the sandbox API declares it, as `setRules` with a database id does.

Every other id is a database that does not exist, and pyric answers as C3
recorded production answering:

- the Admin SDK and `pyric-admin` reject with gRPC code 5, `5 NOT_FOUND: The
  database <id> does not exist for project <project> Please visit
  https://console.cloud.google.com/datastore/setup?project=<project> to add a
  Cloud Datastore or Cloud Firestore database. `;
- the client SDK logs the same `NOT_FOUND` as a connection failure, and `getDoc`
  rejects with `unavailable`, `Failed to get document because the client is
  offline.`;
- pyric adds one notice naming the entry to add to `firebase.json`.

C3 captured one-shot reads only. What an `onSnapshot` listener and a write
against a missing database do was not captured. Until it is, a listener gets
the client's offline behavior and a write rejects as the Admin SDK's read does,
and MD9 says which parts are captured.

Rejected:

- **Allow cross-database lookups until captured.** It could fail open.
- **Serve any id under locked rules.** This record proposed it before C3.
  Admin access to an undeclared database would then succeed in pyric where
  production fails with `NOT_FOUND`, so pyric would allow what production
  denies.
- **Refuse an id outside the naming rules at `getFirestore`.** C3 shows
  production accepts the call and fails the request like any missing
  database.

### 4. The worker protocol: one versioned change

Every Firestore operation frame and listener registration gains an optional
`databaseId`. Absent means `(default)`. The sender omits it for `(default)`,
so a `(default)` frame is byte-identical to today's. RTDB's `instance`
(read by `requestInstance` in
`packages/cli/src/serve/worker/request-instance.ts`) is the precedent, and a
sibling `requestDatabaseId` reads the new field the same engine-free way.

The field covers:

- every Firestore op in the `OpMessage` union (reads, writes, queries,
  aggregations, batches and transactions; a transaction carries it once, at
  begin, and stays bound to that database);
- listener registrations (`target: { service: 'firestore', databaseId?, ... }`);
- the rules ops that already take an RTDB `instance` (`setRules`,
  `getActiveRules`, `getRulesStatus` with `service: 'firestore'`).

On the host, `HostCtx`'s handle caches key by surface, lens and database. That
adds a third key to the resolver ADR-0011 Decision 8 and its spike amendment
describe; this record does not wait for that resolver.

**Refusing a peer that predates the field** (Decision 1 for David, decided
2026-10-27: add the protocol version field now). An old host ignores a field
it doesn't know, so a `databaseId` sent to one would silently read and write
`(default)`. The refusal therefore happens on the side that knows about the
field, before the frame leaves:

- `protocol.ts` exports `WORKER_PROTOCOL_VERSION = 2`. Absent means 1.
- The existing connect exchanges carry it, additively:
  - the bridge's `hello` and `hello-ack`, and `attach` and `attach-ack`
    (`packages/cli/src/bridge/protocol.ts`), as an optional `workerProtocol`
    number beside the existing `protocol: 1` and `capabilities`;
  - the SharedWorker's `getRuntimeEpoch` reply, as `workerProtocol` beside
    `version`.
- A client (the `pyric-admin` remote arm, the served page client) that is asked
  for a named database on a connection whose peer reported no
  `workerProtocol`, or one below 2, throws before sending:
  `FirebaseError('failed-precondition', 'pyric: the host at <url> speaks worker protocol 1, which has no Firestore database ids. Restart it with @pyric/cli <version> or later to use getFirestore(app, "reports").')`.
- The bridge relays a frame carrying `databaseId` to a browser peer only if that
  peer's `hello` reported `workerProtocol` 2 or later, and otherwise answers
  with the same error. A long-open tab from an older build is such a peer.
- A host that receives a `databaseId` it cannot honor refuses the frame with an
  error naming the database. In this design every current host can honor any
  id, so this is the rule for a future host that limits databases, not a code
  path #1317 must build.

The retired-worker boundary (ADR-0011 Decision 1a) is also covered by
build-epoch retirement; the version check is the backstop for a frame sent
before retirement runs.

This adds only the version field from ADR-0011 phase D. The handshake frame,
`transport.protocol`, and folding `getRuntimeEpoch` and `getVersion` together
stay ADR-0011's decision.

Rejected:

- **A capability string** in `capabilities`, as the worker relay uses. It would
  work for the bridge, but the SharedWorker exchange has no capabilities list,
  and David chose the version field.
- **A new op method per database**, or a database prefix in paths. Both change
  every frame and every handler, where one optional field changes none of the
  `(default)` traffic.
- **Build ADR-0011 phases B to D first.** Named databases would wait on an
  unstarted migration.

### 5. The host store and durable persistence: keyed by database

Pyric's persistence stores Firestore documents as v3 bucket records (256
buckets by a hash of the path, plus one `meta` record) in
`packages/pyric/src/sandbox/persistence/chunk-format.ts`. The Node host's
SQLite store keeps them in `records (namespace, id, payload)`
(`packages/cli/src/serve/hosted/persistence/database.ts`), and the
SharedWorker keeps them in one IndexedDB database per key
(`packages/pyric/src/sandbox/persistence/backends.ts`).

`deserializeFromBuckets` merges every non-`meta` record into one document map.
So named databases cannot share a record space with `(default)`: an older
reader would merge them into `(default)`. Each named database gets its own
record space instead:

- **Node host.** A named database's buckets live under their own `namespace`,
  derived from the project namespace and the id by the identity module
  (decision 1). `(default)` keeps the project namespace. `HOSTED_SCHEMA_VERSION`
  goes to 7. Upgrading a version 6 store changes no rows: its records are
  `(default)`'s. An older build refuses a version 7 store with its existing
  `Unsupported hosted database version 7.` instead of opening it and leaving
  named data it can't see.
- **SharedWorker.** A named database persists to its own IndexedDB database,
  keyed from the sandbox's key and the id. The `meta` record (service state)
  stays in the `(default)` key only. An older worker never opens the new keys.
- **Single-file bundles** (`.pyric/state`, a browser `--persist` state file,
  the hosted state view, checkpoints and branches through `full-state.ts`).
  The `pyric-v3-records` bundle keeps its `records` as `(default)` and gains a
  sibling `firestoreDatabases: { <id>: <records> }`. A bundle with no named
  database is unchanged. An older build reading a newer bundle keeps
  `(default)` and drops the named databases.

The rule for writing changed records, write-behind flushes, and quarantine
of a corrupt bucket applies per record space unchanged.

Rejected:

- **Bucket ids with a database prefix in the same record space.** Older
  readers merge them into `(default)` (above).
- **Raise the bundle format version for every bundle.** An older build reads
  an unknown bundle format as empty state, which loses `(default)` too.
- **Write version 7 only when a store first holds a named database.** It saves
  a downgrade for projects without named databases, at the cost of a store
  whose version depends on its contents. Pyric does not promise downgrades.

### 6. Configuration: one resolver, as `firebase deploy` reads the block

Pyric reads the `firestore` block as `getFirestoreConfig` in firebase-tools
15.24.0 `lib/firestore/fsConfig.js` does (15.23.0, the version in `bun.lock`,
is byte-identical):

- An object deploys its `rules` and `indexes` to its `database`, or to
  `(default)`.
- In an array, an entry with `target` deploys to every database `.firebaserc`
  maps under `targets.<project>.firestore.<target>`, after `requireTarget`.
  `target` is checked first, so an entry with both uses `target`.
- An entry with `database` and no `target` deploys to that database.
- An entry with neither throws the CLI's message,
  `Must supply either "target" or "databaseId" in firestore config`.

Pyric adds two refusals the CLI leaves to the API, both naming the entry:

- a `database` value outside the naming rules (decision 1), since production
  can't hold that database;
- two entries that deploy different rules files to one database. This follows
  `database-rules-config.ts` for RTDB: the CLI deploys both, so the
  configuration doesn't decide which ruleset production keeps.

A target no `.firebaserc` mapping resolves waits for the page's project, as
RTDB targets do (the `rtdb-deploy-target-unresolved` app scenario), and the
dev server logs that it is unresolved.

One pure resolver, `packages/pyric/src/sandbox/internal/firestore-rules-config.ts`,
returns `{ database, rulesFile, indexesFile, label }[]` plus unresolved targets.
It reads no file, as `database-rules-config.ts` reads none. Every loader calls
it:

- the dev server, SharedWorker, in-page runtime and Node host
  (`packages/cli/src/serve/rules.ts`);
- `@pyric/cli/register` with `PYRIC_SANDBOX=local`
  (`packages/pyric/src/app/register-rules.ts`);
- the in-process bridge (`packages/cli/src/bridge/server/in-process.ts`),
  which today ignores `firebase.json` for Firestore;
- `pyric verify` (`packages/cli/src/cli/verify.ts`);
- the indexes loader (`packages/cli/src/serve/index-config-store.ts`), so
  each database checks queries against its own indexes.

#1315 makes the `(default)` entry of an array govern `(default)` before any of
this. It can land the resolver with only the `(default)` result consumed.

Rejected: one parser per plane, the cause of #1315.

### 7. `pyric-admin`: both Admin SDK forms on both arms

`pyric-admin`'s `getFirestore` takes the Admin SDK's forms:

```ts
import { getFirestore } from 'firebase-admin/firestore';
getFirestore(app, 'reports');
getFirestore('reports');      // default app
initializeFirestore(app, {}, 'reports');
```

One handle per app and id, as `FirestoreService.getDatabase` caches it.
The admin lens bypasses rules on every database, as it does on `(default)`.

- **In-process arm.** The handle resolves to `getInternalEnvFor(sandbox, id)`
  through the admin lens.
- **Remote arm.** Each frame carries `databaseId` (decision 4). A host whose
  `attach-ack` predates `workerProtocol` 2 gets the `failed-precondition`
  refusal on the first named-database call, not at `getFirestore`, because
  the Admin SDK's `getFirestore` makes no network call.

The pyric-specific `getFirestore(ctx)` form gains the same optional id
(decision 1).

### 8. Surfaces that carry the id

Each surface below names the database when it isn't `(default)`, and omits it
when it is, so `(default)`-only output is unchanged:

- **Activity events and the Studio feed.** Firestore events gain
  `database?: string`, as RTDB events carry `instance?: string`
  (`packages/pyric/src/sandbox/types/events.ts`). Studio shows it on the event
  and can filter by it.
- **Captures, replay and `pyric verify`.** `.pyric/last-session.json` records
  each request's database. Replay drives the request through a handle for that
  database. `pyric verify` evaluates each request against that database's
  rules from `firebase.json` (decision 6). Replay case types in
  `packages/pyric/src/rules/api/case-types.ts` gain `database?`.
- **`pyric simulate firestore`.** `--database <id>` selects the ruleset and
  binds `database`.
- **The MCP `firestore` tool and `pyric firestore <method>`.** A `database`
  argument, and `--database <id>` on the CLI, matching firebase-tools'
  `--database <databaseId>` on its `firestore:*` commands. RTDB tools take
  `instance`; Firestore uses its own word.
- **Seeds and imports.** The state file fixture (`PyricStateFile`),
  `pyric sandbox --seed` and `pyric snapshot` gain `firestoreDatabases`, read
  as in decision 5.
- **Checkpoints and branches** (`packages/pyric/src/sandbox/full-state.ts`,
  `sandbox/branches/`). A checkpoint holds every database. A branch diff
  and promotion work per database.
- **Denials and the runtime chip.** A denial explanation names the database
  and the ruleset it ran. The SDK's own error stays
  `Missing or insufficient permissions.`, as production sends it. The runtime
  chip lists each named database and whether `firebase.json` deploys rules to
  it.
- **Undo and redo.** Per database (decision 2). The tool takes `database`.

Out of scope: Firestore triggers with a `database` option in Cloud Functions.
The Cloud Functions priority picks them up, and the activity event's
`database` field is what they'll read.

### 9. Conformance

**Rows that flip** in `packages/conformance/registry/firestore.ts`:

| Row | Flips to `conforms` on |
| --- | --- |
| MD1 | `packages/pyric/test/firestore/named-database.test.ts` rewritten to assert that two ids hold different documents and that the decision 1 errors match; production reference: the Manage databases page |
| MD2 | the served-entry test asserting a named handle reaches its own database over a worker host, and the app scenario below |
| MD3 | `packages/pyric-admin/test/firestore/named-database.test.ts` asserting isolation on both arms, and a new app scenario `admin-writes-named-firestore-database`, modeled on `admin-writes-named-rtdb-instance` |
| MD4 | C1's observation `firestore-named-database-rules-api`, linked from MD4, plus the rewritten `named-database.test.ts` replaying its cases |

**New rows**, each added in the issue that builds it, with `firestore.json`'s
count raised by the same number in the same change (AGENTS.md item 6;
`packages/conformance/assurance-node-counts/firestore.json` is 194 today):

| Row | Behavior | Issue |
| --- | --- | --- |
| MD5 | `getFirestore(databaseId)` with the default app, and `initializeFirestore(app, settings, databaseId)` | #1316 |
| MD6 | rules `get()`, `exists()`, `getAfter()`, `existsAfter()` of another database | #1316, status from C2 |
| MD7 | a `DocumentReference` field or a batch or transaction reference from another database is refused with the SDK's message | #1316 |
| MD8 | a named database without deployed rules denies client access | #1319 |
| MD9 | a database that does not exist: the Admin SDK's `NOT_FOUND` and the client's offline `unavailable`, on C3's evidence; listeners and writes unverified | #1316 |
| MD10 | per-database rules from the `firestore` array, `target` and `database` forms | #1319 |

The refusal of a host that predates `workerProtocol` 2 (decision 4) has no
production counterpart, so it gets unit tests and a step in the app scenario,
not a row.

The Storage row `storage-rules#131` already covers Storage reading a named
database and is not duplicated.

**The differential test across planes.** An app scenario,
`test/apps/firestore-named-databases`, modeled on
`rtdb-named-instance-assurance`: a project whose `firebase.json` deploys
different rules to `(default)` and `reports`, writing the same path with
different data through each handle. It runs the in-page plane, the
SharedWorker, the Node host (`node --import @pyric/cli/register` with
`PYRIC_SANDBOX=remote`) and the in-process plane, and asserts the same reads,
the same verdicts, and `database` bound to each id on all four. #1316 starts it
with the in-page plane, and each later issue adds its plane.

### 10. The sequence

The order in Decision 3 for David holds. Each issue's plan is written after
this record merges, and its body is updated to match what's here.

1. **#1315**: the `(default)` entry of a `firestore` array. Independent of this
   record. Can land the resolver of decision 6 with only `(default)` consumed.
2. **#1316**: the identity module, one environment per database, the rules
   binding, the ported SDK errors, `SandboxSnapshot.firestoreDatabases`, and the
   sandbox `getFirestore` forms. Flips MD1 and, with a capture, MD4. Adds MD5,
   MD6, MD7, MD9 (a missing database answers as C3 recorded).
3. **#1317**: `databaseId` on the worker protocol, `workerProtocol` 2 on the
   connect exchanges, the served entry, the bridge relay and the Node host.
   Flips MD2.
4. **#1318**: per-database record spaces in the host store (schema 7), the
   SharedWorker's IndexedDB, and bundles. No row flips; its evidence is a
   restart scenario on the Node host with two databases.
5. **#1319**: per-database rules and indexes from the `firestore` array on every
   plane, with locked rules for an undeployed database. Adds MD8 and MD10.
6. **#1320**: `pyric-admin` `getFirestore(app, databaseId)` and
   `getFirestore(databaseId)` on both arms. Flips MD3.
7. **#1321**: the tools, `pyric verify`, replay, Studio, denials and the runtime
   chip (decision 8).

#1318 can run beside #1319 and #1320 once #1317 has merged: it touches only
persistence. Nothing else in the sequence runs in parallel, because #1316
changes the sandbox core every later issue builds on.

## Captures

All three captures use `packages/conformance/src/capture-firestore-named-databases.ts`
against the oracle project `digame-mas`, run one at a time under the shared
production-capture lock.

- **C1: Rules Test API against a named database's path.** Through
  `packages/conformance/src/run-rules.ts`, a scenario in
  `rules-corpus/firestore/` whose test cases address
  `/databases/probes/documents/...` and assert on `database`. It settles
  whether the API evaluates a named database's path and what `database` binds
  to there. It needs only `firebaserules.rulesets.test` and changes no
  production state. If the API refuses the path or always binds `(default)`, C2
  settles MD4 instead.

  Run 2026-10-28, observation
  `packages/conformance/observations/firestore/firestore-named-database-rules-api.json`,
  linked from MD4. The `run-rules.ts` corpus cannot express it, because
  `normalizeDocPath` in `packages/pyric/src/rules/test/spec.ts` always prefixes
  `/databases/(default)/documents/`, so the script's `rules-api` mode posts its
  own test cases with the credential `run-rules.ts` uses. Each probe is a `get`
  of `p/d1` as uid `a`, expecting ALLOW. A first attempt with the oracle
  service account was refused with 403, because that account lacks
  `firebaserules.rulesets.test`.

  | Probe | Under `probes` | Under `(default)` |
  | --- | --- | --- |
  | `allow read: if database == 'probes'` | ALLOW | DENY |
  | `allow read: if database == '(default)'` | DENY | ALLOW |
  | `allow read: if request.path[1] == 'probes'` | ALLOW | DENY |
  | `request.path == /databases/$(database)/documents/p/$(d)` | ALLOW | ALLOW |
  | `match /databases/probes/documents` (literal), `allow read: if true` | ALLOW | DENY |
  | `match /databases/(default)/documents` (literal), `allow read: if true` | DENY | ALLOW |
  | mocked `get(/databases/(default)/documents/c/x).data.v == 1` | ALLOW | ALLOW |
  | mocked `get(/databases/probes/documents/c/x).data.v == 1` | ALLOW | ALLOW |

  It settles MD4. It does not settle MD6, because a mock is not a read.
- **C2: real SDK against `probes`.** A deploy-observe-restore capture, like
  `storage-stdlib-real.ts`, that deploys a ruleset to the `probes` database's
  release and to `(default)`'s, then observes: what `database` binds to; whether
  `get()` and `exists()` in each database can read the other; and that the same
  path holds different documents. It settles MD6, adds deployed-rules evidence to MD4's, and gives MD1 an
  isolation observation. Deploying rules to `probes` changes production state, so
  it waits for David's yes (Decision 2 for David). It must snapshot the
  `cloud.firestore/probes` release before it deploys, restore it, and read it
  back to confirm, and it touches no other database.

  Not run yet. It waits for David's yes, given to him directly.
- **C3: a database that does not exist.** Run 2026-10-28, observation
  `packages/conformance/observations/firestore/firestore-named-database-absent.json`,
  linked from MD1. It reads one missing document from `pyric-absent-<run>`,
  `Bad_Id` and `default` through the client SDK 12.13.0 (no sign-in), the Admin
  SDK 13.10.0 and the REST API, with `(default)` and `probes` as controls. It
  reads only and creates nothing.

  | Database | Client `getDoc` | Admin `get()` | REST |
  | --- | --- | --- | --- |
  | `pyric-absent-<run>` | `unavailable`, client is offline | code 5, `NOT_FOUND: The database ... does not exist` | `404 NOT_FOUND`, same message |
  | `Bad_Id` | same | same | same |
  | `default` | same | same | same |
  | `(default)` (control) | `permission-denied` | missing document | `404`, `Document ... not found.` |
  | `probes` (control) | `permission-denied` | missing document | `404`, `Document ... not found.` |

  It settles decision 3's handling of a missing database and decision 1's
  reading of `default`.

## Consequences

- A project with a named database gets that database's own documents and rules
  in pyric, on every plane and in `pyric-admin`, and the tools say which
  database each request touched.
- Every snapshot, store, bundle and frame written before this change reads as
  `(default)`. `(default)`-only frames, events and files are byte-identical.
- An older host is never sent a database id it would silently ignore. Starting
  with the release that ships #1317, a mismatched host fails loudly.
- An older build refuses a version 7 host store and drops named databases from
  a newer bundle. Downgrades keep `(default)`.
- Until C2 runs, a rule reading another database denies, and MD6 says so.
- A database nothing declares behaves as missing, so a project that created a
  database in the console must name it in `firebase.json` to use it in pyric.
- `instances.ts`'s generic registry moves to a service-neutral module, a
  mechanical change in #1316.
- ADR-0011 gains a protocol version before its handshake exists. When phase D
  lands, `workerProtocol` becomes `transport.protocol.version` and the
  per-exchange fields retire.

## Decisions for David

1. **The worker protocol version field.** Decided 2026-10-27: add it now.
   Decision 4 says where it goes and who refuses.
2. **A capture against a named database.** The oracle project already has the
   `probes` named database, so nothing needs creating. Recommended: approve C2,
   which deploys and then restores rules on `probes`. It is the only way to
   settle MD6 (rules reading across databases); C1 settled MD4.
3. **The order.** Recommended: decision 10's order, which is the one proposed
   in #1314, with #1318 free to run beside #1319 and #1320.
