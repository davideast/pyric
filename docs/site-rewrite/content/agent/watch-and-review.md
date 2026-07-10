---
title: Watch the agent work, then check it
navLabel: Review agent activity
outcome: See every operation your agent performs, live, with the verdict that decided it.
status: draft
---

# Watch the agent work, then check it

An agent you cannot see is an agent you cannot trust. Pyric makes the agent's work visible two ways: live, in Studio, while it happens, and after the fact, in the event stream, where every operation carries its own receipt.

## Watch it live in the Prototype tab

Start the sandbox with Studio on:

```bash
npx pyric dev --ui
```

Studio opens at `/__pyric/ui/`, and its Prototype tab is an agent playground running against the shared sandbox. The same sandbox your app tab uses, the same one your MCP client drives.

Ask for a feature and watch the documents appear in the Firestore tab as the agent writes them, because there is one backend and everyone is looking at it. When the agent claims it seeded ten users, the Auth tab either shows ten users or it does not.

## Review it through the event stream

Every operation the backend performs is a typed event, and agent operations land in the same stream as your app's. Each event carries:

- the operation and who performed it
- its provenance
- the rules verdict that allowed or denied it, and for a denial, the rule that said no and the data it saw

Reviewing an agent session is reading the stream, not reconstructing it. That turns "the agent says it worked" into something you can check line by line. The Traffic tab shows the stream live, and [see what's happening](../observe/see-whats-happening.md) covers reading it yourself, including from code.

## What the agent can and cannot touch

The trust posture is short:

- The sandbox is local state, in your dev server and your browser tab. Every tool call against it stays on your machine, and there is no cloud project behind it to damage.
- The agent reaches production only through the deploy tools, and those work only with credentials you deliberately provide, a login or a service account, as a separate step.
- Until you take that step, the blast radius of any agent session is a sandbox you can reset in one command.

When you do take it, [ship to production](../ship/ship-to-production.md) covers what deploying involves and how to verify a ruleset before it goes live.

## Where to go next

If the agent is not connected yet, start at [set up your agent](./set-up-your-agent.md). To go deeper on the stream itself, read [see what's happening](../observe/see-whats-happening.md).
