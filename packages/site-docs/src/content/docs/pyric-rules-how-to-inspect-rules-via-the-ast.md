---
title: "How to inspect rules through the AST"
navLabel: "Inspect rules via the AST"
group: "pyric / rules"
section: "How-to"
order: 12003
---
# How to inspect rules through the AST

Parse rules into a typed AST and walk the tree for custom analysis: bespoke lint rules, generated documentation, or structural facts the built-in linter doesn't surface.

The parser (`parseToAST`, `parseToASTOrError`, `parseFunctions`), the AST types, and `validateFirestoreRules` are engine-internal, imported from `pyric/rules/internal`. That surface isn't covered by the public `pyric/rules` contract and may change without notice. For the AST alone, `firestoreRules(source).toJSON()` on the public front door returns the same tree without touching the parser directly; reach for the internal imports below when you need to parse arbitrary fragments or run the validator standalone.

## Parse to AST

`parseToASTOrError` returns either the AST or a structured failure. Use it when you want a diagnostic on parse failure:

```ts
import { parseToASTOrError } from 'pyric/rules/internal';

const result = parseToASTOrError(source);
if (!result.ok) {
  console.error(`Line ${result.error.line}, col ${result.error.column}: ${result.error.message}`);
  process.exit(1);
}
const ast = result.ast;
```

When `null` is sufficient signal:

```ts
import { parseToAST } from 'pyric/rules/internal';

const ast = parseToAST(source);
if (!ast) throw new Error('parse failed');
```

## Walk match blocks

`FirestoreRules.service.match` is the root match (always `/databases/{db}/documents`). Walk its `children` recursively to enumerate every nested match block:

```ts
import type { MatchBlock } from 'pyric/rules/internal';

function walk(block: MatchBlock, parentPath = ''): void {
  const path = parentPath + block.path.raw;
  for (const allow of block.allows) {
    console.log(`${path}  allow ${allow.operations.join(',')}`);
  }
  for (const child of block.children) walk(child, path);
}

walk(ast.service.match);
```

## Inspect path patterns

A `PathPattern` is `{ raw: string, segments: PathSegment[] }`. Each segment is one of three shapes:

- `{ type: 'literal', value: 'users' }`
- `{ type: 'wildcard', name: 'uid' }`: for `{uid}`
- `{ type: 'recursive', name: 'document' }`: for `{document=**}`

Branch on `seg.type` rather than parsing `raw`:

```ts
for (const seg of block.path.segments) {
  if (seg.type === 'literal') console.log('static:', seg.value);
  else if (seg.type === 'wildcard') console.log('wildcard:', seg.name);
  else console.log('recursive:', seg.name);
}
```

## Walk expressions

`Expression` is a discriminated union. The discriminator is `type`:

```ts
import type { Expression } from 'pyric/rules/internal';

function walkExpr(expr: Expression, visit: (e: Expression) => void): void {
  visit(expr);
  switch (expr.type) {
    case 'binaryOp':       walkExpr(expr.left, visit); walkExpr(expr.right, visit); break;
    case 'unaryOp':        walkExpr(expr.operand, visit); break;
    case 'methodCall':     walkExpr(expr.object, visit); expr.args.forEach((a) => walkExpr(a, visit)); break;
    case 'memberAccess':   walkExpr(expr.object, visit); break;
    case 'bracketAccess':  walkExpr(expr.object, visit); walkExpr(expr.index, visit); break;
    case 'ternary':        walkExpr(expr.condition, visit); walkExpr(expr.consequent, visit); walkExpr(expr.alternate, visit); break;
    case 'inExpr':         walkExpr(expr.element, visit); walkExpr(expr.collection, visit); break;
    case 'isExpr':         walkExpr(expr.value, visit); break;
    case 'listLiteral':    expr.elements.forEach((e) => walkExpr(e, visit)); break;
    case 'mapLiteral':     expr.entries.forEach((en) => { walkExpr(en.key, visit); walkExpr(en.value, visit); }); break;
    case 'functionCall':   expr.args.forEach((a) => walkExpr(a, visit)); break;
    // 'literal', 'identifier', 'pathLiteral' — leaf nodes
  }
}
```

See [AST reference](../pyric-rules-reference-ast/) for every node shape.

## Run the validator

If your custom checks overlap with security or quality concerns, run the bundled validator and union the findings into your output:

```ts
import { validateFirestoreRules } from 'pyric/rules/internal';

const findings = validateFirestoreRules(ast);
for (const f of findings) {
  console.log(`[${f.severity}] ${f.code} at ${f.path}: ${f.message}`);
}
```

The validator covers public-write detection, default-deny audit, duplicate function names, overlapping paths, and other structural issues. See [Validator findings reference](../pyric-rules-reference-validator-findings/) for the full code list.

## Parse just a function body

Useful for editor pop-ups or function-level lint hooks:

```ts
import { parseFunctions } from 'pyric/rules/internal';

const fns = parseFunctions(`
  function isAdmin() { return request.auth.token.role == 'admin'; }
`);
if (fns) console.log(fns[0].name); // 'isAdmin'
```

`parseFunctions` wraps the input in a minimal `rules_version='2'` shell and returns only the parsed `FunctionDef[]`, or `null` if parsing failed.

## Where to look next

- For every AST node shape, see [AST reference](../pyric-rules-reference-ast/).
- For the validator codes, see [Validator findings reference](../pyric-rules-reference-validator-findings/).
- For `parseToASTOrError`'s `ParseError` shape, see [Errors reference](../pyric-rules-reference-errors/#parseerror).
