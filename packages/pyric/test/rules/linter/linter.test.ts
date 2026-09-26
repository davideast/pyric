import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { lintFirestoreRules } from '../../../src/rules/linter/linter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(__dirname, 'corpus');
// Pre-mortem M1 / X4 — derive the repo root once instead of
// repeating `../../../../` at every call site. Anchors test fixtures
// to a single point so a package-layout move only updates one line.
const REPO_ROOT = join(__dirname, '../../../../..');
const GAME_RULE_FIXTURES = join(REPO_ROOT, 'packages/pyric/test/fixtures/firestore-game-rules');

function readCorpus(filename: string): string {
  return readFileSync(join(CORPUS, filename), 'utf-8');
}

function lint(filename: string) {
  return lintFirestoreRules(readCorpus(filename));
}

function lintSource(source: string) {
  return lintFirestoreRules(source);
}

function hasRule(result: ReturnType<typeof lintFirestoreRules>, rule: string): boolean {
  return result.warnings.some(w => w.rule === rule);
}

function hasError(result: ReturnType<typeof lintFirestoreRules>, rule: string): boolean {
  return result.warnings.some(w => w.rule === rule && w.severity === 'error');
}

function hasWarning(result: ReturnType<typeof lintFirestoreRules>, rule: string): boolean {
  return result.warnings.some(w => w.rule === rule && w.severity === 'warning');
}

