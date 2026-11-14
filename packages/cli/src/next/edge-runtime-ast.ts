/**
 * TypeScript AST and module-graph evaluator for Next.js segment `runtime` and
 * `config.runtime` declarations (failing closed on unparseable or indeterminate
 * runtime declarations per ADR 0023 Decision 3.3).
 */
import { readFileSync, realpathSync } from 'node:fs';
import ts from 'typescript';
import { createProjectModuleResolver } from './edge-module-resolver.js';

type RuntimeClassification = 'edge' | 'nodejs' | 'indeterminate' | 'absent';

export interface ResolvedModuleRuntime {
  readonly runtime: RuntimeClassification;
  readonly configRuntime: RuntimeClassification;
  readonly failedClosed: boolean;
}

type EvaluatedValue =
  | { readonly kind: 'string'; readonly value: string }
  | {
      readonly kind: 'object';
      readonly props: ReadonlyMap<string, EvaluatedValue>;
      readonly hasIndeterminateSpread: boolean;
    }
  | { readonly kind: 'namespace'; readonly file: string }
  | { readonly kind: 'indeterminate' };

interface ImportedBinding {
  readonly source: string;
  readonly importedName: string;
}

interface LocalDestructuredBinding {
  readonly init: ts.Expression;
  readonly propertyName: string;
}

type LocalBinding =
  | { readonly kind: 'expr'; readonly expr: ts.Expression }
  | { readonly kind: 'destructured'; readonly binding: LocalDestructuredBinding }
  | { readonly kind: 'enum'; readonly members: ReadonlyMap<string, ts.Expression | string> };

