# Provider lifecycle and cancellation: local experiment

The scenario is an AI gateway enforcing per-user allowances while protecting
shared capacity from bursts and long-running inference. This experiment asks
when a gateway can safely release an inference reservation. It follows allowance,
admission overload and inference concurrency experiments, reusing their Pyric
transactions and loopback Node/Express transport.

## Hypothesis and scope

A closed transport is insufficient evidence that remote inference stopped.
Release a slot after confirmed completion or cancellation; retain it when remote
outcome is unknown. Explicit stop requests must be authenticated and scoped to
the requesting user. Cancellation acceptance is not cancellation confirmation.

This round is entirely local. No Cloud Run deployment, hosted Firestore, real
AI Logic inference, production credentials or provider charges are involved.
Fixture bearer tokens exercise ownership decisions, not Firebase token validation.
The simulated provider separates its remote-activity oracle from evidence exposed
to the gateway. It cannot demonstrate what an actual AI Logic service confirms.

## Run and inspect

From the repository root (Node and Bun plus installed dependencies required):

```sh
bun experiments/rate-limiting/inference-allowance/run.mjs run \
  --config experiments/rate-limiting/inference-allowance/config/provider-lifecycle.json \
  --out experiments/rate-limiting/inference-allowance/results
bun experiments/rate-limiting/inference-allowance/run.mjs verify CAPTURE_DIRECTORY
bun experiments/rate-limiting/inference-allowance/run.mjs analyze CAPTURE_DIRECTORY
bun experiments/rate-limiting/inference-allowance/run.mjs replay CAPTURE_DIRECTORY --out /tmp/lifecycle-replays
bun test experiments/rate-limiting/inference-allowance/tests/provider-lifecycle.test.ts
```

Each run has a new ID and includes executed source, input configuration, environment,
workload/source hashes, raw events, assertions, summary and an integrity manifest.
Earlier captures are preserved. `compare` accepts two verified captures only when
source, workload, rules and required coverage match. Historical experiments with
different source or workloads remain useful context, not controlled performance pairs.

## Cases

- Normal stream: complete output, then release.
- Owner cancellation: reject signed-out and forged requests; another user's target
  is indistinguishable from an absent request; repeated cancellation is idempotent.
- Ignored cancellation: local transport aborts while remote work continues.
- Inference deadline: stop waiting, request cancellation, retain capacity.
- Client disconnect: local HTTP disconnect triggers an abort; this is deliberately
  not assumed to propagate through a hosted proxy.
- Completion/cancellation race: normal completion wins before delayed cancellation
  confirmation; no false confirmation or double release.
- Stop before dispatch: delayed admission unwinds without dispatch or debit.
- Unknown outcome: transport fails, remote termination cannot be verified.
- Truncated stream: some output arrives before transport failure; still unknown.
- Independently ordered confirmation/output: confirmed cancellation with pending
  or resolved/rejected output, plus confirmed completion whose output remains stuck;
  capacity releases on confirmation while the output deadline bounds the request.
- Negative control: the old promise-only adapter contract releases on transport
  rejection. Two invariants must fail: retention until termination and the real
  per-user execution bound measured by the fixture oracle.

Checks include persisted debit/receipt consistency, no refunds for lost or
cancelled output, no duplicate dispatch, no database work for busy responses,
stream ordering, full event sequences and ownership. A successful experiment
includes the two expected failed control invariants; it does not erase them.

## Implementation map

- `scenarios/provider-lifecycle/`: one authored scenario per file, including
  schedules, options and expected decisions; `scenarios/provider-lifecycle.mjs`
  computes the registry.
- `architecture/gateway.mjs`: owner-scoped cancellation, execution reservation,
  provider outcome classification and conservative quarantine.
- `services/inference-http.mjs`: inference responses and explicit cancellation.
- `services/scripted-provider.mjs`: separate transport, termination and fixture
  oracle lifecycles; configurable confirmation, ignored stop and lost transport.
- `services/http-server.mjs`: local Express, Pyric and final stored allowance observations.
- `harness/http-load-generator.mjs`: separate Node client, real loopback requests.
- `analysis/provider-lifecycle.mjs`: checks and normalised lifecycle measurements.
- `config/provider-lifecycle.json`: bounded local suite; capture/replay uses the
  existing `run.mjs`, shared evidence machinery and `results/` directory.

## Adapter contract and limitations

The new provider adapter returns `start(request, options) -> { result, termination }`.
`result` describes the transport/output. `termination` resolves to an outcome of
`completed`, `cancelled`, or `unknown`, plus an evidence label. Only confirmed
completion or cancellation permits reservation release after dispatch. Provider
confirmation is processed independently of output settlement; confirmed
cancellation is reported as `provider_cancelled`. Completed operations whose
output remains pending require a configured inference deadline to bound response
waiting; every such case here sets one. A rejected
termination promise or invalid outcome is treated as unknown. An adapter must be
trusted host code; generated or caller-supplied outcomes are not authoritative.
Legacy `generate()` adapters remain unchanged for historical regression tests;
they do not acquire this stronger guarantee automatically.

Unknown operations retain their slot in this process (quarantine); they cannot be
safely recovered by a timer or a local abort. Inference requests for that UID stay
busy. Other users can proceed only while shared capacity remains. Enough unknown
operations can exhaust the instance. Quarantine is neither durable nor shared
across replicas; a restart loses these reservations. This is a conservative local
safety experiment, not a production recovery system. Future provider reconciliation
and distributed capacity experiments must address these trade-offs explicitly.

The cancellation endpoint returns 202 `cancellation_requested`, not “cancelled”.
Only the local server exposes it in this round; no deployment router is changed.
It looks up active work using authenticated UID plus request ID. Body-supplied UID
is rejected, completed/absent/foreign requests return 404, and repeated stops do
not send another provider abort. Receipts still conservatively prevent redispatch
without caching a completed answer or claiming exactly-once provider execution.

Normalised events retain run/case/request/attempt/instance IDs and process-local
sequence/timing. `transport-ended` (or the fixture-only `transport-pending`), `provider-outcome`, `execution-quarantined`
and reservation release are distinct. `fixture-remote-*` observations are marked
as simulation evidence, never measurements of real provider billing or capacity.
The `summary.json` lifecycle section separates unknown outcomes from legacy
unclassified outcomes and records null termination/release timing when unobservable.

Stop here before the hosted phase. A future supervised comparison must establish
AI Logic's observable termination contract, authenticated user ownership, a small
shared dispatch budget and output-token limits before invoking any live provider.
