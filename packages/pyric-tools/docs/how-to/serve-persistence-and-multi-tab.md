# Persistence and multi-tab with `pyric serve`

When you run `pyric serve`, your app's `firebase/*` imports are served from an
**in-browser pyric sandbox** instead of real Firebase. This guide covers how
that sandbox keeps (or doesn't keep) data, the flags that control it, and what
to do if the SharedWorker that backs it acts up.

## How the sandbox is hosted (and why it matters)

`pyric serve` runs the sandbox one of two ways, chosen automatically:

- **SharedWorker (the default — Chrome/Edge, Firefox, Safari 16.4+).** One
  sandbox lives in a SharedWorker shared by **every tab** of the origin. All
  tabs read and write the same backend, so writes sync **live across tabs**,
  and the worker keeps its data in **IndexedDB** — so your data **survives a
  refresh, a tab close, and a `pyric serve` restart by default**.
- **In-page fallback (older browsers without SharedWorker).** Each tab runs its
  own sandbox in the page. Data is **ephemeral** (lost on refresh) unless you
  pass `--persist`; cross-tab realtime uses BroadcastChannel.

You can see which path you're on in the console:
`[pyric serve] firebase/* on this page is served by the pyric sandbox in a SharedWorker …`.

## Keep data across reloads — the default

On the SharedWorker path you don't need any flag. The worker persists to the
browser's IndexedDB automatically: refresh the page, close the tab and reopen,
or restart `pyric serve`, and your Firestore docs, auth users, and signed-in
session come back.

> This is a deliberate change from older `pyric serve`, which was ephemeral by
> default. The SharedWorker makes **durability the default** so a refresh never
> loses your work.

## Persist to a committable file — `--persist`

```bash
pyric serve --persist
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
| **`.pyric/state/state.json`** (the `--persist` file) | your project directory | `pyric serve --persist --fresh` (discards it and re-seeds) |

`--fresh` clears only the on-disk file — it does **not** touch the browser's
IndexedDB. For a fully clean slate on the SharedWorker path, **clear site data**
(or use a private window) and add `--fresh` if you use `--persist`.

## Seed data on boot — `--seed`

```bash
pyric serve --seed seed.json
```

Loads a fixture document set admin-style before your app runs. Accepts either a
`"collection/doc" → fields` map or a `pyric snapshot` state file. With
`--persist`, the seed applies only on the **first** (state-less) run — after
that the lived state wins; use `--fresh` to re-seed.

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
| `--fresh` | discard the `.pyric/state` file and re-seed — does **not** clear browser IndexedDB |
| `--seed <file>` | load fixture docs on boot (a `"collection/doc" → fields` map, or a `pyric snapshot` file) |
| `--no-capture` | disable the default-on session capture (`.pyric/last-session.json`, replayed by `pyric verify`) |

The complete `pyric serve` flag set (`--port`, `--host`, `--bridge`,
`--no-watch`, `--no-open`, `--no-cache`, `--allowed-host`, `--json`, …) lives in
the [CLI reference](../reference/cli.md#pyric-serve).

## See also

- [Why an in-browser backend is *not* Firestore offline persistence](../../../pyric/docs/sandbox/explanation/local-backend-vs-firestore-offline.md)
  — why multi-tab + persistence here avoid the distributed-systems complexity.
- [Getting started](../tutorials/getting-started.md) — scaffold → serve → agent.
