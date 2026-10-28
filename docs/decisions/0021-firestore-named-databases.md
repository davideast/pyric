# 0021: Firestore named databases

Status: Proposed

Date: 2026-10-27

Decides how pyric gives each Firestore database its own data, rules and SDK
selection on every plane. Builds on ADR-0011 (the worker protocol) and follows
the shape pyric already uses for Realtime Database instances.

Capture dates below are the UTC dates of their `observedAt` timestamps.

## Context

A Firebase project can hold up to 100 Firestore databases ("You can have a
maximum of 100 databases per project",
[Manage databases](https://firebase.google.com/docs/firestore/manage-databases),
Limitations). The first is `(default)`; any other is a named database.
Production keeps them apart in three ways:

- **Data.** "To create a client connected to a named database, set the
  database ID when you instantiate a client" (Manage databases). Each database
  has its own documents.
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

### What the sources and captures found

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
   port.
2. **The oracle project already has a named database.** The observation
   `packages/conformance/observations/storage-rules/stdlib-realstorage-p3-named-database.json`
   (captured 2026-07-21) read an existing named database `probes`, and the rig
   `packages/conformance/rigs/storage-stdlib-real.ts` lists "the existing
   `probes` named database" as a project feature. No capture needs a new
   database. C2 needs to deploy rules to `probes`, which changes production
   state.
3. **Storage rules cannot read a named database.** In the same observation, a
   Storage rule `firestore.get(/databases/probes/documents/...).data.allow == true`
   was denied both when the `probes` document held `true` and when it held
   `false` (registry row `storage-rules#131`). Pyric's refusal in
   `packages/pyric/src/storage/sandbox/rules-firestore-lookup.ts` ("Storage
   rules may access only the default Firestore database") matches it and stays.
4. **A missing database has no verdict of its own for the client** (C3,
   2026-10-28). Every request to a database the project lacks gets `NOT_FOUND:
   The database <id> does not exist for project <p> ...` from the backend. The
   Admin SDK rejects reads and writes with that message. The client SDK treats
   it as a connection failure and goes offline:
   - `getDoc` rejects with `unavailable`;
   - `onSnapshot` delivers a `fromCache` snapshot of a missing document;
   - `setDoc` stays pending.

   An id outside the naming rules (`Bad_Id`) and the keyword `default` get the
   same answer as a valid id that doesn't exist.
5. **Rules bind to the database the request addresses** (C1, 2026-10-28). For a
   request under `/databases/probes/documents/`:
   - the `{database}` wildcard binds `probes`, and `request.path[1]` is `probes`;
   - a literal `match /databases/probes/documents` block matches, and a literal
     `(default)` block does not;
   - a file with one literal root block per database compiles, and each block
     governs only its own database;
   - under a literal root, `database` is unbound. The compiler warns `Invalid
     variable name: database.`, and evaluating it fails with `Null value error.`

   A request under `(default)` gets the reverse in each case.

C2, which deploys rules to `probes`, has not run. It is the only capture that
can show whether a deployed rule in one database reads another database's
documents (decision 3).

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

**Asking for a database and declaring one are different acts.** Asking
(`getFirestore`, a frame's `databaseId`) accepts any string, because the SDK
does, and allocates nothing: a database nothing declared answers as missing
(decision 3). Declaring a database (decision 3 lists how) creates its
environment and its record space, so a declared id must pass the
[naming rules](https://firebase.google.com/docs/firestore/manage-databases):
4 to 63 characters, lowercase letters, numbers and hyphens, starting with a
letter, ending with a letter or number, and not shaped like a UUID. A project
declares at most 100 databases, `(default)` included, matching production's
quota. A declaration past the cap is refused with an error naming the cap. C3
confirms production treats `Bad_Id` and `default` as databases it lacks, so
`default` is a named database, never an alias for `(default)`.

The checks the client SDK makes are ported, with their messages. The Admin SDK
does not make them (decision 7):

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
- `refEqual` and `queryEqual` compare `firestore` identity, so references to
  the same path in two databases are not equal.
- Reading a stored reference to another database: the client logs `Document
  <name> contains a document reference within a different database
  (<project>/<db>) which is not supported. It will be treated as a reference in
  the current database (<project>/<db>) instead.` and returns a reference in
  the current database.
- Loading an SSR snapshot or bundle from another database:
  `Tried to deserialize key from different database: <a> vs <b>`
  (`invalid-argument`).

One new module, `packages/pyric/src/sandbox/internal/firestore-databases.ts`,
owns the id. It exports:

- `DEFAULT_FIRESTORE_DATABASE = '(default)'`;
- the function that normalizes an argument to an id;
- the naming-rule predicate, which also accepts `(default)`. Every declaring
  path uses it: `firebase.json`, the sandbox API, the worker `setRules` op,
  seeds, snapshots and bundles;
- the declaration cap;
- the record-space key for an id (decision 5);
- the registry key.

Every plane imports it (AGENTS.md item 4).

The keyed, lazily created map that `instances.ts` builds for RTDB
(`createDatabaseInstanceRegistry`) moves to a service-neutral
`resource-registry.ts` beside it, backed by a `Map`. RTDB keeps its `keyOf`,
which knows about project-derived default names. Firestore needs no such
mapping: its default key is always `(default)`.

Rejected:

- **Refuse a malformed id at `getFirestore`.** The SDK has none of that check,
  and C3 shows production fails the request, not the call.
- **Reuse `instances.ts` for Firestore ids.** RTDB names are hostnames parsed
  from URLs, lowercased, and default to `<project>-default-rtdb`. None of that
  applies.
- **Normalize `'default'` to `(default)`**, as RTDB accepts the keyword
  `default`. C3 shows production treats it as a named database.

### 2. The sandbox core: one environment per declared database

The sandbox holds a map from database id to `LocalEnvironment`, one per
declared database. The `(default)` entry is the environment `_env` holds today.

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
| `reset()` | clear every env's documents | clear every database inside one env |

Recommended: (a). Each environment already owns its store, rules, listeners,
transactions and history, so a second database is a second environment. The
work is in `SandboxImpl`:

- it wires each new env's events (`envUnsubs`) with the database stamped on;
- it calls `reevaluateLiveListeners` on every env when the user changes;
- `reset()` clears documents in every env. It keeps the declared set and each
  database's rules, as it keeps `(default)`'s rules today (the
  `hosted-reset-keeps-firestore-rules-with-lint-errors` scenario).

The clock is shared, so a pinned instant holds across databases.

**Every `getInternalEnv(sandbox)` caller must choose.** About 50 call sites
read the one environment today. Leaving them on a default that silently means
`(default)` would let every tool, Studio pane, rules-status read, branch diff
and undo path keep compiling while reading the wrong database (AGENTS.md
item 1). #1316 renames the function to `getDefaultDatabaseEnv`, adds
`getDatabaseEnv(sandbox, databaseId)`, and classifies each call site as
default-only or per-database in its plan. A test lists the callers of
`getDefaultDatabaseEnv`, so a new caller is a reviewed change.

`SandboxSnapshot` keeps `firestore` as the `(default)` documents and gains:

- `firestoreDatabases?: Record<string, Record<string, DocumentData>>` for the
  others, omitted when empty, parsed into a null-prototype object;
- `firestoreDeclared?: string[]`, the declared set (decision 3).

That is RTDB's layout (the default instance at the top level, named instances
under `instances`). Every snapshot written before this change loads as
`(default)` only. A loader refuses, naming the key, any key that fails the
naming rule. That covers `__proto__` and `constructor`. A loader also refuses a
`(default)` key, which belongs at the top level.

`appRuntime.service('firestore/default', ...)` in
`packages/pyric/src/firestore/instances.ts` becomes `firestore/<id>`, so
`getFirestore(app, 'reports')` returns one handle per app and id, as the SDK's
provider does. `initializeFirestore`'s "already been called" check in
`packages/pyric/src/firestore/persistence.ts` keys by id too.

Rejected: (b). It touches every engine under `packages/pyric/src/firestore/sandbox/`
and makes isolation a property every future read site must remember.

### 3. Rules, existence, and a missing database

**Each environment holds its own ruleset.** A request through a `reports`
handle evaluates `reports`' rules. `database` is `reports`, and
`request.path` and `resource.__name__` sit under `/databases/reports/documents/`.
C1 shows production does the same.

The places that hard-code one database today, each of which takes the
evaluating database's id:

- `packages/pyric/src/rules/grammar/FirestoreRules.ohm`: `ServiceBlock` accepts
  exactly one `DocumentsMatch`. It must accept several root blocks, because
  C1 shows production compiles a file with one literal root per database.
- `packages/pyric/src/rules/simulator/handler.ts`:
  - around line 580, the root match is skipped and matching starts at its
    children. A root with a literal database segment must match only that
    database. C1: a literal `(default)` root denies a `probes` request. Today
    pyric allows it, which allows what production denies;
  - line 337, the full path built for `request.path`;
  - line 452, `database: '(default)'` in the evaluation context;
  - lines 561 to 575, the root bindings. Every root wildcard, whatever its
    name, binds the id. Under a literal root, `database` stays unbound, as C1
    shows. Pyric binds it today for `(default)` too, which #1432 fixes.
- `packages/pyric/src/rules/simulator/request-path.ts`: `documentRelativePath`
  strips any `databases/<name>/documents` prefix. It must refuse a name other
  than the evaluating database, so a full-path case can't run against the wrong
  ruleset.
- `packages/pyric/src/rules/simulator/document-lookups.ts`:
  - `normalizeDocumentPath` replaces `$(database)` with `(default)` and strips
    only the `/databases/(default)/documents` prefix;
  - `makeGetResource` builds `__name__` under `(default)`.
- `packages/pyric/src/rules/simulator/evaluation-builtins.ts`: `afterLookupPath`
  (for `getAfter` and `existsAfter`) goes through `normalizeDocumentPath`.
- `packages/pyric/src/rules/simulator/wrappers/reference.ts`:
  - `equals` compares path strings only ("project/database not significant").
    It must compare the database. Otherwise
    `request.resource.data.owner == /databases/(default)/documents/users/$(uid)`
    is true in `reports` in pyric and false in production. Tests cover a
    reference to another database on each side of `==` and `!=`;
  - `referenceToResourceName` defaults `databaseId` to `(default)`; its callers
    pass the stored reference's database.
- `packages/pyric/src/rules/test/spec.ts`: `DB_PREFIX` hard-codes
  `/databases/(default)/documents/`, so `pyric rules test` specs gain a
  `database` field.
- `packages/pyric/src/storage/sandbox/rules-firestore-lookup.ts`: refuses any
  database but `(default)`. This stays, on the evidence of `storage-rules#131`.
  The lookup reads the `(default)` environment by name, never "the current one."

**`get()`, `exists()`, `getAfter()` and `existsAfter()` across databases
(MD6).** Firebase's docs do not say whether a rule in one database may read a
document in another. C1 shows the language accepts such a path: a mocked
`get()` of the other database evaluated in both directions. A mock answers
whatever path it names, so that says nothing about a real read. Until C2
settles it, a lookup of another database fails closed. Three requirements make
that true:

1. **The strip follows the evaluating database.** Only
   `/databases/<evaluating id>/documents/` is stripped. In `reports`,
   `get(/databases/(default)/documents/admins/$(uid))` is a lookup of another
   database. It must never read `reports`' own `admins/<uid>`, which would fail
   open for anyone who can write that document. A test covers exactly that
   case.
2. **The failure is a first-class `RuleError` value**, never a thrown host
   error (AGENTS.md item 2). Absorption then grants a request only when the
   other operand grants it alone (`error || true`), which production grants
   too. `!exists(other)` is an error, so it denies.
3. **Storage's `firestore.get` reads `(default)` by name**, as above.

If C2 shows production allows the read, pyric denies a request production
allows, and MD6 documents that until it is fixed.

**Existence.** Pyric can't see the console, so a database exists in pyric
when it is declared. Data alone never declares one. Ways to declare:

- a `firestore` entry in `firebase.json` names it, by `database` or by a
  `target` `.firebaserc` resolves to it (decision 6). An entry with no `rules`
  declares its database too, so a server-only project that uses `pyric-admin`
  needs only `{ "database": "reports" }`;
- the sandbox API: `declareFirestoreDatabase(sandbox, id)`, or `setRules` with a
  database id. Sandbox tests use these;
- a snapshot, seed or bundle that lists the id in `firestoreDeclared`.

The declared set is stored in the persistence `meta` record, apart from
documents. Deleting a database's last document doesn't undeclare it, and a
restart keeps it. `reset()` keeps it (decision 2). Removing an entry from
`firebase.json` undeclares a database the API didn't declare. Its documents
stay in its record space until "clear persistence" (decision 5).

**A declared database with no rules.** Production creates a database in
"production mode", which "denies all reads and writes from mobile and web
clients", or in "test mode", which allows them (Manage databases). A declared
database with no rules starts locked, unless the runtime runs in permissive
mode, which opens it as it opens `(default)`. Pyric logs this once per
database, as `undeployedInstanceNotice` does for RTDB. This rests on the docs'
description of the console. No capture checked it.

**A database that does not exist.** Every other id answers as C3 recorded:

| Call | Production (C3) | Pyric |
| --- | --- | --- |
| Admin SDK read or write, `pyric-admin` | rejects, gRPC code 5, `5 NOT_FOUND: The database <id> does not exist for project <project> Please visit https://console.cloud.google.com/datastore/setup?project=<project> to add a Cloud Datastore or Cloud Firestore database. ` | the same |
| client `getDoc` | logs the `NOT_FOUND` as a connection failure, goes offline, rejects `unavailable`, `Failed to get document because the client is offline.` | the same |
| client `onSnapshot` | one snapshot, `fromCache: true`, the document missing (188 ms) | the same |
| client `setDoc` | stays pending (unsettled after 20 s) | the same: pending until the handle terminates |

Pyric also logs one notice naming the `firebase.json` entry to add. If the
missing handle asks for a path where `(default)` holds a document, the notice
says so. That is the trail an upgrade leaves (Consequences).

Rejected:

- **Allow cross-database lookups until captured.** It could fail open.
- **Serve any id under locked rules.** The first draft proposed it, before C3.
  Admin access would then succeed in pyric where production fails with
  `NOT_FOUND`, so pyric would allow what production denies.
- **Declare a database by holding its documents.** Existence would then change
  when the last document goes away, and `pyric-admin` could never write a
  database's first document.

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
  `getActiveRules`, `getRulesStatus` with `service: 'firestore'`). `setRules`
  with a `databaseId` declares the database, under decision 1's naming rule
  and cap.

**Untrusted input.** Frames from a page, the bridge and the Node host's
sockets are untrusted. `packages/cli/src/serve/worker/inbound-validation/`
checks `databaseId`:

- it must be a non-empty string of at most 256 characters, or the frame is
  refused as malformed;
- any string within that bound is resolved, and an undeclared id answers as
  missing (decision 3) without allocating anything;
- only `setRules` declares, and only under the naming rule and the cap.

The Node host and the bridge share this check, so the same frame gets the same
answer on every plane.

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
- **A named-database frame waits for the peer's version.** Today
  `getWorkerVersion` (`packages/cli/src/serve/worker/client/connection.ts`)
  only guards against a stale worker and times out after 2 s. A client queues
  a frame with a `databaseId` until the version is known. A timeout counts as
  protocol 1. `(default)` frames don't wait.
- These clients refuse to send a named-database frame to a peer at protocol 1:
  - the `pyric-admin` remote arm;
  - the `@pyric/cli/register` Node client (the ADR-0011 amendment), through
    `attach-ack`;
  - the served page client.

  The error is
  `FirebaseError('failed-precondition', 'pyric: the host at <url> speaks worker protocol 1, which has no Firestore database ids. Restart it with @pyric/cli <version> or later to use getFirestore(app, "reports").')`.
- The bridge relays a frame carrying `databaseId` to a browser peer only if that
  peer's `hello` reported `workerProtocol` 2 or later. Otherwise it answers
  with the same error. A long-open tab from an older build is such a peer.

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
(`packages/cli/src/serve/hosted/persistence/database.ts`, namespace `hosted`),
and the SharedWorker keeps them in one IndexedDB database per key
(`packages/pyric/src/sandbox/persistence/backends.ts`).

`deserializeFromBuckets` merges every non-`meta` record into one document map.
So named databases cannot share a record space with `(default)`: an older
reader would merge them into `(default)`. Each named database gets its own
record space, keyed `<base>/firestore/<id>`:

- `<base>` is the existing key (`hosted`, or the IndexedDB key);
- `<id>` is a declared id. It matches the naming rule, so it contains no `/`,
  and the encoding is injective;
- the identity module refuses a base key that contains `/firestore/`. A test
  checks that no two (base, id) pairs collide, and that none collides with the
  RTDB or `(default)` keys.

The stores:

- **Node host.** Named databases' buckets live under their namespaces, and
  `(default)` keeps `hosted`. `HOSTED_SCHEMA_VERSION` goes to 7. Upgrading a
  version 6 store changes no rows: its records are `(default)`'s. An older
  build refuses a version 7 store with its existing `Unsupported hosted
  database version 7.`
- **SharedWorker.** A named database persists to its own IndexedDB database.
  The `meta` record, which holds service state and the declared set, stays in
  the `(default)` key only. An older worker never opens the new keys.
- **Single-file bundles** (`.pyric/state`, a browser `--persist` state file,
  the hosted state view, checkpoints and branches through `full-state.ts`).
  The `pyric-v3-records` bundle keeps its `records` as `(default)` and gains a
  sibling `firestoreDatabases: { <id>: <records> }`. A bundle with no named
  database is unchanged.

**Reset and clearing.** `reset()` clears every declared database's documents in
memory, and in every record space, `(default)` and named alike. A restart after
a reset brings back no named data. "Clear persistence" deletes every record
space under the base key, found by its `/firestore/` prefix (SQLite namespaces,
and `indexedDB.databases()` in the browser). That includes record spaces left
behind by databases no longer declared. #1318's scenario restarts the Node host
after a reset and checks that both databases come back empty.

**Downgrades.** An older build reading a newer bundle keeps `(default)` and
ignores `firestoreDatabases`. If it then saves `.pyric/state` or a checkpoint,
it writes a bundle without them, and the named databases' data is gone for
good. Pyric does not promise downgrades. The Consequences say so.

The rule for writing changed records, write-behind flushes, and quarantine
of a corrupt bucket applies per record space unchanged.

Rejected:

- **Bucket ids with a database prefix in the same record space.** Older
  readers merge them into `(default)`.
- **Raise the bundle format version for every bundle.** An older build reads
  an unknown bundle format as empty state, which loses `(default)` too.
- **Write version 7 only when a store first holds a named database.** The
  store's version would depend on its contents.

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

Pyric adds checks the CLI leaves to the API, each naming the entry:

- two entries that deploy different rules files to one database are refused.
  This follows `database-rules-config.ts` for RTDB: the CLI deploys both, so the
  configuration doesn't decide which ruleset production keeps;
- a `database` value outside the naming rules (decision 1) gets a startup
  warning, and its database is never declared, so it answers as missing
  (decision 3). Production can't hold that database. David chose to warn and
  serve rather than refuse at startup (#1444);
- more than 100 declared databases is refused, as decision 1's cap.

A target no `.firebaserc` mapping resolves waits for the page's project, as
RTDB targets do (the `rtdb-deploy-target-unresolved` app scenario), and the
dev server logs that it is unresolved.

One pure resolver, `firestoreRulesConfig` in
`packages/pyric/src/sandbox/internal/firestore-rules-config.ts`, exported from
`pyric/sandbox/internal`, returns the shape #1444 (closing #1315) ships:

```ts
interface FirestoreRulesConfig {
  form: 'absent' | 'object' | 'array';  // which firestore form firebase.json uses
  databases: {
    database: string;        // '(default)' or the named id, as written
    rulesFile?: string;      // absent: the entry declares its database and deploys no rules
    indexesFile?: string;    // filled when firebase.json names one
    label: string;           // 'firebase.json firestore[0]'
    configured: boolean;     // firebase.json names the rules file, so a missing file is an error
  }[];
  unresolved: { target: string; label: string; rulesFile?: string; indexesFile?: string }[];
}
```

It reads no file, as `database-rules-config.ts` reads none. The named-database
issues reuse it unchanged. Its fields beyond what firebase-tools reads:

- `configured` carries pyric's old fallback. Without a `firestore` key, or
  with an object that names no `rules`, `firestore.rules` in the project
  directory goes to `(default)` with `configured: false`. The array form has
  no fallback. Whether the fallback should stay is #1452.
- `form` lets a loader tell an object from an array, which the interim rule
  below needs.
- A Vite or `pyric.config` rules override becomes a `{ pyricRulesOverride:
  file }` entry, applied after resolving to whichever entry deploys to
  `(default)`, including one that reaches it through a `.firebaserc` target.
  `firebase.json` never holds this key.

**Until named databases land, an object that names another database keeps
enforcing on `(default)`.** For `{ "firestore": { "database": "reports",
"rules": "r.rules" } }`, main enforced `r.rules` on `(default)`. #1444 keeps
doing so, so no project loses enforcement it had. The resolver still reports
that the object deploys to `reports`, and startup warns: `firebase.json deploys
r.rules to Firestore database "reports". Pyric serves only (default) for now,
so it enforces r.rules on (default), and getFirestore(app, "reports") reads and
writes (default).` Named entries in an array get the matching warning and are
not served. #1319 ends both. From then on the object's rules govern `reports`,
`(default)` gets what pyric gives a `(default)` with no deployed rules today,
and the warning goes away. The Consequences list this as an upgrade change.

The planes pick the project for target resolution in different ways, so a
target can resolve on one plane and not another (#1454). Named databases
inherit that until #1454 is fixed.

Every loader calls the resolver:

- the dev server, SharedWorker, in-page runtime and Node host
  (`packages/cli/src/serve/rules.ts`);
- `@pyric/cli/register` with `PYRIC_SANDBOX=local`
  (`packages/pyric/src/app/register-rules.ts`);
- the in-process bridge (`packages/cli/src/bridge/server/in-process.ts`),
  which today ignores `firebase.json` for Firestore;
- `pyric verify` (`packages/cli/src/cli/verify.ts`);
- the indexes loader (`packages/cli/src/serve/index-config-store.ts`), so
  each database checks queries against its own indexes.

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

- **In-process arm.** The handle resolves to `getDatabaseEnv(sandbox, id)`
  through the admin lens.
- **Remote arm.** Each frame carries `databaseId` (decision 4). A host whose
  `attach-ack` predates `workerProtocol` 2 gets the `failed-precondition`
  refusal on the first named-database call, not at `getFirestore`, because
  the Admin SDK's `getFirestore` makes no network call.

**Mixing databases in the Admin SDK.** The client SDK's checks in decision 1
are not the Admin SDK's. In `@google-cloud/firestore` 7.11.6:

- `validateDocumentReference` (`build/src/reference/helpers.js`) checks only
  `instanceof DocumentReference`;
- `WriteBatch` and `Transaction` make no same-instance check;
- the serializer doesn't check a reference field's database.

So an Admin write of a reference to another database, or a batch spanning two
databases, reaches the backend, and the backend's answer is unknown. Until a
capture (C4) records it, pyric refuses both with its own `invalid-argument`
message. MD7's Admin half is marked unverified.

The pyric-specific `getFirestore(ctx)` form gains the same optional id
(decision 1).

### 8. Surfaces that carry the id

Each surface below names the database when it isn't `(default)`, and omits it
when it is, so `(default)`-only output is unchanged:

- **Activity events and the Studio feed.** Firestore events gain
  `database?: string`, as RTDB events carry `instance?: string`
  (`packages/pyric/src/sandbox/types/events.ts`). Studio shows it on the event
  and can filter by it.
- **Studio's data panes.** They select a database:
  - `packages/studio/src/features/data/FirestorePane.tsx`;
  - `FirestoreCreateModal.tsx`;
  - `FirestoreImportPanel.tsx`;
  - `FirestoreSeedBox.tsx`;
  - `FirestoreDocumentTree.tsx`.
- **`firebase/firestore/lite`.** `packages/pyric/src/firestore/lite.ts` and the
  served `packages/cli/src/serve/entries/firestore-lite.ts` take the id as the
  full entry does.
- **SSR snapshots and bundles.** `packages/pyric/src/firestore/ssr-snapshots.ts`
  and `bundles.ts` carry the database and refuse another database's data with
  the SDK's `Tried to deserialize key from different database` message.
- **Stored references.** The worker client's reference equality,
  `packages/cli/src/serve/worker/client/firestore-reference-equality.ts`,
  compares the database. Reading a reference to another database follows the
  client SDK's log-and-treat-as-current rule (decision 1).
- **Captures, replay and `pyric verify`.**
  - `.pyric/last-session.json` records each request's database.
  - Replay drives each request through a handle for that database.
  - `pyric verify` evaluates each request against that database's rules from
    `firebase.json` (decision 6).
  - Replay case types in `packages/pyric/src/rules/api/case-types.ts` gain
    `database?`.
  - `pyric verify` takes `--rules firestore=<path>` and `--rules
    rtdb:<instance>=<path>` today, but not a per-database Firestore override.
    #1321 adds `--rules firestore:<database>=<path>`, in RTDB's form.
- **`pyric simulate firestore` and `pyric rules test` specs.** `--database
  <id>` and a spec `database` field select the ruleset and bind `database`
  (decision 3).
- **The MCP `firestore` tool and `pyric firestore <method>`.** These take a
  `database` argument, and the CLI takes `--database <id>`. That matches
  firebase-tools' `--database <databaseId>` on its `firestore:*` commands. RTDB
  tools take `instance`, but Firestore uses its own word. That includes
  `discover` (`firestore_discover_paths`).
- **Seeds and imports.** The state file fixture (`PyricStateFile`),
  `pyric sandbox --seed` and `pyric snapshot` gain `firestoreDatabases` and
  `firestoreDeclared`, read as in decisions 2 and 5.
- **Checkpoints and branches** (`packages/pyric/src/sandbox/full-state.ts`,
  `sandbox/branches/`). A checkpoint holds every database and the declared
  set. A branch diff and promotion work per database.
- **Denials and the runtime chip.** A denial explanation names the database
  and the ruleset it ran. The SDK's own error stays
  `Missing or insufficient permissions.`, as production sends it. The runtime
  chip lists each declared database and whether `firebase.json` deploys rules
  to it.
- **Undo and redo.** Per database (decision 2). The tool takes `database`.
- **Lower priority.** The playground's `remote-export.ts` and `management.ts`
  hard-code `(default)`; #1321 covers them.

Out of scope: Firestore triggers with a `database` option in Cloud Functions.
The Cloud Functions priority picks them up, and the activity event's
`database` field is what they'll read.

### 9. Conformance

**Rows that flip** in `packages/conformance/registry/firestore.ts`:

| Row | Flips to `conforms` on |
| --- | --- |
| MD1 | `packages/pyric/test/firestore/named-database.test.ts` rewritten to assert that two ids hold different documents and that decision 1's errors match. The production reference is the Manage databases page; C3 shows only how a missing database answers. C2 adds an oracle observation of isolation |
| MD2 | the served-entry test asserting a named handle reaches its own database over a worker host, and the app scenario below |
| MD3 | `packages/pyric-admin/test/firestore/named-database.test.ts` asserting isolation on both arms, and a new app scenario `admin-writes-named-firestore-database`, modeled on `admin-writes-named-rtdb-instance` |
| MD4 | C1's observation `firestore-named-database-rules-api`, linked from MD4, replayed by the rewritten `named-database.test.ts`: wildcard binding, `request.path`, literal roots, several root blocks, and `database` unbound under a literal root. This is Rules Test API evidence; C2 confirms deployed rules enforce it |

**New rows**, each added in the issue that builds it, with `firestore.json`'s
count raised by the same number in the same change (AGENTS.md item 6;
`packages/conformance/assurance-node-counts/firestore.json` is 194 today):

| Row | Behavior | Issue |
| --- | --- | --- |
| MD5 | `getFirestore(databaseId)` with the default app, and `initializeFirestore(app, settings, databaseId)` | #1316 |
| MD6 | rules `get()`, `exists()`, `getAfter()`, `existsAfter()` of another database | #1316, status from C2 |
| MD7 | client SDK: a reference field, or a batch or transaction reference, from another database is refused with the SDK's message. Admin SDK: refused with pyric's message, unverified until C4 | #1316 |
| MD8 | a declared database without deployed rules denies client access (the docs' description of production mode) | #1319 |
| MD9 | a database nothing declares: C3's Admin `NOT_FOUND` on reads and writes, and the client's offline `getDoc`, `onSnapshot` and pending `setDoc` | #1316 |
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
different data through each handle. It runs:

- the in-page plane;
- the SharedWorker;
- the Node host (`node --import @pyric/cli/register` with `PYRIC_SANDBOX=remote`);
- the in-process plane.

On all four it asserts the same reads, the same verdicts, `database` bound to
each id, and the missing-database answers for an undeclared id. #1316 starts it
with the in-page plane, and each later issue adds its plane.

### 10. The sequence

The order in Decision 3 for David holds. Each issue's plan is written after
this record merges, and its body is updated to match what's here.

1. **#1315** (PR #1444): the `(default)` entry of a `firestore` array. It lands
   the resolver of decision 6 in its full shape, with only `(default)`
   consumed, and the interim object rule.
2. **#1316**: the core. Flips MD1 and MD4, and adds MD5, MD6, MD7 and MD9. It
   covers:
   - the identity module and the declared set;
   - one environment per database, and the `getInternalEnv` classification;
   - the rules sites in decision 3. #1432 can land first;
   - the ported SDK errors;
   - `SandboxSnapshot.firestoreDatabases` and `firestoreDeclared`;
   - the sandbox `getFirestore` forms.
3. **#1317**: `databaseId` on the worker protocol and its inbound validation,
   `workerProtocol` 2 on the connect exchanges, the served entry, the bridge
   relay and the Node host. Flips MD2.
4. **#1318**: per-database record spaces in the host store (schema 7), the
   SharedWorker's IndexedDB, and bundles, with reset and clearing. No row
   flips. Its evidence is a restart scenario on the Node host with two
   databases, including a restart after a reset.
5. **#1319**: per-database rules and indexes from the `firestore` array on every
   plane, with locked rules for a declared database without rules. It retires
   #1444's interim object rule and its warnings. Adds MD8 and MD10.
6. **#1320**: `pyric-admin` `getFirestore(app, databaseId)` and
   `getFirestore(databaseId)` on both arms. Flips MD3.
7. **#1321**: the tools, `pyric verify --rules firestore:<database>=<path>`,
   replay, Studio, denials and the runtime chip (decision 8).

#1318 can run beside #1319 and #1320 once #1317 has merged: it touches only
persistence. Nothing else in the sequence runs in parallel, because #1316
changes the sandbox core every later issue builds on.

## Captures

The captures that change no production state use
`packages/conformance/src/capture-firestore-named-databases.ts` against the
oracle project `digame-mas`. They run one at a time under the shared
production-capture lock.

- **C1: Rules Test API against a named database's path.** It ran on 2026-10-28.
  The observation is
  `packages/conformance/observations/firestore/firestore-named-database-rules-api.json`,
  linked from MD4.

  The `run-rules.ts` corpus can't express this capture: `normalizeDocPath` in
  `packages/pyric/src/rules/test/spec.ts` always prefixes
  `/databases/(default)/documents/`. So the script's `rules-api` mode posts its
  own test cases, with the credential `run-rules.ts` uses. Each probe is a `get`
  of `p/d1` as uid `a`, expecting ALLOW. A first attempt with the oracle
  service account was refused with 403, because that account lacks
  `firebaserules.rulesets.test`. The Test API deploys nothing.

  | Probe | Under `probes` | Under `(default)` |
  | --- | --- | --- |
  | `allow read: if database == 'probes'` | ALLOW | DENY |
  | `allow read: if database == '(default)'` | DENY | ALLOW |
  | `allow read: if request.path[1] == 'probes'` | ALLOW | DENY |
  | `request.path == /databases/$(database)/documents/p/$(d)` | ALLOW | ALLOW |
  | literal `match /databases/probes/documents`, `if true` | ALLOW | DENY |
  | literal `match /databases/(default)/documents`, `if true` | DENY | ALLOW |
  | two literal roots, `probes` `if true` and `(default)` `if false` | ALLOW | DENY |
  | the same two roots with the verdicts swapped | DENY | ALLOW |
  | literal `probes` root, `if database == 'probes'` (warns `Invalid variable name: database.`; `Null value error.`) | DENY | DENY |
  | mocked `get(/databases/(default)/documents/c/x).data.v == 1` | ALLOW | ALLOW |
  | mocked `get(/databases/probes/documents/c/x).data.v == 1` | ALLOW | ALLOW |

  It settles MD4. It does not settle MD6, because a mock is not a read.
- **C2: real SDK against `probes`.** This is a deploy-observe-restore capture,
  modeled on `storage-stdlib-real.ts`. It must:
  1. snapshot the `cloud.firestore/probes` release before it deploys;
  2. deploy a ruleset to `probes` whose rules `get()` and `exists()` a
     run-scoped document in `(default)`;
  3. observe the verdicts through the real SDK, and that the same path holds
     different documents in each database;
  4. restore the release, read it back, and confirm it matches the snapshot;
  5. remove its run-scoped documents and touch no other database.

  It settles MD6 in that direction, adds deployed-rules evidence to MD4, and
  gives MD1 an oracle observation of isolation. Deploying rules to `probes`
  changes production state.

  Not run yet. It waits for David's yes, given to the session that runs it.
- **C3: a database that does not exist.** It ran on 2026-10-28. The observation
  is
  `packages/conformance/observations/firestore/firestore-named-database-absent.json`,
  linked from MD1.

  It reads one missing document from `pyric-absent-<run>`, `Bad_Id` and
  `default` through three paths: the client SDK 12.13.0 (no sign-in), the Admin
  SDK 13.10.0 and the REST API. `(default)` and `probes` are read-only controls.
  Then, against the missing databases only, it tries a client `setDoc`, a client
  `onSnapshot` and an Admin `set()`. Every call is bounded at 20 s. A write to a
  database that doesn't exist creates nothing.

  | Database | Client `getDoc` | Client `onSnapshot` | Client `setDoc` | Admin `get()` and `set()` | REST |
  | --- | --- | --- | --- | --- | --- |
  | `pyric-absent-<run>` | `unavailable`, client is offline | `fromCache` snapshot, missing | pending | code 5, `NOT_FOUND: The database ... does not exist` | `404 NOT_FOUND`, same message |
  | `Bad_Id` | same | same | same | same | same |
  | `default` | same | same | same | same | same |
  | `(default)` (control) | `permission-denied` | not run | not run | missing document (read only) | `404`, `Document ... not found.` |
  | `probes` (control) | `permission-denied` | not run | not run | missing document (read only) | `404`, `Document ... not found.` |

  It settles decision 3's handling of a missing database, MD9, and decision 1's
  reading of `default`.
- **C4: the Admin SDK mixing databases.** An Admin write of a reference to
  another database, and a batch spanning `(default)` and `probes`. It records
  the backend's answer for MD7's Admin half. Its writes land in real databases
  (run-scoped, then removed), so it waits for David's yes with C2.

## Consequences

- A project with a named database gets that database's own documents and rules
  in pyric, on every plane and in `pyric-admin`, and the tools say which
  database each request touched.
- **Upgrading changes what a named handle does.** Today
  `getFirestore(app, 'reports')` works and writes into `(default)`. After
  #1316, an undeclared `reports` answers as a missing database: the client goes
  offline and the Admin SDK gets `NOT_FOUND`. Documents written through it
  before the upgrade are still in `(default)`. The notice in decision 3 names
  the `firebase.json` entry to add and says when `(default)` holds documents at
  the paths asked for. Pyric moves no data. The release notes list this under
  "Behavior changes", as a fix that moves pyric closer to production.
- **An object `firestore` that names another database moves its rules.**
  Until #1319, pyric enforces such an object's rules on `(default)` with a
  warning (decision 6). After it, they govern the named database. `(default)`
  then gets what pyric gives a `(default)` with no deployed rules, unless
  another entry deploys to it. The release notes list this under "Behavior changes".
- A database nothing declares behaves as missing, so a project that created a
  database in the console must name it in `firebase.json`, with or without
  rules, to use it in pyric.
- Every snapshot, store, bundle and frame written before this change reads as
  `(default)`. `(default)`-only frames, events and files are byte-identical.
- An older host is never sent a database id it would silently ignore. Starting
  with the release that ships #1317, a mismatched host fails loudly.
- **Downgrades lose named data.** An older build refuses a version 7 host
  store. It reads a newer bundle as `(default)` only, and if it then saves, the
  named databases' data is gone for good.
- Until C2 runs, a rule reading another database denies, and MD6 says so.
  Until C4 runs, pyric refuses Admin writes that mix databases under its own
  message.
- `getInternalEnv` stops being a silent default, and every caller states which
  database it means.
- `instances.ts`'s generic registry moves to a service-neutral module, a
  mechanical change in #1316.
- ADR-0011 gains a protocol version before its handshake exists. When phase D
  lands, `workerProtocol` becomes `transport.protocol.version` and the
  per-exchange fields retire.

## Decisions for David

1. **The worker protocol version field.** Decided 2026-10-27: add it now.
   Decision 4 says where it goes, who refuses, and how a named-database frame
   waits for the answer.
2. **Captures that write to the oracle project.** The oracle project already has
   the `probes` named database, so nothing needs creating. Recommended: approve
   both:
   - C2, which deploys and then restores rules on `probes`. It is the only way
     to settle MD6;
   - C4, which writes run-scoped Admin documents to `(default)` and `probes`
     and removes them. It settles MD7's Admin half.
3. **The order.** Recommended: decision 10's order, which is the one proposed
   in #1314, with #1318 free to run beside #1319 and #1320, and #1432 free to
   land before #1316.
