# Premortem: hosted sandbox and live mode

Date: 2026-09-12. Reviewed plan: [implementation sequence](hosted-sandbox-live-mode-sequence.md). Source baseline: `c3555ac5`; live spike: `824d8f5b`.

These are hypothetical future failures, grounded where possible in current code. They are not claims that an implemented hosted/live release has these defects. “Evidence” identifies an existing mechanism or an omission in the plan; “failure” describes what could happen if we carry it forward unchanged.

## Finding

The plan identifies many of the right modules but does not fully specify their interactions. Words such as “one lifecycle,” “bounded,” “restore,” “durable,” and “preserve SDK behavior” leave consequential decisions to individual implementation PRs. That is where complexity and production failures would enter.

The greatest risks are preserving only part of the existing host behavior, selecting the wrong execution target or identity, promising durability without defining acknowledgment semantics, and turning a short-lived browser runtime into a server that runs indefinitely. Named booleans help readability; they cannot fix incorrect ownership or ordering.

## Part I: implementation is finished, and we regret the code

### I1. We reused the dispatcher but lost the scheduler

**What happened.** The Node shell calls `handleMessage` for every incoming frame without awaiting earlier messages. Sign-in, a write, and disconnect race. We patch individual handlers with readiness promises, flags, and extra checks. The shell is short, but every handler now compensates for missing ordering.

**Evidence.** `serve/worker/entry.ts` maintains a `messageQueue` per physical port and awaits `handleMessage`. The dispatcher alone does not contain this guarantee. Bridge consumer dispatch is asynchronous. The plan describes the shell as wiring but does not explicitly move or preserve its scheduling behavior.

**Prevention.** Put dispatch ordering in the shared host contract. Define which frames are ordered per logical consumer, what host-wide reset/import requires, and how teardown waits for already-accepted work. Do not serialize every consumer behind one slow operation. Test a delayed sign-in → write → deleteApp sequence, unrelated consumers progressing concurrently, and an old connection completing after replacement. Keep transaction conflict handling in the existing engine.

### I2. “One lifecycle” became an oversized manager

**What happened.** A single module owns socket backoff, auth, configuration, listeners, file flushing, peer registration, credential refresh, and UI status. It has combinations of `connected`, `ready`, `restoring`, `closed`, and `hasSession` that can contradict one another. Every new feature adds optional HostCtx fields and another fallback.

**Evidence.** The plan puts many responsibilities under one lifecycle heading. Current HostCtx already carries caches and optional capabilities; client lifecycle state is split across maps. Consolidating ownership is useful, but merging all implementations would compound the problem.

**Prevention.** Give each resource one owner: connection state and pending work; host execution ordering; session authorization and upstream disposal; storage commits; observation retention. Compose those modules through small interfaces. Represent mutually exclusive states with discriminated unions. A socket close should trigger a named transition, not manually edit five flags in several callers. Add no generic lifecycle framework unless actual implementations need it.

### I3. The wire codec became a second Firestore implementation

**What happened.** The encoder understands transport envelopes, SDK object internals, sentinel evaluation, persistence migration, equality, and capture redaction. Its public input and output are `unknown`; callers add casts and special cases. Updating one SDK value breaks five consumers.

**Evidence.** The proposed “one codec” touches several distinct meanings. Existing code already separates marker rehydration from `prepareWriteData` and transaction canonicalization. Those separations matter.

**Prevention.** Keep one documented marker contract but separate value encoding, wire-envelope parsing, write-intent decoding, and equality. Keep SDK-specific recognition at the SDK adapter. Do not evaluate sentinels while encoding. Test real values alongside ordinary user maps that resemble reserved markers, nested transforms, references, and malformed markers. Preserve the existing public wire where required or version the change deliberately.

### I4. TypeScript approved a fiction

**What happened.** Every adapter claims to satisfy the complete SDK through `as unknown as`. Tests use a fake upstream that matches our invented interface. The real SDK has overloads and objects the fake never represented. We add `any`, optional fields, and defensive property probing until things appear to work.

