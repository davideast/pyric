# 0006: Remove eager page fallback construction after the app-registry PR

Status: Accepted follow-up for the app-registry/SharedWorker PR

Date: 2026-07-14

## Finding

The served entry graph constructs one page-local `Sandbox` even when
`SharedWorker` is available. The app registry binds to that object during
module evaluation, while every worker-capable service adapter routes operations
through the single worker-owned backend. Each additional tab therefore creates
an inactive fallback primitive, although it does not create another routed
Firestore, RTDB, Storage, Auth, or AI backend.

This is a topology and module-initialization debt. It is not evidence of a
second active backend, but leaving it implicit makes the documented one-backend
contract harder to audit.

## Decision for this PR

Keep the eager primitive while the registry and worker-session lifecycle are
being stabilized. Removing it requires decoupling the Firebase-shaped app
registry from its synchronous sandbox binding and then proving every
no-SharedWorker adapter still receives exactly one fallback sandbox. That
crosscuts the import graph without fixing a demonstrated routed-state bug.

The CLI reference now distinguishes the one authoritative worker backend from
the eagerly constructed, inactive fallback primitive. This decision waives
only that construction and allocation P2; it does not waive any operation,
listener, persistence, bridge, Studio, or agent path reaching the wrong
backend.

## Follow-up boundary

In a dedicated simplification PR:

1. Make registry creation independent of eager `initializeSandbox()`.
2. Lazily construct and bind the page sandbox only on the no-SharedWorker path.
3. Add construction-count browser tests for worker and forced-in-page modes.
4. Run the full served-browser, bridge, Studio, packaging, and older-browser
   fallback gates before merging.
