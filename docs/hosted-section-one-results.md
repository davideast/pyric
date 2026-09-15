# Section 1: request bounds and lifecycle cleanup

Section 1 implementation and automated verification are complete against baseline
`03cfb36c` on `hosted-live-mode` (2026-09-15). All fixed assertions in the
[completion map](hosted-section-one-completion.md) are accounted for below. The next
checkpoint is [manual QA](hosted-section-one-manual-qa.md); Section 2 has not begun.

SharedWorker remains the default, hosted mode is opt-in, and genuine in-page mode
is retained. Section 2 and release acceptance remain separate. The existing manual
demo on port 43110 was not changed.

## Changes

- Worker entry, hosted dispatch and the BroadcastChannel relay share required
  argument validation before dispatch. The fixed inventory contains 93 methods,
  seven inbound kinds and seven subscription families; existing service validators
  retain authority over service semantics.
- Browser, bridge and remote receivers validate reply envelopes and outcomes.
  Correlation belongs to its originating port or current peer generation.
  Malformed replies settle affected calls; terminal snapshots unsubscribe before
  their error callback. Unexpected remote failure notifies active listeners,
  while explicit remote close detaches them quietly.
- The shared document decoder enforces the 64-container bound on replies and
  replacement state, including legacy persisted snapshots. Decode failures end
  listeners instead of disappearing inside callback handling.
- Repeated hosted close calls await the same cleanup promise. Closing during
  startup waits for the pending runtime and prevents late registration. Failed
  serve initialization disposes an already-created persistence writer.

No new queue, budget, retry owner, transport fallback or global client cap was
introduced. The existing admission owners retain accepted work until settlement.

## Assertion closure

Fixture names below are relative to `packages/cli/test/e2e/hosted/`. Each row names
the observation that closes it, rather than treating a passing test count as
blanket coverage. The final combined run passed with no retries or skips.

| Completion IDs | Observable proof |
| --- | --- |
| L01–L03 | `section-one-lifecycle-startup`, `section-one-lifecycle-close`, `host-startup-interruption`: failed allocating stages allow corrected startup; interruption prevents late readiness; overlapping close waits for real held work; replacement reacquires project and port. |
| L04–L05 | `section-one-lifecycle-browser`, `init-timeout`, `delayed-init`, `delete-during-attach`, `section-one-lifecycle-disposal`: exact five-second deadlines, fetch abort/socket/port closure, no fallback or revived app after late readiness. Unsent hosted work is canceled; already-posted native work retains its finish contract. |
| L06–L09 | `interrupted-recovery`, `reconnect-listener`, `silent-connection-loss`, `stale-connection-events`, `section-one-lifecycle-browser`: one listener after recovery, declared retry timing, 15-second heartbeat/45-second liveness cutoff, deletion stops attempts, old socket events cannot affect the replacement. |
| L10 | `session-expiry`: real host retention wait; public listener inventory is empty after expiry before fresh admission; the old grant is refused and the surviving app recovers. |
| L11–L12 | `section-one-lifecycle-disposal`, `section-one-lifecycle-close`, `host-pending-shutdown`: active SDK, MCP, direct-command and remote work follows its finish-or-cancel contract; no late listener delivery; natural child exit and project/port reacquisition. Hosted, native SharedWorker and in-page app disposal are covered. |
| P01, P03 | `section-one-protocol`: 278 argument cases per runtime, including 93 missing and 88 mistyped required arguments; subscription and control groups run through actual native, hosted and BroadcastChannel receivers. Hosted ownership normalization has two explicit admitted controls. `reply-ownership`, `reply-envelope`, `snapshot-reply-shape`, `worker-event-replies` cover outbound correlation and termination. |
| P02 | `section-one-bridge`, `host-protocol-refusal`, `attach-reply-shape`, `remote-reply-shape`, `remote-snapshot-shape`, `remote-active-fault`: mounted/standalone/browser-peer/remote receiving routes, current peer ownership, required fields and terminal replies. The 21-kind route inventory distinguishes consumed commands from ignored reverse directions; Studio-only presence rendering is outside these receivers. |
| P04 | `query-structure`: 34 malformed target/filter structures per runtime, accepted depth boundary, refusal before recursive evaluation or listener registration, healthy independent client. |
| P05 | `reply-depth`, `remote-document-depth`, `document-result-shape`, `legacy-document-depth`, `state-document-depth`, retained document/query/transaction depth and marker fixtures: request, reply, subscription and state-replacement decoder entries; refused replacements preserve Firestore, Auth, RTDB and Storage state. |
| P06–P07 | `shared-worker-mcp-fairness`, `section-one-capacity-partial`, `section-one-capacity-retention`, strengthened `remote-operation-bytes` and retained owner fixtures: independent real MCP callers, exact shared admission arithmetic, partial/full reuse after success/failure, cancellation retains accepted work, repeated drain and disposal. |
| P08 | Retained 12 MiB frame matrix plus affected browser/peer/remote boundary fixtures: UTF-8 size refusal remains correlated and healthy work continues. Existing 8 MiB Storage support remains part of the contract. |
| J01 | Final affected browser run, isolated regressions, types/form, import and browser budgets, copied standalone artifact, verified commit/push and [manual checkpoint](hosted-section-one-manual-qa.md). |

