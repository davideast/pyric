# Hosted sandbox and live-mode support contract

This is the target contract for the active implementation, not a statement of
released support. It resolves policy inputs to gates 0B and 3A–3E. The gate
ledger must still prove each configuration, including its refusal paths.
Missing implementation is required work; it must not be relabelled unsupported
merely to clear a gate.

## Configuration ownership

| Configuration | Execution owner | Identity source | State and observation owner | Required proof |
| --- | --- | --- | --- | --- |
| Existing in-page sandbox | Page sandbox | Existing emulated Auth/session and lens | Existing page persistence and observations | Existing SDK regressions, including seeded tenant/claims behaviour |
| Existing SharedWorker sandbox, the default | SharedWorker dispatcher | Per-app emulated session and lens | Existing worker persistence and event stream | Worker/bridge baseline and SharedWorker/Studio browser scenarios |
| Hosted sandbox | One Node host per canonical project/state directory | Per-consumer emulated session and lens | Node persistence; bounded host observations | Hosted SDK, remote/mobile/admin, MCP, restart, isolation, and Studio gates |
| Browser live with SharedWorker observations | The app's real Firebase SDK | The app's real App/Auth owner | SharedWorker observation store; real Firebase owns application data | Both actual browser entry paths, lifecycle, and observation delivery |
| Browser live with hosted observations | The app's real Firebase SDK | The app's real App/Auth owner | Node observation store; real Firebase owns application data | Both actual browser entry paths plus hosted observation isolation |
| Hosted live | Per-consumer real Firebase SDK resources in Node | Explicit real credential source, scoped by consumer and credential generation | Real Firebase owns application data; Node owns scoped observations | Real identity proof, refresh, tenant changes, teardown, and secret containment |

Sandbox hosting preserves the service families already exposed through the
worker/remote contract. Firestore, Auth, RTDB, Storage, and Messaging must each
be represented in the hosted scenario inventory; existing optional AI and
diagnostic capabilities keep their own activation requirements. A browser-only
dependency cannot silently make a previously available operation disappear.

Live execution applies to Firestore, using real App/Auth ownership. Reads,
queries, document listeners, query listeners, writes, batches, transactions,
converters, metadata options, and the network/cache controls exposed by the
normal Firestore entry need explicit forwarding or a documented refusal backed
by a scenario. Every actual upstream mutation executes under the existing
explicit write policy. Other Firebase services must not silently execute
against a sandbox when their app selected live execution.

An execution target includes its Firebase project and database identity.
Named app instances may share that target while retaining independent Auth
sessions. References and observations retain their project/database identity;
an incompatible target fails before dispatch. Existing gaps in named-database
support must be identified by operation and runtime, rather than hidden by
dropping the database field. The support inventory must account for default and
named app/database cases before declaring either supported.

There is one authoritative sandbox per canonical project/state directory.
Browser storage may retain client identity and preferences, but never a second
hosted database. Changing execution mode requires teardown and reconstruction;
existing references are never rerouted to another target. A failed selected
host never falls back to an in-page or SharedWorker store.

## Admission and authority

The emulated sandbox is a trusted development collaboration environment, not
an isolation boundary against its admitted developers. Its explicit admin,
impersonation, reset, and inspection actions remain development capabilities.
This does not permit ordinary data frames to impersonate another connection:
the host binds them to the admitted session and generation. Cross-session
actions use their explicit control interface and are attributable to the caller.

Loopback remains the default bind. Non-loopback sandbox use is an explicit
deployment choice for a trusted network, with Host/Origin checks and documented
full-development-control access. Those checks are not authentication. No
claim of protection from another admitted developer is made for this mode.

Live credentials and private live observations require stronger admission.
Ordinary clients can act and observe only within their authenticated logical
session. Studio aggregation and cross-session controls require an explicit
operator grant; a `platform: studio` string or supplied session ID is not a
grant. The grant must be verified before registration or dispatch. Never
promote sandbox impersonation or an admin lens to real upstream authority.

Credential-bearing non-loopback hosting remains disabled until the credential,
admission, and secret-containment release gates pass. It stays a required
release decision, not an implicit consequence of setting an allowed host.
An invalid or absent upstream credential fails before Firebase execution;
there is no privileged credential fallback.

The canonical state directory has one exclusive writer. A second process
attaches to the discovered owner or refuses without opening a writer. Discovery
must verify project identity, host instance, protocol, and ownership before
resuming any session. Stale discovery cannot authorise a different process.
Only a host holding the ownership claim may publish readiness or replace state.

## Host lifetime

The mount owns the entire startup promise, including dynamically loading the
runtime, acquiring storage, restoring state, installing listeners, and peer
registration. The runtime owns the resources those steps allocate. Startup
must return either one usable runtime or a failure with those resources released.

