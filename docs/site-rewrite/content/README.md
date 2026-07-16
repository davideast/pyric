# Authored workflow content

These pages form the primary learning path. They teach Pyric as one local-to-production system, with Firebase products introduced only when application code reaches them.

## Workflow map

| Phase | Pages | Role |
|---|---|---|
| Overview | `overview.md` | State the local-development contract and production handoff. |
| Run locally | `get-started/*`, `agent/set-up-your-agent.md`, `ship/test-in-node.md` | Start the sandbox and connect browser, Node, or agent work to it. |
| Develop with Firebase APIs | `build/*`, plus the existing RTDB Functions guide | Use ordinary Firebase APIs against the sandbox, then reach local behavior that differs by product. |
| Inspect and correct | `observe/*`, most of `secure/*`, remaining `agent/*` | Read operations and denials, correct state and rules, and inspect agent work. |
| Verify the boundary | `secure/write-a-rules-test-suite.md`, `secure/audit-your-rules.md`, plus the existing CLI verification guide | Check captured application behavior and rules before production. |
| Ship unchanged | `ship/ship-to-production.md`, `ship/set-up-the-project.md` | Build with real Firebase and deploy through Firebase tooling. |
| Conformance | `trust/*`, generated scores, and product matrices | Explain and expose the evidence that Pyric itself matches Firebase. |

Detailed package documentation remains the source for API reference and product-specific depth. The site porter keeps those routes searchable while collapsing them beneath Reference.
