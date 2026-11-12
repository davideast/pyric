/**
 * Detection of Next.js Edge runtime files. The Edge runtime has no Node.js
 * module loader, so the `@pyric/cli/register` interception that serves
 * firebase and firebase-admin in the sandbox does not run there.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const SOURCE_ROOTS = ['app', 'pages', 'src/app', 'src/pages'];
const PROXY_FILES = ['proxy', 'src/proxy'];
const MIDDLEWARE_FILES = ['middleware', 'src/middleware'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', '.git']);

type RuntimeKind = 'edge' | 'nodejs';

interface Token {
  readonly kind: 'ident' | 'string' | 'punct';
  readonly value: string;
  readonly line: number;
}

interface ImportedBinding {
  readonly source: string;
  readonly importedName: string;
}

interface ParsedModuleRuntime {
  readonly localRuntime: Map<string, RuntimeKind>;
  readonly localConfigRuntime: Map<string, RuntimeKind>;
  readonly imports: Map<string, ImportedBinding>;
  readonly directExports: {
    runtime?: RuntimeKind;
    configRuntime?: RuntimeKind;
  };
  readonly namedExportRefs: Array<{ readonly localName: string; readonly exportedName: string }>;
  readonly reexports: Array<{ readonly source: string; readonly importedName: string; readonly exportedName: string }>;
  readonly starReexports: string[];
}

interface ResolvedModuleRuntime {
  readonly runtime?: RuntimeKind;
  readonly configRuntime?: RuntimeKind;
}

const REGEX_PREFIX_CHARS = new Set([
  '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '~', '^', '%', '<', '>',
]);
const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'void', 'delete', 'in', 'instanceof', 'case', 'throw', 'yield', 'await',
]);
const STATEMENT_BOUNDARY_KEYWORDS = new Set([
  'export', 'import', 'const', 'let', 'var', 'function', 'class', 'async', 'type', 'interface', 'enum', 'declare',
]);

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function toRuntimeKind(value: string | undefined): RuntimeKind | undefined {
  if (value === 'edge' || value === 'experimental-edge') return 'edge';
  if (value === 'nodejs') return 'nodejs';
  return undefined;
}

function scanRegexLiteralEnd(source: string, slashIndex: number): number {
  let inCharClass = false;
  for (let i = slashIndex + 1; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '\\') {
      i++;
      if (i >= source.length || source[i] === '\n' || source[i] === '\r') return -1;
      continue;
    }
    if (ch === '[' && !inCharClass) {
      inCharClass = true;
    } else if (ch === ']' && inCharClass) {
      inCharClass = false;
    } else if (ch === '/' && !inCharClass) {
      let end = i + 1;
      while (end < source.length && source[end]! >= 'a' && source[end]! <= 'z') end++;
      return end;
    }
  }
  return -1;
}

function tokenizeModule(source: string): Token[] {
  const tokens: Token[] = [];
  let canStartRegex = true;
  let line = 1;
  const templateBraceDepths: number[] = [];

  const scanTemplateChunk = (startIndex: number, isFirstChunk: boolean): number => {
    let raw = '';
    let i = startIndex;
    const chunkLine = line;
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === '\n') line++;
      if (ch === '\\') {
        i++;
        if (i < source.length) {
          if (source[i] === '\n') line++;
          raw += source[i]!;
        }
        i++;
        continue;
      }
      if (ch === '`') {
        if (isFirstChunk) {
          tokens.push({ kind: 'string', value: raw, line: chunkLine });
        } else {
          tokens.push({ kind: 'punct', value: '`)', line });
        }
        canStartRegex = false;
        return i + 1;
      }
      if (ch === '$' && source[i + 1] === '{') {
        tokens.push({ kind: 'punct', value: '(`', line: chunkLine });
        templateBraceDepths.push(0);
        canStartRegex = true;
        return i + 2;
      }
      raw += ch;
      i++;
    }
    tokens.push({ kind: 'string', value: raw, line: chunkLine });
    canStartRegex = false;
    return i;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      if (i < source.length) i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const startLine = line;
      let raw = '';
      i++;
      while (i < source.length) {
        const inner = source[i]!;
        if (inner === '\\') {
          i++;
          if (i < source.length) {
            if (source[i] === '\n') line++;
            raw += source[i]!;
          }
          i++;
          continue;
        }
        if (inner === quote || inner === '\n') {
          if (inner === '\n') line++;
          if (inner === quote) i++;
          break;
        }
        raw += inner;
        i++;
      }
      tokens.push({ kind: 'string', value: raw, line: startLine });
      canStartRegex = false;
      continue;
    }
    if (ch === '`') {
      i = scanTemplateChunk(i + 1, true);
      continue;
    }
    if (ch === '/' && canStartRegex) {
      const regexEnd = scanRegexLiteralEnd(source, i);
      if (regexEnd !== -1) {
        tokens.push({ kind: 'punct', value: '/regex/', line });
        canStartRegex = false;
        i = regexEnd;
        continue;
      }
    }
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < source.length && isIdentPart(source[i]!)) i++;
      const word = source.slice(start, i);
      tokens.push({ kind: 'ident', value: word, line });
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(word);
      continue;
    }
    if (templateBraceDepths.length > 0) {
      const top = templateBraceDepths.length - 1;
      if (ch === '{') {
        templateBraceDepths[top]!++;
      } else if (ch === '}') {
        if (templateBraceDepths[top] === 0) {
          templateBraceDepths.pop();
          i = scanTemplateChunk(i + 1, false);
          continue;
        }
        templateBraceDepths[top]!--;
      }
    }
    if (ch === '=' && source[i + 1] === '>') {
      tokens.push({ kind: 'punct', value: '=>', line });
      canStartRegex = true;
      i += 2;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...', line });
      canStartRegex = true;
      i += 3;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch, line });
    canStartRegex = REGEX_PREFIX_CHARS.has(ch) || ch === '/';
    i++;
  }
  return tokens;
}

function skipBalancedGroup(tokens: readonly Token[], start: number): number {
  const open = tokens[start]?.value;
  const close = open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : open === '<' ? '>' : null;
  if (close === null) return start + 1;
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const val = tokens[i]!.value;
    if (val === open) depth++;
    else if (val === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return tokens.length;
}

/**
 * Advance past a TypeScript variable type annotation (`: ...`) up to the
 * declarator's `=`, `,`, or `;` at top-level depth 0.
 */
