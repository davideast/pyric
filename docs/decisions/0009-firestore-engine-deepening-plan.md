# 0009: Deepen the Firestore sandbox engine behind a permanent facade

Status: Accepted plan; extends ADR-0007

Date: 2026-07-16

## Context

ADR-0007 accepted the mechanical split of
`packages/pyric/src/sandbox/firestore/local-environment.ts` (3,605 lines) as a
follow-up but did not settle the target design. An architecture review found
the file bundles eight concept families behind ~30 public methods, coupled by
shared mutable instance state: the document store is touched from every family,
the event log from writes and history, and `currentTrigger` — a save/restore
trigger-attribution baton — is written by the write paths *and* the rules
re-evaluation path and read at ~25 emit/schedule sites. Delivery ordering,
trigger attribution, metadata-ack timing, and rules-flip re-evaluation are
reachable only end-to-end and are barely pinned by the existing suites.

The admin-compat query adapter also reaches across the seam for raw candidates
(`readQueryCandidates`, `scanDocuments`) and executes queries on its own side.

## Decisions

1. **Two phases, separate PRs.** The ADR-0007 mechanical split (characterize,
   then pure moves, zero behavior change) lands first and alone. Deepening —
   interface narrowing inside the implementation, trigger-context redesign,
   unit tests at new seams — lands only after the move merges. Mechanical and
   behavioral diffs stay separately auditable.

2. **Targeted characterization pins precede any move.** Before PR A moves
   code, add a characterization suite through the existing public interface
   pinning: delivery FIFO ordering across nested/triggered writes,
   `triggeredBy` attribution including the save/restore stack and the
   re-evaluation path, metadata-ack scheduling, and rules-flip listener
   re-evaluation. These tests must survive every later phase unchanged; they
   are the audit contract for the whole plan.

3. **`TriggerScope` replaces the `currentTrigger` field.** A small module with
   the baton's exact semantics: `run(trigger, fn)` pushes/pops a stack,
   `current()` reads it, and deliveries capture the trigger at schedule time.
   One instance is injected into the write engine (writer) and the listener
   dispatch and event bus (readers). Explicit per-call parameter threading was
   rejected: it rewrites ~30 call sites on the path whose microtask-ordering
   subtlety is the primary regression risk. Relocating the bare field into the
   write engine was rejected because re-evaluation also sets the trigger,
   which would recreate the cross-module write under a new name.

4. **`LocalEnvironment` is the permanent interface.** The extracted modules —
   WriteEngine, ListenerDispatch, RulesReadEngine, EventBus with History — are
   internal seams: private to the implementation and exercised directly only
   by the engine's own unit tests. Callers (`SandboxImpl`, admin-compat) keep
   one interface. Future reviews should not re-propose dissolving the facade
   or exposing the internal modules; no second adapter justifies making those
   seams external.

5. **PR B is a stack of small PRs in coupling order.**
   - B1: EventBus + History (lowest coupling).
   - B2: TriggerScope + ListenerDispatch (delivery queue, notify,
     metadata-ack, re-evaluation hooks) reviewed alone.
   - B3: RulesReadEngine plus a `RulesState` holder (`{ source, ast() }`,
     invalidated by seed/deployRules, shared with the write engine's simulate
     path). WriteEngine remains as the residual owner of `TriggerScope.run`.
   Each PR leaves the engine green through the full simulator, persistence,
   app lifecycle, worker, conformance, and packaging gates.

6. **Admin query absorption is deferred to PR C.** Giving the engine a real
   `runQuery(collection, constraints)` and deleting the candidate-passing
   across the seam is a behavior-sensitive change requiring its own
   characterization of admin query semantics. It must not be folded into the
   internal-only PR B stack. Until then the candidate methods are documented
   as engine-internal.

## Consequences

- Delivery-ordering and attribution bugs concentrate in ListenerDispatch and
  TriggerScope, which gain unit-level interfaces for the first time.
- The facade's external interface does not change in phases A or B; no public
  package subpath or protocol changes anywhere in the plan.
- CONTEXT.md carries the engine vocabulary (Firestore sandbox engine,
  WriteEngine, ListenerDispatch, RulesReadEngine, EventBus, TriggerScope,
  RulesState) so code, tests, and reviews use one name per concept.
- Any correctness defect discovered during the work is fixed independently,
  test-first, per ADR-0007.

## Amendment (2026-07-18): ListenerDispatch file size accepted

