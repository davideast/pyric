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

## Switch identities and impersonate users

The runtime chip also hosts the local identity and impersonation dialog. When active, the collapsed bar displays your current impersonation badge (such as `as: <uid>` or `bypass rules`). Open the chip and select the **Identity** row to search users, test multi-tenant boundaries, or toggle an administrative rules bypass. See [Switch and impersonate identities in development](./switch-and-impersonate-identities.md) for the complete guide.

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
