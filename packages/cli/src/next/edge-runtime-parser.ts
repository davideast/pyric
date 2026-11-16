/**
 * TypeScript AST parser for Next.js segment `runtime` and `config` bindings.
 * Collects every statically declared local binding, import, and export,
 * recording complex or dynamic binding forms (array destructuring, object rest,
 * nested destructuring, computed destructuring keys, default initializers,
 * non-const bindings, and exported functions/classes) as indeterminate so the
 * evaluator fails closed.
 */
import ts from 'typescript';

export interface ImportedBinding {
  readonly source: string;
  readonly importedName: string;
}

export interface LocalDestructuredBinding {
  readonly init: ts.Expression;
  readonly propertyName: string;
}

export type LocalBinding =
  | { readonly kind: 'expr'; readonly expr: ts.Expression }
  | { readonly kind: 'destructured'; readonly binding: LocalDestructuredBinding }
  | { readonly kind: 'enum'; readonly members: ReadonlyMap<string, ts.Expression | string> }
  | { readonly kind: 'indeterminate' };

export interface ParsedModuleAst {
  readonly locals: ReadonlyMap<string, LocalBinding>;
  readonly imports: ReadonlyMap<string, ImportedBinding>;
  readonly exportedExprs: ReadonlyMap<string, ts.Expression>;
  readonly namedExports: ReadonlyArray<{ readonly localName: string; readonly exportedName: string }>;
  readonly reexports: ReadonlyArray<{
    readonly source: string;
    readonly importedName: string;
    readonly exportedName: string;
  }>;
  readonly namespaceReexports: ReadonlyArray<{ readonly source: string; readonly exportedName: string }>;
  readonly starReexports: readonly string[];
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function hasParseDiagnostics(sourceFile: ts.SourceFile): boolean {
  const diags = (sourceFile as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  return Array.isArray(diags) && diags.length > 0;
}

export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  if (modifiers === undefined) return false;
  return modifiers.some((modifier) => modifier.kind === kind);
}

export function propertyKeyText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrapExpression(name.expression);
    if (ts.isStringLiteralLike(inner)) return inner.text;
  }
  return null;
}

function parseSourceWithFallback(filePath: string, sourceText: string): ts.SourceFile | null {
  const initialKind = scriptKindFor(filePath);
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, false, initialKind);
  if (!hasParseDiagnostics(sourceFile)) return sourceFile;
  if (initialKind === ts.ScriptKind.TS || initialKind === ts.ScriptKind.JS) {
    const jsxFallback = initialKind === ts.ScriptKind.TS ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
    const retried = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, false, jsxFallback);
    if (!hasParseDiagnostics(retried)) return retried;
  }
  return null;
}

function collectBindingIdentifiers(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      collectBindingIdentifiers(element.name, out);
    }
    return;
  }
  if (ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingIdentifiers(element.name, out);
      }
    }
  }
}