**Evidence.** The served Firestore entry casts the worker module to the in-page module type. The live spike casts its loader into function shapes and requires a `path` on its structural query interface. These are compatibility assumptions to prove, not a demonstrated live SDK contract.

**Prevention.** Define the supported live surface explicitly. Use SDK types at the adapter and contract tests with real SDK objects; validate each overload we advertise. Keep necessary foreign-library casts narrow and explained. Use TypeScript inference and `satisfies` to check concrete implementations. Do not force every future operation into an elaborate generic registry merely to eliminate a local cast.

Runtime input validation is a separate obligation from type compatibility. Validate converted document data before accepting it into a queue. A late host refusal can otherwise reject valid writes that the caller expected to retain after catching the invalid input. The current atomic root-validation proofs address this failure; nested values and complete adapter declarations remain open.

### I5. Named conditions made the code longer without making it clearer

**What happened.** We replace a long `if` with one enormous `const shouldHandle`, or create `isDefined`, `isNotNull`, `hasValue`, and `canContinue` for the same fact. Predicates move to tiny files, making one decision require several jumps. Extracting an expression also accidentally evaluates work that used to short-circuit.

**Evidence.** The plan has no code-quality acceptance gate. The current conventions allow simple inline conditions, while the user's requirement is stronger: branches should use named variables for logical expressions.

**Prevention.** Every boolean branch reads a named local decision. Compose a complicated decision from a small number of domain facts. Preserve evaluation order and TypeScript narrowing. Use staged guards when a later expression requires an earlier fact. Do not cache a derived boolean across an `await` unless it intentionally describes the earlier moment. A helper must encapsulate a coherent rule, not merely relocate operators. Review new abstractions and casts, not just condition syntax.

### I6. We completed horizontal infrastructure before proving the app path

**What happened.** We finish a codec, a host, a lifecycle abstraction, and an event relay. Only then do we try the actual Vite template. Startup has a module cycle, real Firebase imports resolve to the mirror, and the Auth handle belongs to the wrong implementation. Fixing it changes all four foundations.

**Evidence.** `entries/worker-runtime.ts` chooses a path at module evaluation; `entries/runtime.ts` imports that choice and asynchronously fetches init data. `vite-module-swap.ts` redirects Firebase imports in both Vite and dependency optimization. The spike dynamically imports `firebase/firestore`. The normal served Auth entry is also mirrored.

**Prevention.** Before broad extraction, prove two thin paths through the actual entry points: a browser using a hosted sandbox, and a browser recording one genuine upstream read with the intended Auth/App instance. Prove the real SDK import bypass in both served import maps and Vite optimization. Inject fixtures or use an isolated test backend; these proofs do not require production data. Let the proofs establish the smallest necessary seams.

## Part II: users install it, and the reports accumulate

**Persistence implementation finding.** Three real caller paths now restore an acknowledged document after immediate process termination. Filesystem fault injection exposed a separate failure: the SDK acknowledged an in-memory commit after its disk write failed, and then executed another mutation. The host now distinguishes the committed-but-not-durable SDK outcome and refuses subsequent Firestore SDK mutations; MCP also reports the committed state. This does not complete all-service admission or recovery. Review found unconditional MCP/CLI flushes, the additional HTTP state writer, legacy import, v3 backup/count handling, private checkpoint storage and interrupted multi-record commits still need explicit treatment.

**Service CLI correction.** Disk-fault tests showed that unconditional CLI flushes also rejected reads and replaced a rules refusal with a false committed-state claim. The CLI path now flushes successful durable mutations, admits reads with an unhealthy-memory notice, and preserves rules refusals. Its general `write` effect also includes held-identity switches; those must remain available without disk writes so an operator can inspect under the intended rules identity. That distinction now has a caller-visible proof. Full MCP policy, service/control classification, partial-failure outcomes and recovery still need their gates.

