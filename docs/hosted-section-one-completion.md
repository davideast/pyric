# Section 1 completion map

**Completed 2026-09-15:** all fixed implementation and automated assertions are
accounted for in the [results](hosted-section-one-results.md). The next checkpoint
is [manual QA](hosted-section-one-manual-qa.md). Section 2 has not begun.

The planning inventory below is retained for traceability.

Planning baseline: `4249b996`, 2026-09-14. This map makes the existing
[Section 1 requirements](hosted-hardening-progress.md#section-1-acceptance-request-bounds-and-lifecycle-cleanup)
actionable; it does not replace the support contract or declare new passing evidence.
The original planning reconciliation performed no runtime checks; the linked
completion record contains the final executable evidence.

## How to freeze the work

Freeze the source inventory and acceptance assertions, not an arbitrary number of
tests. A single test can prove several assertions. Conversely, a passing test name
does not prove every resource owned by its implementation was released.

Each completion record must contain: the ID below, applicable source owner/runtime,
the missing assertion, existing evidence and its inputs, the smallest additional
check, and its result. Use these states:

- **Recorded coverage:** an existing report covers the assertion; confirm input
  applicability before reusing it. No new implementation is presumed necessary.
- **Proof missing:** the additional assertion is not established by the cited
  evidence. Inspect first; add a characterization if the behavior already works.
- **Reproduced failure:** an observed failure requires a minimal fix.
- **Verified:** applicable evidence establishes the complete assertion.

The tables below identify recorded coverage and proof gaps. They do not label
unverified source suspicions as reproduced failures. Existing detailed reports stay
in the progress document and `ignored/section1/`; do not duplicate their narratives.

## Execute lifecycle work first

Fixture paths below are relative to `packages/cli/test/e2e/hosted/`.
Use a disposable project and leave the manual demo untouched.

| ID / gate | Exact completion assertion | Existing coverage to reuse | Additional proof to establish |
| --- | --- | --- | --- |
| L01 / L1 | Failure during CLI configuration, asset preparation, sandbox-session creation, HTTP bind, or hosted-runtime initialization releases all resources acquired before that stage; a corrected start can own the same project and port. | `host-ownership.pw.ts`, `in-process-ownership.pw.ts`, `vite-state-ownership.pw.ts` cover particular failure/ownership paths. | Map those assertions to the five named stages; exercise only uncovered stages. For runtime initialization, distinguish persistence enablement, serve initialization, and Storage restoration. |
| L02 / L1 | A stop requested while an asynchronous startup stage is held prevents late readiness; releasing the stage leaves no running child/server or retained project owner. | Existing failed-start checks do not establish stop-during-start at every allocating asynchronous stage. | Apply interruption at the allocating asynchronous stages identified in L01; observe closure/reacquisition externally. |
| L03 / L1,L4 | Two overlapping close calls both remain pending until owned cleanup finishes; afterward a replacement can acquire the project. | CLI `closeOwnedResources` already shares a promise. | Verify the whole chain, including runtime close. `createHostedRuntime.close()` currently returns immediately to a second caller when `closed` is set; this is a source concern, not yet a reproduced public failure. |
| L04 / L2 | Initialization and socket attachment each respect their five-second deadline, settle dependent work, and create no fallback store. | `init-timeout.pw.ts`, `delayed-init.pw.ts`, protocol-refusal fixtures. | Preserve the initialization timing assertion; identify missing attach timing and physical-resource cleanup observations. |
| L05 / L2 | Deletion during initialization or attachment settles unsent work, closes allocated connections, and ignores subsequently released readiness messages. | `delete-during-attach.pw.ts` proves deletion, canceled write, socket close, and clean reopening. | Cover initialization-stage deletion where an app exists; prove late readiness cannot revive either deleted owner. Do not invent an app lifetime before app creation. |
| L06 / L3 | After socket loss or a second interruption during restoration, the existing app regains exactly one active listener and new work succeeds. | `host-restart-reconnect.pw.ts`, `interrupted-recovery.pw.ts`, `reconnect-listener.pw.ts`. | Reconcile existing reports; do not repeat identity semantics belonging to Section 2. |
| L07 / L3 | Reconnect attempts have one owner, use the declared 250 ms exponential delay capped at 5 s with bounded jitter, and stop after app deletion. | `delete-during-recovery.pw.ts` observes no further restoration/resume and no late delivery after deletion. | Observe attempt timing and absence of duplicate reconnect owners; reuse deletion assertions where applicable. |
| L08 / L3 | Missing liveness invokes the same interruption/recovery behavior as socket closure under the declared 15 s heartbeat / 45 s liveness policy. | Closed-socket recovery establishes the destination behavior. | Observe actual heartbeat/liveness expiry through the transport; elapsed-time control must affect the owner being tested. |
| L09 / L3 | Events from a replaced socket cannot fail, mutate, or reopen the replacement connection. | `stale-connection-events.pw.ts`. | Reconcile event types/assertions and input applicability; add only an uncovered callback case. |
| L10 / L3,L4 | At the 60 s retention expiry, the old resume capability is refused and its owned resources are retired; a surviving app can obtain fresh admission. | `session-expiry.pw.ts` establishes expiry refusal and recovery. | Add external resource-release evidence where absent; fresh admission alone is not cleanup proof. |
| L11 / L4 | Deleting an active app or closing a public remote settles pending work under the existing finish-or-cancel contract, ends subscriptions, tolerates repeated disposal, and produces no later delivery. | `connection-loss.pw.ts`, `remote-process-lifecycle.pw.ts`, `remote-refusal-lifecycle.pw.ts`, deletion fixtures. | Cover active pending work plus subscriptions, including default SharedWorker and genuine in-page app ownership where applicable. Remote child exit must be natural, not forced by fixture teardown. |
| L12 / L4 | Host/bridge shutdown accounts for accepted SDK, forwarded MCP, and direct-command work, including clients already closing; after work finishes or is canceled, all owned resources close and the same project can restart. | `host-tool-sessions.pw.ts`, `host-method-connections.pw.ts` prove retention/drain after caller closure; ownership fixtures prove particular reopen paths. | Combine pending work with shutdown, including already-closing ports. Observe completion, no duplicate execution, connection closure, child exit, and successful project/port reacquisition. Reuse L03 for repeated close. |

Startup inventory anchors: `packages/cli/src/cli/serve.ts` (`startServeRuntime`)
and `packages/cli/src/serve/hosted/runtime.ts` (`createHostedRuntime`). Lifecycle
owners also include the mounted bridge/session registry, browser socket and app
client, SharedWorker physical/virtual ports, Service Worker relay realms, and
public remote client. Compare runtime-specific owners; do not create an arbitrary
Cartesian product of every CLI entry point, service and transport.

**Original first executable slice (now complete):** L03 and L12 for the Node hosted shutdown chain, followed
by the missing L01/L02 startup paths. Hold real accepted work, begin shutdown,
observe whether closure waits, release the work, and reopen the same disposable
project. Existing ownership and retained-work fixtures supply the starting point.
This is more specific than writing a new general-purpose lifecycle harness.

## Finish the remaining protocol work

| ID / gate | Fixed scope and completion assertion | Existing coverage / remaining proof |
| --- | --- | --- |
| P01 / R1 | Validate the required fields and routing/correlation of the 7 worker inbound and 5 outbound message kinds listed below at their actual receiving boundaries. Refuse malformed input before dispatch; settle or terminate malformed replies without stranding affected work; preserve an independent client. | Scoped browser `res` outcome validation is verified by `reply-shape.pw.ts`: 13 malformed status/error shapes per runtime reject correlated reads without uncaught errors; valid errors and subsequent reads/writes/listeners remain usable in hosted and SharedWorker modes. Missing/invalid IDs, cross-port correlation, other outbound kinds and service-specific success payloads remain open. Existing outer/request/subscription fixtures cover examples, not the whole kind inventory; map remaining kinds to validators and group identical paths. |
| P02 / R1 | Apply the same assertion to the 21 bridge message kinds below across their mounted, standalone, browser-peer and public-remote receiving routes. | Existing protocol/handshake/refusal fixtures are reusable per assertion. Route inventory must distinguish nested worker validation from outer bridge validation. |
| P03 / R2 | For the 93 operation method literals at the baseline, account for each required argument and structural discriminator before mutation or registration. Explicitly refuse unsupported methods. | Group by the service families below and existing validators. This is argument-shape validation, not a new service conformance project. Direct command and canonical MCP argument validation remain owned by their existing method/tool records; trace forwarding to these owners rather than duplicate schemas. |
| P04 / R2 | Bound and validate recursive Firestore target/query/composite structure, including malformed children and unsupported descriptors, before recursive evaluation or subscription registration. | Verified scoped structural validation in `query-structure.pw.ts`: 34 target/filter cases per runtime across getDocs, count, aggregate and subscription requests. Node-hosted and SharedWorker accept the 64-layer boundary, refuse excessive/malformed trees with correlated errors, preserve both clients and deliver no later data to refused listeners. Field/operator/value semantics remain with existing validators and P03; encoded operand depth remains P05. |
| P05 / R4 | Enforce the 64-container document bound before decoding at four entry classes: operation input, operation reply, subscription snapshot, and import/checkpoint replacement. Preserve boundary special/escaped values and leave refused replacement state intact. | Reuse document, transaction-read, query-value-depth and checkpoint fixtures. Map decoder callers to these four classes; add only uncovered paths, including public remote consumption. |
| P06 / R5 | Real MCP callers using the default SharedWorker retain independent execution ownership: one stalled caller cannot block another, same-caller ordering is preserved, and accounting releases after settlement. | Verified scoped forwarding: the browser relay now preserves the MCP caller ID. `shared-worker-mcp-fairness.pw.ts` drives two real MCP sessions, holds real AI work ahead of one caller at the worker wire boundary, and proves independent progress, same-caller ordering and subsequent use after upstream success/failure. No MCP dispatcher is mocked. Remaining closed-session retention and numerical refill assertions belong to P07. |
| P07 / R5 | Close missing count/byte settlement assertions for the fixed owner list below. Refuse at the existing limits; preserve accepted work and another caller; prove partial/full reuse after the applicable success, failure, timeout, cancellation or disposal path. | Existing per-owner fixtures establish substantial coverage. Direct-command and rendered MCP exact-byte/refill assertions are recorded as complete. Node relay boundary probes currently use margins; Node MCP retained-work probes are not exact/partial-refill proofs. Record which cells actually remain before adding tests. Disposal overlaps L11/L12 and must not be reimplemented as another independent test project. |
| P08 / R3 | Retain the existing frame-boundary matrix and 8 MiB Storage transfer guarantee. | Recorded verified through `9eedb8df` and reconciled in the progress document. Revalidate changed dependencies only; no new frame-hardening task. |
| J01 / J | All assertions have applicable evidence; run the combined affected checks once, required types/form/import/artifact gates, commit/push, and deliver the disposable two-browser manual QA script. | Preserve prior passing inputs where applicable. Manual verification is the next checkpoint; do not begin Section 2. |

### Fixed inventory at the baseline

Worker protocol source: `packages/cli/src/serve/worker/protocol.ts`.

- Inbound: `op`, `sub`, `unsub`, `disconnect`, `appConfig`, `clock-subscribe`, `tool`.
- Outbound: `res`, `snap`, `event`, `runtime-reload`, `clock`.
- Subscription families: Firestore, Auth, events, RTDB, AI stream, Messaging, presence.
- Operation families: 28 unprefixed core methods, 5 Admin, 15 RTDB, 1 sandbox
  clock, 25 Auth, 6 Storage, 2 AI, 7 Messaging, 4 presence: **93 method literals**.
  These counts are a source inventory, not a coverage percentage. The baseline
  union fixes the exact method names; adding SDK behavior is outside this task.

Bridge protocol source: `packages/cli/src/bridge/protocol.ts`.

`hello`, `hello-ack`, `tool-call`, `tool-result`, `worker-message`,
`worker-message-result`, `attach`, `attach-ack`, `worker-op`, `worker-res`,
`worker-sub`, `worker-unsub`, `worker-snap`, `worker-client-disconnect`,
`worker-client-interrupted`, `consumer-presence`, `remote-set-lens`,
`remote-set-lens-ack`, `worker-event`, `ping`, `pong`.

P07 admission owners: browser client correlations; native SharedWorker client
queue; Service Worker relay across realm replacement; Node HostedPort;
public remote client; bridge worker relay; served MCP admission; rendered MCP
tool/resource admission; Node forwarded-tool execution; Node direct-command
execution. Node MCP and direct-command retained-owner caps already have two-round
churn/drain evidence. SharedWorker MCP forwarding is P06, not evidence inherited
from Node. Validate any additional allocation encountered against an existing
owner before proposing another queue or budget.

## Completion discipline

Reconcile evidence before scheduling a runtime check. For every gap, record the
specific missing assertion, not merely “needs more testing.” A source concern
becomes implementation work only after reproduction. Group assertions that share
the same public fixture and resource owner, and reuse unchanged results.

This map freezes 12 lifecycle work records, 8 protocol records and one final join;
it does **not** claim that only 21 tests are needed or that the evidence audit is
already complete. Close an evidence gap by inspecting applicable proof whenever
possible. Report progress as assertions closed and explicit remaining work, not
commit count or an unweighted percentage.

At the first 60–90 minute execution checkpoint, report completed IDs, failures,
remaining assertions and any scope change. Do not weaken a required gate to meet
the checkpoint. A newly discovered failure within one of these assertions stays
in scope. A genuinely new requirement gets a separate proposal and cannot silently
extend this milestone. Existing later-section exclusions remain unchanged.