function skipTypeAnnotation(tokens: readonly Token[], afterColon: number): number {
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  for (let i = afterColon; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind === 'punct') {
      const v = tok.value;
      if (brace === 0 && paren === 0 && bracket === 0 && angle === 0) {
        if (v === '=' || v === ',' || v === ';') {
          return i;
        }
      }
      if (v === '{') brace++;
      else if (v === '}' && brace > 0) brace--;
      else if (v === '(') paren++;
      else if (v === ')' && paren > 0) paren--;
      else if (v === '[') bracket++;
      else if (v === ']' && bracket > 0) bracket--;
      else if (v === '<') angle++;
      else if (v === '>' && angle > 0) angle--;
    }
  }
  return tokens.length;
}

/**
 * Find the end of a variable declarator's initializer expression at depth 0:
 * stops at `,`, `;`, or an ASI newline before a top-level statement keyword.
 */
function findInitializerEnd(tokens: readonly Token[], exprStart: number): number {
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  for (let i = exprStart; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind === 'punct') {
      const v = tok.value;
      if (brace === 0 && paren === 0 && bracket === 0) {
        if (v === ',' || v === ';') return i;
      }
      if (v === '{') brace++;
      else if (v === '}' && brace > 0) brace--;
      else if (v === '(') paren++;
      else if (v === ')' && paren > 0) paren--;
      else if (v === '[') bracket++;
      else if (v === ']' && bracket > 0) bracket--;
    } else if (
      brace === 0 &&
      paren === 0 &&
      bracket === 0 &&
      i > exprStart &&
      tok.kind === 'ident' &&
      STATEMENT_BOUNDARY_KEYWORDS.has(tok.value) &&
      tok.line > tokens[i - 1]!.line
    ) {
      const prev = tokens[i - 1]!;
      const isTsAssertionKeyword = tok.value === 'const' && prev.kind === 'ident' && prev.value === 'as';
      if (!isTsAssertionKeyword) {
        return i;
      }
    }
  }
  return tokens.length;
}

