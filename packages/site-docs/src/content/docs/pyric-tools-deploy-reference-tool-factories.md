---
title: "Tool factories"
group: "pyric-tools / deploy"
section: "Reference"
order: 69
---
# Tool factories

Four factories wrap the namespaces as `@inbrowser/agent` `ToolHandler[]`. Each takes a `ProjectScopedDeps` shape and returns the handlers for its domain.
```ts
interface ProjectScopedDeps {
  scope: ProjectScope;
}
```
Every handler closes over `scope` at factory time and reads `signal` from `ctx` per call. Handlers check `ctx.signal.aborted` before starting work.

## `createFirestoreDeployTools(deps): ToolHandler[]`

Seven handlers covering rules, indexes, and database provisioning.

| Tool name | Backing call | `data` shape |
|---|---|---|
| `firestore_get_rules` | `firestore.rules.fetch` | `{ source: string \| null }` |
| `firestore_deploy_rules` | `firestore.rules.deploy` | `undefined` |
| `firestore_ensure_rules` | `firestore.rules.ensure` | `EnsureRuleOutcome` |
| `firestore_provision_database` | `firestore.databases.provision` | `ProvisionDatabaseOutcome` |
| `firestore_deploy_indexes` | `firestore.indexes.deployAll` | `DeployIndexesOutcome` |
| `firestore_create_index` | `firestore.indexes.create` | `IndexOperation` |
| `firestore_get_index_status` | `firestore.indexes.getStatus` | `GetIndexStatusOutcome` |

## `createHostingDeployTools(deps): ToolHandler[]`

Two handlers.

| Tool name | Backing call | `data` shape |
|---|---|---|
| `hosting_deploy` | `hosting.deployFiles` | `DeployHostingResult` |
| `hosting_ensure_site` | `hosting.sites.ensure` | `EnsureSiteResult` |

## `createRtdbDeployTools(deps): ToolHandler[]`

Two handlers covering Realtime Database rules. `databaseUrl` is optional; when
omitted the tool tries to discover the single default RTDB instance for the
project.

| Tool name | Backing call | `data` shape |
|---|---|---|
| `rtdb_get_rules` | `rtdb.rules.fetch` | `{ ir: RtdbIR }` |
| `rtdb_deploy_rules` | `rtdb.rules.deploy` | `undefined` |

## `createFunctionsDeployTools(deps): ToolHandler[]`

One handler.

| Tool name | Backing call | `data` shape |
|---|---|---|
| `functions_deploy` | `functions.deployLocal` or `functions.deploy` | `DeployFunctionsResult` |

## `DeployToolData`

Type-level map from tool name to the `data` shape its `execute` returns. Use it to narrow without spelunking through the namespace primitives:
```ts
import {
  createFirestoreDeployTools,
  type DeployToolData,
} from 'pyric-tools/deploy';

const handler = createFirestoreDeployTools({ scope })
  .find((h) => h.name === 'firestore_deploy_indexes')!;

const out = await handler.execute(args, ctx);
const data = out.data as DeployToolData['firestore_deploy_indexes'];
// data is now typed as DeployIndexesOutcome
```
A future revision may parameterise each handler as `ToolHandler<Args, Data>` directly. For now the map keeps each factory's return type usable as a single `ToolHandler[]` (registry-friendly) while still surfacing the data contract per tool.

## `ToolResult` shape

Every handler's `execute` returns:
```ts
{
  ok: boolean;
  summary: string;       // one-line agent-facing message
  data?: unknown;        // narrow with DeployToolData[name]
}
```
The `ok` flag reflects the underlying outcome's success: `Outcome.ok` for orchestrators, "no exception thrown" for primitives. The `summary` is suitable for agent-visible logs; `data` is the structured payload.

## Cancellation

Per pre-mortem M8, every handler checks `ctx.signal.aborted` before starting work. This prevents a deploy from *starting* when the agent has already cancelled. It does not abort a deploy already in flight. The underlying namespace primitives don't currently plumb `AbortSignal` through their fetch calls. Wave B (the `firebase-admin` → REST rewrite) is the natural place to thread signals end-to-end.

## Registering with a registry
```ts
import { createToolRegistry } from '@inbrowser/agent';
import {
  createFirestoreDeployTools,
  createRtdbDeployTools,
  createHostingDeployTools,
  createFunctionsDeployTools,
} from 'pyric-tools/deploy';

const registry = createToolRegistry();
const deps = { scope };
for (const h of createFirestoreDeployTools(deps)) registry.register(h);
for (const h of createRtdbDeployTools(deps)) registry.register(h);
for (const h of createHostingDeployTools(deps)) registry.register(h);
for (const h of createFunctionsDeployTools(deps)) registry.register(h);
```
See [Register deploy tools with an agent](../pyric-tools-deploy-how-to-register-tools-with-an-agent/) for the full agent wiring.
