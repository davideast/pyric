---
title: "AST"
group: "pyric / rules"
section: "Reference"
order: 101
---
# AST

The AST is the typed tree produced by `parseToAST` / `parseToASTOrError`. Every shape is exported from `pyric/rules`.

## Root: `FirestoreRules`
```ts
interface FirestoreRules {
  version: string;          // 'rules_version' value, e.g. '2' or '2+modules'
  imports: ImportDecl[];    // only non-empty for '2+modules'
  service: ServiceBlock;
}
```
## `ImportDecl`
```ts
interface ImportDecl {
  functions: string[];   // imported function names
  module: string;        // module name (stdlib name or relative path)
}
```
## `ServiceBlock`
```ts
interface ServiceBlock {
  name: string;          // always 'cloud.firestore' for Firestore rules
  match: MatchBlock;     // the root match (/databases/{database}/documents)
}
```
## `MatchBlock`
```ts
interface MatchBlock {
  path: PathPattern;
  functions: FunctionDef[];
  allows: AllowRule[];
  children: MatchBlock[];
}
```
## `PathPattern`
```ts
interface PathPattern {
  raw: string;              // original path text, e.g. '/users/{uid}'
  segments: PathSegment[];
}

type PathSegment =
  | { type: 'literal'; value: string }
  | { type: 'wildcard'; name: string }     // {name}
  | { type: 'recursive'; name: string };   // {name=**}
```
## `AllowRule`
```ts
interface AllowRule {
  operations: Operation[];
  condition: Expression;
}

type Operation = 'read' | 'write' | 'get' | 'list' | 'create' | 'update' | 'delete';
```
## `FunctionDef`
```ts
interface FunctionDef {
  name: string;
  parameters: string[];
  exported: boolean;       // true when declared `export function ...` (used by '2+modules')
  lets: LetBinding[];
  body: Expression;
}

interface LetBinding {
  name: string;
  value: Expression;
}
```
## `Expression`

Discriminated union — the discriminator is `type`.
```ts
type Expression =
  | { type: 'literal'; value: string | number | boolean | null; raw: string }
  | { type: 'identifier'; name: string }
  | { type: 'memberAccess'; object: Expression; property: string }
  | { type: 'methodCall'; object: Expression; method: string; args: Expression[] }
  | { type: 'bracketAccess'; object: Expression; index: Expression }
  | { type: 'sliceAccess'; object: Expression; start: Expression; end: Expression }
  | { type: 'binaryOp'; op: string; left: Expression; right: Expression }
  | { type: 'unaryOp'; op: string; operand: Expression }
  | { type: 'ternary'; condition: Expression; consequent: Expression; alternate: Expression }
  | { type: 'inExpr'; element: Expression; collection: Expression }
  | { type: 'isExpr'; value: Expression; typeName: string }
  | { type: 'listLiteral'; elements: Expression[] }
  | { type: 'mapLiteral'; entries: Array<{ key: Expression; value: Expression }> }
  | { type: 'pathLiteral'; raw: string; segments: Array<string | Expression> }
  | { type: 'functionCall'; name: string; args: Expression[] };
```
### Notes per variant

- `literal.raw` preserves the original source text of the literal — useful for diagnostics and for `RULES_WEAKENED`'s deterministic serialiser.
- `binaryOp.op` is one of: `&&`, `||`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `+`, `-`, `*`, `/`, `%`.
- `unaryOp.op` is `!` or `-`.
- `methodCall.method` and `memberAccess.property` are strings — there are no nested expressions in the property position.
- `inExpr` represents `x in y`. `isExpr` represents `x is timestamp` (and other type tests).
- `pathLiteral.segments` is `Array<string | Expression>` — a string segment is a literal path component, an `Expression` segment is an interpolation like `$(uid)`.
- `sliceAccess` represents `bytes[0:10]` style slicing. Only valid on `Bytes` at runtime.

## Right-associative chains

The grammar builds `a && b && c` as right-associative: `BinaryOp('&&', a, BinaryOp('&&', b, c))`. The linter's chain-depth algorithm walks `right` recursively for this reason. Don't assume left-associativity when traversing.
