import type { PathPattern, PathSegment } from './FirestoreAST.js';

// ---- String and bytes literal decoding ----
// The body of a string or bytes literal, after the grammar's `stringEscape`
// or `literalEscape` rule has accepted it. `readLiteralBody` splits the body
// into plain text and escape values: `\xHH` and `\ooo` are the value of their
// digits, `\uHHHH` is one UTF-16 code unit, and a simple escape is the code of
// the character it names. A string literal takes each value as a UTF-16 code
// unit; a bytes literal encodes plain text as UTF-8 and takes each escape
// value as one byte.
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  '\\': 0x5c,
  '\'': 0x27,
  '"': 0x22,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  b: 0x08,
  f: 0x0c,
};

function readLiteralBody(
  body: string,
  onText: (text: string) => void,
  onEscape: (value: number) => void,
): void {
  let textStart = 0;
  let i = 0;
  while (i < body.length) {
    if (body[i] !== '\\') {
      i++;
      continue;
    }
    if (i > textStart) onText(body.slice(textStart, i));
    const next = body[i + 1]!;
    if (next === 'x') {
      onEscape(parseInt(body.slice(i + 2, i + 4), 16));
      i += 4;
    } else if (next === 'u') {
      onEscape(parseInt(body.slice(i + 2, i + 6), 16));
      i += 6;
    } else if (next >= '0' && next <= '3') {
      onEscape(parseInt(body.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      onEscape(SIMPLE_ESCAPES[next]!);
      i += 2;
    }
    textStart = i;
  }
  if (body.length > textStart) onText(body.slice(textStart));
}

export function decodeStringLiteral(body: string): string {
  let out = '';
  readLiteralBody(
    body,
    (text) => {
      out += text;
    },
    (value) => {
      out += String.fromCharCode(value);
    },
  );
  return out;
}

export function decodeBytesLiteral(body: string): Uint8Array {
  const out: number[] = [];
  const encoder = new TextEncoder();
  readLiteralBody(
    body,
    (text) => {
      out.push(...encoder.encode(text));
    },
    (value) => {
      out.push(value);
    },
  );
  return new Uint8Array(out);
}

// ---- Path parsing ----

export function parsePath(raw: string): PathPattern {
  const segments: PathSegment[] = [];
  const parts = raw.split('/').filter(Boolean);
  for (const part of parts) {
    if (part.startsWith('{') && part.endsWith('}')) {
      const inner = part.slice(1, -1);
      if (inner.endsWith('=**')) {
        segments.push({ type: 'recursive', name: inner.slice(0, -3) });
      } else {
        segments.push({ type: 'wildcard', name: inner });
      }
    } else {
      segments.push({ type: 'literal', value: part });
    }
  }
  return { raw, segments };
}
