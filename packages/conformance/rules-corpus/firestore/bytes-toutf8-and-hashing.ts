/**
 * ─── Pack 9: bytes-toutf8-and-hashing ─────────────────────────────────────
 * Targets Item 5.3 — Bytes wrapper + String.toUtf8() + hashing.*. Pre-fix:
 * hashing.* threw UnsupportedError ('Unknown method on undefined' because
 * `hashing` resolved to undefined), and String.toUtf8 threw UnsupportedError.
 * Each case here exercises a wrapper-level invariant (size/round-trip) and
 * a hash with a well-known reference value. Picked rules where the literal
 * outputs are stable across runs (no random/time inputs).
 */
import type { PackRecord } from './types.ts';

export const pack: PackRecord = {
  fm: 'Item 5.3',
  rationale: 'Sim must implement Bytes + String.toUtf8() + hashing.{md5,sha256,crc32,crc32c}. Pre-fix: every reference hashing rule denied silently and toUtf8 threw UnsupportedError.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // toUtf8 → Bytes, .size() returns byte count
    match /utf8SizeAllow/{id} {
      allow create: if request.auth != null
        && 'hello'.toUtf8().size() == 5;
    }
    // multi-byte UTF-8 length
    match /utf8MultibyteAllow/{id} {
      allow create: if request.auth != null
        && 'é'.toUtf8().size() == 2;
    }
    // toBase64 round-trip (no padding, URL-safe)
    match /base64Allow/{id} {
      allow create: if request.auth != null
        && 'hi'.toUtf8().toBase64() == 'aGk';
    }
    // toHexString round-trip
    match /hexAllow/{id} {
      allow create: if request.auth != null
        && 'hi'.toUtf8().toHexString() == '6869';
    }
    // is bytes
    match /isBytesAllow/{id} {
      allow create: if request.auth != null
        && 'x'.toUtf8() is bytes;
    }
    // md5 of empty string — well-known reference
    match /md5EmptyAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('').toHexString() == 'd41d8cd98f00b204e9800998ecf8427e';
    }
    // sha256 of 'abc' — NIST FIPS 180-4 reference
    match /sha256AbcAllow/{id} {
      allow create: if request.auth != null
        && hashing.sha256('abc').toHexString() == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    }
    // crc32 reference (IEEE 802.3, '123456789' → 0xCBF43926)
    match /crc32RefAllow/{id} {
      allow create: if request.auth != null
        && hashing.crc32('123456789').toHexString() == 'cbf43926';
    }
    // crc32c reference (Castagnoli, '123456789' → 0xE3069283)
    match /crc32cRefAllow/{id} {
      allow create: if request.auth != null
        && hashing.crc32c('123456789').toHexString() == 'e3069283';
    }
    // hashing accepts pre-encoded Bytes too
    match /hashAcceptsBytesAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('hello'.toUtf8()) == hashing.md5('hello');
    }
    // DENY witness — wrong digest
    match /md5WrongDeny/{id} {
      allow create: if request.auth != null
        && hashing.md5('hello').toHexString() == 'deadbeef';
    }
  }
}`,
  cases: [
    {
      description: "toUtf8().size() == 5 ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'utf8SizeAllow/d1',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: "multi-byte UTF-8 size ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'utf8MultibyteAllow/d2',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'toBase64 round-trip ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'base64Allow/d3',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'toHexString round-trip ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'hexAllow/d4',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'is bytes ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'isBytesAllow/d5',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'md5 empty string ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'md5EmptyAllow/d6',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'sha256 abc ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'sha256AbcAllow/d7',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'crc32 IEEE 802.3 ref ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'crc32RefAllow/d8',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'crc32c Castagnoli ref ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'crc32cRefAllow/d9',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'hashing accepts Bytes input ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'hashAcceptsBytesAllow/d10',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'wrong md5 digest DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'md5WrongDeny/d11',
      auth: { uid: 'alice' },
      data: {},
    },
  ],
  group: 'stress',
};
