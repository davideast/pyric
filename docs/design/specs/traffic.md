# Spec: Traffic

Route: `/traffic`, `/traffic/<eventId>`
Status: draft (respecification — current tab is an assists artifact and is
not a starting point)

## Purpose

Answer "what happened in my sandbox, in what order, and why" — Traffic is
the addressable, user-facing projection of the sandbox event stream (see
TOOL-SYSTEM.md "Traffic is a projection"), the ground truth every other
surface links into. It is **multi-service**: Firestore and RTDB today,
Auth and Storage to follow — one view, service as a first-class dimension,
never per-service traffic surfaces.

## Content inventory

| Item | Tier | Rendering | Rationale |
|---|---|---|---|
| Event list (newest-first, **virtualized**, L6) | primary | direct | the view's reason to exist; unvirtualized lists have already failed firsthand |
| Per-row derived action (denial → debug pipeline; write → open subject record) | primary | direct, one per row (M6) | events must connect to their consequence — the current tab's biggest miss |
| Filter row (service, verdict, caller/provenance, session) | secondary | direct, single compact row | filtering is how a log is used; one row, no stacked toolbars |
| Provenance (session name + caller) per row | secondary | direct, compact chip in row | the cross-tool session identity made visible |
| Event detail (full payload, rule trace, timing) | tertiary | drill-in → `/traffic/<eventId>` (detail pane on wide, stacked on narrow) | detail is per-event, not default render |
| Activity chart / rate summary | tertiary | disclosure (expandable summary strip) | useful sometimes; does not pull its weight as primary real estate |
| Save-session-as-fixture | tertiary | overflow action on the filter row | valuable but rare; pairs with `pyric verify` |

## Primary action

Selecting an event (which reveals its derived action). The view itself has
no global primary action — it is a record, not a workbench.

## Foundation layout contract

```css
.traffic {
  display: grid;
  grid-template-rows: auto 1fr; /* filter row | body */
  gap: var(--space-3);
}
.traffic__body {
  display: grid;
  /* list + detail pane when there is room; single column when not */
  grid-template-columns: repeat(auto-fit, minmax(24rem, 1fr));
  gap: var(--space-4);
  min-height: 0; /* the list owns scroll (L5) */
}
```

Scroll owner: the virtualized event list. The detail pane scrolls
independently. The page never scrolls as a whole.

## Local layouts

- Event row: grid `auto auto 1fr auto auto` (service tag |
  verdict/provenance chip | summary with subject path | time | derived
  action); middle truncates; rows are container-agnostic and carry no
  margins (L2, L4). With four services in one stream, the service tag must
  make origin legible at a scan — a compact, color-consistent tag, not an
  icon guessing game.
- Detail pane: subject header (linked), result body (payload/trace),
  derived actions — the standard result-renderer shape (`DenialDetail`,
  write detail) from TOOL-SYSTEM.md.

## Cross-links (the point of the respec)

- Every row → `/traffic/<eventId>` (stable id; engineering prerequisite).
- Subject link → the record it touched: `/firestore/<path>`,
  `/rtdb/<path>`, `/storage/<path>`, `/auth/<uid>`.
- Denied events → the denial pipeline in Rules, event pre-loaded:
  `/rules?denial=<eventId>`.
- Inbound: Home's feed rows and rules regression tables link back to
  `/traffic/<eventId>`.

## States

- Empty: teaches — "traffic appears when your app, an agent, or a seed
  touches the sandbox," with links to seed builder and MCP setup.
- Loading: history batch skeleton rows.
- Dense: virtualization handles volume; filters + session scoping keep it
  navigable; no cap needed here (unlike Home's feed).
- Narrow: single column; detail becomes a stacked drill-in.

## URL states

- `/traffic?service=&verdict=&caller=&session=` — filter state is
  shareable.
- `/traffic/<eventId>` — one event, detail disclosed.

## Open questions

- Retention/backpressure: history window size in the worker feed and
  whether older events page in on demand.
- Whether the disclosure chart is per-filter (rate of the filtered slice)
  or global.