function unwrapLeadingParens(tokens: readonly Token[], start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (s < e && tokens[s]!.kind === 'punct' && tokens[s]!.value === '(') {
    const closeAfter = skipBalancedGroup(tokens, s);
    if (closeAfter <= e && tokens[closeAfter - 1]?.value === ')') {
      // Only unwrap if the parenthesized group spans up to optional `as` / `satisfies` suffix.
      const tail = tokens[closeAfter];
      if (closeAfter === e || (tail?.kind === 'ident' && (tail.value === 'as' || tail.value === 'satisfies'))) {
        s = s + 1;
        e = closeAfter - 1;
        continue;
      }
    }
    break;
  }
  return [s, e];
}

function extractConfigObjectRuntime(
  tokens: readonly Token[],
  openBrace: number,
  closeExclusive: number,
  localRuntime: ReadonlyMap<string, RuntimeKind>,
  localConfigRuntime: ReadonlyMap<string, RuntimeKind>,
): RuntimeKind | undefined {
  let found: RuntimeKind | undefined;
  let i = openBrace + 1;
  const limit = Math.min(closeExclusive - 1, tokens.length);
  while (i < limit) {
    const tok = tokens[i]!;
    if (tok.kind === 'punct' && tok.value === ',') {
      i++;
      continue;
    }
    if (tok.kind === 'punct' && tok.value === '...') {
      const spreadIdent = tokens[i + 1];
      if (spreadIdent?.kind === 'ident') {
        const inherited = localConfigRuntime.get(spreadIdent.value);
        if (inherited !== undefined) found = inherited;
      }
      i += 2;
      while (i < limit && !(tokens[i]!.kind === 'punct' && tokens[i]!.value === ',')) {
        const v = tokens[i]!.value;
        if (v === '{' || v === '(' || v === '[') i = skipBalancedGroup(tokens, i);
        else i++;
      }
      continue;
    }
    const isRuntimeKey =
      (tok.kind === 'ident' && tok.value === 'runtime') ||
      (tok.kind === 'string' && tok.value === 'runtime');
    if (isRuntimeKey) {
      const next = tokens[i + 1];
      if (next?.kind === 'punct' && next.value === ':') {
        const valTok = tokens[i + 2];
        if (valTok?.kind === 'string') {
          const rk = toRuntimeKind(valTok.value);
          if (rk !== undefined) found = rk;
        } else if (valTok?.kind === 'ident') {
          const rk = localRuntime.get(valTok.value);
          if (rk !== undefined) found = rk;
        }
      } else if (
        tok.kind === 'ident' &&
        (next === undefined || i + 1 >= limit || (next.kind === 'punct' && next.value === ','))
      ) {
        const rk = localRuntime.get('runtime');
        if (rk !== undefined) found = rk;
      }
    }
    // Skip to next top-level property comma inside this object literal.
    while (i < limit && !(tokens[i]!.kind === 'punct' && tokens[i]!.value === ',')) {
      const v = tokens[i]!.value;
      if (v === '{' || v === '(' || v === '[') i = skipBalancedGroup(tokens, i);
      else i++;
    }
  }
  return found;
}

