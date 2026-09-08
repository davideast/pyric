---
title: "Work with an agent against the sandbox"
navLabel: "Use the MCP tools"
group: "Work with an agent"
section: ""
order: 20
description: "Give a local coding agent real backend tasks and watch it inspect, change, and verify the same sandbox as your app."
---

# Work with an agent against the sandbox

Pyric connects your coding agent on your machine to the same sandbox your app and Studio already use. The agent does not get a second copy of the backend: its MCP calls cross the bridge into that sandbox.

Start the bridge, then keep the served app open in a browser tab:
```bash
pyric sandbox --bridge
```
`pyric sandbox` records the running server in `.pyric/serve.json`. The `pyric mcp` process used by Claude Code, Cursor, Codex, or another MCP client reads that pointer and proxies tool calls to `/__pyric/mcp`. The browser tab is the peer that owns the sandbox state, so forwarded data tools need that tab to stay open.

If you have not configured the client yet, follow [Connect an agent to the sandbox](./set-up-your-agent.md). For the complete schema of every tool and resource, see the [MCP tools & resources reference](../reference/mcp.md).

## Diagnose a denied write

Give the agent the task you actually need solved, including the user and operation:

> Alice is signed in but cannot update `profiles/alice`. Find the denial, explain which rule rejects it, and propose the smallest rules change. Do not edit the rules yet.

The agent reads `pyric://sandbox/status` and `pyric://sandbox/events` to inspect the loaded rules, document counts, and recent denied operations. It then calls `diagnose_rule_denial` to trace the exact AST expression that evaluated to `false` (or produced an error), and reads `pyric://firestore/docs/profiles/alice` to compare the stored document with the attempted write.

The important part of the prompt is not a tool name. It is the real identity, path, operation, and desired outcome. The agent chooses the action tools and resource templates from that task.

## Seed a scenario and prove the access rules

Ask for both the useful path and the attack you want rejected:

> Create `projects/p1` owned by Alice. Prove Alice can rename it and Bob cannot. Show me both verdicts and leave the sandbox with the seeded project.

The agent can switch its ambient identity lens with `switch_auth_identity` (or pass an inline `auth` override), create the document with `mutate_sandbox_data`, inspect it via `pyric://firestore/docs/projects/p1`, and verify both access paths with `verify_security_rules` (`action: 'simulate_suite'`).

This is also useful for query rules:

> Seed three posts: two published and one private draft owned by Alice. Find a query that lets a signed-out user list only published posts, run it, and confirm the draft is absent.

That task exercises `mutate_sandbox_data` (`action: 'batch'`) and `query_sandbox_data` against the same data visible in the browser.

## Dry-run a rules migration before editing your file

Ask the agent to prove a candidate ruleset against recorded sandbox traffic before it changes your file:

> Update these Firestore rules so users can edit only their own profile and cannot change `ownerId`. Fork an experiment branch, test the candidate rules against recorded sandbox traffic to ensure zero regressions, simulate an owner update and an ownership-transfer attempt, then edit the file only if all checks pass.

The agent can use:

- `dry_run_experiment` (`action: 'diff'`) to fork an isolated branch, evaluate candidate rules against recorded history, and surface any `ALLOW -> DENY` regressions;
- `verify_security_rules` (`action: 'lint'`) to catch invalid rules syntax, production limits, and common JavaScript-shaped mistakes;
- `verify_security_rules` (`action: 'simulate_suite'`) to evaluate explicit allow and deny test cases with tenant and custom claims;
- `pyric://stdlib/rules/auth` (or `pyric://stdlib/rules/index`) to look up tested standard-library helpers.

Those tools return evidence the agent can show: lint findings, branch regressions, and each simulated verdict. They do not deploy anything.

## Inspect Realtime Database data

The browser bridge also exposes the current Realtime Database sandbox:

> Inspect the Realtime Database tree. Check whether a signed-in user can write another user's `/profiles/{uid}/displayName`, and explain the rule that decides it.

The agent reads `pyric://database/tree/root` (or `pyric://database/tree/profiles`) to inspect the current JSON tree and calls `diagnose_rule_denial` (`service: 'database'`) to evaluate the write request. These tools inspect and simulate local state; they do not connect to a production database.

## Know which side runs each tool and resource

Every MCP interaction uses either a **Verb-First Action Tool** (for state changes, diagnostics, and simulations) or a **`pyric://` Resource URI Template** (for read-only state inspection):

| Capability | Surface | Examples |
|---|---|---|
| State mutation & queries | Action Tools (`tools/call`) | `mutate_sandbox_data`, `query_sandbox_data`, `manage_storage_files` |
| Identity & user management | Action Tools (`tools/call`) | `switch_auth_identity`, `manage_auth_users`, `inspect_auth_flow` |
| Rules verification & branching | Action Tools (`tools/call`) | `diagnose_rule_denial`, `verify_security_rules`, `dry_run_experiment` |
| Environment, Functions & AI | Action Tools (`tools/call`) | `control_sandbox_environment`, `invoke_cloud_function`, `configure_ai_mock` |
| Read-only state inspection | Resource Templates (`resources/read`) | `pyric://sandbox/status`, `pyric://sandbox/events`, `pyric://firestore/docs/{path}`, `pyric://database/tree/{path}`, `pyric://auth/users`, `pyric://storage/objects/{bucket}`, `pyric://stdlib/rules/{module}` |

If a tool reports that no browser peer is connected, open the served app and retry. Do not start a second dev server: that creates a second sandbox, and the agent may modify the one you are not looking at.

## Review what the agent changed

Keep the Traffic view open while the agent works. Every sandbox request appears there with its identity and verdict, so you can compare the agent's report with the operations the browser actually saw. [Review agent activity](./watch-and-review.md) shows how to filter that stream and replay a request.
