---
title: "How to observe sandbox events"
navLabel: "Observe sandbox events"
group: "pyric / sandbox"
section: "How-to"
order: 125
---
# How to observe sandbox events

One subscription covers everything observable. `sandbox.onEvent(cb)` fires a [`SandboxEvent`](../pyric-sandbox-reference-sandbox-event/) for every rule evaluation, every committed write, every snapshot delivered to a listener callback, every suppressed re-eval, every listener attach / detach / errored, and every reset / dispose boundary. Filter on `event.kind` to recover whichever slice your code cares about.

## When to use which kind

| You want to | Filter for |
|---|---|
| Surface denials in a banner / toast | `kind === 'request' && result === 'deny'` |
| Render a "Network panel"-style traffic monitor | `kind === 'request'` |
| Log every committed write for forensic replay | `kind === 'write'` |
| Render a snapshot listener's deliveries | `kind === 'snapshot_delivery'` |
| Investigate "why didn't my listener fire" | `kind === 'snapshot_suppressed'` |
| Track listener lifecycle (attach / detach / errored) | `kind` starts with `'listener_'` |
| Segment a persisted stream around `reset()` / `dispose()` | `kind === 'session_boundary'` |
| Measure rule-engine eval cost | `kind === 'request'`, read `evalMs` |
| Attribute a listener re-eval to the originating write | `kind === 'snapshot_delivery'`, read `triggeredBy` |

## Subscribe
```ts
import { initializeSandbox, type SandboxEvent } from 'pyric/sandbox';

const sandbox = initializeSandbox();
const events: SandboxEvent[] = [];

const unsubscribe = sandbox.onEvent((event) => events.push(event));

// ... later:
unsubscribe();
```
The subscription **survives `sandbox.reset()`** — the underlying environment swaps but the user callback stays in the sandbox-level registry. A `session_boundary` event with `phase: 'reset'` fires immediately before the swap so consumers can segment their stream. On `sandbox.dispose()` the boundary fires once with `phase: 'dispose'` and the registry clears.

## Render a traffic panel
```tsx
function TrafficPanel() {
  const [events, setEvents] = useState<SandboxEvent[]>([]);
  useEffect(() => {
    return sandbox.onEvent((ev) => {
      setEvents((prev) => {
        // Cap the in-memory buffer — see "Volume" below.
        const next = prev.length >= 5000 ? prev.slice(-4999) : prev.slice();
        next.push(ev);
        return next;
      });
    });
  }, []);

  return (
    <ul>
      {events.filter((e) => e.kind === 'request').map((r) => (
        <li key={r.id}>
          <Badge tone={r.result === 'allow' ? 'green' : 'red'}>{r.result}</Badge>
          <code>{r.method} {r.path}</code>
          <span>{r.auth?.uid ?? 'null'}</span>
          <span>{r.evalMs.toFixed(1)}ms</span>
        </li>
      ))}
    </ul>
  );
}
```
## Derive denials as a filter

The previous `onDenial` channel is gone — denials are a one-line filter:
```ts
const unsubscribe = sandbox.onEvent((event) => {
  if (event.kind !== 'request' || event.result !== 'deny') return;
  showBanner(`${event.method} ${event.path} denied`);
});
```
The same `request` event carries `auth`, `reasons`, `request.resourceData`, `resourceBefore` — every field the old `DenialEvent` carried, plus the per-eval `evalMs` the request channel always had.

## Capture snapshot deliveries

`onRequest` used to fire one listener-origin event per write that touched a watched path, even when the listener's diff-check determined the result was identical to the prior snapshot. That over-counted: consumers saw "the listener was woken up", not "the listener delivered to user code". The new `snapshot_delivery` and `snapshot_suppressed` events disambiguate.
```ts
sandbox.onEvent((event) => {
  if (event.kind === 'snapshot_delivery') {
    console.log(
      `listener ${event.listenerId} delivered: ` +
      `+${event.addedCount} ~${event.modifiedCount} -${event.removedCount} ` +
      `(size=${event.size})`,
    );
  } else if (event.kind === 'snapshot_suppressed') {
    console.log(`listener ${event.listenerId} woke up but had nothing to deliver`);
  }
});
```
The initial-fire event (when a listener attaches) emits `snapshot_delivery` with every existing doc as `added` and no `triggeredBy`. Write-driven re-evals carry `triggeredBy: { method, path }`.

