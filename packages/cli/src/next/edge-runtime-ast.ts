/**
 * TypeScript AST and module-graph evaluator for Next.js segment `runtime` and
 * `config.runtime` declarations (failing closed on unparseable or indeterminate
 * runtime declarations per ADR 0023 Decision 3.3).
 */
import { readFileSync, realpathSync } from 'node:fs';
import ts from 'typescript';
import { createProjectModuleResolver } from './edge-module-resolver.js';
import {
  parseModuleAst,
  propertyKeyText,
  unwrapExpression,
  type ParsedModuleAst,
} from './edge-runtime-parser.js';

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
    const cached = parsedMemo.get(realFile);
    if (cached !== undefined || parsedMemo.has(realFile)) {
      return cached ?? null;
    }
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
      if (local.kind === 'indeterminate') return INDETERMINATE_VALUE;
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
        continue;
      }
      if (
        ts.isGetAccessorDeclaration(prop) ||
        ts.isSetAccessorDeclaration(prop) ||
        ts.isMethodDeclaration(prop)
      ) {
        const key = propertyKeyText(prop.name);
        if (key === null) {
          hasIndeterminateSpread = true;
        } else {
          props.set(key, INDETERMINATE_VALUE);
        }
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
