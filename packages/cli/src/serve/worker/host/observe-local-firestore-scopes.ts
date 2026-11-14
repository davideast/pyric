/**
 * Lexical function-scope indexing and parenthesized source token helpers for
 * Firestore rule trace canonicalization (`observe-local-firestore-trace.ts`).
 */
import {
  checkRulesSource,
  indexRulesetScopes,
  readAuthoredSourceMap,
  renderMatchBlockPath,
  topLevelMatches,
  type AuthoredSourceMap,
  type ExprTraceEntry,
  type FirestoreRules,
  type FunctionDef,
  type MatchBlock,
  type RuleEvaluation,
} from 'pyric/rules/internal';

export type FunctionScopeMap = ReadonlyMap<string, readonly FunctionDef[]>;

export interface ParsedRulesEntry {
  readonly source: string;
  readonly ast: FirestoreRules | null;
  readonly sourceMap: AuthoredSourceMap;
  readonly allowScopesByLoc: ReadonlyMap<string, FunctionScopeMap>;
  readonly allowScopesByLine: ReadonlyMap<string, FunctionScopeMap>;
  readonly functionsByMatchPath: ReadonlyMap<string, FunctionScopeMap>;
  readonly fnLexicalScopes: ReadonlyMap<FunctionDef, FunctionScopeMap>;
  readonly allFunctions: FunctionScopeMap;
}

let cachedParsedRules: ParsedRulesEntry | null = null;

function mergeFunctionScope(
  existing: FunctionScopeMap | undefined,
  lexical: ReadonlyMap<string, FunctionDef>,
): Map<string, readonly FunctionDef[]> {
  const merged = new Map<string, readonly FunctionDef[]>();
  if (existing !== undefined) {
    for (const [name, defs] of existing) {
      merged.set(name, defs);
    }
  }
  for (const [name, fn] of lexical) {
    const prev = merged.get(name);
    if (prev === undefined) {
      merged.set(name, [fn]);
    } else if (!prev.includes(fn)) {
      merged.set(name, [...prev, fn]);
    }
  }
  return merged;
}

function lexicalToScopeMap(lexical: ReadonlyMap<string, FunctionDef>): FunctionScopeMap {
  const out = new Map<string, readonly FunctionDef[]>();
  for (const [name, fn] of lexical) {
    out.set(name, [fn]);
  }
  return out;
}

function appendAllFunction(map: Map<string, readonly FunctionDef[]>, fn: FunctionDef): void {
  const prev = map.get(fn.name);
  if (prev === undefined) {
    map.set(fn.name, [fn]);
  } else if (!prev.includes(fn)) {
    map.set(fn.name, [...prev, fn]);
  }
}

function indexAllowRules(
  matchPaths: readonly string[],
  block: MatchBlock,
  scope: ReadonlyMap<string, FunctionDef>,
  allowScopesByLoc: Map<string, FunctionScopeMap>,
  allowScopesByLine: Map<string, FunctionScopeMap>,
): void {
  for (const rule of block.allows) {
    if (rule.loc === undefined) continue;
    for (const mp of matchPaths) {
      const locKey = `${mp}#${rule.loc.line}:${rule.loc.col}`;
      const lineKey = `${mp}#${rule.loc.line}`;
      allowScopesByLoc.set(locKey, mergeFunctionScope(allowScopesByLoc.get(locKey), scope));
      allowScopesByLine.set(lineKey, mergeFunctionScope(allowScopesByLine.get(lineKey), scope));
    }
  }
}

function indexFunctionMaps(ast: FirestoreRules): {
  allowScopesByLoc: Map<string, FunctionScopeMap>;
  allowScopesByLine: Map<string, FunctionScopeMap>;
  functionsByMatchPath: Map<string, FunctionScopeMap>;
  fnLexicalScopes: Map<FunctionDef, FunctionScopeMap>;
  allFunctions: Map<string, readonly FunctionDef[]>;
} {
  const allowScopesByLoc = new Map<string, FunctionScopeMap>();
  const allowScopesByLine = new Map<string, FunctionScopeMap>();
  const functionsByMatchPath = new Map<string, FunctionScopeMap>();
  const fnLexicalScopes = new Map<FunctionDef, FunctionScopeMap>();
  const allFunctions = new Map<string, readonly FunctionDef[]>();

  const rootLexical = new Map<string, FunctionDef>();
  for (const fn of ast.functions ?? []) {
    rootLexical.set(fn.name, fn);
    appendAllFunction(allFunctions, fn);
  }
  for (const fn of ast.service.functions ?? []) {
    rootLexical.set(fn.name, fn);
    appendAllFunction(allFunctions, fn);
  }
  const rootScopeMap = lexicalToScopeMap(rootLexical);
  for (const fn of rootLexical.values()) {
    fnLexicalScopes.set(fn, rootScopeMap);
  }

  const visitBlock = (block: MatchBlock, outer: ReadonlyMap<string, FunctionDef>, prefix: string): void => {
    const lexical = new Map(outer);
    for (const fn of block.functions) {
      lexical.set(fn.name, fn);
      appendAllFunction(allFunctions, fn);
    }
    const scopeMap = lexicalToScopeMap(lexical);
    for (const fn of block.functions) {
      fnLexicalScopes.set(fn, scopeMap);
    }
    const ownPath = renderMatchBlockPath(block);
    const fullPath = prefix === '' ? ownPath : `${prefix}${ownPath}`;
    const paths = ownPath === fullPath ? [ownPath] : [ownPath, fullPath];
    for (const p of paths) {
      functionsByMatchPath.set(p, mergeFunctionScope(functionsByMatchPath.get(p), lexical));
    }
    indexAllowRules(paths, block, lexical, allowScopesByLoc, allowScopesByLine);
    for (const child of block.children) {
      visitBlock(child, lexical, fullPath);
    }
  };

  for (const rootBlock of topLevelMatches(ast.service)) {
    const rootWithBlock = new Map(rootLexical);
    for (const fn of rootBlock.functions) {
      rootWithBlock.set(fn.name, fn);
      appendAllFunction(allFunctions, fn);
    }
    const rootBlockScopeMap = lexicalToScopeMap(rootWithBlock);
    for (const fn of rootBlock.functions) {
      fnLexicalScopes.set(fn, rootBlockScopeMap);
    }
    const rootPath = renderMatchBlockPath(rootBlock);
    functionsByMatchPath.set(rootPath, mergeFunctionScope(functionsByMatchPath.get(rootPath), rootWithBlock));
    indexAllowRules([rootPath], rootBlock, rootWithBlock, allowScopesByLoc, allowScopesByLine);
    for (const child of rootBlock.children) {
      visitBlock(child, rootWithBlock, '');
    }
  }

  return { allowScopesByLoc, allowScopesByLine, functionsByMatchPath, fnLexicalScopes, allFunctions };
}

