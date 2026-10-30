import { describe, expect, test } from 'bun:test';
import { parseHead } from './http-head.ts';
import { bodyFrom, decodeChunked, framingOf, MAX_BODY_BYTES } from './request-body.ts';

const framing = (fields: string) => {
  const head = parseHead(`POST /v1/messages HTTP/1.1${fields === '' ? '' : `\r\n${fields}`}`);
  if (head === undefined) throw new Error('unparsed');
  return framingOf(head);
};

describe('framingOf', () => {
  test('frames by Content-Length, by chunks, or as empty', () => {
    expect(framing('Content-Length: 12')).toEqual({ kind: 'length', length: 12 });
    expect(framing('Transfer-Encoding: Chunked')).toEqual({ kind: 'chunked' });
    expect(framing('')).toEqual({ kind: 'none' });
  });

  test('refuses framing that two readers could read two ways, or that is too large', () => {
    expect(framing('Content-Length: 2\r\nTransfer-Encoding: chunked')).toBeUndefined();
    expect(framing('Content-Length: 2\r\nContent-Length: 2')).toBeUndefined();
    expect(framing('Transfer-Encoding: gzip, chunked')).toBeUndefined();
    expect(framing('Content-Length: -1')).toBeUndefined();
    expect(framing('Content-Length: 0x10')).toBeUndefined();
    expect(framing(`Content-Length: ${MAX_BODY_BYTES + 1}`)).toBeUndefined();
  });
});

describe('decodeChunked', () => {
  test('decodes complete chunks, waits for the rest, and drops trailers', () => {
    expect(decodeChunked(Buffer.from('3;ext=1\r\nabc\r\n2\r\nde\r\n0\r\nX-Trailer: 1\r\n\r\n'))).toEqual({ state: 'complete', body: Buffer.from('abcde') });
    expect(decodeChunked(Buffer.from('3\r\nab'))).toEqual({ state: 'partial' });
    expect(decodeChunked(Buffer.from('3\r\nabc\r\n0\r\n'))).toEqual({ state: 'partial' });
  });

  test('calls broken framing broken', () => {
    expect(decodeChunked(Buffer.from('z\r\nabc\r\n'))).toEqual({ state: 'malformed' });
    expect(decodeChunked(Buffer.from('3\r\nabcX\r\n'))).toEqual({ state: 'malformed' });
    expect(decodeChunked(Buffer.from('a'.repeat(2000)))).toEqual({ state: 'malformed' });
    expect(decodeChunked(Buffer.from('5\r\nabcde\r\n'), 4)).toEqual({ state: 'malformed' });
  });
});

describe('bodyFrom', () => {
  test('waits for a whole Content-Length body and ignores what follows it', () => {
    expect(bodyFrom(Buffer.from('ab'), { kind: 'length', length: 3 })).toEqual({ state: 'partial' });
    expect(bodyFrom(Buffer.from('abcd'), { kind: 'length', length: 3 })).toEqual({ state: 'complete', body: Buffer.from('abc') });
    expect(bodyFrom(Buffer.from('x'), { kind: 'none' })).toEqual({ state: 'complete', body: Buffer.alloc(0) });
  });
});
