import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

// ─── Method dispatch ─────────────────────────────────────────────
//
// A method the evaluator models, called on a receiver that lacks it, is
// production's "Function not found error": an error value that `|| true`
// absorbs (rules-storage-stdlib-timestamp-duration captures
// `resource.size.year() == 1970 || true` allowing). A method name the
// evaluator does not model has an unknown production verdict, so it fails
// closed even under a determining operand.

const path = 'b/pyric-default/o/docs/d1.json';

function evalRead(cond: string): { allowed: boolean; reasons: string[] } {
  const rules = parseStorageRules(`service firebase.storage {
    match /b/{bucket}/o {
      match /docs/{docId} { allow read: if ${cond}; }
    }
  }`);
  return evaluateStorageRules(rules, {
    request: { auth: { uid: 'alice' }, method: 'read', path },
    resource: { size: 10 },
  });
}

describe('evaluateStorageRules — method dispatch', () => {
  it('absorbs a modeled method on the wrong receiver under || true', () => {
    expect(evalRead('resource.size.year() == 1970 || true').allowed).toBe(true);
    expect(evalRead("resource.size.matches('1') || true").allowed).toBe(true);
    expect(evalRead('resource.size.toSet().size() == 1 || true').allowed).toBe(true);
  });

  it('fails closed on a method the evaluator does not model, even under || true', () => {
    const r = evalRead("'a'.frobnicate() == 'a' || true");
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('unsupported method .frobnicate()');
  });

  it('gives a timestamp no string methods', () => {
    const r = evalRead("request.time.lower() == 'x'");
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Function not found error: Name: [lower].');
  });
});