export function parseModuleAst(filePath: string, sourceText: string): ParsedModuleAst | null {
  const sourceFile = parseSourceWithFallback(filePath, sourceText);
  if (sourceFile === null) return null;

  const locals = new Map<string, LocalBinding>();
  const imports = new Map<string, ImportedBinding>();
  const exportedExprs = new Map<string, ts.Expression>();
  const namedExports: Array<{ localName: string; exportedName: string }> = [];
  const reexports: Array<{ source: string; importedName: string; exportedName: string }> = [];
  const namespaceReexports: Array<{ source: string; exportedName: string }> = [];
  const starReexports: string[] = [];

  const recordIndeterminateBinding = (name: ts.BindingName, isExported: boolean): void => {
    const identifiers: string[] = [];
    collectBindingIdentifiers(name, identifiers);
    for (const varName of identifiers) {
      locals.set(varName, { kind: 'indeterminate' });
      if (isExported) {
        namedExports.push({ localName: varName, exportedName: varName });
      }
    }
  };

  for (const statement of sourceFile.statements) {
    if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
      continue;
    }

    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      if (clause === undefined || clause.isTypeOnly) continue;
      const fromSource = statement.moduleSpecifier.text;
      if (clause.name !== undefined) {
        imports.set(clause.name.text, { source: fromSource, importedName: 'default' });
      }
      const bindings = clause.namedBindings;
      if (bindings !== undefined) {
        if (ts.isNamespaceImport(bindings)) {
          imports.set(bindings.name.text, { source: fromSource, importedName: '*' });
        } else if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (element.isTypeOnly) continue;
            let importedName = element.name.text;
            if (element.propertyName !== undefined) {
              importedName = element.propertyName.text;
            }
            imports.set(element.name.text, { source: fromSource, importedName });
          }
        }
      }
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      const members = new Map<string, ts.Expression | string>();
      let nextNumeric = 0;
      for (const member of statement.members) {
        const key = propertyKeyText(member.name);
        if (key === null) continue;
        if (member.initializer !== undefined) {
          members.set(key, member.initializer);
          if (ts.isNumericLiteral(member.initializer)) {
            nextNumeric = Number(member.initializer.text) + 1;
          }
        } else {
          members.set(key, String(nextNumeric));
          nextNumeric += 1;
        }
      }
      const enumName = statement.name.text;
      locals.set(enumName, { kind: 'enum', members });
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        namedExports.push({ localName: enumName, exportedName: enumName });
      }
      continue;
    }

    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) {
      const declName = statement.name.text;
      locals.set(declName, { kind: 'indeterminate' });
      const isNamedExport =
        hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
        !hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      if (isNamedExport) {
        namedExports.push({ localName: declName, exportedName: declName });
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const varName = decl.name.text;
          if (!isConst || decl.initializer === undefined) {
            locals.set(varName, { kind: 'indeterminate' });
          } else {
            locals.set(varName, { kind: 'expr', expr: decl.initializer });
          }
          if (isExported) {
            namedExports.push({ localName: varName, exportedName: varName });
          }
        } else if (ts.isObjectBindingPattern(decl.name)) {
          for (const element of decl.name.elements) {
            if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) {
              recordIndeterminateBinding(element.name, isExported);
              continue;
            }
            let propName: string | null = element.name.text;
            if (element.propertyName !== undefined) {
              propName = propertyKeyText(element.propertyName);
            }
            if (propName === null || element.initializer !== undefined || !isConst || decl.initializer === undefined) {
              recordIndeterminateBinding(element.name, isExported);
              continue;
            }
            locals.set(element.name.text, {
              kind: 'destructured',
              binding: { init: decl.initializer, propertyName: propName },
            });
            if (isExported) {
              namedExports.push({ localName: element.name.text, exportedName: element.name.text });
            }
          }
        } else if (ts.isArrayBindingPattern(decl.name)) {
          recordIndeterminateBinding(decl.name, isExported);
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      exportedExprs.set('default', statement.expression);
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      let fromSource: string | undefined;
      if (statement.moduleSpecifier !== undefined && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        fromSource = statement.moduleSpecifier.text;
      }
      const clause = statement.exportClause;
      if (clause === undefined) {
        if (fromSource !== undefined) {
          starReexports.push(fromSource);
        }
        continue;
      }
      if (ts.isNamespaceExport(clause)) {
        if (fromSource !== undefined) {
          namespaceReexports.push({ source: fromSource, exportedName: clause.name.text });
        }
        continue;
      }
      if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          const exportedName = element.name.text;
          let leftName = exportedName;
          if (element.propertyName !== undefined) {
            leftName = element.propertyName.text;
          }
          if (fromSource !== undefined) {
            reexports.push({ source: fromSource, importedName: leftName, exportedName });
          } else {
            namedExports.push({ localName: leftName, exportedName });
          }
        }
      }
    }
  }

  const markMutatedTarget = (target: ts.Node): void => {
    let cur: ts.Node = target;
    while (ts.isParenthesizedExpression(cur) || ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    }
    if (ts.isIdentifier(cur) && locals.has(cur.text)) {
      locals.set(cur.text, { kind: 'indeterminate' });
    }
  };
  const scanMutations = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      markMutatedTarget(node.left);
    } else if (ts.isDeleteExpression(node)) {
      markMutatedTarget(node.expression);
    }
    ts.forEachChild(node, scanMutations);
  };
  ts.forEachChild(sourceFile, scanMutations);

  return {
    locals,
    imports,
    exportedExprs,
    namedExports,
    reexports,
    namespaceReexports,
    starReexports,
  };
}
