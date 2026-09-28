/**
 * Validator name resolution against production's compiler.
 *
 * `fixtures/name-resolution/captures.json` records, per ruleset, the issues
 * the Rules Test API reported: "Invalid function name: s." for a call no
 * visible scope declares (SEM-4), "Invalid variable name: d." for an
 * unbound identifier (SEM-5), and "Unused function: f." for a function no
 * rule or function calls (QUA-4). Each ruleset compiled; the unresolved
 * names are errors at evaluation, so the rules that reach them deny.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateFirestoreRules, type ValidationFinding } from '../../../src/rules/grammar/FirestoreValidator.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';

interface Probe {
  name: string;
  source: string;
  compiles: boolean;
  issues: { severity: string; description: string }[];
  cases: { description: string; decision: 'ALLOW' | 'DENY' }[];
}

const captured = JSON.parse(readFileSync(join(__dirname, 'fixtures/name-resolution/captures.json'), 'utf-8')) as { probes: Probe[] };

function validate(source: string): ValidationFinding[] {
  const ast = parseToAST(source);
  if (!ast) throw new Error('Failed to parse');
  return validateFirestoreRules(ast);
}

/** The `code: name` pairs a finding list reports for the three name checks. */
function nameFindings(findings: ValidationFinding[]): string[] {
  const out: string[] = [];
  for (const f of findings) {
    const name = /'([^']+)'/.exec(f.message)?.[1];
    if (f.code === 'SEM-4') out.push(`SEM-4: ${/undefined function '([^']+)'/.exec(f.message)?.[1]}`);
    else if (f.code === 'SEM-5') out.push(`SEM-5: ${/unbound variable '([^']+)'/.exec(f.message)?.[1]}`);
    else if (f.code === 'QUA-4') out.push(`QUA-4: ${name}`);
  }
  return out.sort();
}

/** The same pairs from production's issue list. */
function productionNames(probe: Probe): string[] {
  const out: string[] = [];
  for (const issue of probe.issues) {
    const fn = /^Invalid function name: (.+)\.$/.exec(issue.description);
    const variable = /^Invalid variable name: (.+)\.$/.exec(issue.description);
    const unused = /^Unused function: (.+)\.$/.exec(issue.description);
    if (fn) out.push(`SEM-4: ${fn[1]}`);
    else if (variable) out.push(`SEM-5: ${variable[1]}`);
    else if (unused) out.push(`QUA-4: ${unused[1]}`);
  }
  return out.sort();
}

function probe(name: string): Probe {
  const p = captured.probes.find(x => x.name === name);
  if (!p) throw new Error(`no captured probe ${name}`);
  return p;
}

describe('name resolution matches the captured compiler issues', () => {
  test('every captured ruleset compiled', () => {
    expect(captured.probes.filter(p => !p.compiles).map(p => p.name)).toEqual([]);
  });

  // In these two rulesets the function declared out of the caller's reach
  // is unused, and production also reports `request` in its body as an
  // invalid variable. A function reachable from a rule reads `request`
  // without that issue (every other probe), so the validator does not
  // report it.
  const unusedBodyReadsRequest = new Set(['service-function-calls-match-function', 'global-function-calls-service-function']);

  for (const p of captured.probes) {
    test(p.name, () => {
      const expected = productionNames(p).filter(n => !(unusedBodyReadsRequest.has(p.name) && n === 'SEM-5: request'));
      expect(nameFindings(validate(p.source))).toEqual(expected);
    });
  }

  test('an unresolved name denies the request that reaches it', () => {
    for (const name of ['sibling-match-function', 'unbound-variable-in-rule', 'unbound-variable-in-function', 'service-function-reads-capture', 'parent-function-reads-child-capture']) {
      expect(probe(name).cases.map(c => c.decision)).toEqual(['DENY', 'DENY']);
    }
  });
});

const wrap = (body: string, service = '') => `rules_version = '2';
service cloud.firestore {
${service}
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
${body}
  }
}`;

describe('SEM-4: undefined function, resolved by scope', () => {
  test('a call inside a function body to an undeclared function is reported', () => {
    const findings = validate(wrap(`    match /p/{id} {
      function f() { return request.auth != null && notDeclared(); }
      allow read: if f();
    }`));
    expect(findings.filter(f => f.code === 'SEM-4').map(f => f.message)).toEqual([
      "Function 'f' in /p/{id} calls undefined function 'notDeclared'",
    ]);
  });

  test('a call inside a function body to a declared function is not reported', () => {
    const findings = validate(wrap(`    match /p/{id} {
      function g() { return request.auth != null; }
      function f() { return g(); }
      allow read: if f();
    }`));
    expect(findings.filter(f => f.code === 'SEM-4')).toEqual([]);
  });

  test('a call to a function declared only in a sibling match is reported', () => {
    const findings = validate(wrap(`    match /q/{e} {
      function s() { return request.auth != null; }
      allow read: if s();
    }
    match /p/{id} {
      allow read: if s();
    }`));
    expect(findings.filter(f => f.code === 'SEM-4').map(f => f.message)).toEqual([
      "Rule at /p/{id} calls undefined function 's'",
    ]);
  });

  test('a call to a function declared in an enclosing match is not reported', () => {
    const findings = validate(wrap(`    match /p/{id} {
      function s() { return request.auth != null; }
      match /c/{cid} {
        allow read: if s();
      }
    }`));
    expect(findings.filter(f => f.code === 'SEM-4')).toEqual([]);
  });

  test('a service function calling a match function is reported', () => {
    const findings = validate(wrap(`    function inner() { return request.auth != null; }
    match /p/{id} {
      allow read: if outer();
    }`, `  function outer() { return inner(); }`));
    expect(findings.filter(f => f.code === 'SEM-4').map(f => f.message)).toEqual([
      "Function 'outer' in service cloud.firestore calls undefined function 'inner'",
    ]);
  });

  test('global conversions, lookups, and path resolve', () => {
    const findings = validate(wrap(`    match /p/{id} {
      allow read: if int('1') == 1 && string(1) == '1' && float(1) == 1.0 && path('/a/b') != null
        && existsAfter(/databases/$(database)/documents/p/$(id)) && request.auth != null;
    }`));
    expect(findings.filter(f => f.code === 'SEM-4')).toEqual([]);
  });
});

