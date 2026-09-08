/**
 * `arrayBufferToBase64` on both of the runtimes it targets.
 *
 * The `Buffer` branch is what Node.js and Bun take. The `btoa` branch is what
 * a browser or a worker takes, and nothing in a Bun test run exercises it
 * unless `Buffer` is removed from the global scope for the duration of the
 * call, which is what these tests do.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { arrayBufferToBase64 } from '../../src/storage/base64.js';

const globals = globalThis as { Buffer?: unknown };
const realBuffer = globals.Buffer;

afterEach(() => {
  globals.Buffer = realBuffer;
});

/** Run `body` with no global `Buffer`, forcing the `btoa` branch. */
function withoutBuffer<T>(body: () => T): T {
  delete globals.Buffer;
  try {
    return body();
  } finally {
    globals.Buffer = realBuffer;
  }
}

function bufferOf(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe('arrayBufferToBase64', () => {
  it('encodes an empty buffer as an empty string', () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('');
    expect(withoutBuffer(() => arrayBufferToBase64(new ArrayBuffer(0)))).toBe('');
  });

  it('encodes text identically on both branches', () => {
    const bytes = new TextEncoder().encode('hello').buffer as ArrayBuffer;

    expect(arrayBufferToBase64(bytes)).toBe('aGVsbG8=');
    expect(withoutBuffer(() => arrayBufferToBase64(bytes))).toBe('aGVsbG8=');
  });

  it('encodes high bytes identically on both branches', () => {
    const bytes = bufferOf([0x00, 0x7f, 0x80, 0xfe, 0xff]);

    expect(arrayBufferToBase64(bytes)).toBe('AH+A/v8=');
    expect(withoutBuffer(() => arrayBufferToBase64(bytes))).toBe('AH+A/v8=');
  });

  it('pads each remainder length the same way on both branches', () => {
    for (const length of [1, 2, 3, 4, 5]) {
      const bytes = bufferOf(Array.from({ length }, (_, i) => i * 37 % 256));
      expect(withoutBuffer(() => arrayBufferToBase64(bytes))).toBe(arrayBufferToBase64(bytes));
    }
  });
});
