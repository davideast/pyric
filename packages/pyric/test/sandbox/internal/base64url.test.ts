/**
 * The plain-JavaScript base64url codec the sandbox JWT signer uses, checked
 * byte for byte against Node's `Buffer` with `Buffer`, `btoa` and `atob`
 * removed, as in the realm the CLI's in-page auth entry runs in (AGENTS.md
 * item 5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { decodeBase64url, encodeBase64url } from '../../../src/sandbox/internal/base64url.js';
import { base64url, latin1FromBase64url, signIdToken, utf8FromBase64url } from '../../../src/sandbox/internal/index.js';

type Globals = { Buffer?: unknown; btoa?: unknown; atob?: unknown };
const globals = globalThis as Globals;
const NodeBuffer = Buffer;
const saved: Globals = { Buffer: globals.Buffer, btoa: globals.btoa, atob: globals.atob };

const CASES: Record<string, Uint8Array> = {
  empty: new Uint8Array([]),
  'one byte (two padding characters)': new Uint8Array([0xfb]),
  'two bytes (one padding character)': new Uint8Array([0xfb, 0xff]),
  'three bytes (no padding)': new Uint8Array([0xfb, 0xff, 0xbf]),
  'four bytes': new Uint8Array([0, 1, 2, 3]),
  'every byte value': Uint8Array.from({ length: 256 }, (_, index) => index),
  'non-ASCII UTF-8': new TextEncoder().encode('Zoë 名前 🔥'),
};

function bufferEncode(bytes: Uint8Array): string {
  return NodeBuffer.from(bytes).toString('base64url');
}

beforeEach(() => {
  delete globals.Buffer;
  delete globals.btoa;
  delete globals.atob;
});

afterEach(() => {
  Object.assign(globals, saved);
});

describe('base64url codec with no Buffer, btoa or atob', () => {
  it('runs with the globals removed', () => {
    expect(typeof globals.Buffer).toBe('undefined');
    expect(typeof globals.btoa).toBe('undefined');
    expect(typeof globals.atob).toBe('undefined');
  });

  for (const [name, bytes] of Object.entries(CASES)) {
    it(`encodes ${name} as Buffer does`, () => {
      expect(encodeBase64url(bytes)).toBe(bufferEncode(bytes));
      expect(base64url(bytes)).toBe(bufferEncode(bytes));
    });

    it(`decodes ${name} as Buffer does`, () => {
      const encoded = bufferEncode(bytes);
      expect(decodeBase64url(encoded)).toEqual(Uint8Array.from(NodeBuffer.from(encoded, 'base64url')));
      expect(latin1FromBase64url(encoded)).toBe(NodeBuffer.from(encoded, 'base64url').toString('latin1'));
      expect(utf8FromBase64url(encoded)).toBe(NodeBuffer.from(encoded, 'base64url').toString('utf8'));
    });
  }

  it('throws on a dangling character and on characters outside the alphabet', () => {
    expect(() => decodeBase64url('AAAAA')).toThrow();
    expect(() => decodeBase64url('AA+A')).toThrow();
    expect(() => decodeBase64url('AA==')).toThrow();
  });

  it('mints an ID token', async () => {
    const token = await signIdToken({ sub: 'uid-1', name: 'Zoë' });
    expect(token.split('.')).toHaveLength(3);
    expect(JSON.parse(utf8FromBase64url(token.split('.')[1]!))).toMatchObject({ name: 'Zoë' });
  });
});
