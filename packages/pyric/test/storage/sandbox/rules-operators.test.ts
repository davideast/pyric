import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import { typeMatches } from '../../../src/storage/sandbox/rules-operators.js';
import { StorageLatLng } from '../../../src/storage/sandbox/rules-latlng.js';
import { StoragePath } from '../../../src/storage/sandbox/rules-path.js';

// ─── Operators over Timestamp, Duration, and Bytes values ────────
//
// rules-storage-stdlib-timestamp-duration captures production's
// "Unsupported operation error. Received: timestamp < int." for a timestamp
// compared with an int.

const path = 'b/pyric-default/o/docs/d1.json';

function evalRead(cond: string): { allowed: boolean; reasons: string[] } {
  const rules = parseStorageRules(`service firebase.storage {
    match /b/{bucket}/o {
      match /docs/{docId} { allow read: if ${cond}; }
    }
  }`);
  return evaluateStorageRules(
    rules,
    { request: { auth: { uid: 'alice' }, method: 'read', path }, resource: { size: 10 } },
    new Date('2025-06-15T13:45:30.250Z'),
  );
}

describe('evaluateStorageRules — value operators', () => {
  it('compares timestamps and durations by value', () => {
    expect(evalRead('timestamp.value(1000) == timestamp.value(1000)').allowed).toBe(true);
    expect(evalRead('timestamp.value(1000) < timestamp.value(2000)').allowed).toBe(true);
    expect(evalRead("duration.value(1, 's') <= duration.value(1000, 'ms')").allowed).toBe(true);
    expect(evalRead("duration.value(1, 's') == duration.value(1000, 'ms')").allowed).toBe(true);
  });

  it('adds a timestamp and a duration in either order', () => {
    expect(evalRead("duration.value(1, 's') + timestamp.value(0) == timestamp.value(1000)").allowed).toBe(true);
  });

  it('denies comparing a timestamp with an int, through a negation too', () => {
    const r = evalRead('!(request.time < 0)');
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Unsupported operation error. Received: timestamp < int.');
  });

  it('denies arithmetic between a timestamp and an int', () => {
    const r = evalRead('request.time + 1000 > request.time');
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Received: timestamp + int.');
  });

  it('compares bytes by value and in byte order', () => {
    expect(evalRead("'a'.toUtf8() < 'b'.toUtf8() && 'a'.toUtf8() == 'a'.toUtf8()").allowed).toBe(true);
  });

  it('keeps int and float comparisons numeric', () => {
    expect(evalRead('1 < 1.5 && 2.0 == 2').allowed).toBe(true);
  });
});

describe('evaluateStorageRules — is over value types', () => {
  it('types timestamps, durations, and bytes', () => {
    expect(evalRead("request.time is timestamp && duration.value(1, 's') is duration && 'a'.toUtf8() is bytes").allowed)
      .toBe(true);
  });

  it('does not type a timestamp as an int or an int as a timestamp', () => {
    expect(evalRead('!(request.time is int) && !(resource.size is timestamp)').allowed).toBe(true);
  });

  it('denies a type test the evaluator cannot answer', () => {
    expect(evalRead('resource.size is latlng || true').allowed).toBe(true);
    expect(evalRead('resource.size is latlng').allowed).toBe(false);
  });
});

describe('typeMatches — latlng, path, and null', () => {
  it('supports null type check', () => {
    expect(typeMatches(null, 'null')).toBe(true);
    expect(typeMatches('not null', 'null')).toBe(false);
    expect(typeMatches(undefined, 'null')).toBe(false);
  });

  it('supports path type check', () => {
    const p = new StoragePath('users/alice');
    expect(typeMatches(p, 'path')).toBe(true);
    expect(typeMatches('users/alice', 'path')).toBe(false);
  });

  it('supports latlng type check', () => {
    const ll = new StorageLatLng(37.7749, -122.4194);
    expect(typeMatches(ll, 'latlng')).toBe(true);
    expect(typeMatches({ latitude: 37.7749, longitude: -122.4194 }, 'latlng')).toBe(false);
  });
});

