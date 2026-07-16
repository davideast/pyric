---
title: "Watch every read, write, and denial live"
navLabel: "Traffic & rule verdicts"
group: "Observe & shape"
section: ""
order: 4001
description: "See every operation your backend performs, with its rules verdict, without writing a log line."
---

# Watch every read, write, and denial live

Every operation your app performs produces a typed event: the request with its rules verdict, the committed write, the snapshot a listener delivered. You don't instrument anything. The stream is already there, and you can watch it two ways: in Studio, or with one subscription in code.

## Open the Traffic view

```bash
pyric dev --ui
```

Studio mounts at `/__pyric/ui/` on your dev server. The Traffic tab shows the stream live: each request, who made it, the allow or deny verdict, and how long the rules evaluation took. Sign in, write a document, break a rule on purpose. Each one appears as it happens, in the same backend your open tabs are using.

## Subscribe to the event stream

One subscription covers everything observable:

```ts
import { initializeSandbox } from 'pyric/sandbox';

const sandbox = initializeSandbox();

const unsubscribe = sandbox.onEvent((event) => {
  console.log(event.kind);
});
```

The kinds at a glance:

| `event.kind` | What it tells you |
|---|---|
| `request` | An operation the rules engine evaluated, with `result: 'allow' \| 'deny'`, the identity, and `evalMs` |
| `write` | A committed write, with the document's prior and next state |
| `snapshot_delivery` | A listener delivered results to your callback, with added, modified, and removed counts |
| `snapshot_suppressed` | A listener woke up but had nothing new to deliver |
| `listener_attach` / `listener_detach` / `listener_errored` | Listener lifecycle, including denials that silently terminate a stream |
| `session_boundary` | A `reset()` or `dispose()` happened, so you can segment a persisted stream |

Denials are a one-line filter over the same stream:

```ts
sandbox.onEvent((event) => {
  if (event.kind === 'request' && event.result === 'deny') {
    console.log(`${event.method} ${event.path} denied for ${event.auth?.uid ?? 'anonymous'}`);
  }
});
```

The subscription survives `sandbox.reset()`. A `session_boundary` event fires before each rollover, so a subscriber attached once keeps working across every test.

## When a denial needs explaining

A `deny` event is not a bare `permission-denied` string. It carries the method and path, the identity the rules saw, the reasons, and the request data that was evaluated. That is enough to answer "which rule said no, and what did it see" without adding a single log line. [Read a denial and understand it](../read-a-denial/) walks through one.

## Build a traffic monitor

Studio's Traffic view is a consumer of `onEvent`, and you can build your own in about seventy lines. Subscribe, format each kind, and you get a terminal log like this:

```
[#3] request    allow set    notes/n1  by alice  1.4ms
[#4] write      set    notes/n1  by alice  (was: null)
[#5] snapshot_delivery query notes (+1 ~0 -0) size=1 by alice  triggered by set notes/n1
[#7] request    deny   get    notes/n1  by bob    0.2ms  Rule #0 (read,write) deny
```

Two things to know before you ship one:

- Listener re-evaluations dominate the raw stream. Default your view to user-origin requests, deliveries, lifecycle, and denials, and put `origin: 'listener'` traffic behind a toggle.
- Your callback runs synchronously with the operation that produced it, so push heavy work off the hot path with `queueMicrotask` or a worker.

## Inspect the backend through an agent

An agent doesn't scroll a panel. It calls `sandbox_inspect` and gets the current rules, a lint summary, a document census, and the recent requests and denials in one response. That one call replaced a debugging session that once took fifty-one tool calls. See [Set up your agent](../set-up-your-agent/).

## Where to go next

Chase a specific denial in [Read a denial and understand it](../read-a-denial/), or start treating the state you're watching as source in [Shape your data](../shape-your-data/).
