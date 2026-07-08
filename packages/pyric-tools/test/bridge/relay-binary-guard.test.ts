/**
 * Anti-corruption guard at the worker-op relay boundary (remote sandbox,
 * slice 2 hygiene).
 *
 * Both WS legs of the relay are `JSON.stringify`: a `Blob` result becomes
 * `{}`, a TypedArray becomes an index-keyed object — SILENTLY. The guard
 * (`assertJsonSafeRelayValue`, called by `connectBridge`'s `handleWorkerOp`
 * before the `worker-res` is serialized) turns that into a loud error
 * naming the base64 storage ops. This is a cheap explicit TYPE check, not
 * a JSON round-trip per op.
 */

import { describe, it, expect } from 'bun:test';
import {
  findBinaryPayload,
  assertJsonSafeRelayValue,
} from '../../src/bridge/protocol.js';

describe('findBinaryPayload — detection', () => {
  it('detects the top-level binary containers JSON silently mangles', () => {
    expect(findBinaryPayload(new Blob(['x']))).toBe('Blob');
    expect(findBinaryPayload(new ArrayBuffer(4))).toBe('ArrayBuffer');
    expect(findBinaryPayload(new Uint8Array([1, 2]))).toBe('Uint8Array');
    expect(findBinaryPayload(new Float64Array(2))).toBe('Float64Array');
    expect(findBinaryPayload(new DataView(new ArrayBuffer(4)))).toBe('DataView');
    // Node/Bun Buffer is a Uint8Array subclass — also non-JSON-safe (its
    // JSON form `{type:'Buffer',data:[…]}` is an accidental wire format).
    expect(findBinaryPayload(Buffer.from('x'))).toBe('Buffer');
  });

  it('detects binary nested in arrays and plain objects', () => {
    expect(findBinaryPayload({ meta: { blob: new Blob(['x']) } })).toBe('Blob');
    expect(findBinaryPayload([1, 'a', [new Uint8Array(1)]])).toBe('Uint8Array');
  });

  it('passes ordinary JSON-safe values (incl. base64 strings)', () => {
    expect(findBinaryPayload(null)).toBeNull();
    expect(findBinaryPayload(undefined)).toBeNull();
    expect(findBinaryPayload('aGVsbG8=')).toBeNull();
    expect(findBinaryPayload(42)).toBeNull();
    expect(
      findBinaryPayload({ dataB64: 'aGVsbG8=', contentType: 'text/plain', size: 5 }),
    ).toBeNull();
    expect(findBinaryPayload({ items: [{ fullPath: 'a/b', name: 'b' }] })).toBeNull();
  });
});

describe('assertJsonSafeRelayValue — the loud rejection', () => {
  it('throws invalid-argument naming the offender and the base64 ops for a relayed getBlob', () => {
    let caught: (Error & { code?: string }) | null = null;
    try {
      assertJsonSafeRelayValue('storage.getBlob', new Blob(['png-bytes']));
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('invalid-argument');
    expect(caught!.message).toContain("worker op 'storage.getBlob'");
    expect(caught!.message).toContain('Blob');
    expect(caught!.message).toContain('storage.getBytes');
    expect(caught!.message).toContain('storage.putBytes');
  });

  it('accepts the base64 storage op results untouched', () => {
    expect(() =>
      assertJsonSafeRelayValue('storage.getBytes', {
        dataB64: 'iVBORw0KGgo=',
        contentType: 'image/png',
        size: 8,
      }),
    ).not.toThrow();
    expect(() => assertJsonSafeRelayValue('storage.deleteObject', null)).not.toThrow();
  });
});