### R1. “Sometimes my teammate and I see different databases”

**Current partial evidence.** Hosted MCP and service CLI calls now reach the Node sandbox used by browser SDK imports. A CLI test using a copied discovery pointer initially wrote successfully into another project. Requests now carry the canonical caller directory, and the host refuses callers outside its project tree before executing a method. Instance pinning remains a separate check. This does not establish exclusive writer ownership, stale-discovery behavior in every consumer, or durable restoration.

**Cause.** Init is slow or fails, so one page boots an in-page or SharedWorker sandbox before learning that hosting was requested. Another page reaches the Node host. A stale discovery file, reused dev-server port, or background MCP process introduces another authority.

**Evidence.** Transport selection is currently synchronous and availability-based. The plan says selection moves into init but does not specify the failure transition. The existing persistence writer lock is an in-memory lease inside one process, not exclusion between two CLI processes.

**Release gate.** Hosted selection never silently changes to a local store. Show connecting or a targeted failure. Validate canonical project identity and current host identity before restoring a session. Start two CLI processes against the same state directory: the second must attach or refuse without writing. Repeat with a stale discovery record and a different project on the old port.

**Ownership implementation finding.** Native lock availability is also a runtime and packaging boundary: the first addon worked under Node but aborted Bun on an unsupported libuv call. Built-in SQLite removes that dependency, but requesting an exclusive transaction introduced a second failure in which simultaneous starters both refused. A non-blocking immediate write reservation avoids that upgrade race. CLI contention, canonical aliases, process termination and the copied standalone executable now have dedicated scenarios; every remaining writer entry point and full persistence/lifecycle behaviour still require proof.

**Additional writer/restart findings.** Both a non-hosted CLI with `--persist --fresh` and Vite persistence bypassed the hosted lock and advertised readiness against occupied state. Both now acquire the same canonical reservation. Review with a real Vite restart exposed premature replacement teardown: the old server's closeBundle hook closed the newly active generation and released its ownership. Per-server generation cleanup preserves the replacement, its lock and SDK-visible data. Failure before readiness and subsequent reopening are covered; full failure-path resource accounting and other writer entry points remain open.

**In-process entry findings.** Missing discovery let MCP open another persisted sandbox beside a running host, and an explicit in-process service command acknowledged a write while MCP owned the same directory. Both now reserve canonical project state before loading it; normal MCP attachment remains verified. Graceful close, startup failure, project selectors and the copied standalone in-process path have evidence. Exclusion does not unify the legacy runtime, snapshot or Storage sidecar; adoption/migration remains open.

**Stdio discovery finding.** Checking only the health response leaves two gaps: a copied pointer can select another project's host, and the host can restart after discovery but before MCP initialization. Both initially admitted the connection in real stdio tests. Requests now carry the canonical pointer directory and pinned instance; the endpoint verifies them before session creation or resume. Legitimate subdirectory, symlink and Unicode workspace discovery remain supported. Headers are caller-supplied context, not authentication; direct clients without them and older servers that ignore them do not inherit these guarantees. Full admission and version negotiation remain release requirements.

### R2. “After refresh, I am another user—or my requests run under an unexpected lens”

**Cause.** A session ID is treated as proof of ownership. A frame supplies another consumer's session ID, two tabs resume the same identity, or the old socket's close callback removes the new socket's state. Sandbox impersonation is mistaken for a real credential.

**Evidence.** `createConsumerSession` accepts supplied session IDs and uses a per-frame session ID override for ops/subscriptions. Remote lens messages address a target client ID. Detach cleanup operates by ID. Those are trusted development conventions, not sufficient credential-bearing session admission.

**Release gate.** Explicitly declare whether a hosted instance is a fully trusted collaboration environment or enforces client privileges. Bind ordinary frames to the admitted connection; separately authorize privileged cross-session actions. Fence cleanup and replies by connection generation. Test duplicate attach, old-socket close after new attach, session overrides, tenant changes, and real credential refresh. Make this decision before any shared-host release, not only before live LAN support.

