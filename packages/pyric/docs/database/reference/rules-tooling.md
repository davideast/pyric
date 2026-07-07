# RTDB rules tooling

The `pyric/rules/rtdb` subpath is the canonical Realtime Database rules tooling
entrypoint.

```ts
import {
  RtdbMapper,
  createRtdbRulesTools,
  SimulateHandler,
} from 'pyric/rules/rtdb';
```

It re-exports the RTDB rule mapper, expression parser, validator, linter,
simulation handler, write handler, rule constraints, and the rules-focused tool
factory.

## Rule JSON and IR

### `RtdbMapper.mapToIR(rulesJson, shallowData, databaseUrl): RtdbIR`

Convert Firebase RTDB rules JSON into Pyric's rule IR.

```ts
const ir = RtdbMapper.mapToIR(
  {
    rules: {
      profiles: {
        '$uid': {
          '.read': 'auth.uid === $uid',
        },
      },
    },
  },
  null,
  'https://demo-default-rtdb.firebaseio.com',
);
```

### `RtdbMapper.mapToRulesJSON(ir): { rules: Record<string, unknown> }`

Convert Pyric's RTDB rule IR back to Firebase RTDB rules JSON.

### `RtdbIR`

```ts
type RtdbIR = {
  service: 'realtime-database';
  databaseUrl: string;
  rules: RtdbNode;
};
```

## Expressions

### `parseExpression(raw): ParsedExpression`

Parse one RTDB rule expression.

### `buildRuleExpression(raw, context, pathVariables?): RtdbRuleExpression`

Parse, validate, and lint one expression for a rule context.

```ts
const expr = buildRuleExpression('auth.uid === $uid', 'read', ['$uid']);
```

`context` is one of `'read'`, `'write'`, or `'validate'`.

### `validateExpression(raw, context, pathVariables?): RuleError[]`

Return validation errors for one expression.

### `lintExpression(raw, context): RuleLint[]`

Return linter warnings for one expression.

## Local simulation

### `class SimulateHandler`

Evaluate an RTDB rule IR against one simulation input.

```ts
const result = new SimulateHandler().execute(ir, {
  operation: 'read',
  path: '/profiles/alice',
  auth: { uid: 'alice', token: {} },
  mockData: {},
});
```

`SimulationInput`:

```ts
type SimulationInput = {
  operation: 'read' | 'write' | 'validate';
  path: string;
  auth: { uid: string; token: Record<string, unknown> } | null;
  mockData: Record<string, unknown>;
  newData?: unknown;
};
```

## Rules write handler

### `class WriteRulesHandler`

Write a complete `RtdbIR` to the RTDB rules endpoint through an `RtdbHost`.

```ts
const result = await new WriteRulesHandler().execute(host, ir);
```

The handler returns `WriteRulesResult` rather than throwing for Firebase rule
write failures.

## Host-backed tool factories

### `createRtdbRulesTools({ host }): ToolHandler[]`

Rules-focused RTDB tools.

| Tool | Purpose |
|---|---|
| `rtdb_build_expression` | Parse, validate, and lint one RTDB rule expression. |
| `rtdb_get_rules` | Fetch and map deployed RTDB rules into IR. |
| `rtdb_simulate_access` | Evaluate rules locally against mock data. |
| `rtdb_deploy_rules` | Deploy a complete RTDB rule IR. |

### `createRtdbDataTools({ host }): ToolHandler[]`

Data-focused RTDB tools.

| Tool | Purpose |
|---|---|
| `rtdb_crawl_structure` | Inspect RTDB path structure. |
| `rtdb_get` | Read data at a path. |
| `rtdb_set` | Replace data at a path. |
| `rtdb_update` | Merge data or run a multi-location update. |
| `rtdb_push` | Create a child with an auto-generated key. |
| `rtdb_delete` | Delete data at a path. |
| `rtdb_validated_write` | Check schema and simulate rules before writing. |

### `createRtdbAdminTools({ host }): ToolHandler[]`

Backwards-compatible union of `createRtdbRulesTools({ host })` and
`createRtdbDataTools({ host })`.

## `RtdbHost`

```ts
interface RtdbHost {
  readonly projectId: string;
  readonly databaseUrl: string;
  resolveAdminToken(): Promise<string>;
  resolveUserToken(auth: UserAuth): Promise<string>;
  getClientForUser(auth: UserAuth): Promise<Database>;
}
```

`resolveAdminToken` is used for rule fetch/deploy and admin REST paths.
`resolveUserToken` and `getClientForUser` are used for rules-enforcing
user-mode data operations.

## Constraint helpers

`pyric/rules/rtdb` also re-exports the RTDB rule constraint helpers from
`pyric/rules/rtdb-constraints`, including:

- boolean composition: `expr`, `all`, `any`, `not`, `deny`, `always`
- auth and ownership predicates: `authenticated`, `ownPath`, `ownField`
- schema predicates: `hasChildren`, `hasChild`, `fieldIsString`,
  `fieldIsNumber`, `fieldIsBoolean`, `fieldEnum`
- policy helpers: `pathOwnerOnly`, `fieldOwnerOnly`, `ownerOrNew`,
  `hasRole`, `isMember`, `required`, `transition`
