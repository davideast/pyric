---
title: "Realtime Database"
navLabel: "Overview"
group: "pyric / database"
section: ""
order: 10
---
# Realtime Database

Pyric's Realtime Database surface has three deliberately separate parts:

- `pyric/database` is the sandbox-only mirror of the Firebase Database modular
  SDK. Production builds keep resolving the unchanged `firebase/database`
  package; the mirror never dispatches to it at runtime.
- `pyric/sandbox/database` exposes owner controls for installing rules,
  seeding data, and reading detached snapshots.
- `pyric/rules` exposes the RTDB rules constraints DSL (`defineRtdbRules`
  and the combinators) plus `rtdbRules(...)`, the deep handle for linting
  and simulating a ruleset. The engine underneath (rule JSON mapping,
  expression parsing and linting, local simulation, and rules-focused agent
  tools) is internal, on `pyric/rules/internal/rtdb`.

Simulation and structure crawling for agents belong to the sandbox and CLI
tooling, not to the Firebase-shaped `pyric/database` mirror.

## Where to go next

| If you want to | Read |
|---|---|
| Learn the constraints authoring workflow | [Author your first RTDB rules with constraints](./tutorials/01-author-rtdb-rules-with-constraints.md) |
| Look up the RTDB rules tooling API | [RTDB rules tooling reference](./reference/rules-tooling.md) |
| Understand package boundaries for authoring vs shipping | [Why RTDB rules authoring and deploy are separate](./explanation/rules-authoring-and-deploy-are-separate.md) |
| Check Firebase Database compatibility status | [Compatibility matrix](https://pyric.dev/docs/pyric-database-compat/) |
