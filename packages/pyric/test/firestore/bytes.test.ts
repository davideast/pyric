import { describe, expect, it } from 'bun:test';
import { FirebaseError as UpstreamFirebaseError } from 'firebase/app';
import { Bytes as UpstreamBytes } from 'firebase/firestore';
import { FirebaseError } from 'pyric/app';
import { Bytes, FirestoreError } from 'pyric/firestore';

describe('Bytes invalid-argument validation and cross-runtime Base64 parity (#1973)', () => {
  it('wraps invalid Base64 strings and malformed JSON in FirebaseError(invalid-argument) instead of DOMException or TypeError', () => {
    const invalidBase64Cases = ['!!!', 'a', 'ab!c', 'a=b='];
    for (const badInput of invalidBase64Cases) {
      let caught: unknown;
      try {
        Bytes.fromBase64String(badInput);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FirebaseError);
      expect(caught).not.toBeInstanceOf(TypeError);
      expect(caught).not.toBeInstanceOf(FirestoreError);
      expect((caught as FirebaseError).code).toBe('invalid-argument');
      expect((caught as FirebaseError).message).toContain(
        'Failed to construct data from Base64 string',
      );
    }

    const invalidJsonCases: readonly unknown[] = [
      null,
      {},
      { type: 'wrong', bytes: 'YQ==' },
      { type: 'firestore/bytes/1.0', bytes: 123 },
      { type: 'firestore/bytes/1.0', bytes: '!!!' },
    ];
    for (const badJson of invalidJsonCases) {
      let pyErr: unknown;
      try {
        Bytes.fromJSON(badJson as object);
      } catch (error) {
        pyErr = error;
      }
      expect(pyErr).toBeInstanceOf(FirebaseError);
      expect(pyErr).not.toBeInstanceOf(TypeError);
      expect((pyErr as FirebaseError).code).toBe('invalid-argument');
    }

    let upMissingType: unknown;
    let pyMissingType: unknown;
    try {
      UpstreamBytes.fromJSON({});
    } catch (error) {
      upMissingType = error;
    }
    try {
      Bytes.fromJSON({});
    } catch (error) {
      pyMissingType = error;
    }
    expect(upMissingType).toBeInstanceOf(UpstreamFirebaseError);
    expect((pyMissingType as FirebaseError).message).toBe(
      (upMissingType as UpstreamFirebaseError).message,
    );
  });

  it('maintains cross-runtime parity across empty, 1-byte, 2-byte, and 3-byte payloads when atob/btoa/Buffer globals are absent', () => {
    const g = globalThis as Record<string, unknown>;
    const savedAtob = g.atob;
    const savedBtoa = g.btoa;
    const savedBuffer = g.Buffer;
    const payloads = [
      new Uint8Array([]),
      new Uint8Array([0x61]),
      new Uint8Array([0x61, 0x62]),
      new Uint8Array([0x61, 0x62, 0x63]),
      new Uint8Array([0x00, 0xff, 0x7f, 0x80]),
    ];

    const expectedEncoded = payloads.map((arr) => Bytes.fromUint8Array(arr).toBase64());
    try {
      delete g.atob;
      delete g.btoa;
      delete g.Buffer;

      for (let i = 0; i < payloads.length; i += 1) {
        const raw = payloads[i];
        const expectedB64 = expectedEncoded[i];
        if (raw === undefined || expectedB64 === undefined) continue;
        const built = Bytes.fromUint8Array(raw);
        expect(built.toBase64()).toBe(expectedB64);
        const decoded = Bytes.fromBase64String(expectedB64);
        expect(decoded.toUint8Array()).toEqual(raw);
        expect(Bytes.fromJSON(decoded.toJSON()).isEqual(decoded)).toBe(true);
      }

      let fallbackErr: unknown;
      try {
        Bytes.fromBase64String('!!!');
      } catch (error) {
        fallbackErr = error;
      }
      expect(fallbackErr).toBeInstanceOf(FirebaseError);
      expect((fallbackErr as FirebaseError).code).toBe('invalid-argument');
      expect((fallbackErr as FirebaseError).message).toContain(
        'Failed to construct data from Base64 string',
      );
    } finally {
      g.atob = savedAtob;
      g.btoa = savedBtoa;
      g.Buffer = savedBuffer;
    }
  });
});
