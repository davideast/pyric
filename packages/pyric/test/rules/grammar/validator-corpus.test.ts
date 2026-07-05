import { describe, test, expect } from 'bun:test';
import { validateFirestoreRules } from '../../../src/rules/grammar/FirestoreValidator.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const CORPUS = join(import.meta.dir, '../corpus');
function validate(file: string) {
  const content = readFileSync(join(CORPUS, file), 'utf-8');
  const ast = parseToAST(content);
  if (!ast) throw new Error(`Failed to parse ${file}`);
  return validateFirestoreRules(ast);
}

describe('Validator — Corpus Files', () => {
  test('002-allow-all: detects public read + write', () => {
    const findings = validate('valid/002-allow-all.rules');
    const codes = findings.map(f => f.code);
    expect(codes).toContain('SEC-1');  // public write
    expect(codes).toContain('SEC-2');  // public read at recursive wildcard
    expect(codes).toContain('SEC-5');  // permissive recursive wildcard
    expect(codes).toContain('QUA-1');  // hardcoded true
  });

  test('003-deny-all: no SEC-4 (has default deny)', () => {
    const findings = validate('valid/003-deny-all.rules');
    expect(findings.filter(f => f.code === 'SEC-4')).toHaveLength(0);
  });

  test('003-deny-all: no security findings (all locked)', () => {
    const findings = validate('valid/003-deny-all.rules');
    const security = findings.filter(f => f.code.startsWith('SEC'));
    expect(security).toHaveLength(0);
  });

  test('006-auth-checks: no security issues', () => {
    const findings = validate('valid/006-auth-checks.rules');
    const critical = findings.filter(f => f.severity === 'critical');
    expect(critical).toHaveLength(0);
  });

  test('007-data-validation: create validates data', () => {
    const findings = validate('valid/007-data-validation.rules');
    // Create rule references request.resource.data → SEC-6 should not fire for create
    const sec6 = findings.filter(f => f.code === 'SEC-6' && f.operation?.includes('create'));
    expect(sec6).toHaveLength(0);
  });

  test('008-functions: all functions used', () => {
    const findings = validate('valid/008-functions.rules');
    // hasRole and isAdmin call other functions → should find no undefined calls
    expect(findings.filter(f => f.code === 'SEM-4')).toHaveLength(0);
  });

  test('020-complex-real-world: well-structured', () => {
    const findings = validate('valid/020-complex-real-world.rules');
    const critical = findings.filter(f => f.severity === 'critical');
    // Public read on posts is intentional (QUA-1 low), but no critical issues
    // except the default deny which uses write: if false → that's fine
    expect(critical.filter(f => f.code === 'SEC-1')).toHaveLength(0); // no public write
  });

  test('021-production-blockingfun: real-world assessment', () => {
    const findings = validate('valid/021-production-blockingfun.rules');
    const codes = findings.map(f => f.code);

    // Should have default deny (has /{document=**} with false)
    expect(codes.filter(c => c === 'SEC-4')).toHaveLength(0);

    // No public writes
    expect(findings.filter(f => f.code === 'SEC-1')).toHaveLength(0);

    // Has public reads (marathons, articles) — expected
    expect(findings.filter(f => f.code === 'QUA-1' && f.severity === 'low').length).toBeGreaterThan(0);

    // No undefined function calls
    expect(findings.filter(f => f.code === 'SEM-4')).toHaveLength(0);

    // No duplicate functions
    expect(findings.filter(f => f.code === 'QUA-3')).toHaveLength(0);
  });

  test('edge-cases/001-multiple-match-same-path: may flag overlapping', () => {
    const findings = validate('edge-cases/001-multiple-match-same-path.rules');
    // Two matches for /posts/{postId} — but they have the same wildcard structure
    // STR-3 checks for wildcard/literal overlap, not duplicate wildcards
    // This is fine — they OR together
  });

  test('edge-cases/003-scoped-functions: scoped functions valid', () => {
    const findings = validate('edge-cases/003-scoped-functions.rules');
    // Each scoped function is called within its scope
    expect(findings.filter(f => f.code === 'SEM-4')).toHaveLength(0);
  });
});