function parseBindingList(
  tokens: readonly Token[],
  openBrace: number,
): { items: Array<{ left: string; right: string }>; nextIndex: number } {
  const items: Array<{ left: string; right: string }> = [];
  let i = openBrace + 1;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.kind === 'punct' && tok.value === '}') {
      return { items, nextIndex: i + 1 };
    }
    if (tok.kind === 'punct' && tok.value === ',') {
      i++;
      continue;
    }
    // Optional `type` modifier (`import { type Foo, runtime }` / `export { type Foo, runtime }`)
    if (
      tok.kind === 'ident' &&
      tok.value === 'type' &&
      tokens[i + 1] !== undefined &&
      (tokens[i + 1]!.kind === 'ident' || tokens[i + 1]!.kind === 'string') &&
      !(tokens[i + 1]!.kind === 'ident' && tokens[i + 1]!.value === 'as') &&
      !(tokens[i + 1]!.kind === 'punct' && (tokens[i + 1]!.value === ',' || tokens[i + 1]!.value === '}'))
    ) {
      // Skip type-only specifier until `,` or `}`.
      while (i < tokens.length && !(tokens[i]!.kind === 'punct' && (tokens[i]!.value === ',' || tokens[i]!.value === '}'))) {
        i++;
      }
      continue;
    }
    if (tok.kind === 'ident' || tok.kind === 'string') {
      const left = tok.value;
      let right = left;
      i++;
      if (tokens[i]?.kind === 'ident' && tokens[i]!.value === 'as') {
        i++;
        if (tokens[i]?.kind === 'ident' || tokens[i]?.kind === 'string') {
          right = tokens[i]!.value;
          i++;
        }
      }
      items.push({ left, right });
      continue;
    }
    i++;
  }
  return { items, nextIndex: tokens.length };
}

