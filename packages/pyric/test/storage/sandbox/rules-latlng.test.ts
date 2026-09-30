import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

// `latlng.value(latitude, longitude)` builds a LatLng in Storage rules as in
// Firestore rules. Production evaluates the call and fails only at the index
// that follows it (corpus scenario `list-map-literals-and-slice`).

function evaluate(condition: string): { allowed: boolean; reasons: string[] } {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} { allow read: if ${condition}; }
  }
}`);
  const result = evaluateStorageRules(rules, {
    request: { auth: { uid: 'alice' }, method: 'read', path: 'b/pyric-default/o/docs/d1' },
    resource: { size: 1 },
  });
  return { allowed: result.allowed, reasons: result.reasons };
}

describe('Storage latlng namespace', () => {
  it('builds a value that is a latlng and equals the same coordinates', () => {
    expect(evaluate('latlng.value(1.0, 2.0) is latlng').allowed).toBe(true);
    expect(evaluate('latlng.value(1.0, 2.0) == latlng.value(1.0, 2.0)').allowed).toBe(true);
    expect(evaluate('latlng.value(1.0, 2.0) == latlng.value(1.0, 3.0)').allowed).toBe(false);
  });

  it("indexing a latlng is production's function-not-found error, which || true absorbs", () => {
    expect(evaluate('latlng.value(1.0, 2.0)[0] == null')).toEqual({
      allowed: false,
      reasons: ['match /docs/{docId} read: Function not found error: Name: [[]].'],
    });
    expect(evaluate('latlng.value(1.0, 2.0)[0] == null || true').allowed).toBe(true);
  });

  it('a call with arguments that are not two numbers is an error value', () => {
    expect(evaluate("latlng.value('a', 2.0) == null").allowed).toBe(false);
    expect(evaluate("latlng.value('a', 2.0) == null || true").allowed).toBe(true);
  });
});
