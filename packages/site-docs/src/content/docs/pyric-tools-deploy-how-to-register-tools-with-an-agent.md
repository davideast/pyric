---
title: "How to register deploy tools with an agent"
navLabel: "Register deploy tools"
group: "pyric-tools / deploy"
section: "How-to"
order: 58
---
# How to register deploy tools with an agent

This guide shows you how to expose `pyric-tools/deploy`'s primitives as `@inbrowser/agent` tool handlers, so an LLM-driven agent can deploy rules, indexes, and functions through structured tool calls.

## Wire all three factories
```ts
import {
  createFirestoreDeployTools,
  createHostingDeployTools,
  createFunctionsDeployTools,
  fromServiceAccount,
} from 'pyric-tools/deploy';
import { createToolRegistry, createDispatch } from '@inbrowser/agent';

const scope = await fromServiceAccount('./service-account.json');
const deps = { scope };

const registry = createToolRegistry();
for (const h of createFirestoreDeployTools(deps)) registry.register(h);
for (const h of createHostingDeployTools(deps)) registry.register(h);
for (const h of createFunctionsDeployTools(deps)) registry.register(h);

const dispatch = createDispatch(registry);
```
That gives the agent ten tools total: seven for Firestore, two for Hosting, one for Functions.

## Dispatch a call
```ts
const result = await dispatch.execute(
  {
    id: '1',
    name: 'firestore_deploy_rules',
    args: { source: yourRulesSource },
  },
  { signal: new AbortController().signal },
);

console.log(result.ok);        // boolean
console.log(result.summary);   // one-line agent-facing message
console.log(result.data);      // structured outcome (narrow with DeployToolData)
```
## Narrow `data` per tool

Use the `DeployToolData` map to recover the concrete outcome type:
```ts
import type { DeployToolData } from 'pyric-tools/deploy';

if (result.ok) {
  const data = result.data as DeployToolData['firestore_deploy_indexes'];
  if (data.ok) {
    console.log(`Started ${data.operationsStarted.length} index builds`);
  }
}
```
The double-`ok` (one from `ToolResult`, one from `Outcome`) reflects the two layers: did the handler run cleanly, and did the underlying operation succeed.

## Scope only the tools the agent should have

Each factory is independent. Give the agent only the surfaces it needs. A read-only agent might get only `firestore_get_rules` and `firestore_get_index_status`:
```ts
const all = createFirestoreDeployTools(deps);
const readonly = all.filter((h) =>
  h.name === 'firestore_get_rules' || h.name === 'firestore_get_index_status',
);
for (const h of readonly) registry.register(h);
```
Or use `.map` before `.register` to decorate the descriptions:
```ts
const decorated = createFirestoreDeployTools(deps).map((h) => ({
  ...h,
  description: `${h.description} (deploy-bot only)`,
}));
for (const h of decorated) registry.register(h);
```
## Cancellation

Every handler checks `ctx.signal.aborted` before starting work. This prevents a deploy from *starting* when the agent has already cancelled. It doesn't abort a deploy already in flight. The underlying primitives don't yet plumb `AbortSignal` through their fetch calls.

## Where to look next

- For each handler's name, args, and `data` shape, see [Tool factories](../pyric-tools-deploy-reference-tool-factories/).
- For the registry and dispatch primitives, see the `@inbrowser/agent` package.