function parseModuleRuntime(rawSource: string): ParsedModuleRuntime {
  const tokens = tokenizeModule(rawSource);
  const localRuntime = new Map<string, RuntimeKind>();
  const localConfigRuntime = new Map<string, RuntimeKind>();
  const imports = new Map<string, ImportedBinding>();
  const directExports: { runtime?: RuntimeKind; configRuntime?: RuntimeKind } = {};
  const namedExportRefs: Array<{ localName: string; exportedName: string }> = [];
  const reexports: Array<{ source: string; importedName: string; exportedName: string }> = [];
  const starReexports: string[] = [];

  const parseVarDeclarators = (startIndex: number, isExported: boolean): number => {
    let i = startIndex;
    while (i < tokens.length) {
      const tok = tokens[i]!;
      let varName: string | null = null;
      if (tok.kind === 'ident') {
        varName = tok.value;
        i++;
      } else if (tok.kind === 'punct' && (tok.value === '{' || tok.value === '[')) {
        i = skipBalancedGroup(tokens, i);
      } else {
        break;
      }

      if (tokens[i]?.kind === 'punct' && tokens[i]!.value === '!') {
        i++;
      }
      if (tokens[i]?.kind === 'punct' && tokens[i]!.value === ':') {
        i = skipTypeAnnotation(tokens, i + 1);
      }

      if (tokens[i]?.kind === 'punct' && tokens[i]!.value === '=') {
        const exprStart = i + 1;
        const exprEnd = findInitializerEnd(tokens, exprStart);
        if (varName !== null && exprStart < exprEnd) {
          const [s, e] = unwrapLeadingParens(tokens, exprStart, exprEnd);
          const first = tokens[s];
          if (first?.kind === 'string') {
            const rk = toRuntimeKind(first.value);
            if (rk !== undefined) {
              localRuntime.set(varName, rk);
              if (isExported && varName === 'runtime') directExports.runtime = rk;
            }
          } else if (first?.kind === 'ident') {
            const rk = localRuntime.get(first.value);
            if (rk !== undefined) {
              localRuntime.set(varName, rk);
              if (isExported && varName === 'runtime') directExports.runtime = rk;
            }
            const ck = localConfigRuntime.get(first.value);
            if (ck !== undefined) {
              localConfigRuntime.set(varName, ck);
              if (isExported && varName === 'config') directExports.configRuntime = ck;
            }
          } else if (first?.kind === 'punct' && first.value === '{') {
            const closeObj = skipBalancedGroup(tokens, s);
            const ck = extractConfigObjectRuntime(tokens, s, Math.min(closeObj, e), localRuntime, localConfigRuntime);
            if (ck !== undefined) {
              localConfigRuntime.set(varName, ck);
              if (isExported && varName === 'config') directExports.configRuntime = ck;
            }
          }
        }
        i = exprEnd;
      }

      if (tokens[i]?.kind === 'punct' && tokens[i]!.value === ',') {
        i++;
        continue;
      }
      if (tokens[i]?.kind === 'punct' && tokens[i]!.value === ';') {
        i++;
      }
      break;
    }
    return i;
  };

  let i = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      if (tok.kind === 'ident' && (tok.value === 'const' || tok.value === 'let' || tok.value === 'var')) {
        i = parseVarDeclarators(i + 1, false);
        continue;
      }
      if (tok.kind === 'ident' && tok.value === 'import') {
        i++;
        if (tokens[i]?.kind === 'ident' && tokens[i]!.value === 'type') {
          while (i < tokens.length && !(tokens[i]!.kind === 'punct' && tokens[i]!.value === ';')) {
            if (tokens[i]!.kind === 'string' && tokens[i - 1]?.value === 'from') {
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        // Optional default import before `{ ... }` (`import def, { runtime } from './x'`).
        if (tokens[i]?.kind === 'ident' && tokens[i + 1]?.value === ',') {
          i += 2;
        }
        if (tokens[i]?.kind === 'punct' && tokens[i]!.value === '{') {
          const { items, nextIndex } = parseBindingList(tokens, i);
          i = nextIndex;
          if (tokens[i]?.kind === 'ident' && tokens[i]!.value === 'from' && tokens[i + 1]?.kind === 'string') {
            const fromSource = tokens[i + 1]!.value;
            for (const item of items) {
              imports.set(item.right, { source: fromSource, importedName: item.left });
            }
            i += 2;
          }
        }
        continue;
      }
      if (tok.kind === 'ident' && tok.value === 'export') {
        i++;
        if (tokens[i]?.kind === 'ident' && tokens[i]!.value === 'type') {
          // `export type ...` has no runtime effect.
          if (tokens[i + 1]?.kind === 'punct' && tokens[i + 1]!.value === '{') {
            i = skipBalancedGroup(tokens, i + 1);
          } else {
            i++;
          }
          continue;
        }
        if (tokens[i]?.kind === 'ident' && (tokens[i]!.value === 'const' || tokens[i]!.value === 'let' || tokens[i]!.value === 'var')) {
          i = parseVarDeclarators(i + 1, true);
          continue;
        }
        if (tokens[i]?.kind === 'punct' && tokens[i]!.value === '*') {
          i++;
          if (tokens[i]?.kind === 'ident' && tokens[i]!.value === 'as' && tokens[i + 1]?.kind === 'ident') {
            // `export * as config from './mod'`
            const nsName = tokens[i + 1]!.value;
            i += 2;
            if (tokens[i]?.kind === 'ident' && tokens[i]!.value === 'from' && tokens[i + 1]?.kind === 'string') {
              if (nsName === 'config') {
                reexports.push({ source: tokens[i + 1]!.value, importedName: 'runtime', exportedName: 'config' });
              }
              i += 2;
            }
            continue;
          }
          if (tokens[i]?.kind === 'ident' && tokens[i]!.value === 'from' && tokens[i + 1]?.kind === 'string') {
            starReexports.push(tokens[i + 1]!.value);
            i += 2;
          }
          continue;
        }
        if (tokens[i]?.kind === 'punct' && tokens[i]!.value === '{') {
          const { items, nextIndex } = parseBindingList(tokens, i);
          i = nextIndex;
          if (tokens[i]?.kind === 'ident' && tokens[i]!.value === 'from' && tokens[i + 1]?.kind === 'string') {
            const fromSource = tokens[i + 1]!.value;
            for (const item of items) {
              reexports.push({
                source: fromSource,
                importedName: item.left,
                exportedName: item.right,
              });
            }
            i += 2;
          } else {
            for (const item of items) {
              namedExportRefs.push({ localName: item.left, exportedName: item.right });
            }
          }
          continue;
        }
        continue;
      }
    }

    if (tok.kind === 'punct') {
      if (tok.value === '{') braceDepth++;
      else if (tok.value === '}' && braceDepth > 0) braceDepth--;
      else if (tok.value === '(') parenDepth++;
      else if (tok.value === ')' && parenDepth > 0) parenDepth--;
      else if (tok.value === '[') bracketDepth++;
      else if (tok.value === ']' && bracketDepth > 0) bracketDepth--;
    }
    i++;
  }

  return {
    localRuntime,
    localConfigRuntime,
    imports,
    directExports,
    namedExportRefs,
    reexports,
    starReexports,
  };
}

function resolveRelativeSourceFile(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return null;
  }
  const baseTarget = resolve(dirname(fromFile), specifier);
  const candidates: string[] = [baseTarget];
  const strippedJs = baseTarget.replace(/\.[cm]?jsx?$/, '');
  for (const ext of SOURCE_EXTENSIONS) {
    candidates.push(`${baseTarget}${ext}`);
    if (strippedJs !== baseTarget) {
      candidates.push(`${strippedJs}${ext}`);
    }
  }
  for (const ext of SOURCE_EXTENSIONS) {
    candidates.push(join(baseTarget, `index${ext}`));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return realpathSync(candidate);
      }
    } catch {
      // Ignore broken links or unreadable paths.
    }
  }
  return null;
}

