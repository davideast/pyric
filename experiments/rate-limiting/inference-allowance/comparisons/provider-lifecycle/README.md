# Provider lifecycle: local results

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../EVIDENCE.md).

The AI gateway must enforce each user's allowance without letting bursts or
long-running inference exhaust shared capacity. This experiment advances the
execution reservation technique: determine which evidence permits a slot to be
released, independently of the caller's connection and the output transport.

**Local only:** Pyric's public Admin-shaped Firestore sandbox, a Node/Express
server, a separate Node HTTP load generator, and a scripted provider. No Cloud
Run deployment, hosted Firestore writes, live AI Logic requests or credentials
were used in this round.

## Retained runs

The final run is [74ef580f-008b-4e77-ae43-6bfe20675d84 — private archive](../../../../EVIDENCE.md),
executed from source revision `64a8a553819a3c49e1570ffcdab666a0cfc1c5fc`.
Its [manifest — private archive](../../../../EVIDENCE.md)
verifies the source snapshot and recorded artifacts. Source snapshot SHA-256:
`f0ce27a1d1f9c9e1f9177524af22b91a3798920e282ec9ca819c3d951fe7ba75`.

- 14 scenarios; 63 scheduled HTTP operations: 54 inference requests and 9 explicit
  cancellation requests. Chunk-observation acknowledgements are auxiliary traffic.
- 35 simulated provider dispatches.
- 224 checks: 222 passed and 2 deliberately failed in the unsafe control. Every
  outcome matched its declared expectation; no unexpected or incomplete cases.
- Both source-inclusive captures passed integrity verification. Capture/replay
  regression tests also passed, including source/workload compatibility checks.
- Final harness regression suite: 39 tests, 292 assertions, all passed. Scoped
  TypeScript checks passed. Standards and specification review findings were fixed.

The earlier [bfa3a4ff-1365-4ad1-8db7-305dd95a3095 capture — private archive](../../../../EVIDENCE.md)
is preserved unchanged. Its 10 scenarios and 160 checks met their expectations,
but review exposed missing independently ordered transport/confirmation cases.
It is superseded as coverage evidence by the final run, not deleted or relabelled
as a failure. The differing source and workload mean these two runs are not a
controlled performance comparison. A passing suite only establishes its tested cases.

## What happened

| Situation | Observation | Meaning |
| --- | --- | --- |
| Owner requests stop | Foreign and signed-out requests were rejected; forged UID bodies were rejected; repeated owner cancellation produced one provider abort | Cancellation acceptance is owner-scoped and distinct from confirmation |
| Provider ignores stop | Transport ended around 172 ms; remote work completed around 902 ms; capacity remained held for another 729 ms | Local abort cannot justify releasing remote capacity |
| Gateway deadline | Transport ended around 182 ms; the slot remained held another 721 ms until completion | A response timeout does not end inference |
| Client disconnect | A local disconnect triggered an abort; remote work continued; capacity remained occupied | This establishes local behaviour only, not proxy propagation |
| Normal completion wins a cancellation race | Completion was recorded, no false cancellation confirmation, and one release | A stop request does not retroactively change a completed provider outcome |
| Stop before admission completes | The delayed request never dispatched or debited | Only this before-read fixture establishes no-debit cancellation; post-commit debits remain conservative |
| Lost or truncated transport, no confirmation | Each unknown operation retained one slot, including after the fixture oracle knew it had finished | The gateway cannot act on knowledge available only to the test fixture |
| Confirmation with pending, resolved or rejected output | Cancellation stayed classified as cancelled; capacity released once and subsequent work completed | Provider termination must be observed independently of output settlement |
| Confirmed completion with stuck output | Capacity released on confirmation; waiting for output ended at the configured deadline | Inference lifetime and response lifetime are separate |
| Unsafe promise-only control | Slot released roughly 0.12 ms after transport failure; provider work continued to roughly 902 ms; peak same-user activity reached 2 against a limit of 1 | Treating transport settlement as provider termination breaks the actual execution bound |

Timings are observations under deliberately configured sub-second fixtures, not
measurements of AI Logic latency or production throughput. The two failed control
checks remain explicit in [result.json — private archive](../../../../EVIDENCE.md):
`capacity retained until termination` and `remote work respects capacity`.
All guarded cases had peak remote activity of one per user. Other users could
still proceed while shared capacity remained available.

## What changed

The host gateway now offers an owner-scoped cancellation operation and a provider
contract with separate output and termination promises. Known completion or
cancellation releases the reservation; unverified termination quarantines it.
Already-confirmed cancellation takes precedence over a rejected output promise.
The old promise-only adapter remains available for prior experiments and the
explicit unsafe control; existing adapters do not automatically gain stronger
termination guarantees.

Each authored lifecycle scenario has its own file, with computed discovery and
shared fixture construction. Normalised events distinguish transport end,
provider outcome, reservation release and quarantine. Simulation-only remote
activity is labelled separately; absent remote measurements remain null rather
than being inferred from transport events. Executed source and raw data live
beside each other, so inspecting these runs does not require reconstructing Git history.

## Boundary before production

This validates the gateway state transitions against a controlled provider, not
AI Logic's real cancellation contract. Unknown outcomes deliberately consume
capacity indefinitely in this process; enough unknowns can exhaust the instance.
A restart loses local reservations. Neither distributed capacity, durable
reconciliation, Firebase end-user authentication nor provider billing is proven.

No hosted phase was started. The next supervised experiment must establish what
AI Logic can actually confirm, then use a bounded call/output budget to compare
its lifecycle observations with these fixtures. If remote termination cannot be
confirmed, retain that unknown explicitly and design recovery around it.

See [setup, commands and implementation map](../../PROVIDER-LIFECYCLE.md).
