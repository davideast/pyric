/**
 * Translation of `firebase.json` Hosting function rewrites and emulator-path
 * Functions routes into Next.js `path-to-regexp` rewrite rules.
 */
import { Minimatch } from 'minimatch';
import { hostingRewrites } from '../functions/http/rewrites.js';

export interface NextRewriteRule {
  source: string;
  destination: string;
  basePath?: false;
  locale?: false;
}

export interface TranslatedHostingRewrites {
  afterFiles: NextRewriteRule[];
  fallback: NextRewriteRule[];
}

interface RawHostingRewrite {
  source?: unknown;
  regex?: unknown;
  function?: unknown;
  region?: unknown;
}

const MAX_BRACE_EXPANSIONS = 16;
const SAFE_PROJECT_ID_RE = /^[a-zA-Z0-9._-]+$/;
const CATCHALL_PROBE_PATH = '/__pyric_hosting_catchall_probe__/nested';
const UNICODE_PROPERTY_ESCAPE_RE = /(?<!\\)(?:\\\\)*\\[pP]\{/;

function makeRule(source: string, destination: string, hasI18n: boolean): NextRewriteRule {
  return {
    source,
    destination,
    basePath: false,
    ...(hasI18n ? { locale: false as const } : {}),
  };
}

function hasFunctionTarget(rewrite: RawHostingRewrite): boolean {
  if (typeof rewrite.function === 'string' && rewrite.function.length > 0) {
    return true;
  }
  if (typeof rewrite.function === 'object' && rewrite.function !== null) {
    const candidate = rewrite.function as { functionId?: unknown };
    return typeof candidate.functionId === 'string' && candidate.functionId.length > 0;
  }
  return false;
}

function isUnconditionalCatchAll(rewrite: RawHostingRewrite): boolean {
  if (typeof rewrite.source === 'string') {
    return rewrite.source === '**' || rewrite.source === '/**';
  }
  if (typeof rewrite.regex === 'string') {
    try {
      const compiled = new RegExp(rewrite.regex, 'u');
      return compiled.test('/') && compiled.test(CATCHALL_PROBE_PATH);
    } catch {
      return false;
    }
  }
  return false;
}

function findTopLevelBrace(pattern: string): { start: number; end: number; options: string[] } | null {
  let depth = 0;
  let start = -1;
  const parts: string[] = [];
  let partStart = -1;

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) {
        start = i;
        partStart = i + 1;
      }
      depth += 1;
    } else if (ch === ',' && depth === 1) {
      parts.push(pattern.slice(partStart, i));
      partStart = i + 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        parts.push(pattern.slice(partStart, i));
        return parts.length > 1 ? { start, end: i, options: parts } : null;
      }
    }
  }
  return null;
}

function expandBraces(pattern: string): string[] {
  let current = [pattern];
  for (let round = 0; round < 4; round += 1) {
    const next: string[] = [];
    let expandedAny = false;
    for (const item of current) {
      const brace = findTopLevelBrace(item);
      if (brace === null) {
        next.push(item);
        continue;
      }
      expandedAny = true;
      const prefix = item.slice(0, brace.start);
      const suffix = item.slice(brace.end + 1);
      for (const option of brace.options) {
        next.push(`${prefix}${option}${suffix}`);
        if (next.length >= MAX_BRACE_EXPANSIONS) {
          return next;
        }
      }
    }
    current = next;
    if (!expandedAny) break;
  }
  return current;
}

const PATH_TO_REGEXP_META_RE = /[\\():+*?]/;

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
}

function globSegmentToRegex(segment: string): string {
  let out = '';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === '\\' && i + 1 < segment.length) {
      out += escapeRegexLiteral(segment[i + 1]!);
      i += 1;
      continue;
    }
    if (ch === '*') {
      while (segment[i + 1] === '*') i += 1;
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (ch === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close !== -1) {
        let content = segment.slice(i + 1, close);
        if (content.startsWith('!')) {
          content = `^${content.slice(1)}`;
        }
        content = content.replace(/(?<!\\)([()])/g, '\\$1');
        out += `[${content}]`;
        i = close;
        continue;
      }
    }
    out += escapeRegexLiteral(ch!);
  }
  return out;
}

