/**
 * TypeScript AST and `tsconfig.json` module-graph resolver for Next.js segment
 * `runtime` and `config.runtime` declarations.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type tsType from 'typescript';

const ts = createRequire(import.meta.resolve('pyric/package.json'))('typescript') as typeof tsType;

type RuntimeKind = 'edge' | 'nodejs';

export interface ResolvedModuleRuntime {
  readonly runtime?: RuntimeKind;
  readonly configRuntime?: RuntimeKind;
}

type EvaluatedValue =
  | { readonly kind: 'runtime'; readonly value: RuntimeKind }
  | { readonly kind: 'config'; readonly runtime?: RuntimeKind }
  | { readonly kind: 'namespace'; readonly file: string }
  | { readonly kind: 'unknown' };

interface ImportedBinding {
  readonly source: string;
  readonly importedName: string;
}

interface LocalDestructuredBinding {
  readonly init: tsType.Expression;
  readonly propertyName: string;
}

type LocalBinding =
  | { readonly kind: 'expr'; readonly expr: tsType.Expression }
  | { readonly kind: 'destructured'; readonly binding: LocalDestructuredBinding };

interface ParsedModuleAst {
  readonly locals: ReadonlyMap<string, LocalBinding>;
  readonly imports: ReadonlyMap<string, ImportedBinding>;
  readonly exportedExprs: ReadonlyMap<string, tsType.Expression>;
  readonly namedExports: ReadonlyArray<{ readonly localName: string; readonly exportedName: string }>;
  readonly reexports: ReadonlyArray<{
    readonly source: string;
    readonly importedName: string;
    readonly exportedName: string;
  }>;
  readonly namespaceReexports: ReadonlyArray<{ readonly source: string; readonly exportedName: string }>;
  readonly starReexports: readonly string[];
}

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'] as const;

const UNKNOWN_VALUE: EvaluatedValue = { kind: 'unknown' };

function toRuntimeKind(value: string): RuntimeKind | undefined {
  if (value === 'edge' || value === 'experimental-edge') return 'edge';
  if (value === 'nodejs') return 'nodejs';
  return undefined;
}

function scriptKindFor(filePath: string): tsType.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function unwrapExpression(expr: tsType.Expression): tsType.Expression {
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

function hasModifier(node: tsType.Node, kind: tsType.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  if (modifiers === undefined) return false;
  return modifiers.some((modifier) => modifier.kind === kind);
}

function moduleExportNameText(name: tsType.ModuleExportName): string {
  return name.text;
}

function propertyKeyText(name: tsType.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrapExpression(name.expression);
    if (ts.isStringLiteralLike(inner)) return inner.text;
  }
  return null;
}

function parseModuleAst(filePath: string, sourceText: string): ParsedModuleAst {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    scriptKindFor(filePath),
  );

  const locals = new Map<string, LocalBinding>();
  const imports = new Map<string, ImportedBinding>();
  const exportedExprs = new Map<string, tsType.Expression>();
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
              importedName = moduleExportNameText(element.propertyName);
            }
            imports.set(element.name.text, { source: fromSource, importedName });
          }
        }
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
          namespaceReexports.push({
            source: fromSource,
            exportedName: moduleExportNameText(clause.name),
          });
        }
        continue;
      }
      if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          const exportedName = moduleExportNameText(element.name);
          let leftName = exportedName;
          if (element.propertyName !== undefined) {
            leftName = moduleExportNameText(element.propertyName);
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

function tryRealFile(candidate: string): string | null {
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return realpathSync(candidate);
    }
  } catch {
    // Ignore broken links or unreadable entries.
  }
  return null;
}

function resolveCandidateFile(baseTarget: string): string | null {
  const direct = tryRealFile(baseTarget);
  if (direct !== null) return direct;
  const strippedJs = baseTarget.replace(/\.[cm]?jsx?$/, '');
  for (const ext of SOURCE_EXTENSIONS) {
    const withExt = tryRealFile(`${baseTarget}${ext}`);
    if (withExt !== null) return withExt;
    if (strippedJs !== baseTarget) {
      const swappedExt = tryRealFile(`${strippedJs}${ext}`);
      if (swappedExt !== null) return swappedExt;
    }
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const indexFile = tryRealFile(join(baseTarget, `index${ext}`));
    if (indexFile !== null) return indexFile;
  }
  return null;
}

function defaultCompilerOptions(baseDir: string): tsType.CompilerOptions {
  return {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    baseUrl: baseDir,
  };
}

function createProjectModuleResolver(projectRoot: string): (fromFile: string, specifier: string) => string | null {
  const rootDir = resolve(projectRoot);
  const configMemo = new Map<string, tsType.CompilerOptions>();

  const moduleHost: tsType.ModuleResolutionHost = {
    fileExists: (filePath) => existsSync(filePath),
    readFile: (filePath) => {
      try { return readFileSync(filePath, 'utf8'); } catch { return undefined; }
    },
    directoryExists: (dirPath) => {
      try { return existsSync(dirPath) && statSync(dirPath).isDirectory(); } catch { return false; }
    },
    realpath: (filePath) => {
      try { return realpathSync(filePath); } catch { return filePath; }
    },
    getCurrentDirectory: () => rootDir,
    useCaseSensitiveFileNames: true,
  };

  const parseConfigAt = (configFile: string): tsType.CompilerOptions => {
    const cached = configMemo.get(configFile);
    if (cached !== undefined) return cached;
    const configDir = dirname(configFile);
    const fallback = defaultCompilerOptions(configDir);
    const read = ts.readConfigFile(configFile, (filePath) => moduleHost.readFile(filePath));
    if (read.error !== undefined || !read.config) {
      configMemo.set(configFile, fallback);
      return fallback;
    }
    const parseHost: tsType.ParseConfigHost = {
      useCaseSensitiveFileNames: true,
      readDirectory: () => [],
      fileExists: (filePath) => moduleHost.fileExists(filePath),
      readFile: (filePath) => moduleHost.readFile(filePath),
    };
    const parsed = ts.parseJsonConfigFileContent(read.config, parseHost, configDir, undefined, configFile);
    const merged: tsType.CompilerOptions = {
      ...parsed.options,
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
    };
    configMemo.set(configFile, merged);
    return merged;
  };

  const compilerOptionsForDir = (startDir: string): tsType.CompilerOptions | null => {
    let current = resolve(startDir);
    for (;;) {
      for (const configName of ['tsconfig.json', 'jsconfig.json']) {
        const candidate = join(current, configName);
        if (tryRealFile(candidate) !== null) {
          return parseConfigAt(candidate);
        }
      }
      if (current === rootDir) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  };

  return (fromFile: string, specifier: string): string | null => {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const relHit = resolveCandidateFile(resolve(dirname(fromFile), specifier));
      if (relHit !== null) return relHit;
    }
    const options = compilerOptionsForDir(dirname(fromFile));
    if (options === null) return null;
    const resolved = ts.resolveModuleName(specifier, fromFile, options, moduleHost).resolvedModule;
    if (resolved !== undefined) {
      const filePath = resolved.resolvedFileName;
      if (!resolved.isExternalLibraryImport && !filePath.includes('/node_modules/') && !filePath.includes('\\node_modules\\')) {
        const realResolved = resolveCandidateFile(filePath);
        if (realResolved !== null) return realResolved;
      }
    }
    return null;
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
      return evaluateExport(container.file, propName, visited);
    }
    if (container.kind === 'config' && propName === 'runtime' && container.runtime !== undefined) {
      return { kind: 'runtime', value: container.runtime };
    }
    return UNKNOWN_VALUE;
  };

  const evaluateIdentifier = (
    realFile: string,
    parsed: ParsedModuleAst,
    identName: string,
    visited: Set<string>,
  ): EvaluatedValue => {
    const visitKey = `${realFile}::local:${identName}`;
    if (visited.has(visitKey)) return UNKNOWN_VALUE;
    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);

    const local = parsed.locals.get(identName);
    if (local !== undefined) {
      if (local.kind === 'expr') {
        return evaluateExpr(realFile, parsed, local.expr, nextVisited);
      }
      const container = evaluateExpr(realFile, parsed, local.binding.init, nextVisited);
      return readProperty(container, local.binding.propertyName, nextVisited);
    }

    const imported = parsed.imports.get(identName);
    if (imported !== undefined) {
      const targetFile = resolveSpecifier(realFile, imported.source);
      if (targetFile === null) return UNKNOWN_VALUE;
      if (imported.importedName === '*') {
        return { kind: 'namespace', file: targetFile };
      }
      return evaluateExport(targetFile, imported.importedName, nextVisited);
    }

    return UNKNOWN_VALUE;
  };

  const evaluateObjectLiteral = (
    realFile: string,
    parsed: ParsedModuleAst,
    obj: tsType.ObjectLiteralExpression,
    visited: Set<string>,
  ): EvaluatedValue => {
    let runtime: RuntimeKind | undefined;
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const spreadVal = evaluateExpr(realFile, parsed, prop.expression, visited);
        if (spreadVal.kind === 'config' && spreadVal.runtime !== undefined) {
          runtime = spreadVal.runtime;
        } else if (spreadVal.kind === 'namespace') {
          const nsRuntime = evaluateExport(spreadVal.file, 'runtime', visited);
          if (nsRuntime.kind === 'runtime') runtime = nsRuntime.value;
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (prop.name.text === 'runtime') {
          const val = evaluateIdentifier(realFile, parsed, 'runtime', visited);
          if (val.kind === 'runtime') runtime = val.value;
        }
        continue;
      }
      if (ts.isPropertyAssignment(prop)) {
        const key = propertyKeyText(prop.name);
        if (key === 'runtime') {
          const val = evaluateExpr(realFile, parsed, prop.initializer, visited);
          if (val.kind === 'runtime') runtime = val.value;
        }
      }
    }
    return { kind: 'config', runtime };
  };

  const evaluateExpr = (
    realFile: string,
    parsed: ParsedModuleAst,
    rawExpr: tsType.Expression,
    visited: Set<string>,
  ): EvaluatedValue => {
    const expr = unwrapExpression(rawExpr);
    if (ts.isStringLiteralLike(expr)) {
      const rk = toRuntimeKind(expr.text);
      if (rk !== undefined) return { kind: 'runtime', value: rk };
      return UNKNOWN_VALUE;
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
    return UNKNOWN_VALUE;
  };

  const evaluateExport = (
    filePath: string,
    exportName: string,
    visited: Set<string>,
  ): EvaluatedValue => {
    const realFile = toCanonicalFile(filePath);
    const visitKey = `${realFile}::export:${exportName}`;
    if (visited.has(visitKey)) return UNKNOWN_VALUE;
    const parsed = getParsed(realFile);
    if (parsed === null) return UNKNOWN_VALUE;

    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);

    let resolved: EvaluatedValue = UNKNOWN_VALUE;

    const directExpr = parsed.exportedExprs.get(exportName);
    if (directExpr !== undefined) {
      const val = evaluateExpr(realFile, parsed, directExpr, nextVisited);
      if (val.kind !== 'unknown') resolved = val;
    }

    for (const ref of parsed.namedExports) {
      if (ref.exportedName !== exportName) continue;
      const val = evaluateIdentifier(realFile, parsed, ref.localName, nextVisited);
      if (val.kind !== 'unknown') resolved = val;
    }

    for (const reexport of parsed.reexports) {
      if (reexport.exportedName !== exportName) continue;
      const targetFile = resolveSpecifier(realFile, reexport.source);
      if (targetFile === null) continue;
      const val = evaluateExport(targetFile, reexport.importedName, nextVisited);
      if (val.kind !== 'unknown') resolved = val;
    }

    for (const nsReexport of parsed.namespaceReexports) {
      if (nsReexport.exportedName !== exportName) continue;
      const targetFile = resolveSpecifier(realFile, nsReexport.source);
      if (targetFile !== null) {
        resolved = { kind: 'namespace', file: targetFile };
      }
    }

    if (resolved.kind !== 'unknown' || exportName === 'default') {
      return resolved;
    }

    for (const starSource of parsed.starReexports) {
      const targetFile = resolveSpecifier(realFile, starSource);
      if (targetFile === null) continue;
      const starVal = evaluateExport(targetFile, exportName, nextVisited);
      if (starVal.kind !== 'unknown') return starVal;
    }

    return UNKNOWN_VALUE;
  };

  return (file: string): ResolvedModuleRuntime => {
    const realFile = toCanonicalFile(file);
    const cached = resolvedMemo.get(realFile);
    if (cached !== undefined) return cached;

    const runtimeVal = evaluateExport(realFile, 'runtime', new Set());
    const configVal = evaluateExport(realFile, 'config', new Set());

    let runtime: RuntimeKind | undefined;
    if (runtimeVal.kind === 'runtime') {
      runtime = runtimeVal.value;
    }

    let configRuntime: RuntimeKind | undefined;
    if (configVal.kind === 'config') {
      configRuntime = configVal.runtime;
    } else if (configVal.kind === 'namespace') {
      const nsRuntime = evaluateExport(configVal.file, 'runtime', new Set());
      if (nsRuntime.kind === 'runtime') {
        configRuntime = nsRuntime.value;
      }
    }

    const result: ResolvedModuleRuntime = { runtime, configRuntime };
    resolvedMemo.set(realFile, result);
    return result;
  };
}
