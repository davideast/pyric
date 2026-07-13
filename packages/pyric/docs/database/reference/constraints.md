# API reference: RTDB rules constraints

Typed builders that produce Realtime Database security-rule expressions, plus the assembly layer that places them in a path tree and compiles the tree to Firebase rules JSON. Everything on this page is importable directly from `pyric/rules`, the public front door. The dedicated constraints-only subpaths that used to exist (`pyric/rules/rtdb/constraints`, `pyric/rules/rtdb-constraints`) no longer do; there is one place to import the DSL from now. The engine that compiles and simulates against it (the parser, linter, simulator, and tool factories) lives on the internal `pyric/rules/internal/rtdb` subpath instead.

Every builder returns an `Expr`, which is a plain string of RTDB rules language. The produced expressions below are pinned by spec tests, so they are safe to rely on byte for byte.

Realtime Database support is experimental. The behaviors here are verified in-process; see the [compatibility matrix](../COMPAT.md) for what is pinned against production.

## Combinators

| Export | Signature | Produces |
|---|---|---|
| `expr(raw)` | `(raw: string) => Expr` | the raw string, unchanged |
| `all(...exprs)` | `(...exprs: Expr[]) => Expr` | `(a) && (b) && ...` (each operand parenthesized) |
| `any(...exprs)` | `(...exprs: Expr[]) => Expr` | `(a) \|\| (b) \|\| ...` |
| `not(e)` | `(e: Expr) => Expr` | `!(e)` |
| `deny()` | `() => Expr` | `false` |
| `always()` | `() => Expr` | `true` |
| `allow()` | alias of `always` | `true` |

## Atoms

| Export | Signature | Produces |
|---|---|---|
| `authenticated()` | `() => Expr` | `auth !== null` |
| `ownPath(pathVar)` | `(pathVar: string) => Expr` | `auth.uid === $pathVar` |
| `ownField(field)` | `(field: string) => Expr` | `auth.uid === data.child("field").val()` |
| `isNew()` | `() => Expr` | `!data.exists()` |
| `hasChildren()` | `() => Expr` | `newData.hasChildren()` |
| `hasChild(field)` | `(field: string) => Expr` | `newData.hasChild("field")` |
| `fieldIsString(field)` | `(field: string) => Expr` | `newData.child("field").isString()` |
| `fieldIsNumber(field)` | `(field: string) => Expr` | `newData.child("field").isNumber()` |
| `fieldIsBoolean(field)` | `(field: string) => Expr` | `newData.child("field").isBoolean()` |
| `fieldEnum(field, values)` | `(field: string, values: string[]) => Expr` | `newData.child("f").val() === "a" \|\| ... === "b"` |
| `immutable(field)` | `(field: string) => Expr` | `!data.exists() \|\| newData.child("f").val() === data.child("f").val()` |
| `immutableSelf()` | `() => Expr` | `!data.exists() \|\| newData.val() === data.val()` |
| `rootExists(segments)` | `(segments: Segment[]) => Expr` | `root.child("a").child($var).exists()` |
| `rootEquals(segments, value)` | `(segments: Segment[], value: string) => Expr` | `root.child(...).val() === "value"` |

`Segment = string | { $: string }`. A string segment is quoted (`child("members")`); a `{ $: name }` segment is inserted unquoted, which is how path variables (`{ $: '$roomId' }`) and runtime references (`{ $: 'auth.uid' }`) enter a path chain. `fieldEnum`'s branches are not individually parenthesized; compose it through `all()`/`any()`, which wrap it.

## Policies (composed atoms)

