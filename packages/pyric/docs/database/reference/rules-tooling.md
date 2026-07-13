# RTDB rules tooling

The RTDB constraints DSL (`defineRtdbRules` and the combinators) is public,
re-exported directly from `pyric/rules`. The engine underneath it (the rule
mapper, expression parser, validator, linter, simulation handler, write
handler, and the rules-focused tool factory) is engine-internal, on the
`pyric/rules/internal/rtdb` subpath. That subpath isn't covered by the
public `pyric/rules` contract and may change without notice.

```ts
import { defineRtdbRules } from 'pyric/rules';
import {
  RtdbMapper,
  createRtdbRulesTools,
  SimulateHandler,
} from 'pyric/rules/internal/rtdb';
```

## Constraints authoring

### `defineRtdbRules(definition): RtdbRulesDocument`

Create an in-memory RTDB rules document from path constraints.

```ts
import { defineRtdbRules, deny, pathOwnerOnly } from 'pyric/rules';

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

The value `defineRtdbRules` returns. On the public surface it is an inert
authored artifact: the type exposes no methods. You hand it to `rtdbRules()`,
which is the one analysis surface.

```ts
import { rtdbRules } from 'pyric/rules';

const ruleset = rtdbRules(rules);

const issues = ruleset.lint();   // RuleIssue[]
const summary = ruleset.simulate([
  {
    description: 'owner reads their profile',
    expectation: 'ALLOW',
    operation: 'read',
    path: '/profiles/alice',
    auth: 'alice',
  },
]);
const json = ruleset.toJSON();   // { rules: {...} }
```

`lint()` folds the document's parser and linter findings into one
`RuleIssue[]` list; a compile failure arrives as a `COMPILE_ERROR` issue
rather than a throw. `simulate(cases)` takes `RtdbCase[]` and returns
`{ passed, failed, unsupported, cases }`. `toJSON()` compiles to Firebase
RTDB rules JSON.

The method-bearing document interface (`toJSON` / `toIR` / `check` /
`simulate` on the document itself) is internal. Engine consumers reach it via
`pyric/rules/internal/rtdb`, which exports it under the same
`RtdbRulesDocument` name; it is not covered by the public contract.

`RtdbRulesSimulationInput` is the input shape of the internal document
`simulate` method (the public `rtdbRules().simulate` takes `RtdbCase[]`
instead). It accepts the existing simulation fields plus these authoring
conveniences:

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

### Generating `database.rules.json`

`rtdbRules(rules).toJSON()` compiles a constraints document to the exact
`{ rules: {...} }` shape Firebase expects in `database.rules.json`. Everything
that writes the file — the CLI, the MCP tool, and this helper — runs the same
compilation and never recompiles the rules a second time.

For scripts running in Node, `pyric/rules/internal/node` exports a helper that
writes the file directly:

```ts
import { writeRtdbRulesFile } from 'pyric/rules/internal/node';
import { rules } from './database.rules.js';

const path = await writeRtdbRulesFile(rules, 'database.rules.json');
```

#### `writeRtdbRulesFile(doc, path): Promise<string>`

Compiles `doc` and writes the rules JSON as pretty-printed output to `path`,
creating parent directories as needed, and returns the resolved absolute path
written. It is Node-only (imports `node:fs`), so it lives on the internal
`pyric/rules/internal/node` entry rather than alongside the compilation
itself: `rtdbRules(rules).toJSON()`, from the public `pyric/rules`, never
pulls in Node builtins.

#### CLI

```sh
pyric database:rules:generate [--config <path>] [--out <path>]
```

Loads a constraints module (default `database.rules.ts`, or the `--config`
path), looks for a named `rules` export or a default export produced by
`defineRtdbRules(...)`, compiles it to rules JSON, and writes it to `--out`
(default: the `database.rules` path from `firebase.json`, or
`database.rules.json`). Run this before `pyric deploy database` so the static
file can be inspected, diffed, and committed ahead of a live deploy.

#### MCP

The `rtdb_generate_rules` tool takes the same `configPath` (and an optional
`cwd`), loads the module the same way, and returns the compiled
`{ rulesJson }` without deploying it — useful for an agent that wants to show
a user the rules before calling `rtdb_deploy_rules`.

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
await Bun.write('database.rules.json', JSON.stringify(rtdbRules(rules).toJSON(), null, 2));
```

```sh
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
  readonly data: RtdbDataTransport;
  resolveAdminToken(): Promise<string>;
  resolveUserToken(auth: UserAuth): Promise<string>;
}
```

`resolveAdminToken` is used for rule fetch/deploy and admin REST paths.
`resolveUserToken` is used for rules-enforcing REST operations. `data` is the
transport-neutral port used by reads and writes; optional `UserAuth` is passed
through so its adapter can select admin or rules-enforcing user behavior.

## Constraint helpers

The RTDB rule constraint helpers are re-exported directly from `pyric/rules`,
the public front door. The previous dedicated subpaths (`pyric/rules/rtdb`,
`pyric/rules/rtdb/constraints`, `pyric/rules/rtdb-constraints`) no longer
exist; there is one place to import the DSL from now.

The complete builder catalog, with the exact expression each helper
produces, lives in [constraints.md](./constraints.md). At a glance the
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
[constraints.md](./constraints.md).
