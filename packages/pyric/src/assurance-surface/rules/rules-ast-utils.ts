/**
 * Shared browser-clean AST helpers for Firestore and Storage security rules:
 * multi-match / literal-(default) normalization (preserving 1-based line numbers),
 * lexical helper-function inlining with cycle guards, verb expansion, and
 * overbroad auth-only write guard detection.
 */
import type { ServiceBlock } from '@pyric/rules/internal';
import {
  parseToASTOrError,
  resolveModulesBrowser,
  STDLIB_INLINE,
  topLevelMatches,
  type Expression,
  type FirestoreRules,
  type FunctionDef,
  type MatchBlock,
  type Operation,
  type ParseError,
  type PathSegment,
} from '../../rules/internal/index.js';
import type { RtdbExpressionTree } from '../../rules/internal/rtdb.js';

const MAX_RULE_INLINE_DEPTH = 8;

const MULTI_ROOT_SENTINEL = '__pyric_multi_root__';
const DEFAULT_DB_SENTINEL = '__pyric_default_db__';

export interface ParseRulesAstOptions {
  readonly modules?: Readonly<Record<string, string>>;
  readonly targetService?: 'cloud.firestore' | 'firebase.storage';
  readonly sourceFile?: string;
}

export interface BoundRuleExpr {
  readonly expr: Expression;
  readonly scope: RuleAstScope;
}

export interface RuleAstScope {
  readonly vars: Map<string, BoundRuleExpr>;
  readonly functions: readonly (readonly FunctionDef[])[];
  readonly wildcards: ReadonlySet<string>;
  readonly depth: number;
}

export interface ParsedServiceMatches {
  readonly name: string;
  readonly functions: readonly (readonly FunctionDef[])[];
  readonly matches: readonly MatchBlock[];
}

export function expandRuleOps(ops: readonly Operation[]): string[] {
  const out = new Set<string>();
  for (const op of ops) {
    if (op === 'read') {
      out.add('get');
      out.add('list');
    } else if (op === 'write') {
      out.add('create');
      out.add('update');
      out.add('delete');
    } else {
      out.add(op);
    }
  }
  return [...out];
}

export function formatMatchSegment(seg: PathSegment): string {
  if (seg.type === 'literal') {
    if (seg.value === DEFAULT_DB_SENTINEL) return '(default)';
    return seg.value;
  }
  if (seg.type === 'wildcard') return `{${seg.name}}`;
  return `{${seg.name}=**}`;
}

function restoreExprSentinels(expr: Expression): Expression {
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return expr;
    case 'memberAccess':
      return { ...expr, object: restoreExprSentinels(expr.object) };
    case 'methodCall':
      return { ...expr, object: restoreExprSentinels(expr.object), args: expr.args.map(restoreExprSentinels) };
    case 'bracketAccess':
      return { ...expr, object: restoreExprSentinels(expr.object), index: restoreExprSentinels(expr.index) };
    case 'sliceAccess':
      return {
        ...expr,
        object: restoreExprSentinels(expr.object),
        start: restoreExprSentinels(expr.start),
        end: restoreExprSentinels(expr.end),
      };
    case 'binaryOp':
      return { ...expr, left: restoreExprSentinels(expr.left), right: restoreExprSentinels(expr.right) };
    case 'unaryOp':
      return { ...expr, operand: restoreExprSentinels(expr.operand) };
    case 'ternary':
      return {
        ...expr,
        condition: restoreExprSentinels(expr.condition),
        consequent: restoreExprSentinels(expr.consequent),
        alternate: restoreExprSentinels(expr.alternate),
      };
    case 'inExpr':
      return { ...expr, element: restoreExprSentinels(expr.element), collection: restoreExprSentinels(expr.collection) };
    case 'isExpr':
      return { ...expr, value: restoreExprSentinels(expr.value) };
    case 'listLiteral':
      return { ...expr, elements: expr.elements.map(restoreExprSentinels) };
    case 'mapLiteral':
      return {
        ...expr,
        entries: expr.entries.map((entry) => ({
          key: restoreExprSentinels(entry.key),
          value: restoreExprSentinels(entry.value),
        })),
      };
    case 'pathLiteral':
      return {
        ...expr,
        raw: expr.raw.replaceAll(DEFAULT_DB_SENTINEL, '(default)'),
        segments: expr.segments.map((seg) => {
          if (typeof seg === 'string') return seg.replaceAll(DEFAULT_DB_SENTINEL, '(default)');
          return restoreExprSentinels(seg);
        }),
      };
    case 'functionCall':
      return { ...expr, args: expr.args.map(restoreExprSentinels) };
  }
}

function restoreFunctionSentinels(fn: FunctionDef): FunctionDef {
  return {
    ...fn,
    lets: fn.lets.map((letBinding) => ({
      ...letBinding,
      value: restoreExprSentinels(letBinding.value),
    })),
    body: restoreExprSentinels(fn.body),
  };
}

