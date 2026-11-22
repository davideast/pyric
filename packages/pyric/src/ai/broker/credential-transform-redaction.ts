/**
 * Defense-in-depth masking for credentials echoed verbatim or transformed by an
 * upstream (percent-encoded, base64/base64url with or without padding, case
 * changed, HTML-entity encoded, or backslash/Unicode escaped in non-JSON
 * bodies) (#1600).
 *
 * Pure JS (no Node `Buffer`) so browser workers and the Node host share one
 * implementation. Exact and transformed matching is gated to credentials of at
 * least {@link MIN_EXACT_CREDENTIAL_LENGTH} characters so short placeholder
 * values like `GEMINI_API_KEY=e` cannot corrupt JSON envelope keys; URL query
 * redaction (`redactUrl`) still masks short keys in URLs.
 */

const CREDENTIAL_MASK = '***';

/** Minimum raw credential length eligible for exact or transformed text matching. */
export const MIN_EXACT_CREDENTIAL_LENGTH = 8;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const HTML_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  sol: '/',
  bsol: '\\',
  plus: '+',
  equals: '=',
  colon: ':',
  semi: ';',
  quest: '?',
  num: '#',
  percnt: '%',
  commat: '@',
  lowbar: '_',
  hyphen: '-',
  dash: '-',
  period: '.',
  tilde: '~',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  rsqb: ']',
  lcub: '{',
  rcub: '}',
  ast: '*',
  excl: '!',
  dollar: '$',
  comma: ',',
  vert: '|',
  hat: '^',
  grave: '`',
};

/** Pure-JS UTF-8 base64 encoder (Buffer-less for browser and worker parity). */
export function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) return '';
  let out = '';
  let i = 0;
  while (i + 2 < bytes.length) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET.charAt((triple >> 18) & 63);
    out += BASE64_ALPHABET.charAt((triple >> 12) & 63);
    out += BASE64_ALPHABET.charAt((triple >> 6) & 63);
    out += BASE64_ALPHABET.charAt(triple & 63);
    i += 3;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const single = (bytes[i] ?? 0) << 16;
    out += BASE64_ALPHABET.charAt((single >> 18) & 63);
    out += BASE64_ALPHABET.charAt((single >> 12) & 63);
    out += '==';
  } else if (remaining === 2) {
    const pair = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += BASE64_ALPHABET.charAt((pair >> 18) & 63);
    out += BASE64_ALPHABET.charAt((pair >> 12) & 63);
    out += BASE64_ALPHABET.charAt((pair >> 6) & 63);
    out += '=';
  }
  return out;
}

/**
 * Every matchable form of every eligible credential (`length >= 8`), longest
 * first: raw, percent-encoded, standard base64, unpadded base64, base64url,
 * unpadded base64url, and percent-encoded base64.
 */
function quotedForms(credentials: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const credential of credentials) {
    if (credential.length < MIN_EXACT_CREDENTIAL_LENGTH) continue;
    forms.add(credential);
    forms.add(encodeURIComponent(credential));
    const b64 = encodeUtf8Base64(credential);
    if (b64.length >= MIN_EXACT_CREDENTIAL_LENGTH) {
      forms.add(b64);
      forms.add(encodeURIComponent(b64));
      const b64NoPad = b64.replace(/=+$/, '');
      if (b64NoPad.length >= MIN_EXACT_CREDENTIAL_LENGTH) {
        forms.add(b64NoPad);
      }
      const b64Url = b64.replace(/\+/g, '-').replace(/\//g, '_');
      forms.add(b64Url);
      const b64UrlNoPad = b64Url.replace(/=+$/, '');
      if (b64UrlNoPad.length >= MIN_EXACT_CREDENTIAL_LENGTH) {
        forms.add(b64UrlNoPad);
      }
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

function normalizeForCaseMatch(
  haystack: string,
  needles: readonly string[],
): { loweredHaystack: string; loweredNeedles: string[] } {
  const unicodeLower = haystack.toLowerCase();
  if (unicodeLower.length === haystack.length) {
    const loweredNeedles = needles.map((needle) => {
      const lowered = needle.toLowerCase();
      return lowered.length === needle.length ? lowered : asciiLower(needle);
    });
    return { loweredHaystack: unicodeLower, loweredNeedles };
  }
  return {
    loweredHaystack: asciiLower(haystack),
    loweredNeedles: needles.map(asciiLower),
  };
}

interface TextSpan {
  start: number;
  end: number;
}

function mergeOverlappingSpans(spans: readonly TextSpan[]): TextSpan[] {
  if (spans.length <= 1) return [...spans];
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: TextSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start < last.end) {
      if (span.end > last.end) {
        last.end = span.end;
      }
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }
  return merged;
}

function applySpanReplacements(text: string, spans: readonly TextSpan[]): string {
  if (spans.length === 0) return text;
  const merged = mergeOverlappingSpans(spans);
  const parts: string[] = [];
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) {
      parts.push(text.slice(cursor, span.start));
    }
    parts.push(CREDENTIAL_MASK);
    cursor = span.end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts.join('');
}

function replaceCaseInsensitive(text: string, forms: readonly string[]): string {
  let masked = text;
  for (const form of forms) {
    if (form.length === 0) continue;
    const { loweredHaystack, loweredNeedles } = normalizeForCaseMatch(masked, [form]);
    const needle = loweredNeedles[0];
    if (needle === undefined || needle.length === 0) continue;
    let index = loweredHaystack.indexOf(needle);
    if (index === -1) continue;
    const parts: string[] = [];
    let cursor = 0;
    while (index !== -1) {
      if (index > cursor) {
        parts.push(masked.slice(cursor, index));
      }
      parts.push(CREDENTIAL_MASK);
      cursor = index + needle.length;
      index = loweredHaystack.indexOf(needle, cursor);
    }
    if (cursor < masked.length) {
      parts.push(masked.slice(cursor));
    }
    masked = parts.join('');
  }
  return masked;
}

interface DecodedSpanMap {
  decoded: string;
  starts: number[];
  ends: number[];
}

function appendDecodedUnits(
  chars: string[],
  starts: number[],
  ends: number[],
  value: string,
  origStart: number,
  origEnd: number,
): void {
  for (let offset = 0; offset < value.length; offset += 1) {
    chars.push(value.charAt(offset));
    starts.push(origStart);
    ends.push(origEnd);
  }
}

function decodeHtmlEntityToken(token: string): string | undefined {
  if (token.startsWith('#')) {
    const rest = token.slice(1);
    const isHex = rest.startsWith('x') || rest.startsWith('X');
    let codePoint = Number.NaN;
    if (isHex) {
      const hex = rest.slice(1);
      if (/^[0-9a-fA-F]{1,6}$/.test(hex)) {
        codePoint = Number.parseInt(hex, 16);
      }
    } else if (/^\d{1,7}$/.test(rest)) {
      codePoint = Number.parseInt(rest, 10);
    }
    if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
      return String.fromCodePoint(codePoint);
    }
    return undefined;
  }
  return HTML_NAMED_ENTITIES[token.toLowerCase()];
}