| Export | Signature | Produces |
|---|---|---|
| `pathOwnerOnly(pathVar)` | `(pathVar: string) => Expr` | `(auth !== null) && (auth.uid === $var)` |
| `fieldOwnerOnly(field)` | `(field: string) => Expr` | `(auth !== null) && (auth.uid === data.child("f").val())` |
| `ownerOrNew(field)` | `(field: string) => Expr` | signed in, and the record is new or owned by the caller |
| `hasRole(segments, role)` | `(segments: Segment[], role: string) => Expr` | `rootEquals(segments, role)` |
| `isMember(listName, pathVarName)` | `(listName: string, pathVarName: string) => Expr` | `root.child("list").child($var).child(auth.uid).exists()` (prepends `$` to `pathVarName` itself) |
| `required(...fields)` | `(...fields: string[]) => Expr` | AND of `newData.hasChild(...)` per field |
| `transition(field, allowed)` | `(field: string, allowed: Array<[from, to]>) => Expr` | OR of `(data.child("f").val() === "from") && (newData.child("f").val() === "to")` pairs |

## Data helpers

| Export | Signature | Produces |
|---|---|---|
| `dataVal(path?)` | `(path?: string) => Expr` | `data.val()` or `data.child("p").val()` |
| `newDataVal(path?)` | `(path?: string) => Expr` | same on `newData` |
| `dataExists(path?)` / `newDataExists(path?)` | `(path?: string) => Expr` | `.exists()` variants |
| `newDataIs(type)` | `('String' \| 'Number' \| 'Boolean') => Expr` | `newData.isString()` and friends |
| `dataParentVal(depth, field)` | `(depth: number, field: string) => Expr` | `data.parent()...child("f").val()`, `depth` parent hops |
| `newDataParentVal(depth, field)` | `(depth: number, field: string) => Expr` | same on `newData` |
| `newDataParentExists(depth, field)` | `(depth: number, field: string) => Expr` | `newData.parent()...child("f").exists()` |
| `eq(left, right)` | `(left: Expr, right: CompareValue) => Expr` | `left === right` |
| `neq(left, right)` | `(left: Expr, right: CompareValue) => Expr` | `left !== right` |
| `gt(left, n)` | `(left: Expr, n: number) => Expr` | `left > n` |
| `lte(left, n)` | `(left: Expr, n: number) => Expr` | `left <= n` |
| `AUTH_UID` | `Segment` constant `{ $: 'auth.uid' }` | an unquoted comparison value or path segment |

`eq`/`neq` format the right side by type: strings are quoted, numbers and booleans are literal, `null` is `null`, and a `{ $: ... }` segment is inserted unquoted (so `eq(newDataVal('host'), AUTH_UID)` produces `newData.child("host").val() === auth.uid`).

## Game primitives

These are first-class exports, pinned by spec tests, and the deployed tic-tac-toe ruleset is built on them.

| Export | Signature | Semantics |
|---|---|---|
| `turnGuard(turnField, players, statusField?, playingValue?)` | `(turnField: string, players: Record<string, string>, statusField?: string, playingValue?: string) => Expr` | write guard: for each mark, the stored turn equals the mark AND the stored player field equals `auth.uid`; optionally AND-ed with a status check. Reads `data` (pre-write state) throughout, never `newData`, so a writer cannot hand themselves the turn |
| `flip(marks)` | `(marks: string[]) => Expr` | validate for the turn field: creation sets the first mark, then circular rotation (X to O to X; supports 2 or more marks) |
| `winCheckHelper(mark, lines, boardPath?)` | `(mark: string, lines: number[][], boardPath = 'board') => Expr` | validate for a boolean claim field: `true` requires some line of board cells to all equal the mark, `false` requires no such line. The client claims, the rules verify |

## Schema

| Export | Signature | Semantics |
|---|---|---|
| `schemaRules(schema, fieldConstraints?)` | `(schema: z.ZodObject, fieldConstraints?: Record<string, Expr[]>) => SchemaRulesResult` | parent `.validate` requires children plus every non-optional key; each field gets a child `.validate` from its Zod type; `fieldConstraints[key]` is AND-merged with the type check |

Supported Zod types: `string`, `number`, `boolean`, `enum`, `literal` (string, number, boolean), unions of supported types, nested objects (recursive), and `.optional()` (unwrapped, excluded from required). Anything else (arrays, dates, records) throws `Unsupported Zod type`, which `check()` surfaces as a `COMPILE_ERROR` finding.

