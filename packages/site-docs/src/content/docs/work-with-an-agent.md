---
title: "Work with an agent in the browser sandbox"
navLabel: "Use the MCP tools"
group: "Work with an agent"
section: ""
order: 6002
description: "Give a local coding agent real backend tasks and watch it inspect, change, and verify the same browser sandbox as your app."
---

# Work with an agent in the browser sandbox

Pyric connects your coding agent on your machine to the sandbox running in your browser. The agent does not get a second copy of the backend: its MCP calls cross the bridge into the tab your app and Studio already use.

Start the bridge, then keep the served app open in a browser tab:

```bash
pyric dev --bridge
```

`pyric dev` records the running server in `.pyric/serve.json`. The `pyric mcp` process used by Claude Code, Cursor, Codex, or another MCP client reads that pointer and proxies tool calls to `/__pyric/mcp`. The browser tab is the peer that owns the sandbox state, so forwarded data tools need that tab to stay open. Rules-only tools such as linting and module resolution run in the MCP process and do not need the tab.

If you have not configured the client yet, follow [Connect an agent to the sandbox](../set-up-your-agent/).

## Diagnose a denied write

Give the agent the task you actually need solved, including the user and operation:

> Alice is signed in but cannot update `profiles/alice`. Find the denial, explain which rule rejects it, and propose the smallest rules change. Do not edit the rules yet.

The agent starts with `sandbox_inspect`, which returns the loaded rules, lint summary, document counts, and recent requests. It can then use `firestore_simulator_events` to inspect the request history and `firestore_get_document` to compare the stored document with the attempted write.

The important part of the prompt is not a tool name. It is the real identity, path, operation, and desired outcome. The agent chooses the inspection tools from that task.

## Seed a scenario and prove the access rules

Ask for both the useful path and the attack you want rejected:

> Create `projects/p1` owned by Alice. Prove Alice can rename it and Bob cannot. Show me both verdicts and leave the sandbox with the seeded project.

The agent can create the document with `firestore_create_document`, read it with `firestore_get_document`, and run the two hypothetical requests with `firestore_simulate_rules`. For a longer sequence it can open a stateful session with `firestore_simulator_create`, execute operations with `firestore_simulator_execute`, and inspect the result with `firestore_simulator_read`.

This is also useful for query rules:

> Seed three posts: two published and one private draft owned by Alice. Find a query that lets a signed-out user list only published posts, run it, and confirm the draft is absent.

That task exercises `firestore_create_document` and `firestore_query_where` against the same data visible in the browser.

## Correct rules and check the result

Ask the agent to prove the fix before it changes your file:

> Update these Firestore rules so users can edit only their own profile and cannot change `ownerId`. Lint the candidate, simulate an owner update and an ownership-transfer attempt, then edit the file only if both cases pass.

The agent can use:

- `firestore_lint_rules` to catch invalid rules syntax, production limits, and common JavaScript-shaped mistakes;
- `firestore_simulate_rules` to evaluate explicit allow and deny cases;
- `firestore_rules_stdlib_list` and `firestore_rules_stdlib_get` to find tested helpers;
- `firestore_resolve_modules` to compile `2+modules` imports into deployable Firestore Rules.

Those tools return evidence the agent can show: lint findings, each simulated verdict, and the resolved source. They do not deploy anything.

## Inspect Realtime Database data

The browser bridge also exposes the current RTDB sandbox:

> Inspect the Realtime Database tree. Check whether a signed-in user can write another user's `/profiles/{uid}/displayName`, and explain the rule that decides it.

The agent uses `rtdb_crawl_structure` to discover the current paths and `rtdb_simulate_access` to test the request. These tools inspect and simulate local state; they do not connect to a production database.

## Know which side runs each tool

There are two execution paths:

| Tool kind | Examples | Where it runs |
|---|---|---|
| Browser sandbox | `sandbox_inspect`, Firestore document/query tools, simulator sessions, RTDB inspection | Forwarded through `/__pyric/mcp` to the open tab |
| Rules source | `firestore_lint_rules`, `firestore_simulate_rules`, standard-library lookup, module resolution | In the local `pyric mcp` process |

If a Firestore document tool reports that no browser peer is connected, open the served app and retry. Do not start a second dev server: that creates a second sandbox, and the agent may modify the one you are not looking at.

## Review what the agent changed

Keep the Traffic view open while the agent works. Every sandbox request appears there with its identity and verdict, so you can compare the agent's report with the operations the browser actually saw. [Review agent activity](../watch-and-review/) shows how to filter that stream and replay a request.
