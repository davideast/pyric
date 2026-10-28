# Referee: a written contract

Some surfaces are pyric's own: the hosted transport, the bridge, the native
clients, the CLI. Production has no answer for them. Their referee is the
contract pyric wrote down: an accepted ADR in `docs/decisions/`, a JSDoc
comment on an exported function, a docs page. A written contract outranks
sibling surfaces, because two clients can agree on behavior the contract
forbids.

ADR-0019 (`docs/decisions/0019-native-client-reconnect.md`) is the model: it
binds the web hosted client, the Node remote client and the Dart, Swift and
Kotlin clients to one reconnect protocol, and its 2026-10-17 amendment states
a delivery contract as numbered rules D1 to D10 (call order, fate decided at
the call, settled exactly once, drop classification, release order, close,
registered before return, delivery order, getters that match their streams,
cancellation).

## Turn the contract into cases

1. **Read the whole contract, amendments included.** A later amendment can
   reverse an earlier decision (decision 7 of ADR-0019 first failed an
   operation issued while reconnecting; the 2026-10-14 amendment holds it).
   The latest text binds.
2. **List the clauses.** One row per testable statement: its id (D3, decision
   7), the clients it binds, and the observable it promises. A clause with no
   observable ("should be robust") is not a referee; note it and move on.
3. **List the bound surfaces.** For each clause, every client and entry point
   it covers. A clause tested on one client and not another is the most common
   gap.
4. **Write each case as a probe of the observable,** through the real entry
   point: a real socket on a loopback port, a real host process, a dropped
   connection (fault injection, [workstreams.md](workstreams.md#4-fault-injection)).
   Read absence after an operation answered on the same ordered socket, never
   after a delay.

The existing clause tests show the form:
`packages/cli/test/serve/worker/hosted-delivery-contract.test.ts` (D5, D6, D7,
D10 on the web hosted client), `hosted-call-order.test.ts`,
`hosted-reconnect-hold.test.ts`, and per language
`packages/swift-client/Tests/PyricFirestoreTests/*CallOrderTests.swift`,
`packages/flutter-client/test/transport_reconnect_test.dart`.

## Verdicts against a contract

- `REAL` cites the clause by ADR number and id, quotes it, and shows the
  observable that breaks it.
- `FALSE` when the behavior matches the latest text, even if it looks wrong.
  If the contract itself is wrong (it disagrees with production SDK behavior,
  as the 2026-10-18 amendment found for RTDB calls in flight at a drop, #1088),
  that is a
  finding against the contract: propose an amendment, do not fix the code to
  the old text.
- `NEEDS_RUNTIME` when the clause defers to the SDK ("follows the SDK") and no
  observation captures the SDK's behavior: capture it
  ([oracle-sdk-runtime.md](oracle-sdk-runtime.md)).

## Pinning and fixing

A contract has no observation file; the clause test is the evidence. Land it
first as a pin: it asserts today's behavior and names the clause that behavior
breaks. The fix flips the assertion, red to green, as in
[fix-campaign.md](fix-campaign.md). ADR-0019 asks for
fixes grouped by rule, one PR per affected client, each citing the rules it
brings its client into line with.