## Track listener lifecycle
```ts
sandbox.onEvent((event) => {
  if (event.kind === 'listener_attach') console.log(`+ ${event.target.kind}: ${describe(event.target)}`);
  else if (event.kind === 'listener_detach') console.log(`- ${event.listenerId}`);
  else if (event.kind === 'listener_errored') console.log(`! ${event.listenerId}: ${event.error?.message}`);
});
```
Attach fires once before the initial-snapshot delivery. Detach fires when the returned unsubscribe is called against a still-registered listener (idempotent calls don't double-emit; listeners dropped by `reset()` don't emit detach — the `session_boundary` event covers the rollover). Errored fires when a stream-level rule denial silently terminates the listener.

## Volume — default-hide listener re-evals

Per the issue #307 probe data: a query listener can re-evaluate on every write to its collection. With N existing docs and N writes, the upper bound is O(N²) re-evals. The `snapshot_delivery` count tracks actual user-callback invocations — much smaller than the raw re-eval count. Use `kind: 'snapshot_delivery'` events (rather than `kind: 'request' && origin: 'listener'`) when "how many times did the listener fire" is the question.

The decision-doc recommendation: in a UI panel, default-hide `kind: 'request' && origin: 'listener'` events behind a toggle. Default-show: user-origin requests + snapshot deliveries + listener lifecycle + denials. `snapshot_suppressed` is opt-in (inspector mode).

## Capture committed writes for replay
```ts
sandbox.onEvent((event) => {
  if (event.kind !== 'write') return;
  // priorState and nextState are full doc snapshots — null when absent.
  // groupKind disambiguates batch / transaction sub-ops sharing a groupId.
  archive.append({
    at: event.at,
    op: `${event.method} ${event.path}`,
    auth: event.auth?.uid ?? null,
    prior: event.priorState,
    next: event.nextState,
    group: event.groupKind,
    groupId: event.groupId,
  });
});
```
`write` events fire only for writes that the rule engine allowed AND the keyspace successfully applied. Denied or rolled-back writes surface as `kind: 'request' && result: 'deny'` with no companion `write` event.

The `sentinels`, `autoId`, and `requestTime` fields on `WriteSandboxEvent` are populated so a captured stream can be replayed — see [Replay a captured event stream](../pyric-sandbox-how-to-replay-events/). For live observation you can ignore them.

## Segment around reset()
```ts
let session = 1;
sandbox.onEvent((event) => {
  if (event.kind === 'session_boundary') {
    console.log(`--- session ${session} closed (${event.priorOpCount} events) ---`);
    if (event.phase === 'reset') session++;
  }
});
```
`session_boundary` fires BEFORE the env swap on `reset()` and BEFORE teardown on `dispose()`. The subscription survives reset; only dispose clears it.

## Subscriber contract

The sandbox calls your callback **synchronously**, inline with the op that produced the event. A few consequences worth understanding:

- **Heavy synchronous work inflates the next op's `evalMs`.** The event you receive carries timing for the rules evaluation that just finished, but the *next* op is sitting on the same event loop. If your subscriber sorts a 10k-element array on every event, the user-visible op latency includes that work. Push expensive processing into a `queueMicrotask` / `setTimeout(..., 0)` or onto a worker.
- **The sandbox does not await async subscribers.** If you write `sandbox.onEvent(async (ev) => { await fetch(...) })`, the sandbox returns from emit before your `await` resolves. Subscribers are **observational** — the sandbox doesn't propagate their errors and won't pause ops on them. Do your own error handling inside the handler.
- **Async rejections are swallowed.** A rejected Promise from an async subscriber is silently caught — it will not become an `unhandledRejection`, but it will also not surface anywhere. Wrap in `try/catch` yourself if you need to know your subscriber crashed.
- **Large `resourceData` / `sample.docs` balloons the in-memory buffer.** A 1 MB write becomes ~1 MB per event in your ring buffer. Multiply by 5000-event default cap = 5 GB worst case. Strip or truncate before retaining events long-term.
- **No back-pressure.** There is no per-subscriber queue. If a subscriber is slow synchronously, the sandbox blocks; if it's slow asynchronously, the sandbox doesn't wait but events accumulate in *your* downstream pipeline. Size your consumer's buffer.

## See also

- [`SandboxEvent` reference](../pyric-sandbox-reference-sandbox-event/) — field-by-field for every kind.
- [Listener re-evaluation on `deployRules`](../pyric-sandbox-explanation-listener-re-evaluation/) — why deploy-rules-driven re-evals carry no `triggeredBy`.
- design rationale — the rationale for replacing the three-channel surface with one.