### Capacity applicability

All ten fixed owners use the existing `createOperationBudget` arithmetic. It
charges the complete admitted operation before acceptance and releases its
reservation on settlement. Exact -1/equal/+1 boundary cases exercise the shared
arithmetic through native, relay, hosted, rendered MCP and direct-command paths.
Some browser/remote/bridge integrations use measured margins because their
correlation metadata is generated; they prove complete-value wiring and live
partial/full reuse, not byte-exact equivalence of differently shaped envelopes.
The separate frame policy measures the full socket frame.

There is no new 64-client global native limit: that number belongs to existing
Node retained-execution owners. Native logical queues drain their accepted tails.
These applicability decisions preserve the stated per-client contract and do not
claim process memory is bounded independently of the number of clients.

### Fixture corrections

The investigation distinguished product failures from incorrect setup. Native
SharedWorker work posted before deletion is already accepted and can complete
after initialization; the test proves one increment, no app revival, and no
additional post from a deleted handle. Its pending call rejects with
`app/app-deleted`; a later call through a terminated Firestore handle rejects with
the existing `failed-precondition` code.

Two relay tests needed an authorized initial read before they could assert a
healthy listener or its reissue. An errored listener is terminal and must not be
retained for reissue. A cleanup attempt after terminal hosted socket failure can
report `unavailable` while still removing the app. These are recorded contract
corrections, not additional product fixes.

## Verification

- **195 affected browser scenarios passed in 8.0 minutes**, including the one real
  retention-expiry wait; zero failures, retries or skips.
- **2 Storage compatibility cases passed in 5.3 seconds**: complete 8 MiB round
  trips in hosted and default SharedWorker modes.
- **4 copied-binary cases passed in 13.4 seconds** against a freshly compiled
  Darwin ARM64 standalone binary.
- **415 regressions passed in 41 distinct isolated files.** Existing core/worker
  results were reused where their inputs were unchanged; bridge/remote/shutdown
  checks were refreshed. The corrected authenticated-listener test passed with
  its original peer-replacement assertions preserved.
- Pyric and CLI production types, strict hosted fixtures and the changed bridge
  regression fixture pass. Changed-code form has zero findings; whitespace passes.
- The scoped static import graph covers 1,030 files and 32 added edges, with no
  new cycles or unresolved local imports. It includes type-only and literal
  dynamic imports; third-party internals and computed imports are outside scope.
- All five browser budgets pass: client 58,456/98,304 bytes; socket
  12,781/16,384; RTDB 12,969/32,768; codec 18,649/24,576; live Firestore
  387,843/524,288. No forbidden Node/engine boundary imports were introduced.