### R3. “Messages duplicate, writes disappear, and signing out leaves me online”

**Cause.** Reconnect retries a write whose reply was lost, establishes data listeners before auth restoration, or preserves an old RTDB disconnect queue forever. Alternatively, a transient socket interruption triggers a permanent app deletion. One recovery path handles peer replacement, another consumer reconnect, and another host restart.

**Evidence.** These are distinct paths today: bridge peer replacement reissues subscriptions; consumer detach removes them; worker cleanup drains RTDB onDisconnect work. The plan needs a transition contract across those paths.

**Release gate.** Test lost acknowledgment after a non-idempotent mutation, interrupted auth restoration, TCP loss without a clean close, laptop sleep, explicit deleteApp, and restart. Define when RTDB connectivity changes, when disconnect work runs, what survives a resume, and when stale sessions expire. Never retry an uncertain mutation automatically. SDK transaction retries remain governed by their explicit contract.

**Stdio acknowledgment finding.** Two separate proxy branches encouraged retries after committed writes: an HTTP connection failure and the proxy's request deadline. Real tests now drop or withhold an add-document acknowledgment, then read one document through normal browser imports. Both initially failed on the retry-oriented error and now receive explicit uncertainty guidance. A shared message keeps those branches consistent; request replay behavior is unchanged. Other refusal classifications, late replies, pending/settled request bounds and complete shutdown remain open.

**Current partial evidence.** The hosted listener proof now requires the original Auth identity to read a document changed during socket loss. The lost-ack proof reads the single committed increment after the original app reconnects. A separate RTDB red/green cycle exposed disconnect intent being delayed until session expiry; the host now drains it after previously accepted work without clearing Auth. The reviewed app reconnects, writes again and deletes itself; a fresh observer still sees that later value, proving the consumed registration did not rerun on deletion. Connectivity notifications, unclean TCP loss/heartbeat, tenant/lens restoration, stale generations, expiry and complete cleanup remain open release requirements.

The subsequent connectivity slices prove .info/connected listener transitions at the app SDK. Physical loss and explicit goOffline both report false; reconnect respects an app's offline choice. Parent .info snapshots now follow connectivity, and the in-page path observes its existing connection owner. Review preserves unsubscribe, onlyOnce and deleted-app refusal across hosted, SharedWorker and in-page execution. Four further query cycles fix parent-field filtering, in-page updates and duplicate callbacks for unchanged selections. A shared pure query projection preserves the existing backend algorithm, and review checks empty results and scoped off across all three runtimes. Scalar metadata queries, remaining constraints, reset/import and full host offline behavior remain unproven; these listener checks do not close the connectivity or cleanup gates.

A further design trap was treating get(.info) as interchangeable with onValue/onlyOnce. An actual SDK probe taken offline before first connection delivers local metadata through the listener, while get remains pending at a one-second deadline. The SDK uses different internal paths for these APIs. The plan retains a separate get contract investigation; a listener result is insufficient evidence for a cached get implementation or an indefinite-pending claim.

**MCP persistence-policy finding.** Unconditional flushing made reads fail when the state directory became unwritable, and replaced useful Auth refusals with a generic committed-state error. Declared tool effects now separate read availability from mutation admission. Returned failures still flush because a bulk import can create a user before rejecting another entry. The original receipt survives a failed flush with a separate uncertainty notice; successful reads disclose unhealthy memory. CLI review exposed the same partial-failure risk: the successful first write in a sequential batch was excluded from the host flush because a later write failed. The CLI now shares the result-flush policy; a disk-failure TDD cycle preserves both errors, and characterization verifies restart durability and subsequent mutation refusal. These proofs do not establish complete tool classification, other partial-failure paths, all SDK service admission or recovery.

### R4. “The UI showed success, but a restart lost my data”