function translateGlobPattern(
  glob: string,
  targetUrl: string,
  hasI18n: boolean,
): { bucket: 'afterFiles' | 'fallback'; rule: NextRewriteRule } | null {
  if (glob === '**' || glob === '/**') {
    return { bucket: 'fallback', rule: makeRule('/:path*', `${targetUrl}/:path*`, hasI18n) };
  }
  if (!glob.startsWith('/')) {
    return null;
  }

  const collapsed = glob.replace(/\/+/g, '/');
  if (collapsed === '/') {
    return { bucket: 'afterFiles', rule: makeRule('/', `${targetUrl}/`, hasI18n) };
  }
  const trimmed = collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
  const segments = trimmed.slice(1).split('/');
  const sourceParts: string[] = [];
  const destParts: string[] = [];
  let paramIndex = 0;
  let usedPathParam = false;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    if (seg === '**') {
      const name = isLast && !usedPathParam ? 'path' : `glob${paramIndex++}`;
      if (name === 'path') usedPathParam = true;
      sourceParts.push(`:${name}*`);
      destParts.push(`:${name}*`);
    } else if (seg === '*') {
      const name = `seg${paramIndex++}`;
      sourceParts.push(`:${name}`);
      destParts.push(`:${name}`);
    } else if (/[*?[\]]/.test(seg)) {
      const name = `seg${paramIndex++}`;
      const regexBody = globSegmentToRegex(seg);
      sourceParts.push(`:${name}(${regexBody})`);
      destParts.push(`:${name}`);
    } else if (PATH_TO_REGEXP_META_RE.test(seg)) {
      // Parameterize literal segments containing path-to-regexp metacharacters
      // (such as `:` or `(` / `)`) so Next.js prepareDestination never mistakes
      // them for destination parameter references or unnamed groups.
      const name = `seg${paramIndex++}`;
      sourceParts.push(`:${name}(${escapeRegexLiteral(seg)})`);
      destParts.push(`:${name}`);
    } else {
      sourceParts.push(seg);
      destParts.push(seg);
    }
  }

  const source = `/${sourceParts.join('/')}`;
  const destination = `${targetUrl}/${destParts.join('/')}`;
  return { bucket: 'afterFiles', rule: makeRule(source, destination, hasI18n) };
}

/**
 * Rewrite a JavaScript regex body so Next.js's `path-to-regexp` lexer accepts
 * it: convert capturing groups `(...)` and named capturing groups `(?<name>...)`
 * to non-capturing `(?:...)`, and escape bare `(` / `)` inside `[...]` classes
 * because `path-to-regexp` scans parentheses without tracking character classes.
 */
