---
title: "A local backend, not Firestore offline persistence"
navLabel: "Local backend vs. offline"
group: "pyric / sandbox"
section: "Explanation"
order: 142
---
# A local backend, not Firestore offline persistence

A natural worry when you see `pyric dev` keep data across refreshes and sync across tabs is: *"are you reimplementing Firestore's offline + multi-tab persistence?"* That feature is famously one of the hardest parts of the Firestore SDK, and reimplementing it would be a massive undertaking.

The answer is **no — by construction.** pyric's sandbox is a **single local backend**, not a cache in front of a remote server. That one structural difference removes essentially all of the complexity that makes Firestore's offline mode hard. This page explains why, so the distinction is clear before anyone reaches for the wrong mental model.

## What Firestore's offline + multi-tab actually is

Firestore's offline persistence is a **cache-and-sync layer in front of an authoritative remote server**:

- **Offline writes** are applied *optimistically* to a local IndexedDB cache and added to a **mutation queue**. They are sent to the server later; if the server **rejects** them (security rules, a conflict), they must be **rolled back** and every affected listener re-notified.
- **Reading offline** serves results from the cache. When the client reconnects, the server's watch stream must be **reconciled** with the still-pending local mutations (`local view = remote document cache + pending mutations`).
- **Queries offline** require tracking target state, resume tokens, existence/bloom filters, and **limbo resolution** — "this document matches the query locally, but I can't currently confirm it still exists on the server."
- **Multi-tab** is solved with a **shared IndexedDB cache plus leader election**: every tab runs the full client, but one is elected **primary** and owns the network stream; the others share the cache and coordinate via IndexedDB and Web Locks, with the primary handing off when its tab closes.

Every one of those mechanisms exists to solve the same underlying problem: **keeping a local cache and a remote authoritative server convergent, across multiple clients.** That is a distributed-systems problem, and it is why the feature is large.

## Why pyric does not have that problem

In pyric there is **no remote server**, and there is **exactly one authoritative instance** — the sandbox. (The multi-tab realization is one sandbox hosted in a SharedWorker in the browser, or — for an agent — in the dev-server process; tabs and agents are thin clients. Conceptually it is a single backend, and *where* that backend runs, browser or Node, does not change the argument below — "local" means "no remote to reconcile with," not "in the browser.") Because of that:

| Firestore offline must do… | pyric (single local backend) |
|---|---|
| mutation queue + optimistic apply + **rollback** | **nothing** — a write hits the one backend; rules evaluate immediately; it succeeds or fails *now*, never "accepted then rejected later" |
| **reconcile** local cache ↔ remote server | **nothing** — there is only one state |
| query coherence, **limbo** resolution, resume tokens, watch stream | **nothing** — queries run directly against the one in-memory state |
| **leader election** / primary handoff | **nothing** — one instance; no "who owns the network," because there is no network |
| concurrent-client **conflict resolution** | **nothing** — all tabs send operations to one backend, whose single event loop **serializes** them |

The complexity in Firestore is the **price of distribution**. pyric is not distributed: it is one in-process object that several thin clients talk to. That is a *centralized* problem, which is categorically simpler. pyric's "offline" is trivial because the sandbox is **always local** — there is no online↔offline transition to reconcile in the first place.

## What pyric does take on instead (and why it is small)

The single-backend model is not free, but its costs are mechanical, not distributed-systems-shaped:

- A **transport layer** — marshalling operations and streaming snapshot updates between a tab and the backend.
- **Serialization** of values across that boundary (reusing the persistence serializer) and faithful propagation of typed errors (`permission-denied`, `auth/…`).
- **Lifecycle** — the in-browser backend restores its state from IndexedDB when it starts.
- A small **durability window** — a write in the brief interval before the next debounced persist flush can be lost if the process dies right then, the same trade-off any debounced save makes.

None of these are Firestore's offline engine. There is no queue, no rollback, no reconciliation, no leader election, no limbo.

## The one line that would change the answer

There is exactly one way pyric would inherit Firestore's full offline complexity: if it became a **local-first layer that runs your app against the local backend and syncs to real Firestore in the background.** That reintroduces **two sources of truth that must converge** — and with them the mutation queue, rollback, conflict resolution, and the rest.

pyric deliberately does **not** do this. Its model is **build against the local backend, then swap to real Firestore at deploy time** — the import map flips `firebase/*` from the sandbox to the real SDK, and from then on the real backend is authoritative. There is never a moment where a local store and a remote store both hold writes that must be merged. That swap-at-deploy boundary is the guardrail that keeps the sandbox simple.

There is a second, subtler way to inherit the same complexity: give a thin client its own **offline-writing cache**. A cache that accepts writes while disconnected is *also* a second source of truth, and it drags in the same queue / rollback / reconcile machinery. So pyric's clients are always **pure-thin** — they hold no authoritative state. A client that loses its connection (a co-resident tab can't lose it; a dev-server socket can) simply cannot operate until it reconnects, with **nothing to reconcile** — a trivial reconnect, not a distributed problem. That keeps the single-backend guarantee intact whether the one backend runs in a SharedWorker or a dev-server process.

## The takeaway

- Firestore offline = a **cache synchronizing with a remote server**, continuously. Hard, because it is distributed.
- pyric = a **single local backend**, accessed by thin clients, swapped for real Firestore at deploy. Simple, because it is centralized.

Multi-tab consistency and refresh-persistence in pyric are the *easy* versions of those features — one backend, one cache, one writer — not the Firestore offline engine wearing a different coat. If you ever want the local-first-syncs-to-prod product, that is a separate, deliberate decision with its own cost; it is not something the sandbox drifts into.
