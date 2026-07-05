import { describe, test, expect } from 'bun:test';
import { parseToAST, parseRulesFile } from '../../../src/rules/grammar/FirestoreParser.js';
import { assembleRules } from '../../../src/rules/grammar/FirestoreAssembler.js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CORPUS = join(import.meta.dir, '../corpus');

const wrap = (imports: string, body: string = '') => `${imports}
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
    ${body}
  }
}`;

describe('import parsing', () => {
  test('parses single import', () => {
    const ast = parseToAST(wrap("import { isOwner } from 'auth';"));
    expect(ast).not.toBeNull();
    expect(ast!.imports).toHaveLength(1);
    expect(ast!.imports[0].functions).toEqual(['isOwner']);
    expect(ast!.imports[0].module).toBe('auth');
  });

  test('parses multiple functions from same module', () => {
    const ast = parseToAST(wrap("import { isAuthenticated, isOwner } from 'auth';"));
    expect(ast).not.toBeNull();
    expect(ast!.imports[0].functions).toEqual(['isAuthenticated', 'isOwner']);
  });

  test('parses multiple import lines', () => {
    const ast = parseToAST(wrap(
      "import { isOwner } from 'auth';\nimport { hasRequired } from 'validation';"
    ));
    expect(ast).not.toBeNull();
    expect(ast!.imports).toHaveLength(2);
    expect(ast!.imports[0].module).toBe('auth');
    expect(ast!.imports[1].module).toBe('validation');
  });

  test('extracts correct function names', () => {
    const ast = parseToAST(wrap("import { foo, bar, baz } from 'mymod';"));
    expect(ast!.imports[0].functions).toEqual(['foo', 'bar', 'baz']);
  });

  test('extracts correct module name', () => {
    const ast = parseToAST(wrap("import { fn } from 'my-module/sub';"));
    expect(ast).not.toBeNull();
    expect(ast!.imports[0].module).toBe('my-module/sub');
  });

  test('single-quoted module name', () => {
    const ast = parseToAST(wrap("import { fn } from 'auth';"));
    expect(ast!.imports[0].module).toBe('auth');
  });

  test('double-quoted module name', () => {
    const ast = parseToAST(wrap('import { fn } from "auth";'));
    expect(ast!.imports[0].module).toBe('auth');
  });

  test('version 2+modules preserved in AST', () => {
    const ast = parseToAST(wrap("import { fn } from 'auth';"));
    expect(ast!.version).toBe('2+modules');
  });

  test('standard version 2 with no imports still parses', () => {
    const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
  }
}`);
    expect(ast).not.toBeNull();
    expect(ast!.imports).toHaveLength(0);
    expect(ast!.version).toBe('2');
  });

  test('all existing corpus files still parse (no regression)', () => {
    const validDir = join(CORPUS, 'valid');
    const files = readdirSync(validDir).filter(f => f.endsWith('.rules'));
    for (const file of files) {
      const content = readFileSync(join(validDir, file), 'utf-8');
      const ast = parseToAST(content);
      expect(ast).not.toBeNull();
      expect(ast!.imports).toHaveLength(0);
    }
  });

  test('trailing comma in import list', () => {
    const ast = parseToAST(wrap("import { isOwner, isAuthenticated, } from 'auth';"));
    expect(ast).not.toBeNull();
    expect(ast!.imports[0].functions).toEqual(['isOwner', 'isAuthenticated']);
  });

  test('error on malformed import (missing braces)', () => {
    const result = parseRulesFile(wrap("import isOwner from 'auth';"));
    expect(result.valid).toBe(false);
  });

  test('error on import without from', () => {
    const result = parseRulesFile(wrap("import { isOwner } 'auth';"));
    expect(result.valid).toBe(false);
  });

  test('parses with rules_version BEFORE import declarations (Firebase-canonical order)', () => {
    // The agent / human convention is rules_version on line 1, then
    // imports — matching production firestore.rules files. The grammar
    // must accept this ordering as well as the legacy imports-first one.
    const source = `rules_version = '2+modules';
import { isOwner } from 'auth';
service cloud.firestore {
  match /databases/{database}/documents {
    match /x/{id} { allow read: if isOwner(id); }
  }
}`;
    const ast = parseToAST(source);
    expect(ast).not.toBeNull();
    expect(ast!.version).toBe('2+modules');
    expect(ast!.imports).toHaveLength(1);
    expect(ast!.imports[0].functions).toEqual(['isOwner']);
    expect(ast!.imports[0].module).toBe('auth');
  });

  test('parses with multiple imports BEFORE rules_version (legacy order still works)', () => {
    // Pre-existing samples used this ordering — keep it parseable so
    // the change is purely additive.
    const source = `import { isOwner } from 'auth';
import { hasOnly } from 'validation';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /x/{id} { allow read: if isOwner(id) && hasOnly(['a']); }
  }
}`;
    const ast = parseToAST(source);
    expect(ast).not.toBeNull();
    expect(ast!.version).toBe('2+modules');
    expect(ast!.imports).toHaveLength(2);
  });

  test('imports array is empty when no imports present', () => {
    const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
  }
}`);
    expect(ast!.imports).toEqual([]);
  });
});

