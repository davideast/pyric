# Section 5: slow consumers and Rules hot reload

**Current status (combined verification, 2026-09-15): S1 is reopened for its RSS
budget.** Final growth reached 232.2 MiB against 192 MiB; two isolated repeats
produced one pass and one 207.5 MiB failure. Socket refusal and latency passed.
See [the combined report](hosted-milestone-verification.md) for exact evidence and
the next bounded investigation. Earlier passing measurements below are historical.

Started at `57bd8c99` on 2026-09-15. Scope is hardening items 16–17 through
approved S1 SDK, S2 bridge and S3 CLI lifecycle boundaries. Preserve hosted opt-in,
default SharedWorker and genuine in-page support; leave existing manual demos and
Tailscale routes running. Use the TDD skill for demonstrated defects.

| Gate | Acceptance | State |
| --- | --- | --- |
| S1 | A paused event reader reaches an explicit output bound, without starving a healthy SDK client. | Open: final RSS growth exceeds 192 MiB intermittently. Output cutoff and latency still pass; see the combined report. |
| S2 | Observation history has count/byte bounds and reports eviction honestly; later live delivery and disconnect cleanup work. | Verified: count and byte workloads reach independent bounds; gaps, subsequent live delivery, capture refusal and unsubscribe cleanup pass. |
| R1 | Real valid Rules file edits change enforcement while two apps remain active; intended listener behavior is verified. | Verified: Firestore and RTDB edits change reads, writes and active listeners in all three runtimes. |
| R2 | Invalid file edits report failure, preserve the declared service policy, and recover after repair. | Verified: invalid edits report rejection and retain last-good file Rules; repair and explicit listener reattachment pass. |
| J | Applicable runtime parity, targeted regressions, types, code form, builds, manual procedure and pushed evidence. | Verification completed; full section acceptance waits on S1 memory. Current results and the handoff are in the combined report. |

## Workload and budgets declared before implementation

The initial inspection found no aggregate socket output bound and an uncapped
unified sandbox event history. Existing frames are limited to 12 MiB; that alone
does not bound retention across frames. Firestore's undo log is a separate state
history owner and must not silently lose undo semantics as an incidental change.

For the socket probe, attach one actual worker event consumer, pause its network
reads, and repeatedly replace a single 256 KiB document through a healthy browser
SDK client. Use up to 192 writes (48 MiB of source payload, with multiple request
and write observations per operation) to exceed a 24 MiB per-socket queued-output
budget. Reject further output when that budget would be exceeded; cleanup must
release the socket after a bounded close interval. A healthy-client write must
finish in under 2 seconds and its measured p95 must stay below 1 second on this
local fixture. Run two fill/drain cycles; total host RSS growth must stay below
192 MiB for this declared workload, with history retention measured separately.
These are acceptance budgets, not measured results or universal throughput claims.

History retention needs both a count limit (10,000 events) and an encoded-byte
limit (8 MiB), with an explicit observation-gap record for omitted source IDs.
Any resulting impact on replay/capture and event consumers must be traced before
this gate can close. Existing APIs promising full history cannot silently begin
returning an incomplete stream. Direct, unbounded undo state is not equivalent
to observation history and is not covered by a short memory sample.

File-watcher scope follows existing supported adapters: Firestore and RTDB rules
are watched by the CLI. Storage file watching is not currently installed there;
record that limitation rather than inventing a new watcher. Verify actual file
load/validation policy before asserting that every service keeps last-good rules.

## Implemented changes and review scope

The shared WebSocket sender now refuses output that would exceed 24 MiB of
queued bytes, closes that consumer with code 1013, and stops adding frames.
Existing ws close handling bounds an unresponsive closing handshake; existing
session retention and unsubscribe owners remain responsible for their teardown.
No second timer, queue, or registry was introduced.

Served hosted, SharedWorker and in-page roots share one bounded observation
history owner. It retains at most 10,000 events plus an explicit `history-limit`
gap within 8 MiB. The existing worker hydration tail keeps 2,000 events plus a
gap instead of silently discarding earlier observations. Live observations
continue after eviction. Direct SDK history remains unbounded; Firestore undo
state remains separate. Capture retains the gap, and both replay engines and
CLI verification refuse incomplete observation histories before reporting a
verification result. Browser capture exercises multibyte UTF-8 without Node's
Buffer; hosted capture exercises the Node branch.

