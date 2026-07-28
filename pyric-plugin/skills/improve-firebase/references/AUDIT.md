# Firebase audit playbook

Use this reference to select evidence, not to force every possible probe. Inspect the installed Pyric surface first; tool availability differs between the default MCP bridge, CLI, and programmatic registries.

## Contents

1. Evidence matrix
2. Authorization & identity
3. Data integrity & model fit
4. Queries, indexes, performance & cost
5. Runtime behavior & side effects
6. Production readiness & regression safety
7. Capability boundaries
8. Optional high-leverage Pyric surfaces

## 1. Evidence matrix

| Evidence | Pyric surface | What it proves | What it does not prove |
|---|---|---|---|
| E1 static rules | `firestore_lint_rules`; `pyric firestore rules lint`; Storage/RTDB lint and validate commands | Parseability, budgets, known unsafe constructs and smells | Runtime authorization for a concrete identity/state/query |
| E1 Standard Library | `rules_stdlib_list`; `rules_stdlib_get`; Firestore compatibility aliases on older versions | Available tested helpers, exact signatures, and service compatibility | That a helper fits the product model or proves a complete policy |
| E1 modular build | `rules_resolve_modules`; `pyric firestore rules resolve`; `pyric storage rules resolve` | Imports resolve to a deployable version 2 artifact; source/artifact comparison exposes drift | Runtime authorization or deployment state |
| E1 index extraction | `pyric firestore indexes generate <sources...> --out <temp>` | Composite shapes statically visible in supported query syntax | Runtime frequency, production build status, dynamic/admin-chain queries, necessity of every overshot branch |
| E2 sandbox census | `sandbox_inspect` | Active local Firestore rules, document counts, recent requests and denials | Production rules, production traffic, complete schema |
| E2 Firestore simulation | `firestore_simulate_rules` | Local decision for explicit rules, identity, operation, data/query, and mocks | Exact Firebase behavior where Pyric reports an unsupported/gap surface |
| E2 Firestore data plane | `firestore_query_where` and CRUD tools with `as` | Observable local query/data behavior under Rules for supported shapes | Production indexes, latency, scale, unseen data distributions |
| E2 RTDB structure | `rtdb_crawl_structure` | Bounded local tree shape without leaf values | Production tree shape or frequency |
| E2 RTDB authorization | `rtdb_simulate_access` | Local read/write/validate decision against active rules and state | Unsupported expressions or exact production parity outside the conformance contract |
| E2 simulator history | `firestore_simulator_*`, undo/redo/events | State transitions, transactions, and event ordering in an isolated local session | Production contention or network timing |
| E3 journey replay | `pyric verify [fixture]` | Candidate Rules preserve captured Firestore/RTDB requests and resulting state | Journeys never captured; Storage verification; general proof over all inputs |
| E4 hosted replay | `pyric verify --engine rules-test-api|both` | Firebase Rules Test API result for derived Firestore cases; `both` can reveal engine drift | RTDB hosted verification, production data/traffic, uncaptured behavior |
| Optional programmatic | discovery and assurance APIs when actually registered | Bounded schema sampling or mutation-based authorization counterexamples | Availability through the default plugin; permission to read/write production |

For every finding, record the strongest evidence actually obtained and any weaker evidence it corroborates.

## 2. Authorization & identity

Map each protected path to actor, operation, governing match/rule, and required query constraints.

Hunt for:

- unauthenticated or any-signed-in access to private or tenant-scoped data
- authorization derived from incoming `request.resource.data` rather than trusted existing state or claims
- ownership fields writable by the owner, allowing ownership transfer or privilege escalation
- cross-tenant document IDs, collection-group reads, or wildcard matches without a tenant invariant
- broad parent grants that compose with narrower matches unexpectedly
- create/update/delete sharing one condition despite different invariants
- missing field allowlists, type checks, immutable-field checks, or RTDB `.validate`
- claims assumed by Rules but never issued, refreshed, revoked, or handled by the client
- privileged flows that omit recent-login, email-verification, MFA, account-disable, or claim-refresh behavior when the product relies on them
- App Check assumed to be authorization, or absent on abuse-sensitive callable/HTTP endpoints where it would be a useful additional signal
- Admin SDK or Functions paths reachable from untrusted input without an equivalent authorization check
- callable/HTTP Functions that trust client-supplied UIDs, roles, redirect URLs, object paths, or payment/resource ownership
- query/rule mismatch: a query can potentially return documents the caller may not read
- public Storage objects, unsafe metadata/content-type trust, or path ownership gaps when Storage is used

