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

Opening the detail after at least two seconds without activity selects the latest recorded activity period. A gap of more than two seconds separates periods. The timeline retains up to 30 minutes of samples while the page stays open. The timestamps identify the actual recorded period, not the time the tab was opened.

Click or drag on the chart to select an inclusive range of one-second buckets. Arrow keys select a second; Shift extends the selection. Selection and Pause capture an immutable window. New events cannot move it. Live resumes the current minute. Average/s divides the selected total by all selected seconds, including idle seconds; Peak/s is the largest one-second count. Method totals and averages use the same selected period. The listener gauge is explicitly current.

Run `node examples/runtime-flow-lab/verify-firestore-history.mjs` for document totals and Firestore history interactions. Run `node examples/runtime-flow-lab/verify-history.mjs` for idle recall, exact burst totals, pause stability, Live, pointer/keyboard selection and narrow-screen coverage.

## Trigger a problem

The problem buttons make real SDK requests and work with either Messages backend:

- **Deny Firestore write / Deny RTDB write** submit a negative budget to a rule that requires zero or greater. Open the denied request in Traffic to inspect the rule evaluation.
- **Missing Firestore index / Missing RTDB .indexOn** issue a query on a fresh path each time. Open the Index request in Traffic to inspect and add the required index. Repeating the button creates another missing-index case without deleting earlier fixes.
- **Test rate warning** writes messages using the selected Messages backend above its configured write threshold for the configured duration, plus three seconds. Open the amber chip to inspect the incident and its chart evidence. The demo supports enabled write thresholds up to 100/s; higher or disabled thresholds show an explanation instead of starting a workload. It does not change threshold settings.

A recent denial takes priority over amber warnings. Reload the page before testing the amber chip after a denial. Index and threshold configuration lives in a disposable directory created by the demo server; restarting the server resets it.

Run `node examples/runtime-flow-lab/verify-warning-scenarios.mjs` with the demo server running to check both backends, Traffic outcomes, rate incidents and the narrow layout. This verification expects the demo's default threshold settings.

### Reviewing a rate burst

The chip stays interactive while **Test rate warning** runs. Rates shows a compact service list with one recorded-activity summary and incident count per service. Select the service to inspect its timeline, or select its incident count to browse threshold breaches.

Use the **Timeline** slider below the chart to move through retained activity. **Zoom in** shows a shorter interval in more detail; **Zoom out** shows a longer interval. The view ranges from 10 seconds to 30 minutes. **Live** follows new activity without deleting older samples. Scrubbing pauses the view at the chosen time; recording continues while paused or while the chip is closed. Reloading clears page history, and samples older than 30 minutes are discarded.

Run `node examples/runtime-flow-lab/verify-timeline.mjs` to check opening and navigating the chip during a burst, scrubbing and zooming retained activity, and retained totals after the workload stops.

For the regression that checks access after the former one-minute cutoff, run `TIMELINE_AGE_MS=65000 node examples/runtime-flow-lab/verify-timeline.mjs`. It waits after a real burst, scrubs back to the early measurements, returns to Live, and verifies those measurements can still be reached.

## Save a timeline capture

In a service's Rates view, select the period and choose **More actions → Save capture…**. The capture is saved under `examples/runtime-flow-lab/.pyric/captures/` and survives server restarts. CLI and Vite sessions use their own project’s `.pyric/captures/`. Each saved snapshot contains the chart measurements, selected interval, threshold settings, incident details when selected, and retained operations for that service and interval. The demo also attaches a full sandbox state using `captureFullState`; CLI-hosted pages attach the existing session fixture when available. The attachment is current session state at export time, not the historical starting state of the selected interval.

Choose **More actions → Open capture…** in a service's Rates view to list and reopen project captures after a reload. This is a read-only view; **Return to live** returns to the running page. Inside an opened capture, **More actions → Download JSON** downloads a portable copy. The capture list’s menu also offers **Open file…**. Standalone pages without project storage keep the download fallback. Import validates the capture and does not execute its operations, seed its data, or apply its thresholds. Files are limited to 32 MB.

These files use `pyric.rate-capture.v1`. They are investigation bundles, not inputs to `pyric verify` or `seedFromFixture`. Their `sessionFixture` field carries an existing-format attachment separately. Exact selected-period replay is explicitly unavailable without a starting-state checkpoint and complete timing/listener evidence. An unavailable fixture does not prevent exporting measurements; the file records the missing attachment. Event retention is bounded to 30 minutes and 20,000 events, so the operation list is not a claim of completeness.

This does not enable `--persist` or overwrite `.pyric/last-session.json`. Run `node examples/runtime-flow-lab/verify-rate-capture.mjs` to verify project save, state attachment, reopening after reload, download, and file import for both services.

The same store is exposed as sandbox tool methods `saveCapture({capture})`, `listCaptures()`, and `openCapture({id?})`. `capture` is the runtime capture JSON string; omitting `id` opens the latest saved snapshot. Tools inspect the complete bundle without restoring state or replaying operations. Files are immutable snapshots with generated ids; a second save creates a new file.


### Focused Rates navigation

A service drill-in contains one chart, timeline controls, and one table for the selected interval. Its bottom bar has a single **Pause / Resume live** action and **More actions**. The menu contains capture actions, **Thresholds…**, **Incidents**, and **Measurements**. Measurements holds SDK method counts, scope, and coverage explanations. The **Services** breadcrumb returns to the list, where **Requests / Rates** switches the Traffic view. Use `node examples/runtime-flow-lab/verify-rates-navigation.mjs` to verify these paths.

A running browser bridge exposes the same host operations as `sandbox_save_capture`, `sandbox_list_captures`, and `sandbox_open_capture`. These use the bridge host's project directory, so an agent can inspect a capture saved from the chip without downloading it.

## Incident handoff check

Run `bun examples/runtime-flow-lab/verify-capture-handoff.ts` to trigger, select, and save a Firestore and RTDB rate incident. It closes the browser pages. Restart this demo server, then run the same command with `--inspect` to reopen both captures through fresh sandbox and bridge MCP sessions. The check compares saved content with the original browser capture, validates the incident evidence and measurement definitions, and verifies read-only inspection. See `docs/runtime-captures.md` for an example agent prompt.


Use **Rename…** or **Delete…** from an opened project capture's menu to manage it. Deletion has a separate confirmation screen; Cancel preserves the snapshot. Names live in metadata beside the immutable capture. Run `node examples/runtime-flow-lab/verify-capture-management.mjs` to verify naming, reload, cancellation, and deletion on desktop and mobile using disposable copies.
