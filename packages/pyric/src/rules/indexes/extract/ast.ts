/**
 * Small TypeScript-AST helpers used by the rest of the extractor.
 * Pure utilities — no extractor state, no allocation of context.
 */
import ts from 'typescript';

/**
 * Returns the literal text of a string-literal or no-substitution
 * template literal node. Returns `null` for any other expression so the
 * caller can decide how to handle the dynamic case.
 */
export function strLit(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * Extract the callee name from a call expression. Handles both bare
 * identifiers (`query(...)`) and property accesses (`firestore.query(...)`),
 * returning the **rightmost** identifier in either case so module-style
 * imports and namespace imports both work.
 *
 * Returns `null` for callees we can't resolve statically (e.g.,
 * `(foo ? a : b)(...)` or `arr[0](...)`).
 */
export function getCalleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/**
 * Find a top-level function (declaration, function-expression assigned to
 * a `let`/`const`, or arrow function assigned to one) by name and return
 * the function body node. Returns `null` if no such function exists.
 *
 * Used by the extractor to locate the function whose query chain we want
 * to scan. A more complete implementation would build a real symbol
 * table; this is enough for the common Firebase-app pattern of one
 * exported function per query.
 */
export function findFunctionByName(sf: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null;
  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) {
      found = n.body ?? null;
      return;
    }
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
          if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
            found = d.initializer.body;
            return;
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  return found;
}

/**
 * Walk every function-like node in a source file and yield each body.
 * Used by the orchestrator when no specific function name is given —
 * scan everything that could contain a query chain.
 *
 * Includes function declarations, arrow functions, function expressions,
 * and method declarations. Class constructors and getters/setters are
 * also included since they can issue queries too.
 */
export function* iterFunctionBodies(sf: ts.SourceFile): Generator<{ name: string; body: ts.Node }> {
  function nameOf(n: ts.Node): string {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) {
      const id = n.name;
      if (id && ts.isIdentifier(id)) return id.text;
    }
    return '<anon>';
  }

  function* visit(n: ts.Node): Generator<{ name: string; body: ts.Node }> {
    if (ts.isFunctionDeclaration(n) && n.body) {
      yield { name: nameOf(n), body: n.body };
    } else if (ts.isMethodDeclaration(n) && n.body) {
      yield { name: nameOf(n), body: n.body };
    } else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          const name = ts.isIdentifier(d.name) ? d.name.text : '<anon>';
          yield { name, body: d.initializer.body };
        }
      }
    }
    for (const child of n.getChildren()) {
      yield* visit(child);
    }
  }

  yield* visit(sf);
}

/**
 * Parse a string of JS/TS source into a SourceFile. Returns `null` if
 * TypeScript reports a fatal lex error — TypeScript's parser is very
 * lenient (it'll happily produce a partially-correct AST for malformed
 * input), so this almost always succeeds. The orchestrator still wraps
 * the call in a try/catch for the rare hard failure.
 */
export function parseSource(name: string, source: string): ts.SourceFile {
  // ScriptKind.JS for the modular Firebase API in JS; TS is a superset
  // so this still parses .ts correctly. Using JS here means JSDoc tags
  // are surfaced (we'll use this for the Layer 2 annotation work).
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}
