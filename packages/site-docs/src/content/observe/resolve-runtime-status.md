---
title: "Resolve runtime errors and stale workers"
navLabel: "Runtime status"
group: "Observe & shape"
section: ""
order: 15
description: "Use the Pyric runtime chip to inspect sandbox errors, activate a new worker, and open Studio."
---

# Resolve runtime errors and stale workers

During Vite development, Pyric adds a compact runtime chip to the bottom-right corner of the application. It is collapsed by default and reports `ready` while the sandbox is healthy. Open it when the chip reports errors or an update.

## Inspect a sandbox error

1. Select the chip to open the runtime panel.
2. Read the error in the scrollable error area.
3. Use the copy button beside that error to paste the complete message and context into an issue, terminal, or agent conversation.
4. Select **Studio** to open Pyric Studio in a new tab when you need to inspect the sandbox's data, rules, or traffic.

The chip reports errors from the Pyric sandbox. Errors produced only by application UI code remain in the browser's normal developer tools.

## Activate a new worker

Vite can serve a newer Pyric worker while an older SharedWorker is still running for the origin. When that happens, the collapsed chip shows `update` and the panel labels the worker as **New worker available**.

1. Save any unsaved, UI-only form input. Updating reloads every connected tab for this origin.
2. Open the chip.
3. Select **Update worker**.

The old worker stops taking new work, finishes operations it already accepted, flushes captured state, and then reloads its connected tabs onto the new worker generation. The update control always occupies the same place in the panel, but remains disabled when the running worker is current.

If replacement fails, the panel records the failure as a copyable error and leaves the update available so you can try again. Resolve the reported cause first. If a stale worker remains after a failed recovery, close every tab for that development origin and reopen the application.

## Configure the chip

The default configuration is the recommended one:

```ts
pyric()
```

To keep the panel open from the first load while actively debugging runtime failures:

```ts
pyric({ runtimeChip: { initiallyOpen: true } })
```

To hide the runtime surface entirely:

```ts
pyric({ runtimeChip: false })
```

The chip is a development surface. A normal production Vite build does not inject it. Disabling Pyric Studio with `ui: false` keeps the Studio action visible but unavailable, so the panel does not shift as its status changes.