Final verification compared **4,566 source, fixture, configuration and artifact
inputs** with the frozen candidate; none changed during the final checks. Before commit, two extra final newlines
were removed; types/form were refreshed and emitted JavaScript remained identical.
The exact byte-only equivalence is recorded in `whitespace-equivalence.json`.
The runtime input manifest (`runtime-candidate-inputs.json`) SHA-256 is `edb3eb41a70d01318c7506e69a5102b90aa38ef8812f7fe1d40c0045a062cbee`.
The standalone binary SHA-256 is `4853aadd767cb05466218c3fd9d1a67a3048f9979e6501836e108fc739528aca`.

Reproduction uses Node 22.15.0, Bun 1.3.9 and the repository lockfile. Production
types, strict hosted fixtures and changed-code form pass before runtime:

```sh
bun x tsc -p packages/pyric/tsconfig.json --pretty false
bun x tsc -p packages/cli/tsconfig.json --pretty false
bun x tsc -p packages/cli/test/e2e/hosted/tsconfig.json --pretty false
bun scripts/check-changed-code-form.ts 03cfb36c
```

The combined affected selection is reproducible without running the full suite:

```sh
node node_modules/@playwright/test/cli.js test \
  --config packages/cli/test/e2e/hosted/playwright.config.ts \
  attach-reply-shape.pw.ts delete-during-attach.pw.ts \
  document-result-shape.pw.ts host-protocol-refusal.pw.ts \
  init-timeout.pw.ts legacy-document-depth.pw.ts \
  remote-active-fault.pw.ts remote-document-depth.pw.ts \
  remote-operation-bytes.pw.ts remote-reply-shape.pw.ts \
  remote-snapshot-shape.pw.ts reply-depth.pw.ts \
  reply-envelope.pw.ts reply-ownership.pw.ts \
  section-one-bridge.pw.ts section-one-capacity-partial.pw.ts \
  section-one-capacity-retention.pw.ts section-one-lifecycle-browser.pw.ts \
  section-one-lifecycle-close.pw.ts section-one-lifecycle-disposal.pw.ts \
  section-one-lifecycle-startup.pw.ts section-one-protocol.pw.ts \
  session-expiry.pw.ts snapshot-reply-shape.pw.ts \
  state-document-depth.pw.ts worker-event-replies.pw.ts \
  host-startup-interruption.pw.ts host-pending-shutdown.pw.ts \
  delayed-init.pw.ts interrupted-recovery.pw.ts \
  silent-connection-loss.pw.ts stale-connection-events.pw.ts \
  reconnect-listener.pw.ts query-structure.pw.ts \
  document-depth-review.pw.ts transaction-read-depth-review.pw.ts \
  query-value-depth.pw.ts malformed-atomic-write.pw.ts \
  marker-map.pw.ts peer-response-limit.pw.ts \
  remote-reply-limit.pw.ts remote-request-boundary.pw.ts \
  browser-reply-limit.pw.ts browser-operation-bytes.pw.ts \
  bridge-operation-bytes.pw.ts host-tool-admission.pw.ts \
  shared-worker-mcp-fairness.pw.ts
```

The final selection and exact executed command are also retained in
`ignored/section1/finish/final-browser-selection.json` and
`final-browser-execution.json`; reports in that directory are local evidence,
not files shipped in the package. The tracked fixtures contain the assertions.

Refresh the existing Storage compatibility check with `storage-frame-capacity.pw.ts`
under the same hosted Playwright configuration.

For the applicable copied standalone check, build from the verified dist and run:

```sh
(cd packages/cli && bun scripts/compile.ts host)
node node_modules/@playwright/test/cli.js test \
  --config packages/cli/test/e2e/hosted/playwright.standalone.config.ts
```

This checks the copied host-platform binary. It does not claim the later full
packed-install/Vite/version matrix or release acceptance is complete.
