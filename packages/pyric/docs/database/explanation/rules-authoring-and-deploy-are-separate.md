# Why RTDB rules authoring and deploy are separate

Pyric keeps Realtime Database rules authoring in `pyric/rules/rtdb` and project
deployment in `pyric-tools/deploy`.

The authoring package is a pure rules surface. It can build a rules document,
compile it to Firebase RTDB rules JSON, check parser and linter findings, and
run local simulations. It does not need Firebase credentials, a project id, or
network access.

The deploy package is a control-plane surface. It resolves a `ProjectScope`,
discovers or accepts a database URL, obtains an access token, and writes rules
through the Realtime Database rules endpoint.

That split keeps the in-memory workflow usable in tests, code generation, agent
planning, and browser-like hosts. A caller can inspect `rules.toJSON()` without
holding credentials, then choose the deploy path later:

```ts
import { rtdb } from 'pyric-tools/deploy';

await rtdb.rules.deploy(scope, {
  rules,
  databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
});
```

Agent tools keep the same boundary. MCP and registry tools accept JSON-shaped
arguments, so `rtdb_deploy_rules` continues to take `rulesJson`. In-process
TypeScript callers may pass the document object directly because the deploy
adapter can call `toJSON()` before writing.