describe('Firestore Rules Linter', () => {
  describe('SOURCE_SIZE', () => {
    test('minimal rules — no size warning', () => {
      const r = lint('01-minimal.rules');
      expect(hasRule(r, 'SOURCE_SIZE')).toBe(false);
    });

    test('large string over 256KB triggers error', () => {
      const bigSource = 'rules_version = "2";\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /t/{d} {\n      allow read: if request.resource.data.x == "' + 'A'.repeat(260 * 1024) + '";\n    }\n  }\n}';
      const r = lintSource(bigSource);
      expect(hasError(r, 'SOURCE_SIZE')).toBe(true);
    });
  });

  describe('LET_LIMIT', () => {
    test('10 let bindings — no warning', () => {
      const r = lint('02-lets-10-ok.rules');
      expect(hasRule(r, 'LET_LIMIT')).toBe(false);
    });

    test('11 let bindings — no warning (at exact limit)', () => {
      const r = lint('06-lets-11-ok.rules');
      expect(hasRule(r, 'LET_LIMIT')).toBe(false);
    });

    test('12 let bindings — warning', () => {
      const r = lint('06b-lets-12-fail.rules');
      expect(hasError(r, 'LET_LIMIT')).toBe(true);
    });

    test('13 let bindings — warning', () => {
      const r = lint('05-lets-13-fail.rules');
      expect(hasError(r, 'LET_LIMIT')).toBe(true);
    });
  });

  describe('CHAIN_DEPTH', () => {
    test('small rules — no chain warning', () => {
      const r = lint('01-minimal.rules');
      expect(hasRule(r, 'CHAIN_DEPTH')).toBe(false);
    });

    test('10 functions — no chain warning', () => {
      const r = lint('03-functions-10.rules');
      expect(hasRule(r, 'CHAIN_DEPTH')).toBe(false);
    });
  });

  describe('SHARED_GATE', () => {
    test('unique gates — no warning', () => {
      const r = lint('09-unique-gates-12.rules');
      expect(hasRule(r, 'SHARED_GATE')).toBe(false);
    });

    test('shared gates — warning', () => {
      const r = lint('08-shared-gates-12.rules');
      expect(hasRule(r, 'SHARED_GATE')).toBe(true);
    });

    test('8 unique gates — no warning', () => {
      const r = lint('04-unique-gates-8.rules');
      expect(hasRule(r, 'SHARED_GATE')).toBe(false);
    });
  });

  describe('CALL_DEPTH', () => {
    test('6-level call chain — warning', () => {
      const r = lint('10-deep-call-chain.rules');
      expect(hasRule(r, 'CALL_DEPTH')).toBe(true);
    });
  });

  describe('Metrics', () => {
    test('minimal rules metrics', () => {
      const r = lint('01-minimal.rules');
      expect(r.metrics.functionCount).toBe(0);
      expect(r.metrics.allowRuleCount).toBe(2);
      expect(r.metrics.maxLetBindings).toBe(0);
    });

    test('10 functions metrics', () => {
      const r = lint('03-functions-10.rules');
      expect(r.metrics.functionCount).toBe(10);
      expect(r.metrics.allowRuleCount).toBe(10);
    });

    test('let binding count tracked', () => {
      const r = lint('02-lets-10-ok.rules');
      expect(r.metrics.maxLetBindings).toBe(10);
    });

    test('estimated expressions include the body of a called function', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    match /games/{id} { allow read: if signedIn(); }
  }
}`);
      expect(r.metrics.maxEstimatedExpressions).toBeGreaterThan(1);
    });
  });

  describe('Function scope', () => {
    const inMatch = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    match /games/{id} { allow read: if signedIn(); }
  }
}`;
    const atServiceScope = `rules_version = '2';
service cloud.firestore {
  function signedIn() { return request.auth != null; }
  match /databases/{database}/documents {
    match /games/{id} { allow read: if signedIn(); }
  }
}`;
    const atGlobalScope = `rules_version = '2';
function signedIn() { return request.auth != null; }
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow read: if signedIn(); }
  }
}`;

    function andChain(terms: number): string {
      return Array.from({ length: terms }, (_, i) => `request.auth.token.f${i} == true`).join(' && ');
    }

    test('a function in a match block is counted', () => {
      expect(lintSource(inMatch).metrics.functionCount).toBe(1);
    });

    test('a function at service scope is counted', () => {
      expect(lintSource(atServiceScope).metrics.functionCount).toBe(1);
    });

    test('a function at global scope is counted', () => {
      expect(lintSource(atGlobalScope).metrics.functionCount).toBe(1);
    });

    test('estimated expressions follow a call into service and global scope', () => {
      const inline = lintSource(inMatch).metrics.maxEstimatedExpressions;
      expect(inline).toBeGreaterThan(1);
      expect(lintSource(atServiceScope).metrics.maxEstimatedExpressions).toBe(inline);
      expect(lintSource(atGlobalScope).metrics.maxEstimatedExpressions).toBe(inline);
    });

    test('a 99-term && chain in a service-scope function raises CHAIN_DEPTH', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  function wide() { return ${andChain(99)}; }
  match /databases/{database}/documents {
    match /games/{id} { allow read: if wide(); }
  }
}`);
      const chain = r.warnings.filter(w => w.rule === 'CHAIN_DEPTH');
      expect(chain.map(w => w.message)).toEqual([
        "Function 'wide' has a && chain of depth 99. Limit is 98.",
      ]);
      expect(chain[0].severity).toBe('error');
      expect(r.metrics.maxChainDepth).toBe(99);
    });

    test('a 98-term && chain compiles, so it is below the limit error', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  function wide() { return ${andChain(98)}; }
  match /databases/{database}/documents {
    match /games/{id} { allow read: if wide(); }
  }
}`);
      const chain = r.warnings.filter(w => w.rule === 'CHAIN_DEPTH');
      expect(chain.map(w => w.message)).toEqual([
        "Function 'wide' has a && chain of depth 98. Limit is 98. Approaching failure.",
      ]);
      expect(r.metrics.maxChainDepth).toBe(98);
    });

    test('a 99-term && chain in a match-scope function raises CHAIN_DEPTH', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function wide() { return ${andChain(99)}; }
    match /games/{id} { allow read: if wide(); }
  }
}`);
      expect(hasError(r, 'CHAIN_DEPTH')).toBe(true);
    });

    test('a chain split across two functions stays under the limit', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  function firstHalf() { return ${andChain(50)}; }
  function wide() { return firstHalf() && ${andChain(49)}; }
  match /databases/{database}/documents {
    match /games/{id} { allow read: if wide(); }
  }
}`);
      expect(hasRule(r, 'CHAIN_DEPTH')).toBe(false);
      expect(r.metrics.maxChainDepth).toBe(50);
    });

    test('a 99-term && chain in a global-scope function raises CHAIN_DEPTH', () => {
      const r = lintSource(`rules_version = '2';
function wide() { return ${andChain(99)}; }
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow read: if wide(); }
  }
}`);
      expect(hasError(r, 'CHAIN_DEPTH')).toBe(true);
    });

    test('a short && chain in a service-scope function raises no CHAIN_DEPTH', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  function narrow() { return ${andChain(10)}; }
  match /databases/{database}/documents {
    match /games/{id} { allow read: if narrow(); }
  }
}`);
      expect(hasRule(r, 'CHAIN_DEPTH')).toBe(false);
    });

    test('a match-scope function shadows a service-scope function of the same name', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  function gate() { return ${andChain(40)}; }
  match /databases/{database}/documents {
    function gate() { return request.auth != null; }
    match /games/{id} { allow read: if gate(); }
  }
}`);
      expect(r.metrics.maxEstimatedExpressions).toBe(lintSource(inMatch).metrics.maxEstimatedExpressions);
    });
  });

  describe('GET_DUPLICATION', () => {
    test('flags repeated calls to get()-containing function', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function cfg() { return get(/databases/$(database)/documents/config/main).data; }
    function verify1(d, c) { return d.x == c.x; }
    function verify2(d, c) { return d.y == c.y; }
    match /items/{id} {
      allow create: if verify1(request.resource.data, cfg())
        && verify2(request.resource.data, cfg());
    }
  }
}`);
      expect(hasRule(r, 'GET_DUPLICATION')).toBe(true);
      const w = r.warnings.find(w => w.rule === 'GET_DUPLICATION')!;
      expect(w.message).toContain("'cfg'");
      expect(w.message).toContain('2 times');
    });

    test('no warning when get()-function called once', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function cfg() { return get(/databases/$(database)/documents/config/main).data; }
    function verifyAll(d, c) { return d.x == c.x && d.y == c.y; }
    match /items/{id} {
      allow create: if verifyAll(request.resource.data, cfg());
    }
  }
}`);
      expect(hasRule(r, 'GET_DUPLICATION')).toBe(false);
    });

    test('no warning for repeated non-get function', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isOwner(uid) { return request.auth.uid == uid; }
    match /items/{id} {
      allow create: if isOwner('alice') || isOwner('bob');
    }
  }
}`);
      expect(hasRule(r, 'GET_DUPLICATION')).toBe(false);
    });
  });

  describe('PERMISSIVE_RULE', () => {
    test('allow write: if true — warning', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow write: if true;
    }
  }
}`);
      expect(hasWarning(r, 'PERMISSIVE_RULE')).toBe(true);
    });

    test('allow read, write: if true — warning', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read, write: if true;
    }
  }
}`);
      expect(hasWarning(r, 'PERMISSIVE_RULE')).toBe(true);
    });

    test('allow create: if true — warning', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow create: if true;
    }
  }
}`);
      expect(hasWarning(r, 'PERMISSIVE_RULE')).toBe(true);
    });

    test('allow read: if true — NOT flagged (legitimate public-read)', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /publicConfig/{id} {
      allow read: if true;
    }
  }
}`);
      expect(hasRule(r, 'PERMISSIVE_RULE')).toBe(false);
    });

    test('allow write: if true || false — warning (folds to true)', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow write: if true || false;
    }
  }
}`);
      expect(hasWarning(r, 'PERMISSIVE_RULE')).toBe(true);
    });

    test('allow write: if request.auth != null — NOT flagged', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow write: if request.auth != null;
    }
  }
}`);
      expect(hasRule(r, 'PERMISSIVE_RULE')).toBe(false);
    });
  });

  describe('RECURSIVE_WILDCARD_OPEN', () => {
    test('match /{document=**} { allow read, write: if true } — warning', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`);
      expect(hasError(r, 'RECURSIVE_WILDCARD_OPEN')).toBe(true);
    });

    test('match /{document=**} with real predicate — NOT flagged', () => {
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if request.auth != null;
    }
  }
}`);
      expect(hasRule(r, 'RECURSIVE_WILDCARD_OPEN')).toBe(false);
    });

    test('non-recursive open rule does NOT trigger RECURSIVE_WILDCARD_OPEN', () => {
      // PERMISSIVE_RULE will still fire; RECURSIVE_WILDCARD_OPEN should not.
      const r = lintSource(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow write: if true;
    }
  }
}`);
      expect(hasRule(r, 'RECURSIVE_WILDCARD_OPEN')).toBe(false);
    });
  });

  describe('RULES_WEAKENED', () => {
    const wrap = (inner: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${inner}
  }
}`;

    test('removing a && clause flags exactly one warning naming the removed clause', () => {
      const prev = wrap(`    match /items/{id} {
      allow update: if request.auth != null && request.auth.uid == resource.data.ownerId;
    }`);
      const cur = wrap(`    match /items/{id} {
      allow update: if request.auth != null;
    }`);
      const r = lintFirestoreRules(cur, { previousSource: prev });
      const weakened = r.warnings.filter(w => w.rule === 'RULES_WEAKENED');
      expect(weakened.length).toBe(1);
      expect(weakened[0]!.message).toContain('Predicate removed');
      expect(weakened[0]!.message).toContain('ownerId');
      expect(weakened[0]!.severity).toBe('warning');
    });

    test('adding a && clause produces no RULES_WEAKENED warnings', () => {
      const prev = wrap(`    match /items/{id} {
      allow update: if request.auth != null;
    }`);
      const cur = wrap(`    match /items/{id} {
      allow update: if request.auth != null && request.auth.uid == resource.data.ownerId;
    }`);
      const r = lintFirestoreRules(cur, { previousSource: prev });
      expect(hasRule(r, 'RULES_WEAKENED')).toBe(false);
    });

    test('removing an entire allow rule emits one RULES_WEAKENED warning', () => {
      const prev = wrap(`    match /items/{id} {
      allow read: if true;
      allow update: if request.auth != null;
    }`);
      const cur = wrap(`    match /items/{id} {
      allow read: if true;
    }`);
      const r = lintFirestoreRules(cur, { previousSource: prev });
      const weakened = r.warnings.filter(w => w.rule === 'RULES_WEAKENED');
      expect(weakened.length).toBe(1);
      expect(weakened[0]!.message).toContain('Allow rule removed');
      expect(weakened[0]!.message).toContain('update');
    });

    test('removing an entire match block emits one RULES_WEAKENED warning', () => {
      const prev = wrap(`    match /items/{id} {
      allow read: if true;
    }
    match /secrets/{id} {
      allow read: if request.auth.uid == resource.data.ownerId;
    }`);
      const cur = wrap(`    match /items/{id} {
      allow read: if true;
    }`);
      const r = lintFirestoreRules(cur, { previousSource: prev });
      const weakened = r.warnings.filter(w => w.rule === 'RULES_WEAKENED');
      expect(weakened.length).toBe(1);
      expect(weakened[0]!.message).toContain('Match block removed');
      expect(weakened[0]!.message).toContain('secrets');
    });

    test('identical rules produce no RULES_WEAKENED warnings', () => {
      const src = wrap(`    match /items/{id} {
      allow update: if request.auth != null && request.auth.uid == resource.data.ownerId;
    }`);
      const r = lintFirestoreRules(src, { previousSource: src });
      expect(hasRule(r, 'RULES_WEAKENED')).toBe(false);
    });

    test('unparseable previous source — no warnings, no crash', () => {
      const cur = wrap(`    match /items/{id} {
      allow read: if true;
    }`);
      const r = lintFirestoreRules(cur, { previousSource: 'this is not valid rules at all !!! @@@' });
      expect(hasRule(r, 'RULES_WEAKENED')).toBe(false);
      expect(r.parseError).toBeUndefined();
    });

    test('omitting previousSource — no RULES_WEAKENED warnings (back-compat)', () => {
      const src = wrap(`    match /items/{id} {
      allow update: if request.auth != null;
    }`);
      const r = lintFirestoreRules(src);
      expect(hasRule(r, 'RULES_WEAKENED')).toBe(false);
    });

    test('wildcard binding name change does not flag (path normalization)', () => {
      const prev = wrap(`    match /items/{itemId} {
      allow read: if request.auth != null;
    }`);
      const cur = wrap(`    match /items/{id} {
      allow read: if request.auth != null;
    }`);
      const r = lintFirestoreRules(cur, { previousSource: prev });
      expect(hasRule(r, 'RULES_WEAKENED')).toBe(false);
    });
  });

  describe('Real-world rules', () => {
    test('chess rules — should have no errors', () => {
      const chess = readFileSync(join(GAME_RULE_FIXTURES, 'chess.rules'), 'utf-8');
      const r = lintFirestoreRules(chess);
      const errors = r.warnings.filter(w => w.severity === 'error');
      if (errors.length > 0) {
        console.log('Chess lint errors:', errors);
      }
      expect(errors.length).toBe(0);
      expect(r.metrics.functionCount).toBeGreaterThan(20);
      expect(r.metrics.allowRuleCount).toBeGreaterThan(15);
    });

    test('checkers lookup rules — should have no errors', () => {
      const checkers = readFileSync(join(GAME_RULE_FIXTURES, 'checkers-lookup.rules'), 'utf-8');
      const r = lintFirestoreRules(checkers);
      const errors = r.warnings.filter(w => w.severity === 'error');
      expect(errors.length).toBe(0);
    });

    test('connect four rules — should have no errors', () => {
      const cf = readFileSync(join(GAME_RULE_FIXTURES, 'connect-four.rules'), 'utf-8');
      const r = lintFirestoreRules(cf);
      const errors = r.warnings.filter(w => w.severity === 'error');
      expect(errors.length).toBe(0);
    });
  });
});
