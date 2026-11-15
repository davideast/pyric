import { isLocalRelativeModuleSpecifier } from '../grammar/function-scopes.js';

const HEADER_TRIVIA = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/;
const HEADER_IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

function blankPreservingNewlines(text: string): string {
  return text.replace(/[^\n\r]/g, ' ');
}

function skipTrivia(text: string, start: number): number {
  let pos = start;
  while (pos < text.length) {
    const match = HEADER_TRIVIA.exec(text.slice(pos));
    if (!match || match[0].length === 0) break;
    pos += match[0].length;
  }
  return pos;
}

function scanQuotedString(text: string, start: number): { end: number; value: string } | null {
  const quote = text[start];
  if (quote !== "'" && quote !== '"') return null;
  let pos = start + 1;
  let value = '';
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === undefined || ch === '\n' || ch === '\r') return null;
    if (ch === quote) return { end: pos + 1, value };
    if (ch === '\\') {
      const next = text[pos + 1];
      if (next === undefined) return null;
      if (next === 'x' && /^[0-9a-fA-F]{2}/.test(text.slice(pos + 2, pos + 4))) {
        value += String.fromCharCode(parseInt(text.slice(pos + 2, pos + 4), 16));
        pos += 4;
        continue;
      }
      if (next === 'u' && /^[0-9a-fA-F]{4}/.test(text.slice(pos + 2, pos + 6))) {
        value += String.fromCharCode(parseInt(text.slice(pos + 2, pos + 6), 16));
        pos += 6;
        continue;
      }
      if (/^[0-3][0-7]{2}/.test(text.slice(pos + 1, pos + 4))) {
        value += String.fromCharCode(parseInt(text.slice(pos + 1, pos + 4), 8));
        pos += 4;
        continue;
      }
      const simpleEscapes: Record<string, string> = {
        '\\': '\\',
        "'": "'",
        '"': '"',
        n: '\n',
        r: '\r',
        t: '\t',
        b: '\b',
        f: '\f',
      };
      const mapped = simpleEscapes[next];
      if (mapped === undefined) return null;
      value += mapped;
      pos += 2;
      continue;
    }
    value += ch;
    pos += 1;
  }
  return null;
}

function scanRulesVersion(text: string, start: number): number | null {
  if (!/^rules_version\b/.test(text.slice(start))) return null;
  let pos = skipTrivia(text, start + 'rules_version'.length);
  if (text[pos] !== '=') return null;
  pos = skipTrivia(text, pos + 1);
  const str = scanQuotedString(text, pos);
  if (str === null) return null;
  pos = skipTrivia(text, str.end);
  if (text[pos] !== ';') return null;
  return pos + 1;
}

function scanImportDecl(text: string, start: number): { end: number; module: string } | null {
  if (!/^import\b/.test(text.slice(start))) return null;
  let pos = skipTrivia(text, start + 'import'.length);
  if (text[pos] !== '{') return null;
  pos = skipTrivia(text, pos + 1);
  while (pos < text.length && text[pos] !== '}') {
    const ident = HEADER_IDENT.exec(text.slice(pos));
    if (!ident) return null;
    pos = skipTrivia(text, pos + ident[0].length);
    if (text[pos] === ',') {
      pos = skipTrivia(text, pos + 1);
    } else {
      break;
    }
  }
  if (text[pos] !== '}') return null;
  pos = skipTrivia(text, pos + 1);
  if (!/^from\b/.test(text.slice(pos))) return null;
  pos = skipTrivia(text, pos + 'from'.length);
  const str = scanQuotedString(text, pos);
  if (str === null) return null;
  pos = skipTrivia(text, str.end);
  if (text[pos] !== ';') return null;
  return { end: pos + 1, module: str.value };
}

/**
 * Blank out local relative `import { ... } from './...';` declarations in raw
 * `2+modules` source while preserving every newline and column offset so
 * bundled stdlib resolution keeps authored line numbers intact.
 *
 * Returns `null` if the scanned local import count does not match `expectedCount`.
 */
export function blankLocalRelativeImports(rawSource: string, expectedCount: number): string | null {
  const chunks: string[] = [];
  let cursor = 0;
  let lastCopied = 0;
  let blankedCount = 0;

  for (;;) {
    cursor = skipTrivia(rawSource, cursor);
    const versionEnd = scanRulesVersion(rawSource, cursor);
    if (versionEnd !== null) {
      cursor = versionEnd;
      continue;
    }
    const decl = scanImportDecl(rawSource, cursor);
    if (decl !== null) {
      if (isLocalRelativeModuleSpecifier(decl.module)) {
        chunks.push(rawSource.slice(lastCopied, cursor));
        chunks.push(blankPreservingNewlines(rawSource.slice(cursor, decl.end)));
        lastCopied = decl.end;
        blankedCount += 1;
      }
      cursor = decl.end;
      continue;
    }
    break;
  }

  if (blankedCount !== expectedCount) return null;
  chunks.push(rawSource.slice(lastCopied));
  return chunks.join('');
}
