/**
 * A request body as the model forwarder reads it: by Content-Length, or
 * chunked, and nothing else. The forwarder reads the whole body before it
 * dials the model API, so a request it can't frame is refused before
 * anything leaves the machine.
 */
import { headerValues, type RequestHead } from './http-head.ts';

/** The most a Messages request may carry: the API's own request limit. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

export type Framing = { kind: 'length'; length: number } | { kind: 'chunked' } | { kind: 'none' };

/** How the body is framed, or undefined when the fields are ambiguous, unsupported or too large. */
export function framingOf(head: RequestHead): Framing | undefined {
  const lengths = headerValues(head, 'content-length');
  const encodings = headerValues(head, 'transfer-encoding');
  const hasBoth = lengths.length > 0 && encodings.length > 0;
  if (hasBoth || lengths.length > 1 || encodings.length > 1) return undefined;
  if (encodings.length === 1) return encodings[0]?.toLowerCase() === 'chunked' ? { kind: 'chunked' } : undefined;
  if (lengths.length === 0) return { kind: 'none' };
  const raw = lengths[0] ?? '';
  const length = Number(raw);
  const isAllowedLength = /^\d{1,10}$/.test(raw) && length <= MAX_BODY_BYTES;
  return isAllowedLength ? { kind: 'length', length } : undefined;
}

export type Decoded = { state: 'complete'; body: Buffer } | { state: 'partial' } | { state: 'malformed' };

const CHUNK_SIZE = /^([0-9A-Fa-f]{1,8})(;[^\r\n]*)?$/;
const CRLF = Buffer.from('\r\n');
const MAX_SIZE_LINE = 1024;

/** Decodes a chunked body from the bytes read so far: complete, still arriving, or broken. */
export function decodeChunked(buffer: Buffer, max: number = MAX_BODY_BYTES): Decoded {
  const parts: Buffer[] = [];
  let size = 0;
  let offset = 0;
  for (;;) {
    const lineEnd = buffer.indexOf(CRLF, offset);
    const sizeLineTooLong = lineEnd === -1 && buffer.length - offset > MAX_SIZE_LINE;
    if (sizeLineTooLong) return { state: 'malformed' };
    if (lineEnd === -1) return { state: 'partial' };
    const match = CHUNK_SIZE.exec(buffer.subarray(offset, lineEnd).toString('latin1'));
    if (match === null) return { state: 'malformed' };
    const length = parseInt(match[1] ?? '', 16);
    size += length;
    if (size > max) return { state: 'malformed' };
    const dataStart = lineEnd + CRLF.length;
    if (length === 0) return trailerEnd(buffer, dataStart, parts);
    const dataEnd = dataStart + length;
    if (buffer.length < dataEnd + CRLF.length) return { state: 'partial' };
    if (!buffer.subarray(dataEnd, dataEnd + CRLF.length).equals(CRLF)) return { state: 'malformed' };
    parts.push(buffer.subarray(dataStart, dataEnd));
    offset = dataEnd + CRLF.length;
  }
}

/** After the last chunk: trailer fields, which the forwarder drops, up to an empty line. */
function trailerEnd(buffer: Buffer, start: number, parts: Buffer[]): Decoded {
  let offset = start;
  for (;;) {
    const lineEnd = buffer.indexOf(CRLF, offset);
    if (lineEnd === -1) return { state: 'partial' };
    if (lineEnd === offset) return { state: 'complete', body: Buffer.concat(parts) };
    offset = lineEnd + CRLF.length;
  }
}

/** The body, once `buffered` holds all of it: complete, still arriving, or broken. */
export function bodyFrom(buffered: Buffer, framing: Framing): Decoded {
  if (framing.kind === 'none') return { state: 'complete', body: Buffer.alloc(0) };
  if (framing.kind === 'chunked') return decodeChunked(buffered);
  if (buffered.length < framing.length) return { state: 'partial' };
  return { state: 'complete', body: buffered.subarray(0, framing.length) };
}