export function parsedRulesOf(source: string | undefined): ParsedRulesEntry | null {
  if (source === undefined) return null;
  if (cachedParsedRules?.source === source) return cachedParsedRules;
  const checked = checkRulesSource(source);
  const ast = checked.ok ? checked.ast : null;
  const sourceMap = readAuthoredSourceMap(source);
  if (ast === null) {
    cachedParsedRules = {
      source,
      ast: null,
      sourceMap,
      allowScopesByLoc: new Map(),
      allowScopesByLine: new Map(),
      functionsByMatchPath: new Map(),
      fnLexicalScopes: new Map(),
      allFunctions: new Map(),
    };
    return cachedParsedRules;
  }
  indexRulesetScopes(ast);
  cachedParsedRules = { source, ast, sourceMap, ...indexFunctionMaps(ast) };
  return cachedParsedRules;
}

export function resolveInitialScope(entry: RuleEvaluation, parsed: ParsedRulesEntry | null): FunctionScopeMap {
  if (parsed === null) return new Map();
  if (entry.matchPath !== undefined && entry.line !== undefined) {
    if (entry.column !== undefined) {
      const exact = parsed.allowScopesByLoc.get(`${entry.matchPath}#${entry.line}:${entry.column}`);
      if (exact !== undefined) return exact;
    }
    const byLine = parsed.allowScopesByLine.get(`${entry.matchPath}#${entry.line}`);
    if (byLine !== undefined) return byLine;
  }
  if (entry.matchPath !== undefined) {
    const byMatch = parsed.functionsByMatchPath.get(entry.matchPath);
    if (byMatch !== undefined) return byMatch;
  }
  return parsed.allFunctions;
}

export function stripOuterParens(raw: string): string {
  let current = raw.trim();
  while (current.length >= 2 && current.startsWith('(') && current.endsWith(')')) {
    let depth = 0;
    let quote: "'" | '"' | null = null;
    let balancedAcrossWhole = true;
    for (let i = 0; i < current.length; i++) {
      const ch = current[i]!;
      if (quote !== null) {
        if (ch === '\\') {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if ((depth === 0 && i < current.length - 1) || depth < 0) {
          balancedAcrossWhole = false;
          break;
        }
      }
    }
    if (!balancedAcrossWhole || depth !== 0) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

export function extractMethodName(rawSource: string): string | undefined {
  const stripped = stripOuterParens(rawSource);
  if (!stripped.endsWith(')')) return undefined;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let lastTopLevelOpenParen = -1;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (quote !== null) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      if (depth === 0) lastTopLevelOpenParen = i;
      depth++;
    } else if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    }
  }
  if (lastTopLevelOpenParen < 0 || depth !== 0) return undefined;
  const prefix = stripped.slice(0, lastTopLevelOpenParen);
  return /\.([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(prefix)?.[1];
}

export function isAtomicTraceNode(node: ExprTraceEntry): boolean {
  if (node.skipped === true) return false;
  return (
    node.kind === 'identifier' ||
    node.kind === 'memberAccess' ||
    node.kind === 'bracketAccess' ||
    node.kind === 'functionCall'
  );
}

export function pathWildcardNamesOf(matchPath: string | undefined): Set<string> {
  const names = new Set<string>();
  if (!matchPath) return names;
  const pattern = /\{([A-Za-z_][A-Za-z0-9_]*)(?:=\*\*)?\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(matchPath)) !== null) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

export function literalStringOf(node: ExprTraceEntry | undefined): string | undefined {
  if (!node) return undefined;
  if (typeof node.value === 'string') return node.value;
  if (node.kind !== 'literal') return undefined;
  const trimmed = stripOuterParens(node.source);
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

export function literalIndexOf(node: ExprTraceEntry | undefined): number | undefined {
  if (!node) return undefined;
  if (typeof node.value === 'number' && Number.isInteger(node.value) && node.value >= 0) {
    return node.value;
  }
  const stripped = stripOuterParens(node.source);
  if (/^\d+$/.test(stripped)) return Number(stripped);
  return undefined;
}

export function isNullTraceNode(node: ExprTraceEntry | undefined): boolean {
  if (!node) return false;
  if (node.kind === 'literal' && node.value === null) return true;
  return stripOuterParens(node.source) === 'null';
}
