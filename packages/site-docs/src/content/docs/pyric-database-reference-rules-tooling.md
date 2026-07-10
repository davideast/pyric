---
title: "RTDB rules tooling"
group: "pyric / database"
section: "Reference"
order: 161
---
# RTDB rules tooling

The `pyric/rules/rtdb` subpath is the canonical Realtime Database rules tooling
entrypoint.
```ts
import {
  defineRtdbRules,
  RtdbMapper,
  createRtdbRulesTools,
  SimulateHandler,
} from 'pyric/rules/rtdb';
```
It re-exports the RTDB rule mapper, expression parser, validator, linter,
simulation handler, write handler, rule constraints, and the rules-focused tool
factory.

## Constraints authoring

### `defineRtdbRules(definition): RtdbRulesDocument`

Create an in-memory RTDB rules document from path constraints.
```ts
import { defineRtdbRules, deny, pathOwnerOnly } from 'pyric/rules/rtdb';

const rules = defineRtdbRules({
  paths: {
    '/': { read: deny(), write: deny() },
    '/profiles/$uid': {
      read: pathOwnerOnly('$uid'),
      write: pathOwnerOnly('$uid'),
    },
  },
});
```
`definition`:
```ts
type RtdbRulesDefinition = {
  databaseUrl?: string;
  paths: Record<string, PathDef> | ((ctx: RulesetContext) => void);
};
```
`databaseUrl` is optional. Methods that need an IR use an explicit method
argument first, then `definition.databaseUrl`, then the local fallback
`https://local-rtdb.firebaseio.com`.

### `RtdbRulesDocument`
```ts
interface RtdbRulesDocument {
  toJSON(): { rules: Record<string, unknown> };
  toIR(databaseUrl?: string): RtdbIR;
  check(databaseUrl?: string): RtdbRulesCheckResult;
  simulate(input: RtdbRulesSimulationInput, opts?: { databaseUrl?: string }): SimulateResult;
}
```
`toJSON()` returns Firebase RTDB rules JSON. `toIR()` returns Pyric's RTDB rule
IR. `check()` returns parser and linter findings without throwing for compile
failures. `simulate()` normalises friendly input and delegates to
`SimulateHandler`.
```ts
const check = rules.check();

const result = rules.simulate({
  operation: 'read',
  path: '/profiles/alice',
  auth: 'alice',
  data: {},
});
```
`RtdbRulesSimulationInput` accepts the existing simulation fields plus these
authoring conveniences:
```ts
type RtdbRulesSimulationInput = {
  operation: 'read' | 'write' | 'validate';
  path: string;
  auth?: string | { uid: string; token?: Record<string, unknown> } | null;
  data?: Record<string, unknown>;
  mockData?: Record<string, unknown>;
  newData?: unknown;
};
```
`auth: 'alice'` becomes `{ uid: 'alice', token: {} }`. `data` is an alias for
`mockData`; if both are supplied, `mockData` is used.

`RtdbRulesCheckResult`:
```ts
type RtdbRulesCheckResult = {
  ok: boolean;
  errors: RtdbRulesFinding[];
  warnings: RtdbRulesFinding[];
  ir?: RtdbIR;
};
```
Compile failures return an error finding with code `COMPILE_ERROR`.

### Verifying captured sessions

Constraints documents can be passed directly to `pyric-tools/verify` as
candidate RTDB rules:
```ts
import { verifyFixture } from 'pyric-tools/verify';
import { rules } from './database.rules.js';

const fixture = JSON.parse(await Bun.file('.pyric/last-session.json').text());

const result = await verifyFixture(fixture, {
  engines: ['sandbox'],
  rules: { rtdb: rules },
});
```
For CLI verification, generate JSON first and pass it as the RTDB rules file:
```ts
await Bun.write('database.rules.json', JSON.stringify(rules.toJSON(), null, 2));
``````sh
pyric verify --service rtdb --rules rtdb=database.rules.json
```
Verification lives in `pyric-tools/verify` because constraints are an authoring
surface and captured-session replay is local tooling around an app session.
The Firebase Rules Test API engine is Firestore-only; RTDB constraints verify by
compiling to RTDB rules JSON and replaying captured RTDB commits locally.

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

`pyric/rules/rtdb` also re-exports the RTDB rule constraint helpers. The
canonical constraints-only package path is `pyric/rules/rtdb/constraints`.
`pyric/rules/rtdb-constraints` remains available as a compatibility alias.

The complete builder catalog, with the exact expression each helper
produces, lives in [constraints.md](../pyric-database-reference-constraints/). At a glance the
groups are:

- boolean composition: `expr`, `all`, `any`, `not`, `deny`, `always`, `allow`
- auth, ownership, and state atoms: `authenticated`, `ownPath`, `ownField`,
  `isNew`, `immutable`, `immutableSelf`, `rootExists`, `rootEquals`
- schema predicates: `hasChildren`, `hasChild`, `fieldIsString`,
  `fieldIsNumber`, `fieldIsBoolean`, `fieldEnum`
- data navigation and comparison: `dataVal`, `newDataVal`, `dataExists`,
  `newDataExists`, `newDataIs`, `dataParentVal`, `newDataParentVal`,
  `newDataParentExists`, `eq`, `neq`, `gt`, `lte`, and the `AUTH_UID`
  segment constant
- policy helpers: `pathOwnerOnly`, `fieldOwnerOnly`, `ownerOrNew`,
  `hasRole`, `isMember`, `required`, `transition`
- game primitives: `turnGuard`, `flip`, `winCheckHelper`
- assembly: `defineRtdbRules`, `ruleset`, `schemaRules`

### `PathDef`
```ts
interface PathDef {
  read?: Expr;
  write?: Expr;
  validate?: Expr;
  schema?: z.ZodObject<any>;
  fieldConstraints?: Record<string, Expr[]>;
  indexOn?: string[];
  children?: Record<string, PathDef>;
}
```
`schema` supports Zod object fields composed from strings, numbers, booleans,
enums, literals, unions of supported types, nested objects, and optional fields.
Unsupported Zod types throw during compilation.

The game primitives (`turnGuard`, `flip`, `winCheckHelper`) are
first-class exports with spec-pinned output; the deployed tic-tac-toe
ruleset is built on them. Their semantics are in
[constraints.md](../pyric-database-reference-constraints/).