Minimum proof for CRITICAL/HIGH:

1. Establish an ALLOW control representing intended behavior.
2. Mutate exactly one dimension: actor, tenant/path, operation, payload, or query.
3. Show the unintended ALLOW or common-journey DENY with E2+ evidence.
4. If Pyric reports unsupported semantics, downgrade to a hypothesis or use E4 hosted Firestore verification.

Useful identity matrix: signed out; valid owner; authenticated non-owner; same-role other tenant; required claim-holder; stale/missing claim.

## 3. Data integrity & model fit

Pair every important write with the invariants later reads assume.
For Firestore and Storage, inspect the service-compatible Standard Library
before proposing fields, custom metadata, object paths, or helper functions.
Use its signatures to inform the model, then keep only the helpers that express
real product invariants.

Hunt for:

- required fields not validated on create, or deletable/retaggable on update
- field types, enum values, timestamps, ownership, counters, or relationships trusted only by client code
- rules paths that do not match actual collection/RTDB structure
- dead rules and live paths with no meaningful boundary
- unbounded nested RTDB payloads or Firestore documents approaching size/write-rate limits
- joins implemented as serial reads; duplicated data with no fan-out consistency strategy
- arrays/maps chosen against the real access pattern
- write batches/transactions missing where invariants span documents
- schema migrations that strand older clients or documents
- secrets, tokens, or sensitive profile fields stored in broadly readable documents
- FCM registration tokens, password-reset/action links, session cookies, or provider tokens stored or logged outside their intended trust boundary

Firebase web configuration (`apiKey`, `authDomain`, project/app IDs, and related client initialization values) identifies a Firebase project and is normally shipped to browsers. Do not report it as a secret by itself. Report unrestricted non-Firebase credentials, service-account material, private keys, Admin credentials, or a concrete backend/API configuration that wrongly treats a public Firebase key as authorization.

Use local census/structure evidence for shape, but never generalize a sample into a complete production schema. Phrase sample-derived conclusions as coverage statements.

## 4. Queries, indexes, performance & cost

Build a query inventory from every shipped query/listener call site:

| Consumer | Collection/group | Filters | Order | Limit/cursor | Identity | Frequency | Expected cardinality |
|---|---|---|---|---|---|---|---|

Hunt for:

- a composite shape extracted from source but absent from committed `firestore.indexes.json`
- committed composite indexes with no visible query owner (candidate stale cost; do not delete from static evidence alone)
- extractor warnings, overshoot, unsupported/dynamic query construction, or admin-chain syntax hidden from extraction
- query constraints that do not encode the Rules boundary
- collection-group queries missing tenant/owner constraints
- listeners or collection reads without a limit/cursor on potentially large paths
- offset/growing-limit pagination instead of cursors
- N+1 reads, serial waterfalls, repeated existence checks, or fan-out listeners
- hot documents/counters, large payloads, redundant denormalized reads, or write amplification
- RTDB reads attached too high in the tree or missing `.indexOn` for supported queries

Index workflow:

1. Find real query source files; do not fabricate representative code.
2. Run extraction to a temporary file, never the configured production index path.
3. Review warnings and `@firestore-mutex`-style branch intent where supported.
4. Normalize and compare extracted composite definitions with committed config.
5. Link every missing index to its query owner and every extra index to an uncertainty, not an automatic deletion.
6. Prove Rules compatibility locally. Production build readiness requires Firebase Console/CLI observation and is outside a read-only audit unless the user supplies it.

## 5. Runtime behavior & side effects

Hunt for:

- listener lifecycle leaks, duplicate subscriptions, stale identity, and error callbacks omitted
- optimistic/local writes with no rejection recovery
- transactions whose retryable callback performs external side effects
- batched invariants implemented as independent writes
- offline/reconnect behavior that can overwrite newer state or confuse completion with server acknowledgement
- Functions that are non-idempotent, assume exactly-once delivery, recurse on their own writes, or expose unsupported trigger patterns
- RTDB `onValueCreated` handlers whose sandbox-visible writes differ from expected paths/state
- client and Functions/Auth boundaries that disagree about claims or ownership