function createModuleRuntimeResolver(): (file: string) => ResolvedModuleRuntime {
  const parsedMemo = new Map<string, ParsedModuleRuntime | null>();
  const resolvedMemo = new Map<string, ResolvedModuleRuntime>();

  const getParsed = (realFile: string): ParsedModuleRuntime | null => {
    if (parsedMemo.has(realFile)) return parsedMemo.get(realFile)!;
    try {
      const parsed = parseModuleRuntime(readFileSync(realFile, 'utf8'));
      parsedMemo.set(realFile, parsed);
      return parsed;
    } catch {
      parsedMemo.set(realFile, null);
      return null;
    }
  };

  const resolveBindingFromModule = (
    targetFile: string,
    exportedName: string,
    kind: 'runtime' | 'config',
    visited: Set<string>,
  ): RuntimeKind | undefined => {
    const mod = resolveModule(targetFile, visited);
    if (exportedName === 'runtime' && kind === 'runtime') return mod.runtime;
    if (exportedName === 'config' && kind === 'config') return mod.configRuntime;
    const parsed = getParsed(targetFile);
    if (parsed === null) return undefined;
    for (const ref of parsed.namedExportRefs) {
      if (ref.exportedName !== exportedName) continue;
      if (kind === 'runtime') {
        const local = parsed.localRuntime.get(ref.localName);
        if (local !== undefined) return local;
      } else {
        const local = parsed.localConfigRuntime.get(ref.localName);
        if (local !== undefined) return local;
      }
    }
    return kind === 'runtime' ? parsed.localRuntime.get(exportedName) : parsed.localConfigRuntime.get(exportedName);
  };

  const resolveModule = (file: string, visited: Set<string>): ResolvedModuleRuntime => {
    let realFile = file;
    try {
      realFile = realpathSync(file);
    } catch {
      // Keep original path if realpath fails.
    }
    const cached = resolvedMemo.get(realFile);
    if (cached !== undefined) return cached;
    if (visited.has(realFile)) return {};

    const parsed = getParsed(realFile);
    if (parsed === null) return {};

    const nextVisited = new Set(visited);
    nextVisited.add(realFile);

    let runtime: RuntimeKind | undefined = parsed.directExports.runtime;
    let configRuntime: RuntimeKind | undefined = parsed.directExports.configRuntime;

    for (const ref of parsed.namedExportRefs) {
      if (ref.exportedName === 'runtime') {
        const local = parsed.localRuntime.get(ref.localName);
        if (local !== undefined) {
          runtime = local;
          continue;
        }
        const imported = parsed.imports.get(ref.localName);
        if (imported !== undefined) {
          const target = resolveRelativeSourceFile(realFile, imported.source);
          if (target !== null) {
            const resolved = resolveBindingFromModule(target, imported.importedName, 'runtime', nextVisited);
            if (resolved !== undefined) runtime = resolved;
          }
        }
      } else if (ref.exportedName === 'config') {
        const local = parsed.localConfigRuntime.get(ref.localName);
        if (local !== undefined) {
          configRuntime = local;
          continue;
        }
        const imported = parsed.imports.get(ref.localName);
        if (imported !== undefined) {
          const target = resolveRelativeSourceFile(realFile, imported.source);
          if (target !== null) {
            const resolved = resolveBindingFromModule(target, imported.importedName, 'config', nextVisited);
            if (resolved !== undefined) configRuntime = resolved;
          }
        }
      }
    }

    for (const reexport of parsed.reexports) {
      if (reexport.exportedName !== 'runtime' && reexport.exportedName !== 'config') continue;
      const target = resolveRelativeSourceFile(realFile, reexport.source);
      if (target === null) continue;
      if (reexport.exportedName === 'runtime') {
        const resolved = resolveBindingFromModule(target, reexport.importedName, 'runtime', nextVisited);
        if (resolved !== undefined) runtime = resolved;
      } else {
        const resolved = resolveBindingFromModule(target, reexport.importedName, 'config', nextVisited);
        if (resolved !== undefined) configRuntime = resolved;
      }
    }

    for (const starSource of parsed.starReexports) {
      if (runtime !== undefined && configRuntime !== undefined) break;
      const target = resolveRelativeSourceFile(realFile, starSource);
      if (target === null) continue;
      const starResolved = resolveModule(target, nextVisited);
      if (runtime === undefined && starResolved.runtime !== undefined) {
        runtime = starResolved.runtime;
      }
      if (configRuntime === undefined && starResolved.configRuntime !== undefined) {
        configRuntime = starResolved.configRuntime;
      }
    }

    const out: ResolvedModuleRuntime = { runtime, configRuntime };
    if (visited.size === 0) {
      resolvedMemo.set(realFile, out);
    }
    return out;
  };

  return (file: string) => resolveModule(file, new Set());
}

