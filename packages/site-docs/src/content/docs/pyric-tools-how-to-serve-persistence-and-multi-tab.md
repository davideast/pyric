---
title: "Persistence and multi-tab with pyric dev"
navLabel: "Persistence & multi-tab"
group: "pyric-tools"
section: "How-to"
order: 37
---
# Persistence and multi-tab with `pyric dev`

When you run `pyric dev`, your app's `firebase/*` imports are served from an
**in-browser pyric sandbox** instead of real Firebase. This guide covers how
that sandbox keeps (or doesn't keep) data, the flags that control it, and what
to do if the SharedWorker that backs it acts up.

## How the sandbox is hosted (and why it matters)

`pyric dev` runs the sandbox one of two ways, chosen automatically:

- **SharedWorker (the default — Chrome/Edge, Firefox, Safari 16.4+).** One
  sandbox lives in a SharedWorker shared by **every tab** of the origin. All
  tabs read and write the same backend, so writes sync **live across tabs**,
  and the worker keeps its data in **IndexedDB** — so your data **survives a
  refresh, a tab close, and a `pyric dev` restart by default**.
- **In-page fallback (older browsers without SharedWorker).** Each tab runs its
  own sandbox in the page. Data is **ephemeral** (lost on refresh) unless you
  pass `--persist`; cross-tab realtime uses BroadcastChannel.

You can see which path you're on in the console:
`[pyric dev] firebase/* on this page is served by the pyric sandbox in a SharedWorker …`.

## Keep data across reloads — the default

On the SharedWorker path you don't need any flag. The worker persists to the
browser's IndexedDB automatically: refresh the page, close the tab and reopen,
or restart `pyric dev`, and your Firestore docs, auth users, and signed-in
session come back.

> This is a deliberate change from older `pyric serve`, which was ephemeral by
> default. The SharedWorker makes **durability the default** so a refresh never
> loses your work.

## What survives what — the coverage matrix

Durability is per service in this release. "Worker death" means the last tab
of the origin closed (or the browser tore the SharedWorker down between a
refresh of your only tab); with two tabs open — Studio plus your app — the
worker stays alive and everything in this table trivially survives a refresh.

| | refresh<br>(worker alive) | worker death /<br>browser restart | `--persist`<br>(state.json) | `pyric snapshot` |
| --- | --- | --- | --- | --- |
| Firestore documents | ✓ | ✓ IndexedDB | ✓ | ✓ |
| Auth users + session | ✓ | ✓ IndexedDB | ✓ | ✓ |
| Storage objects | ✓ | ✓ IndexedDB (its own store) | ✗ | ✗ |
| RTDB data | ✓ | ✓ IndexedDB | ✓ | ✓ (rides the state blob) |
| Traffic / event history | ✓ | ✓ re-hydrated from the session capture (served mode; the last ~400ms can lag) | ✗ | ✗ |
| Sandbox branches | ✓ | ✓ IndexedDB | ✗ deliberately local | ✗ |

Notes, honestly stated:

- **Storage persists in this browser but does not ride `--persist`** — objects
  live in their own IndexedDB store, so they survive restarts on your machine
  but are not part of the committable state file or `pyric snapshot`.
- **Branches never reach `state.json` on purpose**: they are local working
  state, like a stash, not part of the fixture you'd commit.
- IndexedDB is **per browser profile, per origin (host:port)** — a different
  port, profile, or incognito window is a fresh sandbox.

## Persist to a committable file — `--persist`
```bash
pyric dev --persist
```
`--persist` adds a durable, **git-trackable** state file at
`.pyric/state/state.json`. The sandbox restores from it on start and mirrors
writes back to it. Reach for it when you want sandbox state that:

- survives clearing your browser's storage,
- can be committed and shared with teammates,
- can be promoted to real Firestore later (`pyric snapshot`).

On the SharedWorker path your data already persists in the browser without this
flag — `--persist` is specifically about the **on-disk, shareable** copy.

## Run ephemerally — no data kept

There is **no `--ephemeral` flag**; durable-by-default is intentional. To run
without keeping anything between sessions:

- **Use a private / incognito window.** Its IndexedDB is discarded when the
  window closes, so every session starts clean. (Simplest option.)
- Or **clear site data** between runs (see below).

On a browser without SharedWorker, the in-page fallback is already ephemeral
unless you pass `--persist`.

## Start fresh / clear persistence

Two stores can hold data — clear the one(s) you need:

| Store | Where it lives | Clear it with |
|---|---|---|
| **IndexedDB** (the SharedWorker's default durable store) | the browser, per origin | DevTools → **Application → Storage → Clear site data**, then reload — or just use a private window |
| **`.pyric/state/state.json`** (the `--persist` file) | your project directory | `pyric dev --persist --fresh` (discards it and re-seeds) |

`--fresh` **requires `--persist`** — it discards `.pyric/state/state.json`, and
without `--persist` there is no such file, so `pyric dev` now errors instead of
silently doing nothing.

`--fresh` clears only the on-disk file — it does **not** touch the browser's
IndexedDB. ⚠ **This makes `--fresh` a half-reset**: prime-once only fills an
EMPTY IndexedDB, so a browser tab that already has sandbox data KEEPS it, and
that tab's next flush writes it straight back into the file `--fresh` just
cleared — the "fresh" file quietly refills with the old data. For a fully clean
slate on the SharedWorker path, you must **also clear site data** (or use a
private window) whenever you pass `--fresh`. (A real reset handshake that makes
`--fresh` clear the browser store too is future work.)

## Seed data on boot — `--seed`
```bash
pyric dev --seed seed.json
```
Loads a fixture document set admin-style before your app runs. Accepts either a
`"collection/doc" → fields` map or a `pyric snapshot` state file.

**A seed applies only into an empty home.** If the sandbox already holds
restored data — a `--persist` state file, or data IndexedDB restored from an
earlier session (which happens even without `--persist`, since IndexedDB is the
SharedWorker's default durable store) — the fixture is skipped, not applied on
top of it, and a console line explains why. This is what stops `--seed` from
silently reverting your edits on every reload: without it, default (ephemeral)
mode had no state file to gate on, so the fixture re-applied on every boot no
matter what you'd changed in the browser. Use `--persist --fresh` (plus
clearing browser storage — see above) to discard existing state and re-seed
from scratch.

## SharedWorker troubleshooting

A SharedWorker is shared by all tabs of an origin and **stays alive as long as
any tab is open**. That leads to a few dev-time gotchas:

**"I rebuilt pyric, but my change isn't taking effect."**
A SharedWorker can't hot-update — it runs whatever code started it until
**every** tab of the origin closes. After rebuilding pyric, **close all tabs**
of the origin and open one fresh. The page logs a clear warning when it detects
a stale worker (`the SharedWorker is running OLDER code … CLOSE ALL TABS`). You
can also force-kill it at `chrome://inspect/#workers` → find
`pyric-shared-worker` → **Terminate**.
*This only affects people developing pyric itself — editing **your app's** code
reloads normally, because the worker holds pyric's code, not yours.*

**"My tabs aren't syncing with each other."**
Live multi-tab sync needs all tabs to share one worker. They will, as long as
they're the **same origin** (same `http://localhost:PORT`) and loaded from the
**same pyric build**. If you opened tabs across a rebuild, close them all and
reopen so they share the current worker.

**"A new tab hangs on a blank page while others are open."**
Fixed in current builds — the worker owns a single hot-reload connection, so
tabs don't accumulate persistent connections. On an older build, closing some
tabs frees the browser's per-origin connection pool.

**Sign-in.** Email/password, anonymous, and provider popup/redirect
(`signInWithPopup`/`signInWithRedirect`) all work over the worker — the picker
runs in the page and the identity is handed to the worker, and the session is
shared across tabs. `signInWithCredential` and `or()`/`and()` composite queries
aren't supported over the worker yet (they raise a clear error); both work on
the in-page fallback.

## The flags this guide uses

| Flag | Effect |
|---|---|
| `--persist` | durable, git-trackable state at `.pyric/state/state.json` (worker mirrors to it; the in-page fallback uses it as its durable store) |
| `--fresh` | requires `--persist` (errors otherwise); discards the `.pyric/state` file and re-seeds — does **not** clear browser IndexedDB, so a browser with existing data writes it right back (also clear site data / use a private window for a full reset) |
| `--seed <file>` | load fixture docs on boot (a `"collection/doc" → fields` map, or a `pyric snapshot` file) — applies only into an empty sandbox; skipped (with a console note) if restored/lived data is already present |
| `--no-capture` | disable the default-on session capture (`.pyric/last-session.json`, replayed by `pyric verify`) |

The complete `pyric dev` flag set (`--port`, `--host`, `--bridge`,
`--no-watch`, `--no-open`, `--no-cache`, `--allowed-host`, `--json`, …) lives in
the [CLI reference](../pyric-tools-reference-cli/).

## See also

- [Why an in-browser backend is *not* Firestore offline persistence](../pyric-sandbox-explanation-local-backend-vs-firestore-offline/)
  — why multi-tab + persistence here avoid the distributed-systems complexity.
- [Getting started](../pyric-tools-tutorials-getting-started/) — scaffold → serve → agent.
