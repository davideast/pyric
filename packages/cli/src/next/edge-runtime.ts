/**
 * Detection of Next.js Edge runtime files. The Edge runtime has no Node.js
 * module loader, so the `@pyric/cli/register` interception that serves
 * firebase and firebase-admin in the sandbox does not run there.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SOURCE_ROOTS = ['app', 'pages', 'src/app', 'src/pages'];
const PROXY_FILES = ['proxy', 'src/proxy'];
const MIDDLEWARE_FILES = ['middleware', 'src/middleware'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', '.git']);

const EDGE_EXPORT =
  /export\s+(?:const|let|var)\s+runtime(?:\s*:[^=;]+)?\s*=\s*['"`](?:experimental-)?edge['"`]/;
const NODE_EXPORT =
  /export\s+(?:const|let|var)\s+runtime(?:\s*:[^=;]+)?\s*=\s*['"`]nodejs['"`]/;
const CONFIG_BLOCK_START =
  /export\s+(?:const|let|var)\s+config(?:\s*:[^={]+)?\s*=\s*\{/g;
const EDGE_CONFIG_PROP = /(?:^|[,{;\s])runtime\s*:\s*['"`](?:experimental-)?edge['"`]/;
const NODE_CONFIG_PROP = /(?:^|[,{;\s])runtime\s*:\s*['"`]nodejs['"`]/;

const RUNTIME_LITERAL_VALUES = new Set(['edge', 'experimental-edge', 'nodejs']);
const REGEX_PREFIX_CHARS = new Set([
  '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '~', '^', '%', '<', '>',
]);
const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'void', 'delete', 'in', 'instanceof', 'case', 'throw', 'yield', 'await',
]);

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
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

/**
 * Strip JS/TS line and block comments while keeping `'edge'`,
 * `'experimental-edge'`, and `'nodejs'` literals intact and neutralizing other
 * string, template, and regex literal contents so URLs (`https://...`), globs
 * (`/*`), or quoted code snippets never masquerade as comments or exports.
 */
function stripComments(source: string): string {
  let out = '';
  let canStartRegex = true;
  const templateBraceDepths: number[] = [];

  const scanTemplateChunk = (startIndex: number, allowRuntimeValue: boolean): number => {
    let raw = '';
    let i = startIndex;
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === '\\') {
        raw += ch;
        i++;
        if (i < source.length) raw += source[i]!;
        i++;
        continue;
      }
      if (ch === '`') {
        out += allowRuntimeValue && RUNTIME_LITERAL_VALUES.has(raw) ? `'${raw}'` : "''";
        canStartRegex = false;
        return i + 1;
      }
      if (ch === '$' && source[i + 1] === '{') {
        out += "''+(";
        templateBraceDepths.push(0);
        canStartRegex = true;
        return i + 2;
      }
      raw += ch;
      i++;
    }
    out += "''";
    canStartRegex = false;
    return i;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      out += ' ';
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      out += ' ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      if (i < source.length) i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let raw = '';
      i++;
      while (i < source.length) {
        const inner = source[i]!;
        if (inner === '\\') {
          raw += inner;
          i++;
          if (i < source.length) raw += source[i]!;
          i++;
          continue;
        }
        if (inner === quote || inner === '\n') {
          if (inner === quote) i++;
          break;
        }
        raw += inner;
        i++;
      }
      out += RUNTIME_LITERAL_VALUES.has(raw) ? `'${raw}'` : "''";
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
        out += '/ /';
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
      out += word;
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
          out += ')+';
          i = scanTemplateChunk(i + 1, false);
          continue;
        }
        templateBraceDepths[top]!--;
      }
    }
    out += ch;
    canStartRegex = REGEX_PREFIX_CHARS.has(ch) || ch === '/';
    i++;
  }
  return out;
}

function extractTopLevelConfigSurface(source: string, openBraceIndex: number): string {
  let depth = 0;
  let out = '';
  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      if (depth === 1) out += ch;
      i++;
      while (i < source.length) {
        const inner = source[i]!;
        if (depth === 1) out += inner;
        if (inner === '\\') {
          i++;
          if (i < source.length && depth === 1) out += source[i]!;
        } else if (inner === quote) {
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '{') {
      depth++;
      if (depth === 1) out += ch;
      else if (depth === 2) out += '{}';
      continue;
    }
    if (ch === '}') {
      if (depth === 1) {
        out += ch;
        return out;
      }
      depth--;
      continue;
    }
    if (depth === 1) out += ch;
  }
  return out;
}

function hasConfigProperty(source: string, pattern: RegExp): boolean {
  CONFIG_BLOCK_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONFIG_BLOCK_START.exec(source)) !== null) {
    const openBraceIndex = match.index + match[0].length - 1;
    const topLevel = extractTopLevelConfigSurface(source, openBraceIndex);
    if (pattern.test(topLevel)) return true;
  }
  return false;
}

function declaresEdgeRuntime(rawSource: string): boolean {
  const source = stripComments(rawSource);
  return EDGE_EXPORT.test(source) || hasConfigProperty(source, EDGE_CONFIG_PROP);
}

function declaresNodeRuntime(rawSource: string): boolean {
  const source = stripComments(rawSource);
  return NODE_EXPORT.test(source) || hasConfigProperty(source, NODE_CONFIG_PROP);
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
    try {
      if (declaresEdgeRuntime(readFileSync(file, 'utf8'))) {
        edgeFiles.push(toPosix(relative(projectRoot, file)));
      }
    } catch {
      // An unreadable file is not reported.
    }
  }

  for (const base of MIDDLEWARE_FILES) {
    for (const extension of SOURCE_EXTENSIONS) {
      const file = join(projectRoot, `${base}${extension}`);
      if (!existsSync(file)) continue;
      try {
        if (!declaresNodeRuntime(readFileSync(file, 'utf8'))) {
          edgeFiles.push(toPosix(relative(projectRoot, file)));
        }
      } catch {
        // An unreadable file is not reported.
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
