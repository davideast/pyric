import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

// ─── request.time + timestamp constructors ───────────────────────
//
// `request.time` is the request's evaluation moment. Rules compare it
// against `timestamp.date(y,m,d)` (UTC midnight) and
// `timestamp.value(epochMillis)`. The caller injects the time (3rd arg);
// it defaults to now at evaluation.

describe('evaluateStorageRules — request.time', () => {
  const path = 'b/pyric-default/o/docs/d1.json';

  function evalTime(cond: string, now: Date): boolean {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    return evaluateStorageRules(
      rules,
      { request: { auth: { uid: 'alice' }, method: 'read', path }, resource: { size: 1 } },
      now,
    ).allowed;
  }

  it('allows when request.time is before timestamp.date deadline', () => {
    expect(evalTime('request.time < timestamp.date(2030, 1, 1)', new Date('2026-07-10T00:00:00Z'))).toBe(true);
  });

  it('denies when request.time is after timestamp.date deadline', () => {
    expect(evalTime('request.time < timestamp.date(2030, 1, 1)', new Date('2031-01-01T00:00:00Z'))).toBe(false);
  });

  it('compares request.time against timestamp.value(epochMillis)', () => {
    const cutoff = Date.UTC(2028, 0, 1);
    expect(evalTime(`request.time < timestamp.value(${cutoff})`, new Date(cutoff - 1000))).toBe(true);
    expect(evalTime(`request.time < timestamp.value(${cutoff})`, new Date(cutoff + 1000))).toBe(false);
  });

  it('defaults request.time to now when the caller omits it', () => {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if request.time < timestamp.date(2100, 1, 1); }
      }
    }`);
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 1 },
    });
    expect(r.allowed).toBe(true);
  });
});
