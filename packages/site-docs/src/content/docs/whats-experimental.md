---
title: "What's experimental"
group: "Trust"
section: ""
order: 28
description: "Know exactly which parts of Pyric are v1 and which are still earning it."
---

# What's experimental

Auth, Firestore, and Rules are v1: conformance-held against recorded production behavior, safe to depend on for the dev-to-prod swap.

Realtime Database and Storage are experimental. They are built, documented, and usable today, and they are explicitly not v1. This page is the exact meaning of that word.

## What experimental costs you

The experimental services are verified sandbox-side: unit probes check them against the documented `firebase/database` and `firebase/storage` contracts, and those probes pass. What most of their behavior lacks is a production observation, a recording of what the real service actually did, pinned and replayed in CI. Verified against the documentation is not the same as verified against production, and Pyric does not pretend otherwise.

Concretely, two things follow:

- **Parity is best-effort, not guaranteed.** Don't depend on Realtime Database or Storage behaving identically in production for a swap you can't afford to debug. The edge cases the docs don't state are exactly the ones not yet recorded.
- **Surfaces may change.** As behaviors get pinned to real observations, the implementation follows the evidence, and that can move APIs and semantics between versions.

Known boundaries are named where you'll meet them: Storage's v1 scope excludes `getDownloadURL`, resumable uploads, and paginated `list`, and the remote sandbox caps Storage operations at 8 MiB. Anything unimplemented throws an explicit error with a remediation rather than doing something almost right.

## What graduation looks like

The bar is the one Auth and Firestore already cleared:

1. Probes run against a real Firebase project and the behavior is recorded as observations.
2. CI replays every observation on every change.
3. The service's compatibility matrix fills with rows backed by that evidence.

When a service's matrix is held to production recordings rather than documentation, it stops being experimental. The [Realtime Database](../pyric-database-compat/) and [Storage](../pyric-storage-compat/) matrices show the current row-by-row state, and the machinery is described in [How we know it matches Firebase](../how-we-know-it-matches-firebase/).

Until then, every page about these services says experimental near the top and links here. Use them, watch them, and know which kind of ground you're standing on.

## Where to go next

Build with them anyway, eyes open: [Sync realtime data](../sync-realtime-data/) and [Store files](../store-files/).
