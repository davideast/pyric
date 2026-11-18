import { createHash } from 'node:crypto';
import { describe, it, expect } from 'bun:test';
import { createMd5Hasher, md5 } from '../../../src/internal/storage.js';
import { parseStorageRules } from '../../../src/storage/rules.js';
import { evaluateStorageRules } from '../../../src/storage/rules-evaluator.js';

// ─── hashing.* and Bytes ─────────────────────────────────────────
//
// Digests and encodings replay corpus scenario stdlib-string-bytes-hashing
// (rules-storage-stdlib-string-bytes-hashing): uppercase hexadecimal, padded
// base64url, and CRC digests serialized least-significant byte first.

describe('evaluateStorageRules — hashing and bytes', () => {
  const path = 'b/pyric-default/o/docs/d1.json';

  function evalHash(cond: string): { allowed: boolean; reasons: string[] } {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    return evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: {
        size: 10,
        metadata: { ownerHash: '2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90' },
      },
    });
  }

  it('computes md5, sha256, crc32, and crc32c digests', () => {
    expect(evalHash("hashing.md5('abc').toHexString() == '900150983CD24FB0D6963F7D28E17F72'").allowed).toBe(true);
    expect(evalHash(
      "hashing.sha256('abc').toHexString() == 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD'",
    ).allowed).toBe(true);
    expect(evalHash("hashing.crc32('abc').toHexString() == 'C2412435'").allowed).toBe(true);
    expect(evalHash("hashing.crc32c('abc').toHexString() == 'B73F4B36'").allowed).toBe(true);
  });

  it('hashes a string like its UTF-8 bytes', () => {
    expect(evalHash("hashing.sha256('abc'.toUtf8()) == hashing.sha256('abc')").allowed).toBe(true);
    expect(evalHash(
      'hashing.sha256(request.auth.uid).toHexString().lower() == resource.metadata.ownerHash',
    ).allowed).toBe(true);
  });

  it('encodes bytes and compares them by value', () => {
    expect(evalHash("'hi'.toUtf8().toBase64() == 'aGk=' && 'hi'.toUtf8().toHexString() == '6869'").allowed).toBe(true);
    expect(evalHash("'hi'.toUtf8() == 'hi'.toUtf8() && 'hi'.toUtf8() != 'ho'.toUtf8()").allowed).toBe(true);
    expect(evalHash('hashing.md5(\'x\').size() == 16').allowed).toBe(true);
  });

  it('denies hashing an int, an error || true absorbs', () => {
    const r = evalHash('hashing.md5(resource.size).size() == 16');
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('hashing.md5(int)');
    expect(evalHash('hashing.md5(resource.size).size() == 16 || true').allowed).toBe(true);
  });

  it('returns an absorbable function-not-found error on an undefined hashing function', () => {
    const r = evalHash("hashing.sha1('abc').size() == 20");
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Function not found error: Name: [sha1].');
    expect(evalHash("hashing.sha1('abc').size() == 20 || true").allowed).toBe(true);
  });

  it('denies a wrong argument count', () => {
    expect(evalHash("hashing.md5('a', 'b').size() == 16").allowed).toBe(false);
    expect(evalHash("'a'.toUtf8().toBase64('x') == 'YQ=='").allowed).toBe(false);
  });

  it('streams chunks through createMd5Hasher identically to single-shot md5 and node:crypto across padding boundaries', () => {
    const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 128, 1000];
    const stepSizes = [1, 7, 63, 64, 65];
    for (const len of lengths) {
      const payload = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        payload[i] = (i * 31 + 17) & 0xff;
      }
      const expected = new Uint8Array(createHash('md5').update(payload).digest());
      expect([...md5(payload)]).toEqual([...expected]);
      for (const step of stepSizes) {
        const hasher = createMd5Hasher();
        for (let offset = 0; offset < len; offset += step) {
          hasher.update(payload.subarray(offset, Math.min(offset + step, len)));
        }
        expect([...hasher.digest()]).toEqual([...expected]);
      }
    }
  });
});