Actual file-edit tests exposed a hosted-only defect: the session advertised new
Rules but never applied them to the Node runtime. The file watcher now invokes
the existing shared Rules handler before updating the payload or broadcasting
success. Invalid Firestore and RTDB file edits retain their validated last-good
policy. Listener recovery follows the service/runtime contract; explicit replacement
after repair is verified. The subsequent manual walkthrough below records
in-page Firestore’s automatic recovery distinction. Direct SDK invalid-
Rules semantics and unsupported Storage file watching remain unchanged.

The hosted capture check exposed another boundary defect: the runtime received
an init payload before the HTTP namespace added its session token, so its capture
POSTs were rejected. The session now owns one token shared by the runtime payload
and namespace. No authentication check was removed.

This closes the bounded hardening items only. It does not establish the broader
gate 6B fifteen-minute workload, all-browser release coverage, or a bound on
Firestore undo state. Existing manual demos and Tailscale routes are untouched.

The runnable [manual checkpoint](hosted-section-five-manual-qa.md) includes build
commands, both service URLs, actual file edits, terminal diagnostics, expected
allowed/denied operations, repair, and explicit listener reattachment.

## Verification evidence

Final production builds pass for Pyric and the CLI. Node **22.15.0** runs the
focused browser checks with one worker and zero retries. Ten unchanged scenarios
pass in `browser-verified.log`; the separately corrected history workload passes
both scenarios in `history-batched.log` (61 seconds). The final diagnostic version
of the count case passes separately in `count-diagnosis.log` (59 seconds),
retaining exactly 10,001 entries including the gap, at 6,133,302 encoded bytes. Earlier failed count probes
reached the byte cap first or spent the timeout in serialized listener churn;
those runs are not counted as passes. The final count workload uses 70 groups of
50 independent listener lifetimes, bounded to 50 concurrent subscriptions.
The byte workload replaces one 256 KiB document 48 times.

The final slow-reader result records p95 **83.7 / 81.9 ms**, maximum write latency
**128.6 / 142.7 ms**, and host RSS growth **58,785,792 / 84,393,984 bytes** across
two cycles. Both clients close with the declared 1013 reason. These are workload
measurements, not a universal latency guarantee or a proof about all retained
process memory. Event-stream unsubscribe/port cleanup regressions also pass.

**140 regressions pass**: 83 CLI session/worker/Rules/verification cases, 50 SDK
history/service/replay cases, and seven existing undo controls. The hydration
regression now expects the existing 2,000-event suffix plus the explicit gap and
checks the exact 50 omitted source IDs. Both replay engines reject both frame
and history gaps; existing complete-history replay cases continue to pass.
Strict hosted-fixture types and 24-file changed-code form pass with zero findings.
The new history/integrity modules depend on shared event/error leaves; adapters
reuse them rather than adding per-runtime policy copies. No conformance registry
rows or Rules evaluator semantics changed.

All five browser dependency/size checks pass:

| Entry | Bytes | Budget |
| --- | ---: | ---: |
| Worker client | 58,471 | 98,304 |
| WebSocket connection | 12,810 | 16,384 |
| RTDB listeners | 12,969 | 32,768 |
| Value codec | 18,649 | 24,576 |
| Live Firestore | 387,843 | 524,288 |

A fresh normal npm installation outside the worktree contains **5,716 files**
byte-identical to the four candidate tarballs. All **11 installed-package browser
scenarios pass in 31.6 seconds**, including hosted/default SharedWorker/in-page
selection, reload, warm startup, recovery, admission and Vite HMR. npm reports a
`prebuild-install` deprecation warning; this is not a warning-free install claim.
The previous phase 4 consumer and running Tailscale endpoint were not modified.

Exact reports, tarball identities, installation location and input hashes live
in `ignored/section5/`. The manual procedure uses the same fixture and file edits
as the browser checks. Verification here is automated Chromium, not a claimed
native in-app walkthrough or another phone test. Phase 6 (items 18–19) and the
broader release acceptance remain open.


## Subsequent manual walkthrough

The [executed checkpoint](hosted-section-five-manual-qa.md#executed-checkpoint--2026-09-15)
now records a fresh 12-scenario pass and 96 actual in-app browser button actions
across all six service/runtime combinations. It also corrects the listener
recovery wording: in-page Firestore resumed automatically after Rules repair;
other tested service/runtime combinations required explicit reattachment.
Temporary tabs, server and fallback override were cleaned up; existing demos
and Tailscale routes remain unchanged.