interface ParsedModuleAst {
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

const INDETERMINATE_VALUE: EvaluatedValue = { kind: 'indeterminate' };

function classifyRuntimeString(value: string): RuntimeClassification {
  if (value === 'edge' || value === 'experimental-edge') return 'edge';
  if (value === 'nodejs') return 'nodejs';
  return 'indeterminate';
}

function classifyRuntimeValue(val: EvaluatedValue | null): RuntimeClassification {
  if (val === null) return 'absent';
  if (val.kind === 'string') return classifyRuntimeString(val.value);
  return 'indeterminate';
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

function unwrapExpression(expr: ts.Expression): ts.Expression {
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

function propertyKeyText(name: ts.PropertyName): string | null {
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

function parseModuleAst(filePath: string, sourceText: string): ParsedModuleAst | null {
  const sourceFile = parseSourceWithFallback(filePath, sourceText);
  if (sourceFile === null) return null;

  const locals = new Map<string, LocalBinding>();
  const imports = new Map<string, ImportedBinding>();
  const exportedExprs = new Map<string, ts.Expression>();
  const namedExports: Array<{ localName: string; exportedName: string }> = [];
  const reexports: Array<{ source: string; importedName: string; exportedName: string }> = [];
  const namespaceReexports: Array<{ source: string; exportedName: string }> = [];
  const starReexports: string[] = [];

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
      if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
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

    if (ts.isVariableStatement(statement)) {
      const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      for (const decl of statement.declarationList.declarations) {
        if (decl.initializer === undefined) continue;
        if (ts.isIdentifier(decl.name)) {
          const varName = decl.name.text;
          locals.set(varName, { kind: 'expr', expr: decl.initializer });
          if (isExported) {
            exportedExprs.set(varName, decl.initializer);
          }
        } else if (ts.isObjectBindingPattern(decl.name)) {
          for (const element of decl.name.elements) {
            if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue;
            let propName: string | null = element.name.text;
            if (element.propertyName !== undefined) {
              propName = propertyKeyText(element.propertyName);
            }
            if (propName === null) continue;
            locals.set(element.name.text, {
              kind: 'destructured',
              binding: { init: decl.initializer, propertyName: propName },
            });
            if (isExported) {
              namedExports.push({ localName: element.name.text, exportedName: element.name.text });
            }
          }
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

export function createModuleRuntimeResolver(projectRoot: string): (file: string) => ResolvedModuleRuntime {
  const resolveSpecifier = createProjectModuleResolver(projectRoot);
  const parsedMemo = new Map<string, ParsedModuleAst | null>();
  const resolvedMemo = new Map<string, ResolvedModuleRuntime>();

  const toCanonicalFile = (filePath: string): string => {
    try {
      return realpathSync(filePath);
    } catch {
      return filePath;
    }
  };

  const getParsed = (realFile: string): ParsedModuleAst | null => {
    if (parsedMemo.has(realFile)) return parsedMemo.get(realFile)!;
    try {
      const parsed = parseModuleAst(realFile, readFileSync(realFile, 'utf8'));
      parsedMemo.set(realFile, parsed);
      return parsed;
    } catch {
      parsedMemo.set(realFile, null);
      return null;
    }
  };

  const readProperty = (
    container: EvaluatedValue,
    propName: string,
    visited: Set<string>,
  ): EvaluatedValue => {
    if (container.kind === 'namespace') {
      return evaluateExport(container.file, propName, visited) ?? INDETERMINATE_VALUE;
    }
    if (container.kind === 'object') {
      const prop = container.props.get(propName);
      if (prop !== undefined) return prop;
      if (container.hasIndeterminateSpread) return INDETERMINATE_VALUE;
    }
    return INDETERMINATE_VALUE;
  };

  const evaluateIdentifier = (
    realFile: string,
    parsed: ParsedModuleAst,
    identName: string,
    visited: Set<string>,
  ): EvaluatedValue => {
    const visitKey = `${realFile}::local:${identName}`;
    if (visited.has(visitKey)) return INDETERMINATE_VALUE;
    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);

    const local = parsed.locals.get(identName);
    if (local !== undefined) {
      if (local.kind === 'expr') {
        return evaluateExpr(realFile, parsed, local.expr, nextVisited);
      }
      if (local.kind === 'enum') {
        const props = new Map<string, EvaluatedValue>();
        for (const [key, init] of local.members) {
          if (typeof init === 'string') {
            props.set(key, { kind: 'string', value: init });
          } else {
            props.set(key, evaluateExpr(realFile, parsed, init, nextVisited));
          }
        }
        return { kind: 'object', props, hasIndeterminateSpread: false };
      }
      const container = evaluateExpr(realFile, parsed, local.binding.init, nextVisited);
      return readProperty(container, local.binding.propertyName, nextVisited);
    }

    const imported = parsed.imports.get(identName);
    if (imported !== undefined) {
      const targetFile = resolveSpecifier(realFile, imported.source);
      if (targetFile === null) return INDETERMINATE_VALUE;
      if (imported.importedName === '*') {
        return { kind: 'namespace', file: targetFile };
      }
      return evaluateExport(targetFile, imported.importedName, nextVisited) ?? INDETERMINATE_VALUE;
    }

    return INDETERMINATE_VALUE;
  };

  const evaluateObjectLiteral = (
    realFile: string,
    parsed: ParsedModuleAst,
    obj: ts.ObjectLiteralExpression,
    visited: Set<string>,
  ): EvaluatedValue => {
    const props = new Map<string, EvaluatedValue>();
    let hasIndeterminateSpread = false;
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const spreadVal = evaluateExpr(realFile, parsed, prop.expression, visited);
        if (spreadVal.kind === 'object') {
          for (const [k, v] of spreadVal.props) props.set(k, v);
          if (spreadVal.hasIndeterminateSpread) hasIndeterminateSpread = true;
        } else if (spreadVal.kind === 'namespace') {
          const nsParsed = getParsed(toCanonicalFile(spreadVal.file));
          if (nsParsed === null) {
            hasIndeterminateSpread = true;
          } else {
            const nsRuntime = evaluateExport(spreadVal.file, 'runtime', visited);
            if (nsRuntime !== null) props.set('runtime', nsRuntime);
          }
        } else {
          hasIndeterminateSpread = true;
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        const key = prop.name.text;
        props.set(key, evaluateIdentifier(realFile, parsed, key, visited));
        continue;
      }
      if (ts.isPropertyAssignment(prop)) {
        const key = propertyKeyText(prop.name);
        if (key === null) {
          hasIndeterminateSpread = true;
          continue;
        }
        props.set(key, evaluateExpr(realFile, parsed, prop.initializer, visited));
      }
    }
    return { kind: 'object', props, hasIndeterminateSpread };
  };

  const evaluateExpr = (
    realFile: string,
    parsed: ParsedModuleAst,
    rawExpr: ts.Expression,
    visited: Set<string>,
  ): EvaluatedValue => {
    const expr = unwrapExpression(rawExpr);
    if (ts.isStringLiteralLike(expr)) {
      return { kind: 'string', value: expr.text };
    }
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = evaluateExpr(realFile, parsed, expr.left, visited);
      const right = evaluateExpr(realFile, parsed, expr.right, visited);
      if (left.kind === 'string' && right.kind === 'string') {
        return { kind: 'string', value: left.value + right.value };
      }
      return INDETERMINATE_VALUE;
    }
    if (ts.isIdentifier(expr)) {
      return evaluateIdentifier(realFile, parsed, expr.text, visited);
    }
    if (ts.isObjectLiteralExpression(expr)) {
      return evaluateObjectLiteral(realFile, parsed, expr, visited);
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const receiver = evaluateExpr(realFile, parsed, expr.expression, visited);
      return readProperty(receiver, expr.name.text, visited);
    }
    if (ts.isElementAccessExpression(expr)) {
      const arg = unwrapExpression(expr.argumentExpression);
      if (ts.isStringLiteralLike(arg)) {
        const receiver = evaluateExpr(realFile, parsed, expr.expression, visited);
        return readProperty(receiver, arg.text, visited);
      }
    }
    return INDETERMINATE_VALUE;
  };

  const evaluateExport = (
    filePath: string,
    exportName: string,
    visited: Set<string>,
  ): EvaluatedValue | null => {
    const realFile = toCanonicalFile(filePath);
    const visitKey = `${realFile}::export:${exportName}`;
    if (visited.has(visitKey)) return INDETERMINATE_VALUE;
    const parsed = getParsed(realFile);
    if (parsed === null) return INDETERMINATE_VALUE;

    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);

    let resolved: EvaluatedValue | null = null;

    const directExpr = parsed.exportedExprs.get(exportName);
    if (directExpr !== undefined) {
      resolved = evaluateExpr(realFile, parsed, directExpr, nextVisited);
    }

    for (const ref of parsed.namedExports) {
      if (ref.exportedName !== exportName) continue;
      resolved = evaluateIdentifier(realFile, parsed, ref.localName, nextVisited);
    }

    for (const reexport of parsed.reexports) {
      if (reexport.exportedName !== exportName) continue;
      const targetFile = resolveSpecifier(realFile, reexport.source);
      if (targetFile === null) {
        resolved = INDETERMINATE_VALUE;
        continue;
      }
      const val = evaluateExport(targetFile, reexport.importedName, nextVisited);
      resolved = val ?? INDETERMINATE_VALUE;
    }

    for (const nsReexport of parsed.namespaceReexports) {
      if (nsReexport.exportedName !== exportName) continue;
      const targetFile = resolveSpecifier(realFile, nsReexport.source);
      if (targetFile === null) {
        resolved = INDETERMINATE_VALUE;
      } else {
        resolved = { kind: 'namespace', file: targetFile };
      }
    }

    if (resolved !== null || exportName === 'default') {
      return resolved;
    }

    for (const starSource of parsed.starReexports) {
      const targetFile = resolveSpecifier(realFile, starSource);
      if (targetFile === null) return INDETERMINATE_VALUE;
      const starVal = evaluateExport(targetFile, exportName, nextVisited);
      if (starVal !== null) return starVal;
    }

    return null;
  };

  const classifyConfigValue = (configVal: EvaluatedValue | null): RuntimeClassification => {
    if (configVal === null) return 'absent';
    if (configVal.kind === 'object') {
      const runtimeProp = configVal.props.get('runtime');
      if (runtimeProp !== undefined) {
        return classifyRuntimeValue(runtimeProp);
      }
      return configVal.hasIndeterminateSpread ? 'indeterminate' : 'absent';
    }
    if (configVal.kind === 'namespace') {
      const nsRuntime = evaluateExport(configVal.file, 'runtime', new Set());
      return classifyRuntimeValue(nsRuntime);
    }
    return 'indeterminate';
  };

  return (file: string): ResolvedModuleRuntime => {
    const realFile = toCanonicalFile(file);
    const cached = resolvedMemo.get(realFile);
    if (cached !== undefined) return cached;

    const parsed = getParsed(realFile);
    if (parsed === null) {
      const failed: ResolvedModuleRuntime = {
        runtime: 'indeterminate',
        configRuntime: 'indeterminate',
        failedClosed: true,
      };
      resolvedMemo.set(realFile, failed);
      return failed;
    }

    const runtimeVal = evaluateExport(realFile, 'runtime', new Set());
    const configVal = evaluateExport(realFile, 'config', new Set());
    const runtime = classifyRuntimeValue(runtimeVal);
    const configRuntime = classifyConfigValue(configVal);
    const result: ResolvedModuleRuntime = { runtime, configRuntime, failedClosed: false };
    resolvedMemo.set(realFile, result);
    return result;
  };
}