`firestore/sandbox/listener-dispatch.ts` (902 lines) exceeds the 600-line
structural trigger. Accepted deliberately: the file is one concept — the
listener registry, delivery scheduler, notify paths, metadata acks, and
rules-flip re-evaluation form a single dispatch machine with one injected
host seam — and splitting it would separate the scheduler from the notify
paths that are its only callers. Architecture scans should not re-flag
this file absent a second concept accreting into it.

## Amendment (2026-07-20): B4, B5, and PR C completed

The remaining stack is implemented behind the permanent facade:

- B4 extracted `WriteEngine`; B5 added a shared `WriteRuntime` and
  `AtomicWritePipeline`, with batch and transaction executors owning only
  their protocol-specific coordination.
- PR C replaced candidate-passing with
  `LocalEnvironment.runQuery(request: RunQueryRequest)`. `RulesReadEngine`
  now gathers candidates, derives the conservative rules-proof projection
  from the exact captured execution plan, evaluates the list rule, and
  executes filters/order/cursors/limit. One-shot reads and listeners use the
  same executor. The admin adapter builds plan data and shapes snapshots.
- `QueryImpl`, `CollectionRefImpl`, and `CollectionGroupQueryImpl` are separate
  concepts with named state and mirrored tests. Reference construction uses an
  injected factory rather than a two-way module import.

The `value-order.ts` move in the first PR C commit is an accepted exception to
the pure-move commit rule. The destination is a dependency of the newly shared
engine executor, so the move and import rewiring were reviewed as one atomic
query-ownership change; rewriting the already-ratcheted stack solely to alter
commit boundaries would add integration risk without changing the final diff.
The same exception applies to commit `06a520af`: splitting
`CollectionRefImpl` and `CollectionGroupQueryImpl` out of `query.ts` removed
the adapter-side listener executor and its import cycle at the same seam. The
class extraction, required reference factory, and data-only listener plan were
reviewed and regression-tested together; retroactively separating them after
the security ratchet would preserve the final code while invalidating the
reviewed stack.

The previously exported callable `QueryConstraintApplier` type remains as a
deprecated source-compatibility declaration, but it is no longer executable as
a listener target: runtime use fails closed with `invalid-argument`. Supporting
that callback would restore two independently mutable representations (proof
metadata plus executable code), violating the single-plan security invariant.
New integrations use `QueryConstraintPlan`.

Query plans are immutable in structure, but opaque object/array operands retain
their original identity. This preserves the pre-existing invariant that query
construction and diagnostics never invoke user getters or Proxy traps. Deeply
snapshotting arbitrary JavaScript values cannot satisfy that invariant in the
general case. This P2 tradeoff is accepted for this stack and must not be
described as deep operand immutability. A follow-up design must introduce an
engine-owned opaque operand capsule (or explicitly lock identity semantics) and
prove all three properties together: no user-code observation, stable listener
membership after registration, and Firestore-compatible equality/membership.

## Amendment (2026-07-21): collection-group rules fail closed

A collection-group query ranges over every collection with the requested ID,
including empty and future nested collections. Authorizing only concrete paths
present in the current local state would make rules act as filters and could
approve a narrower scope than the query actually represents. Rules-enforced
collection-group reads therefore authorize only through an isolated global
`/{document=**}` list/read match, which truly governs every possible result.
Universal rules that reference `request.path` or their recursive wildcard
binding also fail closed because one representative path cannot prove their
condition for every possible group location.
List proof and residual simulation share the simulator's all-match resolver
and the same projected allow-rule set. The proof includes global, service,
root, ancestor, and matched-block helper scopes; residual simulation receives
only rules that the static proof accepted and a synthetic resource built from
query equalities, never a user-addressable placeholder document from local
state. This keeps overlapping-rule OR semantics without letting an unprovable
sibling or stored row authorize a broader query.
For every list query, candidate-document wildcards and `request.path` are
result-dependent and therefore cannot prove the query safe; fixed ancestor
wildcards and request auth/query/time/method remain query-invariant.
Reachable helper-name collisions across lexical scopes also fail closed until
the simulator represents helper calls with scope-aware identities; unrelated
shadowed helpers do not taint an otherwise invariant rule.
Group-specific version-2 shapes such as `/{path=**}/items/{id}` return
`permission-denied` until the rules matcher can symbolically evaluate a
recursive wildcard with trailing segments. The explicit `bypassRules` admin
lens still executes every collection-group plan.
