import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

// ─── string.matches() regex ──────────────────────────────────────
//
// `string.matches(re)` — RE2-style pattern that must match the WHOLE
// string (production anchors implicitly). Invalid patterns and known
// RE2-unsupported constructs deny with a reason, never a false allow.

describe('evaluateStorageRules — matches()', () => {
  const path = 'b/pyric-default/o/docs/d1.json';

  function evalMatch(cond: string, metadata: Record<string, string>): { allowed: boolean; reasons: string[] } {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    return evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 1, metadata },
    });
  }

  it('matches a whole-string pattern', () => {
    expect(evalMatch("resource.metadata.kind.matches('[a-z]+')", { kind: 'report' }).allowed).toBe(true);
  });

  it('is whole-string anchored: partial pattern does NOT match', () => {
    // 'abc'.matches('a') is FALSE — production anchors implicitly.
    expect(evalMatch("resource.metadata.kind.matches('a')", { kind: 'abc' }).allowed).toBe(false);
  });

  it('denies (with reason) on an invalid regex pattern', () => {
    const r = evalMatch("resource.metadata.kind.matches('[')", { kind: 'abc' });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('matches');
  });

  it('denies a backreference pattern (RE2-unsupported, would fail in production)', () => {
    const r = evalMatch("resource.metadata.kind.matches('(a)\\\\1')", { kind: 'aa' });
    expect(r.allowed).toBe(false);
  });

  it('denies a lookahead pattern (RE2-unsupported, would fail in production)', () => {
    const r = evalMatch("resource.metadata.kind.matches('a(?=b)')", { kind: 'ab' });
    expect(r.allowed).toBe(false);
  });

  it('denies matches() against a non-string target', () => {
    const r = evalMatch("resource.metadata.missing.matches('.*')", { kind: 'abc' });
    expect(r.allowed).toBe(false);
  });
});
