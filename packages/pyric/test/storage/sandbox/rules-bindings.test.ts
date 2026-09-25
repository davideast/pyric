import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import type { StorageResource } from '../../../src/storage/sandbox/rules.js';

// ─── request and resource bindings ───────────────────────────────

const path = 'b/pyric-default/o/docs/d1.json';

function evalRead(cond: string, resource: StorageResource): { allowed: boolean; reasons: string[] } {
  const rules = parseStorageRules(`service firebase.storage {
    match /b/{bucket}/o {
      match /docs/{docId} { allow read: if ${cond}; }
    }
  }`);
  return evaluateStorageRules(
    rules,
    { request: { auth: { uid: 'alice' }, method: 'read', path }, resource },
    new Date('2025-06-15T13:45:30.250Z'),
  );
}

describe('evaluateStorageRules — time bindings', () => {
  it('binds request.time to a timestamp at the evaluation instant', () => {
    expect(evalRead('request.time == timestamp.value(1749995130250)', { size: 1 }).allowed).toBe(true);
    expect(evalRead('request.time is timestamp', { size: 1 }).allowed).toBe(true);
  });

  it('binds resource.timeCreated and resource.updated to timestamps', () => {
    const resource = { size: 1, timeCreated: '2025-06-15T00:00:00Z', updated: '2025-06-15T13:00:00.500Z' };
    expect(evalRead('resource.timeCreated == timestamp.date(2025, 6, 15)', resource).allowed).toBe(true);
    expect(evalRead('resource.updated.nanos() == 500000000 && resource.updated is timestamp', resource).allowed)
      .toBe(true);
  });

  it('reads an unparseable time field as an absent property', () => {
    const r = evalRead('resource.updated == resource.updated', { size: 1, updated: 'not-a-time' });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Property updated is undefined on object.');
  });
});