function restoreMatchSentinels(block: MatchBlock): MatchBlock {
  const segments = block.path.segments.map((seg): PathSegment => {
    if (seg.type === 'literal' && seg.value === DEFAULT_DB_SENTINEL) {
      return { type: 'literal', value: '(default)' };
    }
    return seg;
  });
  return {
    ...block,
    path: {
      raw: block.path.raw.replaceAll(DEFAULT_DB_SENTINEL, '(default)'),
      segments,
    },
    functions: block.functions.map(restoreFunctionSentinels),
    allows: block.allows.map((allow) => ({
      ...allow,
      condition: restoreExprSentinels(allow.condition),
    })),
    children: block.children.map(restoreMatchSentinels),
  };
}

/**
 * Scan `source` outside string literals and comments to:
 * 1. Replace `/databases/(default)/` and `/b/(default)/` in `match` headers with `DEFAULT_DB_SENTINEL`.
 * 2. Expand bare `allow <ops>;` to `allow <ops>: if true;` on the same line.
 * 3. Wrap each `service <name> { ... }` body in `match /__pyric_multi_root__ { ... }`
 *    on the exact opening/closing brace lines so line numbers never shift.
 */
function normalizeMultiMatchSource(source: string): string {
  const serviceHeaderRe = /\bservice\s+[A-Za-z][A-Za-z.]*\s*\{/y;
  const defaultDbMatchRe = /\/(databases|b)\/\(default\)\//y;
  const bareAllowRe = /\ballow\s+((?:read|write|get|list|create|update|delete)(?:\s*,\s*(?:read|write|get|list|create|update|delete))*)\s*;/y;
  let out = '';
  let i = 0;
  let braceDepth = 0;
  const serviceCloseDepths: number[] = [];

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i + 2);
      let end = source.length;
      if (nl !== -1) end = nl;
      out += source.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      let end = source.length;
      if (close !== -1) end = close + 2;
      out += source.slice(i, end);
      i = end;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i]!;
        out += c;
        i += 1;
        if (c === '\\' && i < source.length) {
          out += source[i]!;
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }

    if (braceDepth === 0) {
      serviceHeaderRe.lastIndex = i;
      const m = serviceHeaderRe.exec(source);
      if (m !== null) {
        out += `${m[0]} match /${MULTI_ROOT_SENTINEL} {`;
        braceDepth += 1;
        serviceCloseDepths.push(braceDepth);
        i += m[0].length;
        continue;
      }
    }

    defaultDbMatchRe.lastIndex = i;
    const dbMatch = defaultDbMatchRe.exec(source);
    if (dbMatch !== null) {
      out += `/${dbMatch[1]}/${DEFAULT_DB_SENTINEL}/`;
      i += dbMatch[0].length;
      continue;
    }

    bareAllowRe.lastIndex = i;
    const bareAllow = bareAllowRe.exec(source);
    if (bareAllow !== null) {
      out += `allow ${bareAllow[1]}: if true;`;
      i += bareAllow[0].length;
      continue;
    }

    if (ch === '{') {
      braceDepth += 1;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '}') {
      const topServiceDepth = serviceCloseDepths[serviceCloseDepths.length - 1];
      if (topServiceDepth !== undefined && braceDepth === topServiceDepth) {
        serviceCloseDepths.pop();
        braceDepth -= 1;
        out += '} }';
        i += 1;
        continue;
      }
      if (braceDepth > 0) braceDepth -= 1;
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

interface DeclaredFunctionScope {
  readonly functions: readonly (readonly FunctionDef[])[];
  readonly wildcards: ReadonlySet<string>;
}

const DECLARED_FUNCTION_SCOPES = new WeakMap<FunctionDef, DeclaredFunctionScope>();

function indexMatchFunctionScopes(
  block: MatchBlock,
  parentFunctions: readonly (readonly FunctionDef[])[],
  parentWildcards: ReadonlySet<string>,
): void {
  const nextWildcards = new Set(parentWildcards);
  for (const seg of block.path.segments) {
    if (seg.type !== 'literal') nextWildcards.add(seg.name);
  }
  const currentFunctions = [...parentFunctions, block.functions];
  for (const fn of block.functions) {
    DECLARED_FUNCTION_SCOPES.set(fn, {
      functions: currentFunctions,
      wildcards: nextWildcards,
    });
  }
  for (const child of block.children) {
    indexMatchFunctionScopes(child, currentFunctions, nextWildcards);
  }
}

function indexParsedServiceScopes(services: readonly ParsedServiceMatches[]): void {
  const emptyWildcards: ReadonlySet<string> = new Set();
  for (const svc of services) {
    for (let g = 0; g < svc.functions.length; g += 1) {
      const prefixGroups = svc.functions.slice(0, g + 1);
      for (const fn of svc.functions[g] ?? []) {
        DECLARED_FUNCTION_SCOPES.set(fn, {
          functions: prefixGroups,
          wildcards: emptyWildcards,
        });
      }
    }
    for (const topMatch of svc.matches) {
      indexMatchFunctionScopes(topMatch, svc.functions, emptyWildcards);
    }
  }
}

function stripCommentsAndStringsPreservingNewlines(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i + 2);
      const end = nl === -1 ? source.length : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      out += source.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote;
      i += 1;
      while (i < source.length) {
        const c = source[i]!;
        if (c === '\\' && i + 1 < source.length) {
          out += '  ';
          i += 2;
          continue;
        }
        if (c === quote) {
          out += quote;
          i += 1;
          break;
        }
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function isModularRulesSource(source: string): boolean {
  const scrubbed = stripCommentsAndStringsPreservingNewlines(source);
  const versionMatch = /\brules_version\s*=\s*(['"])/g;
  let m: RegExpExecArray | null;
  while ((m = versionMatch.exec(scrubbed)) !== null) {
    const quoteIdx = m.index + m[0].length - 1;
    const rawSlice = source.slice(quoteIdx);
    const strMatch = /^(['"])2\+modules\1\s*;/.exec(rawSlice);
    if (strMatch !== null) return true;
  }
  return false;
}

export function preNormalizeModularSyntax(source: string): string {
  const defaultDbMatchRe = /\/(databases|b)\/\(default\)\//y;
  const bareAllowRe = /\ballow\s+((?:read|write|get|list|create|update|delete)(?:\s*,\s*(?:read|write|get|list|create|update|delete))*)\s*;/y;
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i + 2);
      const end = nl === -1 ? source.length : nl;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i]!;
        out += c;
        i += 1;
        if (c === '\\' && i < source.length) {
          out += source[i]!;
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    defaultDbMatchRe.lastIndex = i;
    const dbMatch = defaultDbMatchRe.exec(source);
    if (dbMatch !== null) {
      out += `/${dbMatch[1]}/${DEFAULT_DB_SENTINEL}/`;
      i += dbMatch[0].length;
      continue;
    }
    bareAllowRe.lastIndex = i;
    const bareAllow = bareAllowRe.exec(source);
    if (bareAllow !== null) {
      out += `allow ${bareAllow[1]}: if true;`;
      i += bareAllow[0].length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function restoreDefaultDbSentinelText(source: string): string {
  return source.replaceAll(DEFAULT_DB_SENTINEL, '(default)');
}

function collectExportedFunctionNames(moduleText: string): string[] {
  const scrubbed = stripCommentsAndStringsPreservingNewlines(moduleText);
  const re = /\bexport\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(scrubbed)) !== null) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function collectCalledIdentifiers(bodyText: string): Set<string> {
  const scrubbed = stripCommentsAndStringsPreservingNewlines(bodyText);
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(scrubbed)) !== null) {
    out.add(m[1]!);
  }
  return out;
}

function skipHeaderTrivia(text: string, start: number): number {
  let pos = start;
  while (pos < text.length) {
    const m = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(text.slice(pos));
    if (!m || m[0].length === 0) break;
    pos += m[0].length;
  }
  return pos;
}

export function expandBareModuleImports(
  source: string,
  lookupModuleText: (specifier: string) => string | null,
): string {
  interface BareImportSpan {
    readonly start: number;
    readonly end: number;
    readonly quote: string;
    readonly specifier: string;
  }
  const bareSpans: BareImportSpan[] = [];
  let cursor = 0;
  for (;;) {
    cursor = skipHeaderTrivia(source, cursor);
    const slice = source.slice(cursor);
    if (/^rules_version\b/.test(slice)) {
      let pos = skipHeaderTrivia(source, cursor + 'rules_version'.length);
      if (source[pos] !== '=') break;
      pos = skipHeaderTrivia(source, pos + 1);
      const str = /^(['"])([^'"]*)\1/.exec(source.slice(pos));
      if (!str) break;
      pos = skipHeaderTrivia(source, pos + str[0].length);
      if (source[pos] !== ';') break;
      cursor = pos + 1;
      continue;
    }
    if (/^import\b/.test(slice)) {
      const importStart = cursor;
      let pos = skipHeaderTrivia(source, cursor + 'import'.length);
      if (source[pos] === '{') {
        const closeBrace = source.indexOf('}', pos + 1);
        if (closeBrace === -1) break;
        pos = skipHeaderTrivia(source, closeBrace + 1);
        if (!/^from\b/.test(source.slice(pos))) break;
        pos = skipHeaderTrivia(source, pos + 'from'.length);
        const str = /^(['"])([^'"]*)\1/.exec(source.slice(pos));
        if (!str) break;
        pos = skipHeaderTrivia(source, pos + str[0].length);
        if (source[pos] !== ';') break;
        cursor = pos + 1;
        continue;
      }
      const str = /^(['"])([^'"]+)\1/.exec(source.slice(pos));
      if (!str) break;
      const quote = str[1]!;
      const specifier = str[2]!;
      pos = skipHeaderTrivia(source, pos + str[0].length);
      if (source[pos] !== ';') break;
      bareSpans.push({
        start: importStart,
        end: pos + 1,
        quote,
        specifier,
      });
      cursor = pos + 1;
      continue;
    }
    break;
  }

  if (bareSpans.length === 0) return source;

  const called = collectCalledIdentifiers(source.slice(cursor));
  let rebuilt = '';
  let prevEnd = 0;
  for (const span of bareSpans) {
    rebuilt += source.slice(prevEnd, span.start);
    const modText = lookupModuleText(span.specifier);
    if (modText === null) {
      throw new Error(`Module '${span.specifier}' not found`);
    }
    const exported = collectExportedFunctionNames(modText);
    const used = exported.filter((fn) => called.has(fn));
    const rawSpan = source.slice(span.start, span.end);
    const newlineCount = (rawSpan.match(/\n/g) ?? []).length;
    const trailingNewlines = '\n'.repeat(newlineCount);
    if (used.length > 0) {
      rebuilt += `import { ${used.join(', ')} } from ${span.quote}${span.specifier}${span.quote};${trailingNewlines}`;
    } else {
      rebuilt += rawSpan.replace(/[^\n]/g, ' ');
    }
    prevEnd = span.end;
  }
  rebuilt += source.slice(prevEnd);
  return rebuilt;
}

export function lookupInMemoryModule(
  specifier: string,
  modules?: Readonly<Record<string, string>>,
): string | null {
  if (modules !== undefined) {
    if (Object.hasOwn(modules, specifier)) return modules[specifier]!;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const withoutExt = specifier.endsWith('.rules') ? specifier.slice(0, -'.rules'.length) : specifier;
      const withExt = `${withoutExt}.rules`;
      if (Object.hasOwn(modules, withoutExt)) return modules[withoutExt]!;
      if (Object.hasOwn(modules, withExt)) return modules[withExt]!;
    }
  }
  if (Object.hasOwn(STDLIB_INLINE, specifier)) {
    return STDLIB_INLINE[specifier as keyof typeof STDLIB_INLINE] ?? null;
  }
  const stdlibAlias = /^\.\/stdlib\/(.+?)(?:\.rules)?$/.exec(specifier);
  if (stdlibAlias && Object.hasOwn(STDLIB_INLINE, stdlibAlias[1]!)) {
    return STDLIB_INLINE[stdlibAlias[1]! as keyof typeof STDLIB_INLINE] ?? null;
  }
  return null;
}

function lowerModularRulesInMemoryOrError(
  source: string,
  options?: ParseRulesAstOptions,
): { ok: true; source: string } | { ok: false; message: string } {
  if (!isModularRulesSource(source)) return { ok: true, source };
  try {
    let preparedModules: Record<string, string> | undefined;
    if (options?.modules !== undefined) {
      preparedModules = {};
      for (const [key, rawMod] of Object.entries(options.modules)) {
        if (typeof rawMod !== 'string') continue;
        const expandedMod = expandBareModuleImports(rawMod, (spec) =>
          lookupInMemoryModule(spec, options.modules),
        );
        Object.defineProperty(preparedModules, key, {
          value: preNormalizeModularSyntax(expandedMod),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    const expandedSource = expandBareModuleImports(source, (spec) =>
      lookupInMemoryModule(spec, preparedModules ?? options?.modules),
    );
    const preNormalized = preNormalizeModularSyntax(expandedSource);
    const resolveOpts: {
      modules?: Record<string, string>;
      targetService?: 'cloud.firestore' | 'firebase.storage';
      sourceFile?: string;
    } = {};
    if (preparedModules !== undefined) resolveOpts.modules = preparedModules;
    if (options?.targetService !== undefined) resolveOpts.targetService = options.targetService;
    if (options?.sourceFile !== undefined) resolveOpts.sourceFile = options.sourceFile;
    const resolved = resolveModulesBrowser(preNormalized, resolveOpts);
    if (!resolved.success) {
      return { ok: false, message: resolved.error.message };
    }
    return { ok: true, source: restoreDefaultDbSentinelText(resolved.data.resolved) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function lowerModularRulesInMemory(
  source: string,
  options?: ParseRulesAstOptions,
): string {
  const lowered = lowerModularRulesInMemoryOrError(source, options);
  return lowered.ok ? lowered.source : source;
}

function buildDirectServiceMatches(ast: FirestoreRules): ParsedServiceMatches[] {
  let services = [ast.service];
  if (ast.services && ast.services.length > 0) services = ast.services;
  const parsed = services.map((svc) => ({
    name: svc.name,
    functions: [ast.functions ?? [], svc.functions ?? []],
    matches: topLevelMatches(svc),
  }));
  indexParsedServiceScopes(parsed);
  return parsed;
}

function buildNormalizedServiceMatches(fallback: FirestoreRules): ParsedServiceMatches[] {
  let services = [fallback.service];
  if (fallback.services && fallback.services.length > 0) services = fallback.services;
  const parsed = services.map((svc) => {
    const topMatches = topLevelMatches(svc);
    const root = topMatches[0];
    const globalFns = (fallback.functions ?? []).map(restoreFunctionSentinels);
    const serviceFns = (svc.functions ?? []).map(restoreFunctionSentinels);
    if (!root) {
      return {
        name: svc.name,
        functions: [globalFns, serviceFns],
        matches: [],
      };
    }
    const isSyntheticRoot =
      topMatches.length === 1
      && root.path.segments.length === 1
      && root.path.segments[0]?.type === 'literal'
      && root.path.segments[0].value === MULTI_ROOT_SENTINEL;
    if (!isSyntheticRoot) {
      return {
        name: svc.name,
        functions: [globalFns, serviceFns],
        matches: topMatches.map(restoreMatchSentinels),
      };
    }
    return {
      name: svc.name,
      functions: [globalFns, serviceFns, root.functions.map(restoreFunctionSentinels)],
      matches: root.children.map(restoreMatchSentinels),
    };
  });
  indexParsedServiceScopes(parsed);
  return parsed;
}

function formatRulesParseFailure(err: ParseError): string {
  const detail = err.expected ? `expected ${err.expected}` : err.message;
  return `Syntax error at line ${err.line}, column ${err.column}: ${detail}`;
}

function unwrapNormalizedServiceBlock(svc: ServiceBlock): ServiceBlock | null {
  const topMatches = topLevelMatches(svc);
  const root = topMatches[0];
  const serviceFns = (svc.functions ?? []).map(restoreFunctionSentinels);
  if (!root) return null;
  const isSyntheticRoot =
    topMatches.length === 1
    && root.path.segments.length === 1
    && root.path.segments[0]?.type === 'literal'
    && root.path.segments[0].value === MULTI_ROOT_SENTINEL;
  const matches = isSyntheticRoot
    ? root.children.map(restoreMatchSentinels)
    : topMatches.map(restoreMatchSentinels);
  const firstMatch = matches[0];
  if (!firstMatch) return null;
  const functions = isSyntheticRoot
    ? [...serviceFns, ...root.functions.map(restoreFunctionSentinels)]
    : serviceFns;
  return {
    ...svc,
    functions,
    match: firstMatch,
    matches,
  };
}

export function parseFirestoreRulesAstWithMultiMatch(
  source: string,
  options?: ParseRulesAstOptions,
): { readonly source: string; readonly ast: FirestoreRules } | null {
  const lowered = lowerModularRulesInMemoryOrError(source, options);
  if (!lowered.ok) return null;
  const effectiveSource = lowered.source;

  const direct = parseToASTOrError(effectiveSource);
  if (direct.ok) {
    const services =
      direct.ast.services && direct.ast.services.length > 0
        ? direct.ast.services
        : [direct.ast.service];
    const fsService = services.find((svc) => svc.name === 'cloud.firestore');
    if (!fsService) return null;
    const ast: FirestoreRules =
      fsService === direct.ast.service ? direct.ast : { ...direct.ast, service: fsService };
    return { source: effectiveSource, ast };
  }

  const normalized = normalizeMultiMatchSource(effectiveSource);
  const fallback = parseToASTOrError(normalized);
  if (!fallback.ok) return null;

  const rawServices =
    fallback.ast.services && fallback.ast.services.length > 0
      ? fallback.ast.services
      : [fallback.ast.service];
  const unwrappedServices: ServiceBlock[] = [];
  for (const svc of rawServices) {
    const unwrapped = unwrapNormalizedServiceBlock(svc);
    if (unwrapped) unwrappedServices.push(unwrapped);
  }
  const fsService = unwrappedServices.find((svc) => svc.name === 'cloud.firestore');
  if (!fsService) return null;
  const ast: FirestoreRules = {
    ...fallback.ast,
    functions: (fallback.ast.functions ?? []).map(restoreFunctionSentinels),
    service: fsService,
    services: unwrappedServices,
  };
  return { source: effectiveSource, ast };
}

export function parseRulesAstWithMultiMatchOrError(
  source: string,
  options?: ParseRulesAstOptions,
): { ok: true; services: ParsedServiceMatches[] } | { ok: false; message: string } {
  const lowered = lowerModularRulesInMemoryOrError(source, options);
  if (!lowered.ok) return lowered;
  const effectiveSource = lowered.source;

  const direct = parseToASTOrError(effectiveSource);
  if (direct.ok) {
    return { ok: true, services: buildDirectServiceMatches(direct.ast) };
  }

  const normalized = normalizeMultiMatchSource(effectiveSource);
  const fallback = parseToASTOrError(normalized);
  if (fallback.ok) {
    return { ok: true, services: buildNormalizedServiceMatches(fallback.ast) };
  }

  const primary = direct.error;
  const secondary = fallback.error;
  const chosen =
    secondary.line > primary.line
    || (secondary.line === primary.line && secondary.column > primary.column)
      ? secondary
      : primary;
  return { ok: false, message: formatRulesParseFailure(chosen) };
}

export function validateRulesSourceSyntax(
  source: string,
  expectedService?: 'cloud.firestore' | 'firebase.storage',
  options?: ParseRulesAstOptions,
): { ok: true } | { ok: false; message: string } {
  const parsed = parseRulesAstWithMultiMatchOrError(source, options);
  if (!parsed.ok) return parsed;
  if (
    expectedService !== undefined
    && !parsed.services.some((svc) => svc.name === expectedService)
  ) {
    return {
      ok: false,
      message: `Missing 'service ${expectedService}' block.`,
    };
  }
  return { ok: true };
}

export function isHeaderOnlyRulesVersionStub(source: string): boolean {
  let cursor = skipHeaderTrivia(source, 0);
  if (!/^rules_version\b/.test(source.slice(cursor))) return false;
  cursor = skipHeaderTrivia(source, cursor + 'rules_version'.length);
  if (source[cursor] !== '=') return false;
  cursor = skipHeaderTrivia(source, cursor + 1);
  const str = /^(['"])([^'"]*)\1/.exec(source.slice(cursor));
  if (!str) return false;
  cursor = skipHeaderTrivia(source, cursor + str[0].length);
  if (source[cursor] !== ';') return false;
  cursor = skipHeaderTrivia(source, cursor + 1);
  return cursor === source.length;
}

export function parseRulesAstWithMultiMatch(
  source: string,
  options?: ParseRulesAstOptions,
): ParsedServiceMatches[] {
  const parsed = parseRulesAstWithMultiMatchOrError(source, options);
  return parsed.ok ? parsed.services : [];
}

function findScopedFunctionEntry(
  scope: RuleAstScope,
  name: string,
): { readonly fn: FunctionDef; readonly groupIndex: number } | undefined {
  for (let i = scope.functions.length - 1; i >= 0; i -= 1) {
    const found = scope.functions[i]?.find((fn) => fn.name === name);
    if (found) return { fn: found, groupIndex: i };
  }
  return undefined;
}

export function resolveRuleExpr(expr: Expression, scope: RuleAstScope): BoundRuleExpr {
  let cur: BoundRuleExpr = { expr, scope };
  for (let i = 0; i < 16; i += 1) {
    if (cur.expr.type === 'identifier') {
      const bound = cur.scope.vars.get(cur.expr.name);
      if (!bound) break;
      cur = bound;
      continue;
    }
    if (cur.expr.type === 'functionCall') {
      const inlined = inlineRuleCall(cur.expr, cur.scope);
      if (!inlined) break;
      cur = inlined;
      continue;
    }
    break;
  }
  return cur;
}

export function inlineRuleCall(
  call: Extract<Expression, { type: 'functionCall' }>,
  scope: RuleAstScope,
): BoundRuleExpr | undefined {
  if (scope.depth >= MAX_RULE_INLINE_DEPTH) return undefined;
  const entry = findScopedFunctionEntry(scope, call.name);
  if (!entry) return undefined;
  const { fn, groupIndex } = entry;
  const declaredScope = DECLARED_FUNCTION_SCOPES.get(fn);
  const calleeFunctions = declaredScope?.functions ?? scope.functions.slice(0, groupIndex + 1);
  const calleeWildcards = declaredScope?.wildcards ?? scope.wildcards;

  let currentVars = new Map<string, BoundRuleExpr>();
  fn.parameters.forEach((param, idx) => {
    const arg = call.args[idx];
    if (arg) {
      currentVars.set(param, { expr: arg, scope });
    } else {
      currentVars.set(param, { expr: { type: 'literal', value: null, raw: 'null' }, scope });
    }
  });
  for (const letBinding of fn.lets) {
    const letEvalScope: RuleAstScope = {
      vars: currentVars,
      functions: calleeFunctions,
      wildcards: calleeWildcards,
      depth: scope.depth + 1,
    };
    const nextVars = new Map(currentVars);
    nextVars.set(letBinding.name, { expr: letBinding.value, scope: letEvalScope });
    currentVars = nextVars;
  }
  const inner: RuleAstScope = {
    vars: currentVars,
    functions: calleeFunctions,
    wildcards: calleeWildcards,
    depth: scope.depth + 1,
  };
  return { expr: fn.body, scope: inner };
}

export function isRequestMemberChain(
  expr: Expression,
  scope: RuleAstScope,
  chain: readonly string[],
): boolean {
  let cur = resolveRuleExpr(expr, scope);
  for (let i = chain.length - 1; i > 0; i -= 1) {
    if (cur.expr.type !== 'memberAccess' || cur.expr.property !== chain[i]) return false;
    cur = resolveRuleExpr(cur.expr.object, cur.scope);
  }
  return (
    cur.expr.type === 'identifier'
    && cur.expr.name === chain[0]
    && !cur.scope.vars.has(chain[0]!)
  );
}

function isNullLiteral(expr: Expression, scope: RuleAstScope): boolean {
  const resolved = resolveRuleExpr(expr, scope).expr;
  return resolved.type === 'literal' && resolved.value === null;
}

function isEmptyStringLiteral(expr: Expression, scope: RuleAstScope): boolean {
  const resolved = resolveRuleExpr(expr, scope).expr;
  return resolved.type === 'literal' && resolved.value === '';
}

function isAuthPresenceTarget(expr: Expression, scope: RuleAstScope): boolean {
  return (
    isRequestMemberChain(expr, scope, ['request', 'auth'])
    || isRequestMemberChain(expr, scope, ['request', 'auth', 'uid'])
    || isRequestMemberChain(expr, scope, ['request', 'auth', 'token'])
  );
}

type GuardSummary = 'auth-only' | 'tautology' | 'impossible' | 'narrowed';

function combineConjunction(left: GuardSummary, right: GuardSummary): GuardSummary {
  if (left === 'impossible' || right === 'impossible') return 'impossible';
  if (left === 'narrowed' || right === 'narrowed') return 'narrowed';
  if (left === 'auth-only' || right === 'auth-only') return 'auth-only';
  return 'tautology';
}

export function summarizeRulesGuard(
  expr: Expression,
  scope: RuleAstScope,
  negated: boolean,
): GuardSummary {
  const resolved = resolveRuleExpr(expr, scope);
  const e = resolved.expr;
  const s = resolved.scope;

  if (e.type === 'literal' && typeof e.value === 'boolean') {
    let val = e.value;
    if (negated) val = !val;
    if (val) return 'tautology';
    return 'impossible';
  }

  if (e.type === 'unaryOp' && e.op === '!') {
    return summarizeRulesGuard(e.operand, s, !negated);
  }

  if (e.type === 'binaryOp') {
    if ((e.op === '&&' && !negated) || (e.op === '||' && negated)) {
      return combineConjunction(
        summarizeRulesGuard(e.left, s, negated),
        summarizeRulesGuard(e.right, s, negated),
      );
    }
    if ((e.op === '||' && !negated) || (e.op === '&&' && negated)) {
      const left = summarizeRulesGuard(e.left, s, negated);
      const right = summarizeRulesGuard(e.right, s, negated);
      if (left === 'auth-only' || right === 'auth-only') return 'auth-only';
      if (left === 'tautology' || right === 'tautology') return 'tautology';
      if (left === 'impossible' && right === 'impossible') return 'impossible';
      return 'narrowed';
    }
    if (e.op === '==' || e.op === '!=') {
      const leftRes = resolveRuleExpr(e.left, s).expr;
      const rightRes = resolveRuleExpr(e.right, s).expr;
      if (leftRes.type === 'literal' && typeof leftRes.value === 'boolean') {
        const flips = (e.op === '==' && !leftRes.value) || (e.op === '!=' && leftRes.value);
        let nextNeg = negated;
        if (flips) nextNeg = !negated;
        return summarizeRulesGuard(e.right, s, nextNeg);
      }
      if (rightRes.type === 'literal' && typeof rightRes.value === 'boolean') {
        const flips = (e.op === '==' && !rightRes.value) || (e.op === '!=' && rightRes.value);
        let nextNeg = negated;
        if (flips) nextNeg = !negated;
        return summarizeRulesGuard(e.left, s, nextNeg);
      }
      const assertsNotEqual = (e.op === '!=' && !negated) || (e.op === '==' && negated);
      if (assertsNotEqual) {
        if (isAuthPresenceTarget(e.left, s) && (isNullLiteral(e.right, s) || isEmptyStringLiteral(e.right, s))) {
          return 'auth-only';
        }
        if (isAuthPresenceTarget(e.right, s) && (isNullLiteral(e.left, s) || isEmptyStringLiteral(e.left, s))) {
          return 'auth-only';
        }
      }
      return 'narrowed';
    }
    return 'narrowed';
  }

  if (e.type === 'isExpr') {
    if (!negated && e.typeName === 'string' && isRequestMemberChain(e.value, s, ['request', 'auth', 'uid'])) {
      return 'auth-only';
    }
    return 'narrowed';
  }

  if (e.type === 'ternary') {
    const condTrue = combineConjunction(
      summarizeRulesGuard(e.condition, s, false),
      summarizeRulesGuard(e.consequent, s, negated),
    );
    const condFalse = combineConjunction(
      summarizeRulesGuard(e.condition, s, true),
      summarizeRulesGuard(e.alternate, s, negated),
    );
    if (condTrue === 'auth-only' || condFalse === 'auth-only') return 'auth-only';
    if (condTrue === 'tautology' || condFalse === 'tautology') return 'tautology';
    if (condTrue === 'impossible' && condFalse === 'impossible') return 'impossible';
    return 'narrowed';
  }

  if (e.type === 'functionCall') {
    const inlined = inlineRuleCall(e, s);
    if (!inlined) return 'narrowed';
    return summarizeRulesGuard(inlined.expr, inlined.scope, negated);
  }

  return 'narrowed';
}

export function isOverbroadAuthOnlyRulesExpr(expr: Expression, scope: RuleAstScope): boolean {
  return summarizeRulesGuard(expr, scope, false) === 'auth-only';
}

function isRtdbAuthTarget(t: RtdbExpressionTree): boolean {
  if (t.type === 'identifier' && t.name === 'auth') return true;
  if (t.type === 'member' && (t.property === 'uid' || t.property === 'token')) {
    return t.object.type === 'identifier' && t.object.name === 'auth';
  }
  return false;
}

function isRtdbNullOrEmpty(t: RtdbExpressionTree): boolean {
  if (t.type === 'null') return true;
  return t.type === 'string' && t.value === '';
}

export function summarizeRtdbGuard(t: RtdbExpressionTree, negated: boolean): GuardSummary {
  if (t.type === 'boolean') {
    let val = t.value;
    if (negated) val = !val;
    if (val) return 'tautology';
    return 'impossible';
  }
  if (t.type === 'unary' && t.operator === '!') {
    return summarizeRtdbGuard(t.argument, !negated);
  }
  if (t.type === 'binary') {
    if ((t.operator === '&&' && !negated) || (t.operator === '||' && negated)) {
      return combineConjunction(
        summarizeRtdbGuard(t.left, negated),
        summarizeRtdbGuard(t.right, negated),
      );
    }
    if ((t.operator === '||' && !negated) || (t.operator === '&&' && negated)) {
      const left = summarizeRtdbGuard(t.left, negated);
      const right = summarizeRtdbGuard(t.right, negated);
      if (left === 'auth-only' || right === 'auth-only') return 'auth-only';
      if (left === 'tautology' || right === 'tautology') return 'tautology';
      if (left === 'impossible' && right === 'impossible') return 'impossible';
      return 'narrowed';
    }
    const isEq = t.operator === '==' || t.operator === '===';
    const isNeq = t.operator === '!=' || t.operator === '!==';
    if (isEq || isNeq) {
      if (t.left.type === 'boolean') {
        const flips = (isEq && !t.left.value) || (isNeq && t.left.value);
        let nextNeg = negated;
        if (flips) nextNeg = !negated;
        return summarizeRtdbGuard(t.right, nextNeg);
      }
      if (t.right.type === 'boolean') {
        const flips = (isEq && !t.right.value) || (isNeq && t.right.value);
        let nextNeg = negated;
        if (flips) nextNeg = !negated;
        return summarizeRtdbGuard(t.left, nextNeg);
      }
      const assertsNotEqual = (isNeq && !negated) || (isEq && negated);
      if (assertsNotEqual) {
        if (isRtdbAuthTarget(t.left) && isRtdbNullOrEmpty(t.right)) return 'auth-only';
        if (isRtdbAuthTarget(t.right) && isRtdbNullOrEmpty(t.left)) return 'auth-only';
      }
      return 'narrowed';
    }
    return 'narrowed';
  }
  if (t.type === 'ternary') {
    const condTrue = combineConjunction(
      summarizeRtdbGuard(t.test, false),
      summarizeRtdbGuard(t.consequent, negated),
    );
    const condFalse = combineConjunction(
      summarizeRtdbGuard(t.test, true),
      summarizeRtdbGuard(t.alternate, negated),
    );
    if (condTrue === 'auth-only' || condFalse === 'auth-only') return 'auth-only';
    if (condTrue === 'tautology' || condFalse === 'tautology') return 'tautology';
    if (condTrue === 'impossible' && condFalse === 'impossible') return 'impossible';
    return 'narrowed';
  }
  return 'narrowed';
}

export function isOverbroadAuthOnlyRtdbExpr(t: RtdbExpressionTree): boolean {
  return summarizeRtdbGuard(t, false) === 'auth-only';
}

export type RelationalOp = '<' | '<=' | '>' | '>=';

export function isRelationalOp(op: string): op is RelationalOp {
  return op === '<' || op === '<=' || op === '>' || op === '>=';
}

export function flipRelationalSides(op: RelationalOp): RelationalOp {
  switch (op) {
    case '<':
      return '>';
    case '<=':
      return '>=';
    case '>':
      return '<';
    case '>=':
      return '<=';
  }
}

export function negateRelationalOp(op: RelationalOp): RelationalOp {
  switch (op) {
    case '<':
      return '>=';
    case '<=':
      return '>';
    case '>':
      return '<=';
    case '>=':
      return '<';
  }
}

export function satisfyingRelationalValue(op: RelationalOp, bound: number): number {
  switch (op) {
    case '>':
      return Number.isInteger(bound) ? bound + 1 : Math.floor(bound) + 1;
    case '>=':
      return bound;
    case '<':
      return Number.isInteger(bound) ? bound - 1 : Math.ceil(bound) - 1;
    case '<=':
      return bound;
  }
}

export interface TernaryBranchPlan {
  readonly conditionNegated?: boolean;
  readonly visitConsequent: boolean;
  readonly visitAlternate: boolean;
  readonly singleRoute: boolean;
}

export function classifyTernaryBranches(
  rawConsequentBool: boolean | undefined,
  rawAlternateBool: boolean | undefined,
  negated: boolean,
): TernaryBranchPlan {
  const effCons = rawConsequentBool === undefined ? undefined : (negated ? !rawConsequentBool : rawConsequentBool);
  const effAlt = rawAlternateBool === undefined ? undefined : (negated ? !rawAlternateBool : rawAlternateBool);
  if ((effCons === false && effAlt === false) || (effCons === true && effAlt === true)) {
    return { visitConsequent: false, visitAlternate: false, singleRoute: false };
  }
  if (effAlt === false) {
    return { conditionNegated: false, visitConsequent: true, visitAlternate: false, singleRoute: true };
  }
  if (effCons === false) {
    return { conditionNegated: true, visitConsequent: false, visitAlternate: true, singleRoute: true };
  }
  if (effCons === true) {
    return { conditionNegated: false, visitConsequent: false, visitAlternate: true, singleRoute: false };
  }
  if (effAlt === true) {
    return { conditionNegated: true, visitConsequent: true, visitAlternate: false, singleRoute: false };
  }
  return { conditionNegated: false, visitConsequent: true, visitAlternate: true, singleRoute: false };
}