describe('SEM-5: unbound variable', () => {
  test('an allow condition reading an unbound name is an error-severity finding', () => {
    const findings = validate(wrap(`    match /games/{id} {
      allow create: if request.auth != null && d.a1 == 'R';
    }`));
    const sem5 = findings.filter(f => f.code === 'SEM-5');
    expect(sem5.map(f => [f.severity, f.operation, f.message])).toEqual([
      ['high', 'create', "Rule at /games/{id} reads unbound variable 'd'. No let binding, function parameter, path capture, or rules global has that name, so evaluating it is an error and the request is denied"],
    ]);
  });

  test('let bindings, parameters, path captures, and globals resolve', () => {
    const findings = validate(wrap(`    match /games/{id} {
      function isStartingBoard(board) {
        let d = board;
        let firstRow = d.a1;
        return firstRow == 'R' && id != '' && database != '';
      }
      allow create: if request.auth != null && isStartingBoard(request.resource.data)
        && math.abs(-1) == 1 && request.time > timestamp.value(0) && duration.value(1, 's') != null
        && latlng.value(0, 0) != null && hashing.sha256('a') != null
        && get(/databases/$(database)/documents/games/$(id)).data.x == resource.data.x;
    }`));
    expect(findings.filter(f => f.code === 'SEM-5')).toEqual([]);
  });

  test('a service function reading a path capture is reported', () => {
    const findings = validate(wrap(`    match /p/{id} {
      allow read: if f();
    }`, `  function f() { return request.auth != null && database != ''; }`));
    expect(findings.filter(f => f.code === 'SEM-5').map(f => f.message)).toEqual([
      "Function 'f' in service cloud.firestore reads unbound variable 'database'. No let binding, function parameter, path capture, or rules global has that name, so evaluating it is an error and the request is denied",
    ]);
  });
});

describe('QUA-4: unused function at every scope', () => {
  test('the arcade repro: a function in the root match that no rule calls', () => {
    const findings = validate(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function neverCalled() { return request.auth != null; }
    match /games/{id} {
      allow create: if request.auth != null && d.a1 == 'R';
    }
  }
}`);
    expect(findings.filter(f => f.code === 'QUA-4').map(f => [f.severity, f.path, f.message])).toEqual([
      ['low', '/databases/{database}/documents', "Unused function 'neverCalled': no rule or function calls it"],
    ]);
    expect(findings.filter(f => f.code === 'SEM-5').map(f => /'([^']+)'/.exec(f.message)?.[1])).toEqual(['d']);
  });

  test('unused global and service functions are reported', () => {
    const findings = validate(`rules_version = '2';
function g0() { return true; }
service cloud.firestore {
  function s0() { return true; }
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
  }
}`);
    expect(findings.filter(f => f.code === 'QUA-4').map(f => f.path)).toEqual(['global scope', 'service cloud.firestore']);
  });

  test('a function called only by an unused function is not reported, as in production', () => {
    const findings = validate(wrap('', `  function s0() { return s2(); }\n  function s2() { return true; }`));
    expect(findings.filter(f => f.code === 'QUA-4').map(f => /'([^']+)'/.exec(f.message)?.[1])).toEqual(['s0']);
  });

  test('a call that resolves to a shadowing declaration leaves the outer one unused', () => {
    const findings = validate(wrap(`    match /p/{id} {
      function s() { return request.auth != null; }
      allow read: if s();
    }`, `  function s() { return true; }`));
    expect(findings.filter(f => f.code === 'QUA-4').map(f => f.path)).toEqual(['service cloud.firestore']);
  });
});

// The `2+modules` resolver writes imported functions at service scope; a
// rule reaches them through a match-scope helper, as in the chess showcase.
describe('resolved-module shape stays clean', () => {
  test('service functions reached through a match helper: no SEM-4, SEM-5, or QUA-4', () => {
    const findings = validate(`rules_version = '2';
service cloud.firestore {
  function isAuthenticated() { return request.auth != null; }
  function isMyTurn() { return resource.data.turn == request.auth.uid; }
  function turnFlipped() { return request.resource.data.turn != resource.data.turn; }
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
    match /games/{gameId} {
      function cfg() { return get(/databases/$(database)/documents/config/$(gameId)).data; }
      function baseMoveChecks() { return isAuthenticated() && isMyTurn() && turnFlipped() && cfg().open == true; }
      allow update: if baseMoveChecks() && request.resource.data.move is string;
    }
  }
}`);
    expect(findings.filter(f => ['SEM-4', 'SEM-5', 'QUA-4'].includes(f.code))).toEqual([]);
  });
});
