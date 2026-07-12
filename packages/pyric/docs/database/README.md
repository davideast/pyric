# Realtime Database

Pyric's Realtime Database surface has two parts:

- `pyric/database` mirrors the Firebase Database modular SDK and exposes
  host-backed data tools.
- `pyric/rules` exposes the RTDB rules constraints DSL (`defineRtdbRules`
  and the combinators) plus `rtdbRules(...)`, the deep handle for linting
  and simulating a ruleset. The engine underneath (rule JSON mapping,
  expression parsing and linting, local simulation, and rules-focused agent
  tools) is internal, on `pyric/rules/internal/rtdb`.

## Where to go next

| If you want to | Read |
|---|---|
| Learn the constraints authoring workflow | [Author your first RTDB rules with constraints](./tutorials/01-author-rtdb-rules-with-constraints.md) |
| Look up the RTDB rules tooling API | [RTDB rules tooling reference](./reference/rules-tooling.md) |
| Understand package boundaries for authoring and deploy | [Why RTDB rules authoring and deploy are separate](./explanation/rules-authoring-and-deploy-are-separate.md) |
| Check Firebase Database compatibility status | [Compatibility matrix](./COMPAT.md) |
