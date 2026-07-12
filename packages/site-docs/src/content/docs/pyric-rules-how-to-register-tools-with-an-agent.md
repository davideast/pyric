---
title: "How to register rules tools with an agent"
navLabel: "Register rules tools"
group: "pyric / rules"
section: "How-to"
order: 13006
---
# How to register rules tools with an agent

Expose the rules surface as tool handlers for an `@inbrowser/agent` registry, so an LLM-driven agent can lint, simulate, and test rules through structured tool calls.

The tool factories (`createFirestoreRulesTools`, `createFirestoreSimulatorTools`) are engine-internal, imported from `pyric/rules/internal/node`. They're not part of the public `pyric/rules` contract and may change without notice, but they're the supported way to wire rules tooling into an agent registry.

## Without project credentials: lint / resolve / simulate

`createFirestoreRulesTools()` returns three handlers:

```ts
import { createFirestoreRulesTools } from 'pyric/rules/internal/node';
import { createToolRegistry } from '@inbrowser/agent';

const registry = createToolRegistry();
for (const handler of createFirestoreRulesTools()) {
  registry.register(handler);
}

registry.list().map((h) => h.name);
// → ['firestore_lint_rules', 'firestore_resolve_modules', 'firestore_simulate_rules']
```

These are pure-local: no network, no credentials, safe to expose anywhere.

## With a `ProjectScope`: also expose live testing

Pass a `ProjectScope` and a fourth handler appears: `firestore_test_rules`, which calls Google's Rules Test API.

```ts
import { fromServiceAccount } from 'pyric-tools/deploy';

const scope = await fromServiceAccount('./service-account.json');

for (const handler of createFirestoreRulesTools({ scope })) {
  registry.register(handler);
}

registry.list().map((h) => h.name);
// → ['firestore_lint_rules', 'firestore_resolve_modules',
//    'firestore_simulate_rules', 'firestore_test_rules']
```

Only attach `scope` when the host actually has credentials. The factory drops `firestore_test_rules` cleanly when `scope` is omitted, so an unsuspecting agent can't try to call it.

## Dispatch a tool call

`@inbrowser/agent` does the dispatch:

```ts
import { createDispatch } from '@inbrowser/agent';

const dispatch = createDispatch(registry);

const result = await dispatch.execute(
  {
    id: '1',
    name: 'firestore_lint_rules',
    args: { source: yourRulesSource },
  },
  { signal: new AbortController().signal },
);

console.log(result.summary); // 'Linted rules source'
console.log(result.data);    // the full internal LintResult
```

The `ToolResult` shape is uniform across handlers: `{ ok, summary, data }`. Look at `summary` for a one-line agent-facing message; `data` is the structured payload.

## Stateful simulator tools (Slice 8 scaffold)

`createFirestoreSimulatorTools({ resolveSandbox })` is the entry point for the seven-tool simulator family that operates against a session-scoped `LocalEnvironment` from `pyric/sandbox`. It currently returns an empty array. The full implementation lands as consumers ask for it. The factory shape and dependency contract are stable; only the handlers are pending.

```ts
import { createFirestoreSimulatorTools } from 'pyric/rules/internal/node';

// Today: returns [] — placeholder
const tools = createFirestoreSimulatorTools({
  resolveSandbox: () => sessionContext.localEnv,
});
```

The `resolveSandbox` resolver fires per dispatch, so hosts that reset or swap the sandbox transparently get a fresh environment without re-registering tools.

## Where to look next

- For the tool names, parameters, and the result shape, see [Internal engine in the API reference](../pyric-rules-reference-api/#internal-engine-pyricrulesinternal).
- For `ToolHandler`, `createToolRegistry`, and `createDispatch`, see the `@inbrowser/agent` package.
