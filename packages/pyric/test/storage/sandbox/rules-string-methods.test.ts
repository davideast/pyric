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

// ─── lower() / upper() / trim() / replace() / toUtf8() ───────────
//
// Values replay corpus scenario stdlib-string-bytes-hashing
// (rules-storage-stdlib-string-bytes-hashing).

describe('evaluateStorageRules — string methods', () => {
  const path = 'b/pyric-default/o/docs/d1.json';

  function evalString(cond: string): { allowed: boolean; reasons: string[] } {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    return evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 10, metadata: { name: 'Report.PDF' } },
    });
  }

  it('lowercases, uppercases, and trims', () => {
    expect(evalString("'AbC'.lower() == 'abc' && 'AbC'.upper() == 'ABC' && '  x y  '.trim() == 'x y'").allowed).toBe(true);
    expect(evalString("resource.metadata.name.lower() == 'report.pdf'").allowed).toBe(true);
  });

  it('replaces every match of a regular expression', () => {
    expect(evalString("'aXa'.replace('a', 'b') == 'bXb'").allowed).toBe(true);
    expect(evalString("'a.b'.replace('.', '-') == '---'").allowed).toBe(true);
    expect(evalString("'a.b'.replace('.', '-') == 'a-b'").allowed).toBe(false);
    expect(evalString("'a1b22'.replace('[0-9]+', '#') == 'a#b#'").allowed).toBe(true);
  });

  it('expands $1 group references and reads \\$ as a dollar sign in the replacement', () => {
    expect(evalString("'ab'.replace('(a)', '$1$1') == 'aab'").allowed).toBe(true);
    expect(evalString("'ab'.replace('a', '\\\\$') == '$b'").allowed).toBe(true);
  });

  it('denies a replacement that names no group', () => {
    const r = evalString("'ab'.replace('a', '$&') == 'ab'");
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('replace()');
  });

  it('denies an invalid or RE2-unsupported replace pattern', () => {
    expect(evalString("'abc'.replace('(', 'x') == 'abc'").allowed).toBe(false);
    expect(evalString("'aa'.replace('(a)\\\\1', 'x') == 'x'").allowed).toBe(false);
  });

  it('encodes a string as UTF-8 bytes', () => {
    expect(evalString("'é'.toUtf8().size() == 2 && 'abc'.toUtf8().size() == 3").allowed).toBe(true);
  });

  it('gives an int no string methods, an error || true absorbs', () => {
    const r = evalString("resource.size.lower() == '10'");
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Function not found error: Name: [lower].');
    expect(evalString("resource.size.lower() == '10' || true").allowed).toBe(true);
  });

  it('denies a wrong argument count', () => {
    expect(evalString("'a'.lower('b') == 'a'").allowed).toBe(false);
    expect(evalString("'a'.replace('a') == 'a'").allowed).toBe(false);
  });
});