**Legacy mirror finding.** Hosted mode mounted the writable legacy state channel even without explicit `--persist`. A caller with the current session capability could replay an older valid mirror after a newer SDK write acknowledged. Running memory retained the new value, but process restart restored the old one. The session now declares the channel's owner; hosted writes return 423 before body collection while reads remain available. The public SDK/restart test and SharedWorker persistence handoff pass. Separate CLI/Vite servers and other writer entry points remain an ownership obligation.

**Storage implementation finding.** A successful controller flush did not persist Storage at all: Node's Storage fallback remained in memory. A failing SDK restart test now drives snapshot/restore of bytes and exact backend metadata through the existing state-file owner. Upload/delete errors and later admission are also tested. A second test then reproduced an older asynchronous snapshot overwriting a newer acknowledged upload. Explicit hosted flushes now serialize the complete controller/Storage operation. That alone did not protect reset: a paused save restored a cleared object after reset acknowledged. The shared reset handler now waits for the runtime persistence policy; hosted reset admission also refuses before clearing memory when persistence is unhealthy. Both failures have public remote/SDK red-green proofs. Separate section replacements still are not one atomic multi-service commit; snapshot coherence, automatic controller flushes, reset generations, all buckets and recovery remain release requirements.

**Cause.** Success means the in-memory mutation finished, although the file write failed. Firestore restores while Storage bytes or auth records do not. A stale flush completes after reset and resurrects data. A backup is overwritten during recovery. An atomic rename was treated as a complete power-loss durability guarantee.

**Evidence.** `bestEffortFlush` catches errors and still permits success. Storage persists separately. The current state file uses synchronous atomic replacement. The plan names durability but leaves the exact success contract open.

**Release gate.** Settle what acknowledgment guarantees and how a committed-but-not-persisted mutation is reported without encouraging a duplicate retry. Test process termination at commit points, disk full, denied writes, corrupt state, concurrent flushes, reset/restore races, and restart of every advertised service. Specify the failure model: process crash recovery is different from promising survival of machine power loss.

### R5. “It works in the morning and becomes unusable by afternoon”

**Cause.** The socket queue is bounded, but host event history, pending calls, reconnect records, and capture serialization are not. Slow Studio consumers compete with app replies. Repeated whole-history capture grows increasingly expensive. A debounce that continually resets never captures a busy session. Synchronous file writes block every client.

**Evidence.** `SandboxImpl.dispatch` unconditionally appends to `eventHistory`. Capture rebuilds a full fixture and resets its timer on every event. The file store uses synchronous writes. None is automatically suitable for a long-running shared host.

**Release gate.** Give retained history, capture, pending operations, per-client queues, and expired sessions explicit bounds and overflow behavior. Preserve completeness claims by reporting dropped ranges or using a defined capture-retention policy. Set a maximum capture delay. Run a representative sustained workload with a stalled consumer; memory should plateau under the declared retention policy and an unrelated client's response latency should stay within an agreed budget. Avoid an unmeasured persistence-engine rewrite.

### R6. “Live mode says it is connected, but it isn't using the real app”

**Cause.** The upstream import is swapped back to Pyric, or fails as an unresolved browser import. Real Firestore and mirrored Auth share superficially compatible handles but different app ownership. After HMR there are two recorders or two SDK instances. Cache/network control functions retain sandbox no-op behavior in live mode.

**Release gate.** Run a packed installation through Vite cold optimization, warm optimization, served import maps, HMR, and page reload. Assert which implementation executes each operation, which Auth/App it uses, and how many upstream calls and recorder subscriptions exist. In live mode, forward supported SDK controls or report an explicit limitation. Never fall back to a sandbox result after a real upstream failure. Mode changes require a defined teardown/reconstruction path; no arbitrary toggle on existing references.

### R7. “The recorder changed my app's behavior”

