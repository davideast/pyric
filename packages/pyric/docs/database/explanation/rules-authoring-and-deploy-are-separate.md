# Why RTDB rules authoring and deploy are separate

Pyric keeps Realtime Database rules authoring in `pyric/rules` (the constraints
DSL, public). Shipping those rules to a real Firebase project is a separate
concern: use [`firebase-tools`](https://firebase.google.com/docs/cli) or the
Firebase Console.

The authoring package is a pure rules surface. It can build a rules document,
compile it to Firebase RTDB rules JSON, check parser and linter findings, and
run local simulations. It does not need Firebase credentials, a project id, or
network access.

That split keeps the in-memory workflow usable in tests, code generation, agent
planning, and browser-like hosts. A caller can inspect `rtdbRules(rules).toJSON()`
without holding credentials, write `database.rules.json` (or run
`pyric database:rules:generate`), then ship later:

```bash
firebase deploy --only database
```

Agent tools keep the same boundary. Local simulation and generate tools return
JSON-shaped artifacts; production release is outside pyric's CLI surface.
