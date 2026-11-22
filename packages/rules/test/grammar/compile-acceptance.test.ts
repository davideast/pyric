import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreRules, lint, storageRules } from '../../src/index.js';
import { resolveModules } from '../../src/modules/resolver.js';
import { SimulateFirestoreRulesHandler } from '../../src/simulator/handler.js';
import { compileStorageRules } from '../../src/storage/rules-resolution.js';
import { parseStorageRules } from '../../src/storage/rules.js';

function fsRulesWithGuard(guard: string, version = "rules_version = '2';\n"): string {
  return `${version}service cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{id} {\n      allow get: if ${guard};\n    }\n  }\n}`;
}

function stRulesWithGuard(guard: string, version = "rules_version = '2';\n", service = 'firebase.storage'): string {
  return `${version}service ${service} {\n  match /b/{bucket}/o {\n    match /items/{id} {\n      allow get: if ${guard};\n    }\n  }\n}`;
}

describe('#1347 shared grammar and compile acceptance parity', () => {
  describe('FS2-VAL-4: .5 and 5. float literals accepted; scientific notation refused', () => {
    test('accepts .5 and 5. as float literals in Firestore and Storage while keeping 1.matches() method syntax intact', () => {
      const guard = '.5 == 0.5 && 5. == 5.0 && .5 is float && 5. is float && !(5. is int) && -.5 == -0.5';
      const fs = firestoreRules(fsRulesWithGuard(guard)).simulate([
        { description: 'floats', expectation: 'ALLOW', method: 'get', path: 'items/1' },
      ]);
      expect(fs.cases[0]!.decision).toBe('ALLOW');

      const st = storageRules(stRulesWithGuard(guard), { bucket: 'b1' }).simulate([
        { description: 'st floats', expectation: 'ALLOW', method: 'get', path: '/items/1', resource: { size: 1 } },
      ]);
      expect(st.cases[0]!.decision).toBe('ALLOW');

      const methodOnInt = firestoreRules(fsRulesWithGuard("1.matches('x') || true")).simulate([
        { description: 'int method absorbed', expectation: 'ALLOW', method: 'get', path: 'items/1' },
      ]);
      expect(methodOnInt.cases[0]!.decision).toBe('ALLOW');
    });

    test.each(['1e3 == 1000', '1.5e3 == 1500.0', '.5e2 == 50.0'])(
      'keeps scientific notation %s refused at parse time on both engines',
      (guard) => {
        expect(() => firestoreRules(fsRulesWithGuard(guard))).toThrow();
        expect(() => parseStorageRules(stRulesWithGuard(guard))).toThrow();
      },
    );
  });

  describe('FS2-VAL-10: literal /databases/(default)/documents root', () => {
    test('compiles and evaluates literal /databases/(default)/documents root and keeps exists(...) closing parens intact', () => {
      const source = [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/(default)/documents {',
        '    match /items/{id} {',
        '      allow get: if !exists(/databases/(default)/documents/users/alice);',
        '    }',
        '  }',
        '}',
      ].join('\n');

      const sim = firestoreRules(source).simulate([
        {
          description: 'literal default root with exists lookup',
          expectation: 'ALLOW',
          method: 'get',
          path: 'items/1',
        },
      ]);
      expect(sim.cases[0]!.decision).toBe('ALLOW');
    });
  });

  describe('ST-H1-5 & ST-H1-14: chained in / is precedence and service cloud.storage', () => {
    test('compiles and evaluates chained in and is expressions and service cloud.storage', () => {
      const guard =
        "resource.size is int == true && ('a' in ['a']) is bool && ('a' in ['a'] in [true]) && (1 is int is bool)";
      const st = storageRules(stRulesWithGuard(guard, "rules_version = '2';\n", 'cloud.storage'), {
        bucket: 'b1',
      }).simulate([
        { description: 'chained in/is on cloud.storage', expectation: 'ALLOW', method: 'get', path: '/items/1', resource: { size: 42 } },
      ]);
      expect(st.cases[0]!.decision).toBe('ALLOW');
    });
  });

  describe('FS2-VAL-6: wildcard keyword names vs non-keyword globals', () => {
    const keywordNames = ['true', 'false', 'null', 'in', 'is', 'if', 'return', 'let'] as const;

    test.each(keywordNames)(
      'refuses keyword {%s} and {%s=**} as match wildcard names across Firestore and Storage',
      (kw) => {
        const fsSingle = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{${kw}} { allow get: if true; }\n  }\n}`;
        const fsGlob = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{${kw}=**} { allow get: if true; }\n  }\n}`;
        expect(() => firestoreRules(fsSingle)).toThrow();
        expect(() => firestoreRules(fsGlob)).toThrow();

        const stSingle = `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /items/{${kw}} { allow get: if true; }\n  }\n}`;
        expect(() => parseStorageRules(stSingle)).toThrow();
      },
    );

    test('keeps {request} and {database} accepted as wildcard names on both engines', () => {
      const fsSource = [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{request} {',
        "      allow get: if request == 'doc1' && database == '(default)';",
        '    }',
        '  }',
        '}',
      ].join('\n');
      const fs = firestoreRules(fsSource).simulate([
        { description: '{request} and {database}', expectation: 'ALLOW', method: 'get', path: 'items/doc1' },
      ]);
      expect(fs.cases[0]!.decision).toBe('ALLOW');

      const stSource = [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{database}/o {',
        '    match /items/{request} {',
        "      allow get: if request == 'obj1' && database == 'b1';",
        '    }',
        '  }',
        '}',
      ].join('\n');
      const st = storageRules(stSource, { bucket: 'b1' }).simulate([
        { description: 'st {request} and {database}', expectation: 'ALLOW', method: 'get', path: '/items/obj1', resource: { size: 1 } },
      ]);
      expect(st.cases[0]!.decision).toBe('ALLOW');
    });
  });

  describe('FS2-VAL-5, FS2-VAL-6 & ST-H1-12: duplicate parameters, lets, and same-path captures', () => {
    const rejectedScopeCases: ReadonlyArray<{
      label: string;
      fsBody: string;
      stBody: string;
      expectedMessage: string;
    }> = [
      {
        label: 'duplicate function parameter',
        fsBody: 'function f(a, a) { return a == 1; }\n    match /items/{id} { allow get: if f(1, 1); }',
        stBody: 'function f(a, a) { return a == 1; }\n    match /items/{id} { allow get: if f(1, 1); }',
        expectedMessage: 'Parameter a is already defined.',
      },
      {
        label: 'duplicate let binding',
        fsBody: 'function f() { let x = 1; let x = 2; return x == 2; }\n    match /items/{id} { allow get: if f(); }',
        stBody: 'function f() { let x = 1; let x = 2; return x == 2; }\n    match /items/{id} { allow get: if f(); }',
        expectedMessage: 'Variable x is already bound in the current scope.',
      },
      {
        label: 'let shadowing a parameter',
        fsBody: 'function f(a) { let a = 2; return a == 2; }\n    match /items/{id} { allow get: if f(1); }',
        stBody: 'function f(a) { let a = 2; return a == 2; }\n    match /items/{id} { allow get: if f(1); }',
        expectedMessage: 'Variable a is already bound in the current scope.',
      },
      {
        label: 'capture bound twice in one match path',
        fsBody: 'match /a/{x}/b/{x} { allow get: if x == "1"; }',
        stBody: 'match /a/{x}/b/{x} { allow get: if x == "1"; }',
        expectedMessage: 'Variable x is already bound in the current scope.',
      },
    ];

    for (const c of rejectedScopeCases) {
      test(`refuses ${c.label} across firestoreRules, lint, simulate, parseStorageRules, compileStorageRules, and storageRules`, () => {
        const fsSource = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    ${c.fsBody}\n  }\n}`;
        expect(() => firestoreRules(fsSource)).toThrow(c.expectedMessage);

        const lintIssues = lint(fsSource);
        expect(lintIssues.some((i) => i.code === 'VARIABLE_REDEFINED' && i.message === c.expectedMessage)).toBe(
          true,
        );

        const handlerRes = new SimulateFirestoreRulesHandler().simulate(fsSource, [
          { description: c.label, expectation: 'DENY', method: 'get', path: 'items/1' },
        ]);
        expect(handlerRes.success).toBe(false);

        const stSource = `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    ${c.stBody}\n  }\n}`;
        expect(() => parseStorageRules(stSource)).toThrow(c.expectedMessage);
        expect(() => compileStorageRules(stSource)).toThrow(c.expectedMessage);
        expect(() => storageRules(stSource)).toThrow(c.expectedMessage);
      });
    }

    test('keeps nested capture rebinding match /a/{x} { match /b/{x} } compiling on both engines', () => {
      const fsSource = [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /a/{x} {',
        '      match /b/{x} {',
        "        allow get: if x == 'inner';",
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n');
      const fs = firestoreRules(fsSource).simulate([
        { description: 'nested rebinding', expectation: 'ALLOW', method: 'get', path: 'a/outer/b/inner' },
      ]);
      expect(fs.cases[0]!.decision).toBe('ALLOW');

      const stSource = [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /a/{x} {',
        '      match /b/{x} {',
        "        allow get: if x == 'inner';",
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n');
      const st = storageRules(stSource, { bucket: 'b1' }).simulate([
        { description: 'st nested rebinding', expectation: 'ALLOW', method: 'get', path: '/a/outer/b/inner', resource: { size: 1 } },
      ]);
      expect(st.cases[0]!.decision).toBe('ALLOW');
    });
  });

  describe('FS2-VAL-9 & ST-H1-2: mid-path ** under version 1 or omitted version', () => {
    const expectedGlobMsg = 'Invalid glob match expression. Glob matches are only permitted at the end of a path.';

    test.each(["rules_version = '1';\n", ''])(
      'refuses mid-path ** under %j on both Firestore and Storage while keeping v2 and nested v1 globs compiling',
      (versionHeader) => {
        const fsMidGlob = `${versionHeader}service cloud.firestore {\n  match /databases/{database}/documents {\n    match /{prefix=**}/items/{id} { allow get: if true; }\n  }\n}`;
        expect(() => firestoreRules(fsMidGlob)).toThrow(expectedGlobMsg);
        expect(lint(fsMidGlob).some((i) => i.code === 'GLOB_MATCH_COUNT' && i.message === expectedGlobMsg)).toBe(
          true,
        );

        const stMidGlob = `${versionHeader}service firebase.storage {\n  match /b/{bucket}/o {\n    match /{prefix=**}/leaf.txt { allow get: if true; }\n  }\n}`;
        expect(() => parseStorageRules(stMidGlob)).toThrow(expectedGlobMsg);
        expect(() => storageRules(stMidGlob)).toThrow(expectedGlobMsg);
      },
    );

    test('keeps v2 mid-path ** and v1 nested match under trailing ** compiling', () => {
      const v2MidGlob = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{prefix=**}/items/{id} { allow get: if true; }\n  }\n}";
      expect(() => firestoreRules(v2MidGlob)).not.toThrow();

      const v1Nested = "rules_version = '1';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /tree/{rest=**} {\n      match /leaf.txt { allow get: if true; }\n    }\n  }\n}";
      expect(() => parseStorageRules(v1Nested)).not.toThrow();
    });
  });

  describe('FS2-DSL-1: match or allow inside a 2+modules module file fails with PARSE_FAILED', () => {
    test.each([
      ['match block inside module', "export function ok() { return true; }\nmatch /extra/{id} { allow read: if true; }"],
      ['allow rule inside module', 'export function ok() { return true; }\nallow read: if true;'],
    ])('%s returns PARSE_FAILED naming the module', (_label, moduleBody) => {
      const dir = mkdtempSync(join(tmpdir(), 'rules-module-dsl1-'));
      try {
        writeFileSync(join(dir, 'bad-mod.rules'), moduleBody);
        const entry = [
          "rules_version = '2+modules';",
          "import { ok } from './bad-mod.rules';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /items/{id} { allow get: if ok(); }',
          '  }',
          '}',
        ].join('\n');
        const res = resolveModules(entry, { basePath: dir });
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.error.code).toBe('PARSE_FAILED');
          expect(res.error.message).toContain('./bad-mod.rules');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