function sanitizeRegexForPathToRegexp(body: string): string {
  let out = '';
  let inCharClass = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) {
      out += ch + body[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === '[' && !inCharClass) {
      inCharClass = true;
      out += ch;
      continue;
    }
    if (ch === ']' && inCharClass) {
      inCharClass = false;
      out += ch;
      continue;
    }
    if (inCharClass) {
      if (ch === '(' || ch === ')') {
        out += `\\${ch}`;
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '(') {
      if (body[i + 1] !== '?') {
        out += '(?:';
        continue;
      }
      if (body[i + 2] === '<' && body[i + 3] !== '=' && body[i + 3] !== '!') {
        const nameEnd = body.indexOf('>', i + 3);
        if (nameEnd !== -1) {
          out += '(?:';
          i = nameEnd;
          continue;
        }
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Strip a leading `/` (or `\/`) from each branch of a leading top-level
 * non-capturing alternation such as `(?:/api|/v2)/.*` -> `(?:api|v2)/.*`.
 * Returns `null` if the group is not an all-slash-prefixed leading alternation.
 */
function stripLeadingSlashFromAlternation(body: string): string | null {
  if (!body.startsWith('(?:')) return null;
  let depth = 0;
  let inCharClass = false;
  const branchSplits: number[] = [];
  let closeIndex = -1;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[' && !inCharClass) {
      inCharClass = true;
      continue;
    }
    if (ch === ']' && inCharClass) {
      inCharClass = false;
      continue;
    }
    if (inCharClass) continue;
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    } else if (ch === '|' && depth === 1) {
      branchSplits.push(i);
    }
  }
  if (closeIndex === -1) return null;
  const inner = body.slice(3, closeIndex);
  const branches: string[] = [];
  let start = 3;
  for (const splitAt of branchSplits) {
    branches.push(body.slice(start, splitAt));
    start = splitAt + 1;
  }
  branches.push(body.slice(start, closeIndex));
  if (branches.length === 0 || inner.length === 0) return null;

  const stripped: string[] = [];
  for (const branch of branches) {
    if (branch.startsWith('\\/')) {
      stripped.push(branch.slice(2));
    } else if (branch.startsWith('/')) {
      stripped.push(branch.slice(1));
    } else {
      return null;
    }
  }
  return `(?:${stripped.join('|')})${body.slice(closeIndex + 1)}`;
}

const LEADING_QUANTIFIER_RE = /^[?*+{]/;

function stripLeadingSlashFromRegexBody(body: string, anchoredStart: boolean): { ok: true; body: string } | { ok: false } {
  if (body.startsWith('\\/?')) {
    return { ok: true, body: body.slice(3) };
  }
  if (body.startsWith('/?')) {
    return { ok: true, body: body.slice(2) };
  }
  if (body.startsWith('\\/')) {
    const rest = body.slice(2);
    return LEADING_QUANTIFIER_RE.test(rest) ? { ok: false } : { ok: true, body: rest };
  }
  if (body.startsWith('/')) {
    const rest = body.slice(1);
    return LEADING_QUANTIFIER_RE.test(rest) ? { ok: false } : { ok: true, body: rest };
  }
  const altStripped = stripLeadingSlashFromAlternation(body);
  if (altStripped !== null) {
    return { ok: true, body: altStripped };
  }
  if (!anchoredStart) {
    return { ok: true, body: `(?:.*/)?${body}` };
  }
  return { ok: false };
}

function extractLeadingLiteralPrefix(rawRegex: string): string | null {
  const match = /^\^\\?\/\??(.*)$/.exec(rawRegex);
  if (match === null) return null;
  const withoutAnchor = match[1]!;
  const literalSegments: string[] = [];
  for (const seg of withoutAnchor.split('/')) {
    if (seg.length === 0 || /[^a-zA-Z0-9._-]/.test(seg)) {
      break;
    }
    literalSegments.push(seg);
  }
  return literalSegments.length > 0 ? `/${literalSegments.join('/')}` : null;
}

function fallbackForUnrepresentableRegex(
  rawRegex: string,
  targetUrl: string,
  hasI18n: boolean,
  onWarning?: (warning: string) => void,
  index?: number,
): { bucket: 'afterFiles' | 'fallback'; rule: NextRewriteRule } | null {
  const prefix = extractLeadingLiteralPrefix(rawRegex);
  if (prefix !== null) {
    return {
      bucket: 'afterFiles',
      rule: makeRule(`${prefix}/:path*`, `${targetUrl}${prefix}/:path*`, hasI18n),
    };
  }
  onWarning?.(
    `firebase.json hosting.rewrites[${index ?? 0}] (${JSON.stringify(rawRegex)}) could not be represented as a Next.js rewrite and was skipped.`,
  );
  return null;
}

function translateRegexPattern(
  rawRegex: string,
  targetUrl: string,
  hasI18n: boolean,
  onWarning?: (warning: string) => void,
  index?: number,
): { bucket: 'afterFiles' | 'fallback'; rule: NextRewriteRule } | null {
  let compiled: RegExp;
  try {
    compiled = new RegExp(rawRegex, 'u');
  } catch (error) {
    onWarning?.(
      `firebase.json hosting.rewrites[${index ?? 0}] (${JSON.stringify(rawRegex)}) is skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  if (compiled.test('/') && compiled.test(CATCHALL_PROBE_PATH)) {
    return { bucket: 'fallback', rule: makeRule('/:path*', `${targetUrl}/:path*`, hasI18n) };
  }

  if (UNICODE_PROPERTY_ESCAPE_RE.test(rawRegex)) {
    const prefix = extractLeadingLiteralPrefix(rawRegex);
    if (prefix !== null) {
      return {
        bucket: 'afterFiles',
        rule: makeRule(`${prefix}/:path*`, `${targetUrl}${prefix}/:path*`, hasI18n),
      };
    }
    return { bucket: 'fallback', rule: makeRule('/:path*', `${targetUrl}/:path*`, hasI18n) };
  }

  const anchoredStart = rawRegex.startsWith('^');
  const anchoredEnd = rawRegex.endsWith('$') && !rawRegex.endsWith('\\$');
  let rawBody = rawRegex;
  if (anchoredStart) rawBody = rawBody.slice(1);
  if (anchoredEnd) rawBody = rawBody.slice(0, -1);

  const sanitizedRaw = sanitizeRegexForPathToRegexp(rawBody);
  const stripped = stripLeadingSlashFromRegexBody(sanitizedRaw, anchoredStart);
  if (!stripped.ok) {
    return fallbackForUnrepresentableRegex(rawRegex, targetUrl, hasI18n, onWarning, index);
  }
  let body = stripped.body;
  if (!anchoredEnd) {
    body = `${body}.*`;
  }
  if (body.length === 0) {
    return { bucket: 'afterFiles', rule: makeRule('/', `${targetUrl}/`, hasI18n) };
  }
  if (LEADING_QUANTIFIER_RE.test(body)) {
    return fallbackForUnrepresentableRegex(rawRegex, targetUrl, hasI18n, onWarning, index);
  }

  try {
    // Next.js path-to-regexp compiles regex params without the /u flag.
    new RegExp(`^/(?:${body})$`);
  } catch {
    return fallbackForUnrepresentableRegex(rawRegex, targetUrl, hasI18n, onWarning, index);
  }

  return {
    bucket: 'afterFiles',
    rule: makeRule(`/:match(${body})`, `${targetUrl}/:match`, hasI18n),
  };
}

/**
 * Translate `firebase.json` `hosting.rewrites` whose target is a Cloud Function
 * into Next.js rewrite rules targeting the local Pyric Functions HTTP gateway.
 *
 * Preserves Firebase Hosting ordering: a catch-all non-function rewrite (such
 * as `{ source: "**", destination: "/index.html" }`) shadows later function
 * rewrites, and malformed patterns are warned about and skipped without failing
 * Next.js startup.
 */
export function translateHostingFunctionRewrites(
  firebaseJson: unknown,
  targetUrl: string,
  options?: { hasI18n?: boolean; onWarning?: (warning: string) => void },
): TranslatedHostingRewrites {
  const hasI18n = options?.hasI18n === true;
  const onWarning = options?.onWarning;

  // Validate syntax through the canonical Hosting rewrite reader so warnings
  // match `pyric sandbox` and Vite consistently.
  const warningsSeen = new Set<string>();
  const warnOnce = (warning: string): void => {
    if (warningsSeen.has(warning)) return;
    warningsSeen.add(warning);
    onWarning?.(warning);
  };
  hostingRewrites(firebaseJson, warnOnce);

  const hosting = (firebaseJson as { hosting?: unknown } | null)?.hosting;
  const site = Array.isArray(hosting) ? hosting[0] : hosting;
  const rawRewrites = (site as { rewrites?: unknown } | undefined)?.rewrites;
  if (!Array.isArray(rawRewrites)) {
    return { afterFiles: [], fallback: [] };
  }

  const afterFiles: NextRewriteRule[] = [];
  const fallback: NextRewriteRule[] = [];
  const seenSources = new Set<string>();
  const pushUnique = (bucket: 'afterFiles' | 'fallback', rule: NextRewriteRule): void => {
    if (seenSources.has(rule.source)) return;
    seenSources.add(rule.source);
    if (bucket === 'fallback') {
      fallback.push(rule);
    } else {
      afterFiles.push(rule);
    }
  };

  for (let index = 0; index < rawRewrites.length; index += 1) {
    const entry = rawRewrites[index] as RawHostingRewrite | null;
    if (entry === null || typeof entry !== 'object') continue;

    if (!hasFunctionTarget(entry)) {
      if (isUnconditionalCatchAll(entry)) {
        break;
      }
      continue;
    }

    if (typeof entry.source === 'string') {
      try {
        new Minimatch(entry.source);
      } catch (error) {
        warnOnce(
          `firebase.json hosting.rewrites[${index}] (${JSON.stringify(entry.source)}) is skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const expanded = expandBraces(entry.source);
      // Drop redundant exact prefix when `{,/**}` expands alongside `<prefix>/**`,
      // because Next.js's `<prefix>/:path*` already matches `<prefix>`, `<prefix>/`, and `<prefix>/...`.
      const globstarPrefixes = new Set(
        expanded.filter((item) => item.endsWith('/**')).map((item) => item.slice(0, -'/**'.length)),
      );
      for (const glob of expanded) {
        if (globstarPrefixes.has(glob)) continue;
        const translated = translateGlobPattern(glob, targetUrl, hasI18n);
        if (translated !== null) {
          pushUnique(translated.bucket, translated.rule);
        }
      }
      continue;
    }

    if (typeof entry.regex === 'string') {
      const translated = translateRegexPattern(entry.regex, targetUrl, hasI18n, warnOnce, index);
      if (translated !== null) {
        pushUnique(translated.bucket, translated.rule);
      }
    }
  }

  return { afterFiles, fallback };
}

/**
 * Build the Next.js rewrite rule that proxies Functions emulator / callable
 * paths (`/<projectId>/<region>/<name>[/...]`) to the local Functions gateway.
 */
export function assembleEmulatorPathRewrite(
  projectId: string,
  targetUrl: string,
  hasI18n = false,
): NextRewriteRule | null {
  if (!SAFE_PROJECT_ID_RE.test(projectId)) {
    return null;
  }
  return makeRule(
    `/${projectId}/:region([a-z]+-[a-z]+\\d+)/:fn/:path*`,
    `${targetUrl}/${projectId}/:region/:fn/:path*`,
    hasI18n,
  );
}