**Cause.** Snapshot serialization calls a user converter twice, a getter throws, a recorder mutates the supplied object, or cloning blocks a large listener delivery. Metadata-only events vanish under JSON deduplication. An observer exception is mislabeled as an upstream failure. Unsupported operations silently take the sandbox path.

**Evidence.** The spike observes `snapshot.data()` and passes the original snapshot onward. It estimates listener changes and has a partial operation surface. Bridge replay uses serialized-value equality to suppress a repeated initial snapshot.

**Release gate.** Compare instrumented and uninstrumented executions using real SDK objects and representative overloads: converters, metadata options, query cursors, field transforms, errors, and observer exceptions. Check upstream call counts, converter invocation counts, result identity, and listener sequences. Publish a supported-operation table; refuse unsupported live routes before spending work. Keep snapshot delivery, observed server decisions, and recording success separate.

### R8. “Studio's explanation is confidently wrong”

**Cause.** The request is replayed with today's rules, a later identity, or data another user saw yesterday. A limited query removal is interpreted as deletion. A write estimate becomes an observation. Event IDs collide across page recorders, or late events arrive after a reset and rebuild an obsolete shadow.

**Evidence.** The plan discusses unknown state but needs temporal and multi-producer semantics. The spike's recorder has a per-recorder `live-<sequence>` ID and its explainer uses the current shadow. Current capture uses rules from the init payload.

**Release gate.** Give observations producer identity, producer sequence, request identity, execution target, observation source/time, and a host/reset generation. Separate host arrival order from backend commit order. Define duplicate and stale-event handling. Explain against the captured context or explicitly say what cannot be reconstructed. Test two producers with the same local sequence, changed rules, limited queries, auth changes, and reconnect delivering old observations.

### R9. “One bad client takes down everyone's sandbox”

**Cause.** A TypeScript type guard checks only the frame discriminator and then code assumes the nested payload is valid. Large, deeply nested, or malformed frames consume resources or throw inside a callback. One successful parse is treated as permission to perform any operation.

**Evidence.** A local check during this assessment showed that `isBridgeMessage({ type: 'worker-op' })` and an attach carrying `protocol: 999` and numeric `clientSessionId` both return true. This proves only that the guard accepts those shapes; it is not an end-to-end exploit demonstration.

Subsequent real-transport tests found an executed malformed request: an array in a document-path field was coerced to a string and written successfully. The current setDoc and atomic-write checks reject it on both transports. Review also found a separate transaction write loop bypassing the batch check; both now share one typed application helper. Full inbound validation remains open.

Atomic-request tests exposed partial commits as well: an unknown write method was silently skipped while its valid sibling committed. An empty-string transaction read set was accepted as zero reads and both writes committed. Current checks reject these shapes, null descriptors and non-array write lists with invalid-argument. Follow-up tests reject null read entries and array-valued read paths that previously allowed both writes to commit. A second client verifies that no document changed and both clients continue working. The array assertion validates only the container; entry/path checks still do not establish that serialized read data or complete write payloads are safe.

Read-data tests found a separate failure: missing data/JSON, malformed JSON and scalar document roots returned aborted, misclassifying invalid requests as retryable conflicts. Current checks validate the envelope and decode its contents before conflict comparison, reusing the existing encoding and document-root validators. Unsupported read encodings are also refused in the reviewed transport matrix. Full nested-value validation and resource bounds remain required.

**Release gate.** Validate envelope shape, payload schema, negotiated version, allowed operation, nesting/size limits, and session ownership before dispatch. Contain failures to the request or offending connection. Test malformed frames and oversize inputs while another client continues useful work. A JSON-safe encoder is not an inbound validator.

Import review exposed two more integration failures: destructive imports reused a recovery decoder that silently skipped corrupt records, and validation errors escaped the SharedWorker handler without a reply. The shared import preflight and explicit error response now address the reviewed cases. Exercising the published remote consumer also revealed that the hosted shell only supported browser worker-port traffic; operations and subscriptions now share its existing execution queue. These proofs leave complete schema validation, all-service replacement, admission and lifetime gates open.

