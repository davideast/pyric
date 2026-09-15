# Local usage estimates

Traffic → Rates leads with service-specific usage. Select a service for coverage and SDK method counts. These are estimates for this page, averaged over five seconds, not a Firebase invoice or project-wide totals.

## Firestore

The current model follows document-operation units used by Firestore Standard edition:

- A successful document fetch counts one read, including a missing document.
- A successful query counts its returned documents, with a minimum of one read.
- Initial listener results count their documents. Later query results count added and modified documents, not the entire result again. Document deletion notifications do not add reads.
- Explicit cache reads and snapshots marked from cache contribute no estimated server reads.
- Successful set, update and add calls count one write; deletes count separately. Batches count their constituent writes and deletes only after success.
- Denied writes do not count as successful writes. Any rules-dependent reads they cause remain unmeasured.

Not measured: transaction reads, writes and retries; aggregate/index-entry scans; rules-dependent reads; query removals whose deletion/filter cause is unavailable; storage and network charges. Production connection sharing, caching and reconnect behavior can differ. Pending-write metadata in the local sandbox can accompany an already accepted write, so it is not treated as proof of a free cache delivery.

## Realtime Database

The primary view includes Reads/s and Writes/s (public SDK requests, including failed attempts), Listener deliveries/s (callbacks, including initial results), and Snapshot payload/s. Requests and deliveries remain separate rather than being combined into an ambiguous ops total. These are activity metrics, not RTDB billing units.

Snapshot payload is the UTF-8 JSON size of values returned by explicit fetches and listener callbacks. It includes initial results and subsequent deliveries, for value and child listeners.

This is **not billed download size**. A full callback value can be assembled from a small wire delta; several callbacks may share one connection. Protocol/encryption overhead, priorities, exact wire serialization, reconnects, storage and onDisconnect execution are not measured. The UI displays billed downloads and stored data as **Not measured**, never as zero or as payload-byte totals.

## Evidence and limits

Adapters reduce results to numeric evidence before the journal observes them. No document contents or serialized payloads are retained in the observation stream. Page and worker adapters share the same measurement functions. Worker query deliveries carry the numeric change evidence computed at the host where query changes are available.

Completed SDK calls remain useful diagnostics, but are not substituted for document counts or payload size. Unsupported evidence is surfaced; the rolling ring remains bounded independently of request volume.

Billing references: [Firestore](https://firebase.google.com/docs/firestore/pricing), [Realtime Database](https://firebase.google.com/docs/database/usage/billing).

## Service activity history

The service overview keeps live five-second averages and the time of last activity. Both service details share a timeline with individual one-second buckets. RTDB shows requests and listener deliveries; Firestore shows estimated document reads, writes and deletes. Each service keeps its own selection and playback state. Measurement explanations are collapsed below the method table. It retains up to 60 seconds; the latest activity window remains available while idle, even when the tab was closed.

Opening the detail after at least two seconds without activity selects the latest recorded activity period. A gap of more than two seconds separates periods. Long periods can be limited by the 60-second retention window. The timestamps identify the actual recorded period, not the time the tab was opened.

Click or drag on the chart to select an inclusive range of one-second buckets. Arrow keys select a second; Shift extends the selection. Selection and Pause capture an immutable window. New events cannot move it. Live resumes the current minute. Average/s divides the selected total by all selected seconds, including idle seconds; Peak/s is the largest one-second count. Method totals and averages use the same selected period. The listener gauge is explicitly current.

Run `node examples/runtime-flow-lab/verify-firestore-history.mjs` for document totals and Firestore history interactions. Run `node examples/runtime-flow-lab/verify-history.mjs` for idle recall, exact burst totals, pause stability, Live, pointer/keyboard selection and narrow-screen coverage.
