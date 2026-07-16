---
title: "RTDB rules tooling"
group: "pyric / database"
section: "Reference"
order: 16004
---
# RTDB rules tooling

The RTDB constraints DSL (`defineRtdbRules` and the combinators) is public,
re-exported directly from `pyric/rules`. The engine underneath it (expression
parser, validator, linter, compile/simulate/serialize, and replay) is
engine-internal, on the `pyric/rules/internal/rtdb` subpath. That subpath isn't
covered by the public `pyric/rules` contract and may change without notice.

```ts
import { defineRtdbRules, rtdbRules } from 'pyric/rules';
import {
  compileRtdbRules,
  simulateRtdbRules,
  serializeRtdbRules,
  replay,
  parseExpression,
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
  paths: Record<string, PathDef> | ((ctx: RulesetContext) => void);
};
```

There is no `databaseUrl` on the definition. Compilation is
environment-independent; the database URL is a Firebase project concern when
you ship with `firebase-tools`, not part of the authored artifact.

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

The method-bearing document interface (`toJSON` / `compile` / `check` /
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
};
```

Compile failures return an error finding with code `COMPILE_ERROR`.

### Generating `database.rules.json`

`rtdbRules(rules).toJSON()` compiles a constraints document to the exact
`{ rules: {...} }` shape Firebase expects in `database.rules.json`. Everything
that writes the file — the CLI, the MCP library tool, and this helper — runs
the same compilation and never recompiles the rules a second time.

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
pyric database rules generate [--config <path>] [--out <path>]
```

Loads a constraints module (default `database.rules.ts`, or the `--config`
path), looks for a named `rules` export or a default export produced by
`defineRtdbRules(...)`, compiles it to rules JSON, and writes it to `--out`
(default: the `database.rules` path from `firebase.json`, or
`database.rules.json`). This is a local artifact step only — inspect, diff,
and commit the file, then ship with `firebase-tools` / Console.

#### MCP / library

The `rtdb_generate_rules` tool (library; not on the default bridge) takes the
same `configPath` (and an optional `cwd`), loads the module the same way, and
returns the compiled `{ rulesJson }` without contacting a Firebase project.

### Verifying captured sessions

Constraints documents can be passed directly to `@pyric/cli/verify` as
candidate RTDB rules:

```ts
import { verifyFixture } from '@pyric/cli/verify';
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

Verification lives in `@pyric/cli/verify` because constraints are an authoring
surface and captured-session replay is local tooling around an app session.
The Firebase Rules Test API engine is Firestore-only; RTDB constraints verify by
compiling to RTDB rules JSON and replaying captured RTDB commits locally.

## Compiled rules (internal)

### `compileRtdbRules(rulesJson): CompiledRtdbRules`

Convert Firebase RTDB rules JSON into the compiled tree the simulator uses
(`CompiledRtdbRules` is the `RtdbNode` root).

### `serializeRtdbRules(compiled): { rules: Record<string, unknown> }`

Convert a compiled tree back to Firebase RTDB rules JSON.

### `simulateRtdbRules(compiled, input): SimulateResult`

Evaluate one operation against a compiled rules tree.

```ts
const compiled = compileRtdbRules({
  rules: {
    profiles: {
      $uid: {
        '.read': 'auth.uid === $uid',
      },
    },
  },
});

const result = simulateRtdbRules(compiled, {
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

### `replay` / expression helpers

Also on `pyric/rules/internal/rtdb`:

- `replay` — replay captured RTDB commits against candidate rules
- `parseExpression` / `validateExpression` / `lintExpression` /
  `buildRuleExpression` — expression-level parse, validate, and lint

## Production deployment

The rules engine performs no production reads or writes. Generate and inspect
rules locally (`pyric database rules generate`, `rtdbRules(doc).toJSON()`), then
ship with `firebase-tools` / Console (`firebase deploy --only database`).
Production operations never live on the Firebase-shaped `pyric/database` mirror
or this internal engine seam.

## Constraint helpers

The RTDB rule constraint helpers are re-exported directly from `pyric/rules`,
the public front door. The previous dedicated subpaths (`pyric/rules/rtdb`,
`pyric/rules/rtdb/constraints`, `pyric/rules/rtdb-constraints`) no longer
exist; there is one place to import the DSL from now.

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