| State and event | Required outcome |
| --- | --- |
| Idle → start | Reserve this startup before the first asynchronous boundary. |
| Starting → a second start | Refuse the second request; never create a second runtime or writer. |
| Starting → success | Register one authoritative peer only if the owner is still open. |
| Starting → failure | Release partial resources; preserve the original startup error. Readiness stays false. |
| Starting → close | Mark the owner closed immediately. Await the owned startup, dispose any runtime it produces, and never publish it as ready. The start caller receives a closed-startup error. |
| Ready → close | Stop admission; detach owned connections; finish or explicitly cancel accepted work under its operation contract; release listeners, upstream sessions, timers, and persistence. |
| Closing → close | Return the same close completion; no duplicate teardown. |
| Closed → start | Refuse. Restart uses a new owner and must pass project/state ownership checks again. |
| Failed startup → close | Complete cleanup without replacing the already-observed startup error. |

The promise returned by close is a completion boundary. It must not resolve
while a known asynchronous startup can still register a peer or allocate an
unowned runtime. Timeouts may report incomplete shutdown; they cannot turn
unfinished cleanup into success. Expected startup cancellation is distinct
from a cleanup failure, which must remain observable.

## Client lifetime and ordering

| Transition | Required outcome |
| --- | --- |
| Initialising → ready | Negotiate the host and protocol, configure the app, restore tenant/Auth/lens, then establish data listeners and release dependent operations. |
| Initialising → failure | Reject queued work and release the physical connection. Do not create another store. |
| Ready → interrupted | Reject pending calls. Retain logical subscription intent and session identity for restoration. The app remains registered. |
| Interrupted → restoring | Open a new connection generation and repeat admission, configuration, and identity restoration. Never replay a mutation with an uncertain outcome. |
| Restoring → ready | Re-establish current listener intent once; ignore callbacks from obsolete generations. |
| Any live state → explicit app deletion | Stop reconnect, cancel listener intent, reject pending work with the existing app-deletion contract, and release this app's resources. |
| Old connection closes after replacement | Clean only that old generation; it cannot remove the replacement's identity or listeners. |
| Host reset/import | Advance the reset generation before replacing data. Old work cannot repopulate the replacement state. Refresh affected observers/handles or fail them explicitly. |

Requests from one consumer execute in accepted order, including identity
changes and teardown. Another consumer must not wait behind a stalled upstream
request from that consumer. This is not a global serial queue.

An unsent request fails without execution. A sent request whose reply is lost
may have executed; its error says so and does not imply a safe automatic retry.
SDK transaction retries remain governed by their explicit upstream contract.
No general offline mutation queue is introduced.

Physical socket loss immediately marks RTDB connectivity offline and drains
that connection generation's onDisconnect work once. Resumption establishes a
new online generation; applications re-register disconnect intent through the
normal SDK contract. Expiry releases retained session resources, and explicit
app deletion cannot be undone by a later resume request.

## Acknowledgment and durability

Hosted persistence is authoritative. It must restore Firestore records, RTDB,
Auth users, Storage bytes/metadata, checkpoints, and required host identity
metadata before seed application and readiness. Restore tests read values
through the SDK after process restart. Live credentials, refresh tokens,
per-connection capabilities, and private session secrets are not checkpoint
or capture data.

The required initial guarantee is recovery from process termination after a
durable acknowledgment. It is not a claim of survival after machine power loss.
Commit writes use the existing atomic-replacement primitives, serialised by
the storage owner. Recovery preserves the last recoverable state and reports
corruption; it never silently replaces damaged state with an empty database.

A successful durable mutation acknowledgment means its committed state is
recoverable after process termination. If execution committed in memory but
storage fails, return a distinct committed-but-not-durable outcome, report
unhealthy persistence, and stop admitting further durable mutations until
recovery. Do not present that outcome as an unexecuted write that is safe to
repeat. Reads may continue against the explicitly reported in-memory state.
The existing memory-only prototype remains labelled memory-only until these
guarantees pass; that label is not the final persistence implementation.

Reset/restore and pending flushes share an ownership generation. A stale flush
cannot complete after reset and resurrect the previous state. A single owner
may use more than one physical file if the restart/commit contract accounts for
all files; do not assume atomic rename of one file commits unrelated sidecars.

## Initial bounds and workload budgets

These are implementation inputs to test, not measured performance claims.
Preserve the existing 8 MiB decoded Storage operation limit. The transport
frame limit must accommodate its base64 representation and envelope.

When a browser initiates a frame-limit close, use application code `4009`: the
browser WebSocket API prohibits initiating protocol code `1009`. Node sockets
use `1009`. Both paths must settle affected work and release the connection.
The browser receive check runs before JSON parsing/dispatch, after the native
WebSocket implementation has assembled its message; it cannot cap the native
browser network buffer through that API.