function isEdgeModuleRuntime(resolved: ResolvedModuleRuntime): boolean {
  if (resolved.runtime !== undefined) return resolved.runtime === 'edge';
  return resolved.configRuntime === 'edge';
}

function isNodeModuleRuntime(resolved: ResolvedModuleRuntime): boolean {
  if (resolved.runtime !== undefined) return resolved.runtime === 'nodejs';
  return resolved.configRuntime === 'nodejs';
}

function hasSourceExtension(name: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function collectSourceFiles(directory: string, found: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const full = join(directory, name);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) {
      collectSourceFiles(full, found);
    } else if (hasSourceExtension(name)) {
      found.push(full);
    }
  }
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/**
 * List the project files that run on the Next.js Edge runtime, as paths
 * relative to `projectRoot`: route/page/proxy files that declare
 * `export const runtime = 'edge'` or `export const config = { runtime: 'edge' }`,
 * and `middleware` / `src/middleware` files unless they opt into Node via
 * `export const runtime = 'nodejs'` or `export const config = { runtime: 'nodejs' }`.
 */
export function findEdgeRuntimeFiles(projectRoot: string): string[] {
  if (!existsSync(projectRoot)) {
    return [];
  }
  const edgeFiles: string[] = [];
  const resolveRuntime = createModuleRuntimeResolver();

  const sources: string[] = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    collectSourceFiles(join(projectRoot, sourceRoot), sources);
  }
  for (const base of PROXY_FILES) {
    for (const extension of SOURCE_EXTENSIONS) {
      const file = join(projectRoot, `${base}${extension}`);
      if (existsSync(file)) sources.push(file);
    }
  }
  for (const file of sources) {
    if (isEdgeModuleRuntime(resolveRuntime(file))) {
      edgeFiles.push(toPosix(relative(projectRoot, file)));
    }
  }

  for (const base of MIDDLEWARE_FILES) {
    for (const extension of SOURCE_EXTENSIONS) {
      const file = join(projectRoot, `${base}${extension}`);
      if (!existsSync(file)) continue;
      let readable = true;
      try {
        readFileSync(file, 'utf8');
      } catch {
        readable = false;
      }
      if (!readable) continue;
      if (!isNodeModuleRuntime(resolveRuntime(file))) {
        edgeFiles.push(toPosix(relative(projectRoot, file)));
      }
    }
  }

  return edgeFiles;
}

