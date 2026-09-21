# Experiment: real-provider cancellation and reconciliation

## Goal and uncertainty

Determine which observable facts an actual AI provider exposes after a timeout,
client disconnect or gateway crash, and whether those facts are strong enough to
release an execution slot or safely retry dispatch. The first intended integration
is Firebase AI Logic, with the exact provider, API, model and SDK pinned at run time.
Do not presume that a model endpoint has an operation-status, cancellation or
idempotency API merely because another API from the same provider does.

**Status: local fixtures and the direct real-service phase are implemented. Cloud Run has not been deployed for this experiment.**
The original investigation brief below remains the specification. See [local results](./RESULTS.md) and [live handoff](./LIVE-PLAN.md) for the implemented scope and remaining work.
Follow the [shared build and evidence contract](../README.md#common-implementation-contract-for-all-four-briefs).
The original brief authorizes no deployment or inference by itself. The separately authorized real-service run and commands are documented in [live/README.md](./live/README.md).

The hypothesis to test is conditional: **authoritative provider terminal evidence
can justify releasing capacity; local transport termination alone cannot**. It is
acceptable to discover that a provider offers no way to resolve interrupted work.
That is a useful constraint for subsequent designs, not a failed experiment to fix
by guessing that work stopped.

## Prior evidence and code to read

1. [Provider lifecycle guide](../inference-allowance/PROVIDER-LIFECYCLE.md) and
   [its final local findings](../inference-allowance/comparisons/provider-lifecycle/README.md):
   14 scripted scenarios, with output and terminal state observed independently.
2. [Hosted execution comparison](../inference-allowance/comparisons/hosted-execution/README.md):
   the container did not receive the tested downstream disconnects; therefore test
   an explicit owner-scoped stop request separately from closing a client socket.
3. [Distributed hosted findings](../distributed-capacity/hosted/RESULTS.md): three
   unknown reservations deliberately held all three slots, but terminal state was
   supplied by the operator. This does not establish actual AI Logic capabilities.
4. [Prepared AI Logic adapter](../inference-allowance/services/ai-logic.mjs): currently
   non-streaming, uses Firebase Auth and App Check credentials, an explicit shared
   dispatch-budget callback and a transport deadline. It has not proved remote
   cancellation or queryable operation state. Do not rename its fetch rejection
   to `provider-cancelled`.
5. [Scripted provider](../inference-allowance/services/scripted-provider.mjs),
   [lifecycle assessment](../inference-allowance/analysis/provider-lifecycle.mjs),
   [local independent oracle](../distributed-capacity/services/provider.mjs) and
   [durable hosted fixture](../distributed-capacity/hosted/provider.mjs).

At implementation time inspect the installed SDK source and current official API
documentation. Start from the [AI Logic documentation](https://firebase.google.com/docs/ai-logic)
and its [production checklist](https://firebase.google.com/docs/ai-logic/production-checklist).
Capture document URLs, retrieval date, API/SDK versions and the narrowly supported
claim in `capabilities.json`. Do not treat SDK surface names as termination guarantees.

## Build these files and responsibilities

```text
provider-contract/
  README.md
  architecture/termination-evidence.mjs   # Pure evidence classifier, no network
  adapters/provider-contract.mjs         # Explicit capabilities + observation API
  adapters/ai-logic.mjs                  # One pinned real API; no guessed methods
  adapters/scripted.mjs                  # Same public contract over fixtures
  services/provider-oracle.mjs           # Separate process, hidden from gateway
  services/gateway.mjs                   # Output, explicit stop, lifecycle events
  fixtures/capabilities.mjs              # Supported/absent/unknown capability profiles
  scenarios/*.mjs                       # One interruption schedule per file
  harness/runner.mjs                     # Public programmatic seam and barriers
  analysis/assess.mjs                   # Coverage, evidence strength and conclusions
  config/local.json                     # Fake provider, loopback only; no credentials
  config/live.example.json              # Disabled, explicit budgets/target fields
  tests/*.test.ts
  capture-definition.mjs
  execute.mjs
  run.mjs
  results/<runId>/...
```

Do not create a new provider framework or wrap every AI SDK. Build one adapter and
one scripted implementation. The proposed interface needs `start`, `requestStop`
and, only where supported, `observe`; transport output and terminal observation
must be separate channels. Return a tagged observation containing status, operation
ID, source, observed time, scope and evidence strength. Use statuses such as
`running`, `completed`, `cancelled`, `rejected-before-start`, `unknown`, and
`unsupported`; retain the raw sanitised evidence that justifies each classification.

A stop response acknowledging receipt is not cancellation confirmation. A closed
stream, an AbortError, a 5xx response, or no operation found is not automatically
proof of non-execution. Define allowed classifications before implementing them.
Provider-generated operation IDs are nullable. An application idempotency key is
not evidence of provider deduplication unless the exact API supports that contract.

## Implementation sequence

1. Produce the initial capability matrix: non-streaming, streaming, client abort,
   explicit remote cancellation, lookup by durable operation ID, lookup by caller
   key, deduplicated dispatch and per-operation usage. Give every entry
   `supported | unsupported | unverified`, a primary-source reference and its scope.
2. At public runner/HTTP seams, use TDD to prove that a fixture can end transport
   while continuing work, and that the gateway keeps the slot. The test oracle must
   survive gateway process death and remain inaccessible to gateway code.
3. Implement the evidence classifier and a fake adapter exposing independently
   controlled output, stop acknowledgment, terminal confirmation and observability.
   Keep the prior promise-only release as an explicit **local-only negative control**.
4. Implement the real adapter only for verified capabilities. Missing `observe`
   returns `unsupported`; do not synthesise a successful status query. Normal
   terminal responses may be classified only to the extent the API contract permits.
5. Add capture/replay, required-check assessment, raw transport/terminal ordering,
   budget enforcement and crash-safe partial capture before enabling a live profile.
6. Run local fixtures, verify and replay the capture. Prepare an operator-approved
   bounded live plan. Do not deploy a new gateway or call a model yet.
7. Once explicitly authorised, run the same transport path planned for the actual
   system. A local direct SDK call can establish SDK/API observations, but cannot
   stand in for the browser → Cloud Run → AI Logic path. Label paths separately.
8. Turn observed live capability limits into versioned fixture profiles. Re-run
   the fixtures using those profiles; do not retrofit old expectations or captures.

## Required cases and interpretation

| Case | Trigger and observation | Required interpretation |
| --- | --- | --- |
| Normal response | Complete non-streaming call | Record terminal evidence and usage if supplied; establish baseline. |
| Normal stream | Consume a complete stream | Record first chunk, final marker, terminal observation and usage separately. |
| Abort before dispatch | Stop at an explicit pre-dispatch barrier | Zero provider dispatch attempts and zero dispatch-budget charges. |
| Abort after acceptance | Request stop after response headers or another observable acceptance point | Preserve whether acceptance itself proves execution; distinguish stop acknowledgment from terminal confirmation. |
| Abort after first chunk | Client closes after acknowledging one chunk | Do not infer remote stop from socket closure; record gateway awareness. |
| Explicit stop | Authenticated owner requests cancellation through the gateway | Record propagation and actual provider capability independently of client disconnect. |
| Gateway deadline | Timeout while output is pending | Preserve unknown remote state until stronger evidence exists. |
| Lost gateway | Kill the real local gateway process after dispatch | Oracle continues; restart has no privileged knowledge. Hosted process-kill is a separately approved phase. |
| Lost output / truncated stream | Fixture drops transport before terminal evidence | No fabricated completion, refund or release. |
| Completion/stop race | Exercise both event orders through barriers | One stable terminal outcome; no double release. |
| Duplicate dispatch key | Only send a second real call if the exact API documents deduplication and budget allows | Record returned identifiers; identical text is not proof of one execution or one charge. |
| Later observation | Query operation state only if supported | Retain inaccessible/absent/unsupported separately; do not convert missing state to cancelled. |

For unsupported live cases, retain the capability result and mark the corresponding
behavioural check unexecuted. The contract investigation may be complete while the
provider cannot satisfy a desired recovery guarantee. If an expected capability is
inconclusive because evidence is missing, report inconclusive rather than unsupported.

## Data, measurements and comparison

Use `providerContractExperiments/{runId}/cases/{caseId}` for optional Firestore
budget and reservation data. Add that namespace to the shared log-scope allowlist
with exclusion tests. Use the common capture schema plus `capabilities.json` and
`provider-observations.ndjson`. Assign an evidence label to each observation:
`fixture-oracle`, `provider-response`, `provider-status-query`, `gateway-observation`,
`client-observation` or `aggregate-billing`. Only fixture state provides a complete
remote activity oracle in local tests. Keep oracle facts out of gateway decisions.

Measure dispatches, requested/acknowledged/confirmed cancellations, terminal
observations, unresolvable operations, and transport-to-terminal duration **only
where that duration is observable in one clock domain**. Record usage when returned;
unknown usage is null. Aggregate billing cannot attribute one interrupted call
without a documented correlation mechanism and must not be used as a fake oracle.

Compare fixture variants to the old lifecycle scenarios by named property and fault
schedule. Do not numerically compare their configured sub-second durations to real
AI latency. A scripted provider and a real model are different implementations;
report a capability/contract comparison, not source-identical provider parity.
The gateway/classifier code and relevant input policy should remain identical.

## Running the local implementation

From the repository root, with workspace dependencies installed and Pyric built:

```sh
bun test experiments/rate-limiting/provider-contract/tests
bun experiments/rate-limiting/provider-contract/run.mjs run --config experiments/rate-limiting/provider-contract/config/local.json --out /tmp/provider-contract
bun experiments/rate-limiting/provider-contract/run.mjs verify CAPTURE
bun experiments/rate-limiting/provider-contract/run.mjs replay CAPTURE --out /tmp/provider-replay
bun experiments/rate-limiting/provider-contract/run.mjs analyze CAPTURE
bun experiments/rate-limiting/provider-contract/run.mjs compare CAPTURE REPLAY
bun experiments/rate-limiting/provider-contract/run.mjs preflight --config experiments/rate-limiting/provider-contract/config/local.json
# The disabled live example intentionally fails preflight; no CLI can deploy or call a model.
```

The local runner declares a conservative 512-command bound per case (including
up to five 50-poll barriers, controls, recovery, callbacks and final inspections).
Preflight requires the sum of those bounds: 8,192 commands for all 16 cases, within
the default 20,000-command cap. Native transactions allow at most eight callback
attempts separately. A 50-second controller deadline can still make a slow run
incomplete; command headroom is not a timing guarantee. Draining aborts and settles
local output promises before final snapshots, retaining unknown remote work.

Use synthetic prompts with no family/user data. The first live plan must state a
maximum of 12 total provider dispatches, at most two concurrently, a maximum of
64 output tokens per call unless the selected API/model needs an explicitly approved
alternative, and a total test deadline. These are pilot guardrails, not a guarantee
of a dollar ceiling or adequate timing for every case. Count hidden SDK retries as
dispatches or disable them; stop if that cannot be verified. Declare which cases
fit the budget, capability prerequisites and repetition count before starting.
Do not increase the budget because a result was inconvenient. Unknown operations
continue to count against the live concurrency budget across cases. If they exhaust
it, stop the live phase and retain that finding; starting another case or ending
the controller is not evidence that the remote jobs disappeared.

## Completion criteria and handoff

- Local negative control demonstrates that transport-only release is unsafe.
- Supported cases retain complete evidence; missing live capabilities are explicit.
- No real-provider outcome is derived from fixture-only state or local abort alone.
- Source captures verify and replay; failure captures remain incomplete and intact.
- Deliver `capabilities.json`, findings and a contract profile consumable by
  [integrated admission](../integrated-admission/README.md) and
  [automatic recovery](../automatic-recovery/README.md).
- State exactly which interruption outcomes can be resolved, which remain unknown,
  and whether safe re-dispatch is supported. A negative answer is a successful
  finding; do not promise exactly-once remote execution.