### R10. “It only works on your machine, and support keeps telling me to refresh”

**Cause.** The test suite uses source imports and fake ports. The published package omits a dynamic import, peers bring another protocol version, a proxied HTTPS app receives a wrong socket address, mobile lifecycle behavior differs, or missing dependencies prevent the important tests from running. Diagnostics still say “open a browser tab” for a Node-host failure.

**Evidence.** Current bridge errors describe a browser-owned sandbox. The original assessment could not load three test files because `fake-indexeddb` was missing. Existing URL code assumes a particular serve/bridge relationship. The same wire has independently released consumers.

**Release gate.** Run supported Node versions and actual packed installs outside the workspace; use representative existing remote clients. Cover same-origin hosting, HTTPS/proxy paths, IPv4/IPv6, and the declared LAN configuration. Record the selected target, host instance/build, connection state, last transition, restore stage, persistence health, and recording gaps in diagnostics. A support artifact should identify failure without including credentials or private document contents by default. Gate release on the required tests actually running.

## Changes to make to the plan before implementation

1. **Add two early end-to-end proofs.** Hosted browser traffic and browser-owned real SDK traffic should constrain abstractions before steps 2–3 become broad refactors. Keep the hosted credential proof early, as already proposed.
2. **Write a supported-configuration table.** For each supported host/execution combination, name the execution owner, auth source, observation owner, persistence owner, unsupported operations, and failure behavior. Include named app/project/database limitations. Do not promise the Cartesian product of every topology and SDK capability.
3. **Make a lifecycle transition table a dependency of the host adapter.** Cover initial boot, ordered messages, session restore, disconnect, replacement, deletion, reset/import, and shutdown. Add connection and reset generation rules. Test intentional races, not just successful calls.
4. **Decide authority and persistence before the team preview.** Specify process exclusion, session admission, privileged Studio actions, acknowledgment semantics, and no-fallback behavior. Distinguish a trusted development sandbox from isolated clients.
5. **Broaden “bounded events” to the whole observation lifetime.** Retention, capture scheduling, producer identity, loss reporting, and control-traffic responsiveness belong in the same acceptance contract.
6. **Add a code-quality gate to each slice.** Named local conditions; coherent responsibility and resource ownership; valid state types; no unexplained double assertions; no speculative option or generic extension point; no transport/mode checks spreading into SDK operations. Review a representative operation's entire path and delete machinery that earns no behavior.
7. **Make release criteria binary and user-shaped.** Replace “reconnect works” with concrete interruption tests; replace “durable” with the agreed failure model; replace “parity” with named operations, overloads, and runtimes. Record workload and limits before calling performance acceptable. Preserve the existing repo integration and conformance gates.

These changes tighten the existing plan. They do not justify a new distributed sync system, a custom database, a universal transport framework, or a wholesale implementation of ADR-0011.

## Evidence entry points

- Scheduling and lifecycle: `packages/cli/src/serve/worker/entry.ts`, `host/dispatch.ts`, `host/rtdb.ts`, `client/core.ts`.
- Session routing and validation: `packages/cli/src/bridge/server/peer.ts`, `server/bridge.ts`, `protocol.ts`.
- Entry selection and SDK ownership: `packages/cli/src/serve/entries/worker-runtime.ts`, `runtime.ts`, `app-client.ts`, `firestore.ts`, `vite-module-swap.ts`.
- Durability and retention: `packages/cli/src/serve/state-store.ts`, `writer-lock.ts`, `worker/serve-init.ts`, `packages/pyric/src/sandbox/internal/sandbox-impl.ts`.
- Live evidence: `spike/live-mode-firestore:packages/pyric/src/firestore/live/{firebase-upstream,upstream,recorder,reads,listeners,shadow-store,explain}.ts`.

No feature code changed and no live backend was contacted. Apart from the small parser-guard check described above, this is a source-based premortem rather than runtime validation of the proposed implementation.