Pyric can execute only the Functions shapes supported by the installed version. Report every omitted/unsupported trigger as untested; never extrapolate from a supported RTDB trigger to all Firebase Functions.

## 6. Production readiness & regression safety

Hunt for:

- primary user journeys absent from captured fixtures
- candidate Rules that introduce `now-allowed`, `now-denied`, state drift, unsupported replay, or engine drift
- local-only confidence where a hosted check is warranted for a high-risk Firestore boundary
- missing or ambiguous Firebase project selection, generated Rules not resolved for deployment, or index config not wired through `firebase.json`
- `firestore.modules.rules` or `storage.modules.rules` missing while generated Rules are hand-edited
- `firestore.rules` or `storage.rules` drifted from its modular source, or `firebase.json` pointed at the modular source instead of the generated artifact
- client-bundled secrets or accidental Admin credentials
- deploy scripts that can target the wrong project or deploy broader surfaces than intended
- Pyric conformance gaps relevant to the application's actual features
- tests that assert only ALLOW controls and never adjacent DENY mutations

Treat `pyric verify` as regression evidence, not a universal security proof. Coverage is the set of captured events and explicitly authored cases; name missing journeys.

## 7. Capability boundaries

- The default MCP bridge does not expose every programmatic Pyric tool. Index extraction is a CLI/library surface; discovery and assurance may require a custom registry.
- Service-neutral Standard Library tools may be absent on older Pyric versions. Use the Firestore aliases or bundled skill reference; do not invent a Storage tool.
- `sandbox_inspect`, RTDB crawl, and data-plane tools describe the connected local sandbox, not production.
- The Firestore Rules Test API requires existing credentials and project scope. Never solicit secrets into chat or create credentials.
- Production deployment and index build status belong to Firebase CLI/Console. Keep this audit non-mutating.
- Storage can be linted/simulated locally, but captured-session verification currently targets Firestore/RTDB.
- Unsupported/gap results are evidence about Pyric's limit, not evidence that Firebase allows or denies the operation.

## 8. Optional high-leverage Pyric surfaces

Use these only when the installed project or host actually exposes them. Their absence is not a reason to install packages, create credentials, or improvise an integration during an audit.

### Authorization assurance campaigns

Pyric's programmatic assurance surface can turn a known-good operation into bounded, one-dimension mutations and search for local counterexamples across Firestore, RTDB, and Storage. This is stronger than accumulating arbitrary deny examples because every probe retains its ALLOW control and names the invariant it challenges.

When `firebase_assurance_*` tools are registered, follow their state machine rather than skipping ahead:

1. `attach` to an isolated local target or `start` from explicit local rules/state.
2. `map` actors and known-good observations.
3. `define` plain-language ALLOW/DENY invariants with provenance and confidence.
4. `propose` mutations in exactly one dimension: path, query, payload, or operation.
5. `run`, then `inspect` capability qualifications and verdict evidence.
6. `minimize` a confirmed local counterexample without erasing the meaningful mutation.
7. `verify` through an available stronger engine when the finding warrants it.
8. `export` durable cases for the implementation plan.

Do not call an abstention a pass. Record unsupported constructs and registry gaps as Trust findings when they affect the application's real boundary.

### Bounded schema discovery

When `firestore_discover_paths` is registered with an authorized data source, start with its dry-run cost preview. Bound depth, samples, concurrency, and payload size; record reported read/list operations; resume only with the returned continuation. Use `firestore_find_collection_group` when the collection ID is known and only its host paths are unknown.

Discovery samples structure and field presence. It does not authorize data access, prove every production variant, or justify copying sensitive examples into plans. Prefer the connected local sandbox unless the user explicitly placed a production source in scope.

### Captured journeys as a regression corpus

The default `pyric dev` capture is unusually valuable because it binds actual application requests, identities, Rules, and resulting state into one replayable fixture. Rank a missing capture for a primary security or revenue journey higher than additional static style findings. A small corpus covering owner, non-owner, signed-out, privileged, and failure paths often produces more release confidence than a large ungrounded rules-test inventory.