describe('assembler emits imports', () => {
  test('AST with imports assembles import lines', () => {
    const ast = parseToAST(wrap("import { isOwner } from 'auth';"));
    const output = assembleRules(ast!);
    expect(output).toContain("import { isOwner } from 'auth';");
    expect(output).toContain("rules_version = '2+modules';");
  });

  test('AST without imports assembles identically to before', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} {
      allow read, write: if false;
    }
  }
}`;
    const ast = parseToAST(source);
    const output = assembleRules(ast!);
    expect(output).not.toContain('import');
  });

  test('multiple imports on separate lines', () => {
    const ast = parseToAST(wrap(
      "import { isOwner } from 'auth';\nimport { hasRequired } from 'validation';"
    ));
    const output = assembleRules(ast!);
    expect(output).toContain("import { isOwner } from 'auth';");
    expect(output).toContain("import { hasRequired } from 'validation';");
  });

  test('round-trip: parse with imports → assemble → parse → equal', () => {
    const source = wrap("import { isAuthenticated, isOwner } from 'auth';");
    const ast1 = parseToAST(source);
    const assembled = assembleRules(ast1!);
    const ast2 = parseToAST(assembled);
    expect(ast2).not.toBeNull();
    expect(ast2!.imports).toEqual(ast1!.imports);
    expect(ast2!.version).toBe(ast1!.version);
  });

  test('version string preserved as 2+modules', () => {
    const ast = parseToAST(wrap("import { fn } from 'mod';"));
    const output = assembleRules(ast!);
    expect(output).toContain("rules_version = '2+modules';");
  });
});

describe('export keyword parsing', () => {
  test('export function has exported: true', () => {
    const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    export function isAuthenticated() { return request.auth != null; }
    match /{d=**} { allow read, write: if false; }
  }
}`);
    expect(ast).not.toBeNull();
    expect(ast!.service.match.functions[0].exported).toBe(true);
    expect(ast!.service.match.functions[0].name).toBe('isAuthenticated');
  });

  test('function without export has exported: false', () => {
    const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function helper() { return true; }
    match /{d=**} { allow read, write: if false; }
  }
}`);
    expect(ast!.service.match.functions[0].exported).toBe(false);
  });

  test('mixed export and non-export in same scope', () => {
    const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    export function pub() { return true; }
    function priv() { return false; }
    match /{d=**} { allow read, write: if false; }
  }
}`);
    expect(ast!.service.match.functions[0].name).toBe('pub');
    expect(ast!.service.match.functions[0].exported).toBe(true);
    expect(ast!.service.match.functions[1].name).toBe('priv');
    expect(ast!.service.match.functions[1].exported).toBe(false);
  });

  test('all existing corpus functions have exported: false', () => {
    const { readdirSync, readFileSync } = require('fs');
    const { join } = require('path');
    const validDir = join(import.meta.dir, '../corpus/valid');
    const files = readdirSync(validDir).filter((f: string) => f.endsWith('.rules'));
    for (const file of files) {
      const content = readFileSync(join(validDir, file), 'utf-8');
      const ast = parseToAST(content);
      if (ast) {
        for (const fn of ast.service.match.functions) {
          expect(fn.exported).toBe(false);
        }
      }
    }
  });

  test('export function round-trips', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    export function isAuth() {
      return request.auth != null;
    }
    match /{d=**} {
      allow read, write: if false;
    }
  }
}
`;
    const ast1 = parseToAST(source);
    const assembled = assembleRules(ast1!);
    expect(assembled).toContain('export function isAuth()');
    const ast2 = parseToAST(assembled);
    expect(ast2!.service.match.functions[0].exported).toBe(true);
  });

  test('assembled non-export function has no prefix', () => {
    const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function helper() { return true; }
    match /{d=**} { allow read, write: if false; }
  }
}`);
    const output = assembleRules(ast!);
    expect(output).toContain('function helper()');
    expect(output).not.toContain('export function helper()');
  });
});