function decodeHtmlEntitiesWithSpans(text: string): DecodedSpanMap {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) === '&') {
      const semi = text.indexOf(';', i + 1);
      if (semi !== -1 && semi - i <= 16) {
        const decoded = decodeHtmlEntityToken(text.slice(i + 1, semi));
        if (decoded !== undefined) {
          appendDecodedUnits(chars, starts, ends, decoded, i, semi + 1);
          i = semi + 1;
          continue;
        }
      }
    }
    chars.push(text.charAt(i));
    starts.push(i);
    ends.push(i + 1);
    i += 1;
  }
  return { decoded: chars.join(''), starts, ends };
}

function decodeEscapesWithSpans(text: string): DecodedSpanMap {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) === '\\' && i + 1 < text.length) {
      const next = text.charAt(i + 1);
      if (next === 'u' && text.charAt(i + 2) === '{') {
        const close = text.indexOf('}', i + 3);
        if (close !== -1 && close - (i + 3) >= 1 && close - (i + 3) <= 6) {
          const hex = text.slice(i + 3, close);
          if (/^[0-9a-fA-F]+$/.test(hex)) {
            const codePoint = Number.parseInt(hex, 16);
            if (codePoint <= 0x10ffff) {
              appendDecodedUnits(chars, starts, ends, String.fromCodePoint(codePoint), i, close + 1);
              i = close + 1;
              continue;
            }
          }
        }
      } else if (next === 'u' && i + 5 < text.length) {
        const hex = text.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          const decoded = String.fromCharCode(Number.parseInt(hex, 16));
          appendDecodedUnits(chars, starts, ends, decoded, i, i + 6);
          i += 6;
          continue;
        }
      } else if (next === 'x' && i + 3 < text.length) {
        const hex = text.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          const decoded = String.fromCharCode(Number.parseInt(hex, 16));
          appendDecodedUnits(chars, starts, ends, decoded, i, i + 4);
          i += 4;
          continue;
        }
      } else if (next === '/' || next === '"' || next === "'" || next === '\\') {
        appendDecodedUnits(chars, starts, ends, next, i, i + 2);
        i += 2;
        continue;
      }
    }
    chars.push(text.charAt(i));
    starts.push(i);
    ends.push(i + 1);
    i += 1;
  }
  return { decoded: chars.join(''), starts, ends };
}

function redactAcrossDecodedMap(
  text: string,
  map: DecodedSpanMap,
  forms: readonly string[],
): string {
  const { loweredHaystack, loweredNeedles } = normalizeForCaseMatch(map.decoded, forms);
  const matches: TextSpan[] = [];
  for (const needle of loweredNeedles) {
    if (needle.length === 0) continue;
    let index = loweredHaystack.indexOf(needle);
    while (index !== -1) {
      const origStart = map.starts[index];
      const origEnd = map.ends[index + needle.length - 1];
      if (origStart !== undefined && origEnd !== undefined && origEnd > origStart) {
        matches.push({ start: origStart, end: origEnd });
      }
      index = loweredHaystack.indexOf(needle, index + needle.length);
    }
  }
  return applySpanReplacements(text, matches);
}

/**
 * Mask every eligible (`length >= 8`) credential in `text` across exact,
 * percent-encoded, base64/base64url, case-changed, HTML-entity, and
 * backslash/Unicode-escaped forms while leaving unrelated text intact.
 */
export function redactTransformedCredentials(
  text: string,
  credentials: readonly string[],
): string {
  if (text.length === 0 || credentials.length === 0) return text;
  const forms = quotedForms(credentials);
  if (forms.length === 0) return text;
  let masked = replaceCaseInsensitive(text, forms);
  if (masked.includes('&')) {
    masked = redactAcrossDecodedMap(masked, decodeHtmlEntitiesWithSpans(masked), forms);
  }
  if (masked.includes('\\')) {
    masked = redactAcrossDecodedMap(masked, decodeEscapesWithSpans(masked), forms);
  }
  return masked;
}