const EDGE_RUNTIME_UNSUPPORTED_CODE = 'PYRIC_EDGE_RUNTIME_UNSUPPORTED';

/** Build the startup warning for the given Edge files, or null when there are none. */
function formatEdgeRuntimeWarning(edgeFiles: string[]): string | null {
  if (edgeFiles.length === 0) {
    return null;
  }
  const list = edgeFiles.map((file) => `  ${file}`).join('\n');
  return (
    '[Pyric] These files run on the Next.js Edge runtime, where the Pyric sandbox does not apply:\n' +
    `${list}\n` +
    'The Edge runtime has no Node.js module loader, so firebase and firebase-admin imports there reach production Firebase.\n' +
    "Move the file to the Node.js runtime (`export const runtime = 'nodejs'`) to use the sandbox."
  );
}

/** Build the stop message for the given Edge files, or null when there are none. */
function formatEdgeRuntimeStop(edgeFiles: string[]): string | null {
  if (edgeFiles.length === 0) {
    return null;
  }
  const list = edgeFiles.map((file) => `  ${file}`).join('\n');
  return (
    '[Pyric] Next.js Edge runtime is not supported in the Pyric sandbox:\n' +
    `${list}\n` +
    'The Edge runtime has no Node.js module.registerHooks, so firebase and firebase-admin imports cannot be swapped or stopped and would reach live Firebase.\n' +
    "Set `export const runtime = 'nodejs'` (or `export const config = { runtime: 'nodejs' }` in middleware), or set `PYRIC_ALLOW_UNSWAPPED_EDGE=1` to bypass this stop at your own risk.\n" +
    `code: ${EDGE_RUNTIME_UNSUPPORTED_CODE}`
  );
}

/**
 * Refuse Next.js Edge runtime files in sandbox dev mode unless explicitly
 * bypassed with `PYRIC_ALLOW_UNSWAPPED_EDGE=1`.
 */
export function enforceNoEdgeRuntime(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): void {
  const edgeFiles = findEdgeRuntimeFiles(projectRoot);
  if (edgeFiles.length === 0) {
    return;
  }
  if (env.PYRIC_ALLOW_UNSWAPPED_EDGE === '1') {
    warn(formatEdgeRuntimeWarning(edgeFiles)!);
    return;
  }
  const error = new Error(formatEdgeRuntimeStop(edgeFiles)!) as Error & { code: string };
  error.code = EDGE_RUNTIME_UNSUPPORTED_CODE;
  throw error;
}