| Resource or deadline | Initial bound | Exhaustion behaviour |
| --- | ---: | --- |
| Hosted init and attach | 5 seconds per stage | Reject startup and close its resources; no fallback store. |
| Inbound or outbound encoded frame | 12 MiB | Refuse before dispatch/send; isolate the offending request or connection. |
| Encoded document nesting | 64 containers | Refuse before recursive decoding or execution. |
| Pending operations per client | 256 | Reject new work with resource exhaustion before accepting it. |
| Queued operation bytes per client | 24 MiB | Reject new work before accepting it; do not discard an acknowledged operation. |
| Observation queue per consumer | 1,000 events or 16 MiB, whichever comes first | Report the dropped sequence range; keep operation/control traffic independent. |
| Retained host observation history | 10,000 events or 32 MiB, whichever comes first | Evict oldest observations with an explicit retained range and gap provenance. |
| Capture retained observation bytes | 32 MiB | Bound the capture and record incompleteness; never call it a full database snapshot. |
| Capture maximum delay under continuous traffic | 2 seconds | Flush incrementally on a maximum-age deadline; a debounce cannot postpone forever. |
| Interrupted session retention | 60 seconds | Expire identity-bound resources and resume capability; reconnect then requires fresh admission. |
| Connection heartbeat | Every 15 seconds; interrupted after 45 seconds without liveness | Apply the same loss transition as a closed socket. |
| Reconnect delay | 250 ms initial, exponential backoff capped at 5 seconds, with bounded jitter | One reconnect owner per app; cancel on deletion. |

A consumer attachment is refused with the existing admission policy close
(`1008`) if its proposed registration would make the complete presence frame
exceed 12 MiB. This is admission refusal for a valid input frame; it leaves
existing consumer records intact.

An oversized observation batch first loses optional snapshot samples. If it still
cannot fit, its consumer receives an `observation_gap` in the existing event
stream, carrying the omitted count and first/last source event IDs. The gap
replaces that delivery batch; it does not report the underlying operations as
failed or change their data. The runtime reports incomplete activity and keeps
operation/control traffic connected. These IDs delimit the omitted batch, not
a globally contiguous sequence range. This frame refusal does not implement
the separate queue, retained-history, or capture budgets below.

Before closing gate 6B, run a 15-minute local workload after a 2-minute warm-up:
four active consumers, 100 total 1 KiB document operations per second, 20 live
subscriptions per active consumer, and one stalled observation consumer.
Maintain a fixed 1,000-document dataset so database growth does not disguise
retention growth. Reach the event-count limits in this workload. Exercise the
byte limits separately with larger valid payloads, including below/equal/above
boundary cases; a count limit reached first cannot prove byte-limit behaviour.

During that workload, unrelated-client response latency must stay below 500 ms
at p95 and 2 seconds at p99. Post-warm-up memory growth attributable to retained
history, queues, and sessions must remain within their configured aggregate
bounds; compare equal workload windows and account separately for the fixed
dataset and runtime baseline. Disposal returns owned external handles to their
recorded baseline. Do not use a single RSS reading as proof of no leak.

A necessary limit or budget change requires new measurements and an explained
contract change. Existing supported values cannot be rejected merely to make
a transport budget pass. This table does not authorise a new persistence
engine, scheduler framework, or transport protocol.

## Remaining gate 0B work

The [support manifest](hosted-sandbox-live-mode-support.json) names six target
configurations and 44 required scenario declarations. Run
`bun scripts/check-support-contract.ts docs/hosted-sandbox-live-mode-support.json`
from the repository root. The command refuses unknown scenario references,
duplicate configuration/scenario identities, uncovered configurations, and an
empty inventory. Configurations must state host, execution owner, identity
source, project/database scope, persistence owner, and non-empty service
families. Scenarios must state an S1–S6 seam, gate references, and an expected
outcome. The command reports missing metadata paths. Its successful report
explicitly covers scenario declarations; it does not claim that tests executed.

Required CI runs the command, its tests, and strict tool typechecking, and
preserves the declaration report. The command test executes the workflow's
actual shell command against valid and invalid inventories and checks that
invalid declarations fail the step. This local verification is not evidence
of a remote CI run.

Complete semantic validation of ownership, project/database scope,
operation/control families, policies, and refusal coverage. Bind the declarations to collected
executable scenarios, expanding broad family scenarios into their concrete
operation and failure cases as the vertical slices require. The present
checker validates metadata presence and basic shape; it does not establish
that ownership combinations are coherent, gate IDs exist, every family has
its required scenarios, or executable bindings are complete. These are unfinished parts of 0B, not waived
requirements. The contract above cannot by itself mark lifecycle, durability,
or performance complete.