## Assembly

### `defineRtdbRules(definition)`

```ts
function defineRtdbRules(definition: {
  databaseUrl?: string;
  paths: Record<string, PathDef> | ((ctx: RulesetContext) => void);
}): RtdbRulesDocument;
```

The authoring entry, and the one to reach for first. The returned
`RtdbRulesDocument` is an inert authored artifact: on the public surface it
exposes no methods. Pass it to `rtdbRules()` for everything analytical:

| Call | Returns | Notes |
|---|---|---|
| `rtdbRules(doc).lint()` | `RuleIssue[]` | parser errors and lint warnings (for example `LOOSE_EQUALITY` for `==`), per node and rule; a compile throw surfaces as one `COMPILE_ERROR` issue |
| `rtdbRules(doc).simulate(cases)` | `{ passed, failed, unsupported, cases }` | in-process verdicts for a list of `RtdbCase`s |
| `rtdbRules(doc).explain(oneCase)` | `RtdbExplanation` | the structured account of one case |
| `rtdbRules(doc).toJSON()` | `{ rules: {...} }` | Firebase rules JSON; raw `'true'`/`'false'` become JSON booleans |

Case conveniences: `auth: 'alice'` normalizes to `{ uid: 'alice', token: {} }`.

URL precedence when compiling: `definition.databaseUrl`, then
`https://local-rtdb.firebaseio.com`. The method-bearing document interface
(with `toIR`/`check`/`simulate` on the document itself) is internal, on
`pyric/rules/internal/rtdb`.

### `ruleset(databaseUrl, input)`

```ts
function ruleset(
  databaseUrl: string,
  input: Record<string, PathDef> | ((ctx: RulesetContext) => void),
): RtdbIR;
```

The raw IR builder underneath `defineRtdbRules`. Same inputs, no document wrapper.

### `PathDef`

```ts
interface PathDef {
  read?: Expr;
  write?: Expr;
  validate?: Expr;
  schema?: z.ZodObject<z.ZodRawShape>;
  fieldConstraints?: Record<string, Expr[]>;
  indexOn?: string[];
  children?: Record<string, PathDef>;
}
```

Placement semantics worth knowing:

- Path keys are literal strings with `$wildcards` as segments (`'/games/$gameId'`); every `$segment` becomes a path variable in scope for expression validation.
- `children` keys are path suffixes (`'/comments/$commentId'`) concatenated onto the parent path.
- An explicit `validate` wins over the schema-derived parent validate; the schema's per-field validates still apply.
- `indexOn` on a path that ends in a `$wildcard` is hoisted to the parent container node (`'/posts/$postId'` places `.indexOn` on `posts`). On a non-wildcard path it is silently dropped, so put it on the wildcard path.
- Every expression is parsed, validated, and linted at build time; findings attach to the IR and surface through `rtdbRules(doc).lint()`.

## Deployment boundary

Constraint helpers compile locally and never contact production. Deploy the
result explicitly through `pyric deploy database` or
`createRtdbDeployTools({ scope })` from `pyric-tools/deploy`.

## Exported types

`Expr`, `Segment`, `PathDef`, `RulesetContext`, `SchemaRulesResult`, `RtdbRulesDocument`, `RtdbRulesDefinition`, `RtdbRulesCheckResult`, `RtdbRulesFinding`, `RtdbRulesFindingRule` (`'.read' | '.write' | '.validate' | 'ruleset'`), `RtdbRulesJson`, `RtdbRulesSimulationAuth`, `RtdbRulesSimulationInput`.

## Boundaries

- `winCheckHelper`'s full expression is verified by parse and substring checks rather than a byte-level snapshot.
- A `PathDef` whose node cannot be found during assembly is skipped without error.
- `schemaRules` with nested optional objects is untested territory.

See [rules-tooling.md](./rules-tooling.md) for the parser, linter, simulator internals, and tool factories, and the [authoring tutorial](../tutorials/01-author-rtdb-rules-with-constraints.md) for the guided path.
